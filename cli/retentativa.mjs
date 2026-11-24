// A política ÚNICA de re-tentativa e o PORTÃO de rede do cliente do PJe.
//
// Puro: nenhum `fetch`, nenhum disco. Relógio, sono e sorteio entram por
// parâmetro, e é isso que deixa o teste medir esperas sem esperar.
//
// POR QUE ISTO EXISTE (medido nos lotes reais, 11.608 peças):
// - a re-tentativa antiga era linear (0,8 s, 1,6 s), sem sorteio e sem
//   `Retry-After`, e cada peça decidia sozinha. Um 503 do PJe derrubava cinco
//   pedidos juntos, e os cinco voltavam JUNTOS 800 ms depois — a manada que
//   mantém o servidor sobrecarregado;
// - as rotas do PROCESSO (lista de peças, ficha, movimentações) não
//   re-tentavam nada: um 503 em `documentos` punha o processo inteiro em
//   "falhou", sem segunda chance.
//
// TRÊS peças, e cada uma responde a uma pergunta diferente:
// - `classificar`: vale tentar de novo?
// - `espera`: quanto esperar? (full jitter: o sorteio é o que desfaz a manada)
// - `criarPortao`: quantos pedidos podem estar na rede AGORA? É o semáforo
//   compartilhado. Quando o PJe responde 429/503, o portão FECHA para todos, e
//   ninguém bate na porta enquanto o servidor pediu para esperar.

// ---------------------------------------------------------------------------
// Classificação
// ---------------------------------------------------------------------------

// Transitória: o mesmo pedido pode dar certo daqui a pouco.
// Definitiva: repetir só gasta o tempo de quem espera e a paciência do servidor.
// - 403 é DEFINITIVO: no PJe é peça cancelada (o título aparece riscado na
//   linha do tempo), e o 403 se repete com e sem os cabeçalhos do navegador;
// - 401 não é nem um nem outro: é a sessão, e quem decide é quem pergunta ao PJe
//   se ela está viva (`autenticado`).
export function classificar({ status = 0, erroDeRede = false } = {}) {
  if (erroDeRede) return "transitoria";
  if (status === 401) return "sessao";
  if (status === 408 || status === 425 || status === 429) return "transitoria";
  if (status >= 500 && status < 600) return "transitoria";
  return "definitiva";
}

// `Retry-After` vem em SEGUNDOS ("120") ou numa DATA HTTP
// ("Wed, 21 Oct 2026 07:28:00 GMT"). Devolve milissegundos, ou `null` quando o
// cabeçalho não existe ou não dá para ler — e aí quem decide é o sorteio.
export function lerRetryAfter(valor, agoraMs = Date.now()) {
  const v = String(valor ?? "").trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - agoraMs) : null;
}

export const ESPERA_BASE_MS = 1000;
export const ESPERA_TETO_MS = 20000;
// O servidor pode pedir mais que o nosso teto — e ele sabe o que está dizendo.
// Mas acima de um minuto a espera deixa de ser "respira" e vira "volte depois",
// que é decisão da FILA (retomar o processo mais tarde), não de um pedido.
export const RETRY_AFTER_TETO_MS = 60000;

// FULL JITTER: sorteio uniforme entre zero e o teto exponencial da tentativa.
// É a variante que mais espalha os pedidos. Com uma espera FIXA por tentativa,
// cinco pedidos que falham juntos voltam juntos, e o servidor recebe a mesma
// rajada que o derrubou.
export function espera(tentativa, opcoes = {}) {
  const {
    base = ESPERA_BASE_MS,
    teto = ESPERA_TETO_MS,
    retryAfterMs = null,
    tetoRetryAfter = RETRY_AFTER_TETO_MS,
    aleatorio = Math.random,
  } = opcoes;
  const janela = Math.min(teto, base * 2 ** Math.max(0, tentativa));
  const sorteio = Math.floor(aleatorio() * janela);
  if (retryAfterMs == null) return sorteio;
  return Math.max(sorteio, Math.min(retryAfterMs, tetoRetryAfter));
}

// ---------------------------------------------------------------------------
// O portão
// ---------------------------------------------------------------------------

// O semáforo de REDE. Quem manda na concorrência real é ele, não o pool de
// peças: o pool decide o que buscar adiante; o portão decide quantos pedidos
// estão no fio ao mesmo tempo.
//
// UM POR LOTE, NUNCA POR CLIENTE. O app cria um cliente por processo (a sessão
// salva é relida a cada um, para um login novo valer sem reiniciar). Um portão
// que nascesse dentro do cliente seria de um processo só, e o limite
// compartilhado não existiria. Por isso ele entra por parâmetro.
//
// AIMD (o controle de congestionamento do TCP): sobrecarga (429, 503, teto de
// tempo) corta o limite PELA METADE; uma sequência de sucessos soma UM. Cai
// rápido quando o servidor reclama e sobe devagar quando ele aguenta.
//
// UMA RAJADA CORTA UMA VEZ. Com cinco pedidos no fio e o PJe soluçando, os
// cinco voltam 503 quase juntos; cortando a cada um, o limite ia de 8 a 2 num
// instante e só voltava depois de 120 sucessos. É a regra do TCP: perda de
// pacote enviado ANTES do último corte não corta de novo. Cada pedido carimba a
// GERAÇÃO em que entrou (`entrar()` a devolve), e só quem entrou depois do
// último corte pode cortar outra vez. A fila do app faz o mesmo com o 429 do
// provedor.
//
// A espera entre tentativas NÃO acontece aqui dentro. Quem vai esperar sai do
// portão primeiro — senão uma peça dormindo seguraria uma vaga que outra
// usaria.
export function criarPortao(opcoes = {}) {
  const {
    inicial = 5,
    min = 2,
    max = 8,
    sucessosParaSubir = 20,
    // 429/503 sem `Retry-After`: fecha por um instante curto, só para a rajada
    // que já estava no fio não ser seguida de outra.
    fechamentoPadraoMs = 2000,
    relogio = Date.now,
    agendar = setTimeout,
    desagendar = clearTimeout,
  } = opcoes;

  const piso = Math.max(1, Math.min(min, max));
  const topo = Math.max(piso, max);
  let limite = Math.max(piso, Math.min(topo, inicial));
  let emUso = 0;
  let fechadoAte = 0;
  let sucessos = 0;
  let geracao = 0;
  let timer = null;
  const fila = [];
  const est = {
    limiteMin: limite,
    limiteMax: limite,
    sobrecargas: 0,
    cortes: 0,
    fechamentos: 0,
    maxEmUso: 0,
  };

  function ocupar() {
    emUso++;
    if (emUso > est.maxEmUso) est.maxEmUso = emUso;
  }

  function despachar() {
    const falta = fechadoAte - relogio();
    if (falta > 0) {
      // Um relógio só, para o instante em que o portão reabre. Se alguém
      // estender o fechamento no meio, o relógio acorda, confere e se rearma.
      if (!timer && fila.length) {
        timer = agendar(() => {
          timer = null;
          despachar();
        }, falta);
      }
      return;
    }
    while (fila.length && emUso < limite) {
      ocupar();
      fila.shift()(geracao);
    }
  }

  return {
    // Resolve quando há vaga E o portão está aberto, com a GERAÇÃO do instante
    // em que o pedido ocupou a vaga (devolva-a no `sair`). A ordem de chegada é
    // respeitada: quem entrou na fila não é passado por quem chegou depois.
    entrar() {
      if (!fila.length && emUso < limite && relogio() >= fechadoAte) {
        ocupar();
        return Promise.resolve(geracao);
      }
      return new Promise((resolver) => {
        fila.push(resolver);
        despachar();
      });
    },

    // `sobrecarga`: o servidor reclamou (corta o limite pela metade).
    // `esperaMs`: por quanto tempo NINGUÉM entra (o `Retry-After` do servidor).
    // `sucesso`: resposta que não foi reclamação, conta para subir o limite.
    // `geracao`: a que o `entrar()` devolveu. Sem ela, a reclamação corta
    // sempre (o comportamento de quem não sabe quando o pedido saiu).
    sair({ sobrecarga = false, esperaMs = 0, sucesso = false, geracao: g } = {}) {
      emUso = Math.max(0, emUso - 1);
      if (sobrecarga) {
        est.sobrecargas++;
        sucessos = 0;
        if (g === undefined || g >= geracao) {
          limite = Math.max(piso, Math.floor(limite / 2));
          geracao++;
          est.cortes++;
        }
      } else if (sucesso) {
        sucessos++;
        if (sucessos >= sucessosParaSubir) {
          sucessos = 0;
          if (limite < topo) limite++;
        }
      }
      if (esperaMs > 0) {
        const ate = relogio() + esperaMs;
        if (ate > fechadoAte) {
          fechadoAte = ate;
          est.fechamentos++;
        }
      }
      if (limite < est.limiteMin) est.limiteMin = limite;
      if (limite > est.limiteMax) est.limiteMax = limite;
      despachar();
    },

    // Para o 429/503 sem cabeçalho: o fechamento curto de sempre.
    fechamentoPadraoMs,

    get limite() {
      return limite;
    },
    get emUso() {
      return emUso;
    },
    get esperando() {
      return fila.length;
    },

    estatisticas() {
      return { ...est, limite };
    },

    // Encerra o relógio pendente (teste, ou lote que terminou com a fila vazia).
    parar() {
      if (timer) desagendar(timer);
      timer = null;
    },
  };
}
