// O núcleo: baixar as peças de um processo e montar o pacote.
//
// Compartilhado por `pje baixar`, `pje atualizar` e `pje sondar` — os três fazem
// a mesma coisa com escopos diferentes, e duplicar isto faria os três divergirem
// no primeiro ajuste.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { lerCorpo } from "./corpo.mjs";
import { classificar, espera, lerRetryAfter } from "./retentativa.mjs";
import { sinkPasta } from "./sink-fs.mjs";
import { lerCache, lerDoDisco, limparOrfaos } from "./cache.mjs";
import { montarFicha, docsDe } from "./ficha.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// `exportar.js` é puro de propósito (src/exportar.js:14-16) e tem rodapé
// CommonJS (src/exportar.js:876): carrega no Node sem shim nenhum.
//
// É este reuso que garante que o pacote saia IDÊNTICO ao do botão do painel — e
// é por isso que o CLI mora no repositório da extensão em vez de ser um pacote
// npm solto: um pacote solto teria de duplicar este arquivo, e a cópia
// divergiria no primeiro ajuste.
export const PjeExport = require(path.join(AQUI, "..", "src", "exportar.js"));

const sono = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Uma peça
// ---------------------------------------------------------------------------

// Quantas idas por peça, contando a primeira. Cinco com espera exponencial
// sorteada (1 s, 2 s, 4 s, 8 s de teto na janela) cobre um soluço de ~15 s do
// PJe sem prender o processo por minutos.
const TENTATIVAS_PECA = 5;

// A casca ganha UMA nova ida depois desta espera. É o teste empírico de "a casca
// é transitória?": o que ela recuperar vai contado no diagnóstico.
const REPESCAGEM_CASCA_MS = 5000;

const fmtTamanho = (n) =>
  !n ? null : n >= 1048576 ? (n / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";

// O STATUS QUE VALE É O DA ROTA COMPLETA, não o da última tentada.
//
// As duas rotas fracassam de formas diferentes e a curta é a MENOS informativa:
// medido neste processo, ela devolve 404 para TODA peça — inclusive para as que
// a completa entrega com 200. Guardar "o último status" fazia um 403 da rota boa
// ser reportado como 404 da rota ruim, e 404 e 403 são diagnósticos opostos:
// "não existe" contra "você não pode". O relatório mandava o usuário procurar a
// peça no lugar errado.
function statusMaisInformativo(a, b) {
  // 0 = nem respondeu. Qualquer resposta vale mais que nenhuma.
  if (!a) return b;
  if (!b) return a;
  // Entre duas respostas, a que NÃO é 404 diz mais: 403/500/429 apontam causa.
  if (a !== 404) return a;
  return b;
}

// Uma peça, com as re-tentativas DENTRO da busca.
//
// A espera entre tentativas acontece aqui, fora do portão (cada ida à rede entra
// e sai dele por conta própria): peça dormindo não segura vaga de rede.
//
// `diag`: onde contar re-tentativas, esperas e cascas recuperadas (opcional).
export async function obterPeca(cli, idProcesso, idDoc, opcoes = {}) {
  const {
    tentativas = TENTATIVAS_PECA,
    repescagemMs = REPESCAGEM_CASCA_MS,
    dormir = cli.esperar || sono,
    aleatorio = cli.sortear || Math.random,
    diag = null,
  } = opcoes;
  const contar = (chave, ms) => {
    if (cli.contarRetentativa) cli.contarRetentativa(chave, ms);
    else if (diag) {
      diag.retentativas[chave] = (diag.retentativas[chave] || 0) + 1;
      diag.esperaMs += ms;
    }
  };
  const urls = cli.urlsDownload(idProcesso, idDoc);
  // O status da tentativa MAIS RECENTE é o que descreve a peça agora. O de uma
  // tentativa antiga (um 503 que já passou) não pode decidir a de agora.
  let ultimoStatus = 0;
  let houveErroDeRede = false;
  // A rede caiu na rota COMPLETA (a única que serve os dois tipos de peça). O
  // 404 da curta na mesma volta não diz nada sobre a peça: ela devolve 404 para
  // quase tudo.
  let redeNaCompleta = false;
  let repescou = false;

  for (let t = 0; t < tentativas; t++) {
    houveErroDeRede = false;
    redeNaCompleta = false;
    let statusDaVez = 0;
    let retryAfterMs = null;
    let casca = false;
    for (let iu = 0; iu < urls.length; iu++) {
      const u = urls[iu];
      let r;
      try {
        r = await cli.baixarBruto(u);
      } catch {
        // Rede caiu, o teto de tempo estourou ou o corpo parou de chegar. Isso É
        // transitório e vale re-tentativa.
        houveErroDeRede = true;
        if (iu === 0 && urls.length > 1) redeNaCompleta = true;
        continue;
      }
      if (r.midia) {
        // Gravação de áudio/vídeo: decisão do dono do projeto é LISTAR, não
        // baixar. Não é falha, e a outra rota não mudaria nada.
        const tam = fmtTamanho(r.tamanho);
        return {
          ok: false,
          midia: true,
          tipo: r.tipo || null,
          tamanho: r.tamanho || null,
          motivo:
            "gravação de áudio/vídeo (" + [r.tipo, tam].filter(Boolean).join(", ") + ") — não baixada; ouça no PJe",
        };
      }
      statusDaVez = statusMaisInformativo(statusDaVez, r.status);
      if (r.status === 429 || r.status === 503) {
        const pedido = lerRetryAfter(r.headers && r.headers.get("retry-after"));
        if (pedido != null) retryAfterMs = Math.max(retryAfterMs || 0, pedido);
      }
      if (!r.ok) continue;
      try {
        const corpo = await lerCorpo(r, idDoc);
        if (corpo) {
          if (repescou && diag) diag.cascasRecuperadas++;
          return { ok: true, corpo };
        }
        casca = true;
      } catch (e) {
        // Veio inteiro, mas não é documento que dê para guardar. Não adianta
        // tentar a outra rota nem re-tentar: guarda o motivo e para.
        return { ok: false, motivo: e.message };
      }
    }
    if (statusDaVez) ultimoStatus = statusDaVez;
    const transitoria = houveErroDeRede || classificar({ status: statusDaVez }) === "transitoria";
    if (transitoria) {
      if (t + 1 >= tentativas) break;
      const w = espera(t, { retryAfterMs, aleatorio });
      // Quem justifica a repetida é a rede quando ela caiu (o 404 da rota curta,
      // na mesma volta, não é o motivo).
      contar(houveErroDeRede || !statusDaVez || statusDaVez === 200 ? "rede" : statusDaVez, w);
      await dormir(w);
      continue;
    }
    if (casca && !repescou && repescagemMs > 0) {
      // Uma ida a mais para a casca, e uma só: na maioria ela é estado do
      // servidor e não se resolve esperando.
      repescou = true;
      contar("casca", repescagemMs);
      await dormir(repescagemMs);
      t--; // a repescagem não consome uma das tentativas de rede
      continue;
    }
    break;
  }

  // Rede caída na rota completa até o fim: o motivo é a REDE, e não o 404 da
  // curta. Relatar "sem download (404)" diria que não há o que fazer, e há:
  // rodar de novo.
  const melhorStatus = houveErroDeRede && redeNaCompleta && ultimoStatus === 404 ? 0 : ultimoStatus;

  if (melhorStatus === 403) {
    // O servidor entendeu quem somos e RECUSOU este documento. Não é falha
    // técnica e não há retry que resolva — medido: 403 com e sem os cabeçalhos
    // `X-pje-*`, com e sem `Referer`, nas duas rotas.
    return {
      ok: false,
      motivo: "HTTP 403 (o PJe recusou o acesso a esta peça)",
      semPermissao: true,
    };
  }
  if (melhorStatus === 404) {
    return {
      ok: false,
      motivo: "HTTP 404 (o PJe não tem download para esta peça)",
      naoServivel: true,
    };
  }
  if (houveErroDeRede && !melhorStatus) {
    return { ok: false, motivo: "a rede não respondeu depois de " + tentativas + " tentativas" };
  }
  if (melhorStatus && melhorStatus !== 200) {
    return { ok: false, motivo: "HTTP " + melhorStatus };
  }
  // O limite conhecido: o PJe não materializa a peça até ela ser aberta na
  // sessão. Não é a rota — é estado no servidor.
  return {
    ok: false,
    motivo: "não materializada nesta sessão (o PJe devolveu envelope vazio)",
    casca: true,
  };
}

// ---------------------------------------------------------------------------
// Pool de prefetch
//
// `montarZip` chama `obter(id)` UM POR VEZ, em ordem cronológica, e esse
// contrato não muda — o que mudaria a numeração e o índice. O paralelismo entra
// por baixo: uma janela vai baixando adiante e `obter` só aguarda a promessa que
// já está em voo. Mesmo truque do pipeline de upload da extensão
// (`baixarSelecionadas`), e `src/exportar.js` segue intocado.
//
// A JANELA É LIMITADA de propósito. Disparar as 141 de uma vez traria todas para
// a memória ao mesmo tempo — e o conteúdo é base64, ~1,33x os bytes. Num
// processo grande isso mata o Node antes de gravar a primeira peça.
//
// O paralelo é legítimo aqui, ao contrário do que a extensão faz: a serialização
// que ela obedece é da ativação A4J na sessão JSF, que este caminho não toca.
// O catálogo mediu 5 requisições REST simultâneas respondendo, duas vezes.
//
// TRÊS limites, e cada um responde a uma pergunta:
// - `concorrencia`: quantas buscas deste processo em voo;
// - `janela`: quantas peças adiantadas (em voo + prontas esperando a vez);
// - `tetoBytes`: quanto conteúdo pronto pode esperar em memória.
// E a rede de verdade é o portão do cliente, compartilhado.
//
// A VAGA É REPOSTA QUANDO QUALQUER BUSCA TERMINA, não quando a peça DA VEZ é
// consumida. Antes era no consumo: um PDF grande (ou uma peça esperando
// re-tentativa) na frente da fila deixava as outras vagas paradas, com as peças
// seguintes prontas para buscar. Agora a peça lenta ocupa UMA vaga, e as outras
// seguem adiantando até a janela.
// ---------------------------------------------------------------------------

export function criarPool(ids, buscar, opcoes = {}) {
  const {
    concorrencia = 5,
    janela = Math.max(2, concorrencia * 2),
    tetoBytes = 200 * 1048576,
    tamanhoDe = (r) => (r && r.ok && r.corpo ? (r.corpo.b64 || r.corpo.text || "").length : 0),
  } = opcoes;
  const estado = new Map(); // id -> { p, pronto, bytes }
  const iniciados = new Set();
  let proximo = 0;
  let emVoo = 0;
  let bytesProntos = 0;
  const est = { maxEmVoo: 0, maxJanela: 0 };

  function iniciar(id) {
    iniciados.add(id);
    const reg = { pronto: false, bytes: 0, p: null };
    emVoo++;
    if (emVoo > est.maxEmVoo) est.maxEmVoo = emVoo;
    reg.p = Promise.resolve()
      .then(() => buscar(id))
      .then(
        (r) => {
          reg.pronto = true;
          reg.bytes = tamanhoDe(r);
          if (estado.get(id) === reg) bytesProntos += reg.bytes;
          return r;
        },
        (e) => {
          reg.pronto = true;
          throw e;
        }
      )
      .finally(() => {
        emVoo--;
        encher();
      });
    // Rejeição de peça adiantada ainda não tem quem a espere: sem isto seria
    // "unhandled rejection". Quem consome recebe o erro pelo `await`.
    reg.p.catch(() => {});
    estado.set(id, reg);
    if (estado.size > est.maxJanela) est.maxJanela = estado.size;
  }

  function encher() {
    while (
      proximo < ids.length &&
      emVoo < concorrencia &&
      estado.size < janela &&
      bytesProntos < tetoBytes
    ) {
      const id = ids[proximo++];
      if (!iniciados.has(id)) iniciar(id);
    }
  }
  encher();

  async function obter(id) {
    // Fora de ordem (ou fora da lista): busca avulsa.
    if (!estado.has(id)) iniciar(id);
    const reg = estado.get(id);
    try {
      return await reg.p;
    } finally {
      estado.delete(id);
      if (reg.pronto) bytesProntos -= reg.bytes;
      encher();
    }
  }
  obter.estatisticas = () => ({ ...est, emVoo, janela: estado.size, bytesProntos });
  return obter;
}

// ---------------------------------------------------------------------------
// Um processo
// ---------------------------------------------------------------------------

// `agora`: o instante que vai no pacote (`geradoEm`). Só o teste passa — o
// oráculo compara dois pacotes byte a byte, e eles precisam do mesmo instante.
export async function baixarProcesso(cli, cnj, opcoes = {}) {
  const {
    destinoRaiz = "autos",
    forcar = false,
    concorrencia = 3,
    zip = false,
    onProgresso = null,
    agora = undefined,
  } = opcoes;

  const t0 = Date.now();
  const antes = cli.estatisticas ? cli.estatisticas() : null;
  const diag = { retentativas: {}, esperaMs: 0, cascasRecuperadas: 0 };

  const id = await cli.idPorCnj(cnj);

  const [enxuta, partes] = await Promise.all([
    cli.fichaEnxuta(id).catch(() => null),
    cli.partes(id).catch(() => null),
  ]);
  const ficha = montarFicha({ cnj, enxuta, partes });

  const docs = docsDe(await cli.documentos(id));
  if (!docs.length) throw new Error("a lista de peças veio vazia");

  const pasta = path.join(destinoRaiz, PjeExport.nomePasta(cnj));
  fs.mkdirSync(pasta, { recursive: true });

  // O cache é lido ANTES da montagem: durante ela os arquivos são reescritos, e
  // um índice lido no meio já não descreveria o que está no disco.
  const cache = forcar ? { mapa: new Map(), geradoEm: null } : lerCache(pasta);
  const novas = docs.filter((d) => !cache.mapa.has(d.id));

  let baixadas = 0;
  let reusadas = 0;
  const cascas = [];
  const naoServiveis = [];
  const semPermissao = [];
  const midias = [];
  let sessaoMorreu = false;

  const buscar = async (idDoc) => {
    const r = await obterPeca(cli, id, idDoc, { diag });
    if (r.ok) {
      baixadas++;
      if (onProgresso) onProgresso(baixadas, novas.length);
    }
    return r;
  };

  // Só as peças NOVAS entram no pool, NA ORDEM EM QUE `montarZip` VAI PEDIR
  // (a cronológica): adiantar outra ordem faria a peça da vez virar busca
  // avulsa. As do cache são lidas do disco na hora e não ocupam a janela.
  // A ordem sai da lista INTEIRA: ordenar só as novas poderia trocar de critério
  // (data de juntada × inversa da tela) e divergir da ordem da montagem.
  const ordemNovas = PjeExport.ordenarCronologico(docs)
    .docs.filter((d) => !cache.mapa.has(d.id))
    .map((d) => d.id);
  const poolObter = criarPool(ordemNovas, buscar, {
    concorrencia: Math.max(1, Math.min(8, concorrencia)),
  });
  const titulos = new Map(docs.map((d) => [d.id, d.titulo]));

  const obter = async (idDoc) => {
    if (sessaoMorreu) throw new Error("sessão do PJe encerrada durante a rodada");
    const doCache = cache.mapa.get(idDoc);
    if (doCache) {
      reusadas++;
      return lerDoDisco(doCache);
    }
    const r = await poolObter(idDoc);
    if (!r.ok) {
      if (r.midia) {
        midias.push({
          id: idDoc,
          // sem o "123456 - " do começo, como o índice do pacote grava o título
          titulo: String(titulos.get(idDoc) || "").replace(/^\s*\d{6,}\s*-\s*/, ""),
          tipo: r.tipo,
          tamanho: r.tamanho,
        });
      }
      if (r.casca) cascas.push(idDoc);
      if (r.naoServivel) naoServiveis.push(idDoc);
      if (r.semPermissao) semPermissao.push(idDoc);
      // "A SESSÃO CAIU" É UMA AFIRMAÇÃO FORTE E PRECISA SER CONFIRMADA.
      //
      // Tratar todo 403 como sessão morta foi um defeito caro: um 403 POR
      // DOCUMENTO — que é o caso real, com as outras 134 peças respondendo 200
      // na mesma sessão — abortava o lote inteiro. A diferença entre "você não
      // pode ver ESTE documento" e "você não está mais logado" não está no
      // status; está em perguntar.
      //
      // Uma requisição a mais por 403 é barata, e só acontece no caminho de
      // exceção.
      if (r.semPermissao && !(await cli.autenticado())) sessaoMorreu = true;
      throw new Error(r.motivo);
    }
    return r.corpo;
  };

  const origemLista =
    "lista oficial de documentos do PJe (rota REST), lida em " +
    new Date().toLocaleDateString("pt-BR");

  const res = await PjeExport.montarZip({
    docs, obter, cnj, ficha, origemLista, zip: sinkPasta(pasta),
    ...(agora ? { agora } : {}),
  });

  // As gravações de áudio/vídeo que ficaram de fora, LISTADAS. `montarZip` as
  // registra como falha (a numeração salta nelas, como em toda peça que não
  // veio), e quem lê o pacote precisa saber que elas NÃO são falha: são
  // depoimentos gravados que se ouvem no PJe. Reescrito a cada rodada — a
  // gravação nunca entra no índice, então ela é reconhecida de novo toda vez,
  // e de graça (o download é cancelado no primeiro pedaço).
  try {
    fs.writeFileSync(
      path.join(pasta, "midias.json"),
      JSON.stringify({ versao: 1, processo: cnj, itens: midias }, null, 2)
    );
  } catch {
    /* sem a lista o pacote continua correto; as falhas ainda dizem o motivo */
  }

  // A renumeração cronológica faz a mesma peça mudar de nome quando entra uma
  // peça nova antes dela. Sem esta limpeza a pasta acumularia o mesmo documento
  // sob dois números a cada execução.
  const orfaos = limparOrfaos(
    pasta,
    res.itens.map((it) => it.arquivo),
    res.itens.map((it) => it.id),
    docs.map((d) => d.id)
  );

  // Quando houve 403, vale uma requisição a mais para trazer a EVIDÊNCIA.
  //
  // Medido num processo real do TJCE: as quatro peças "Mandado" recusadas
  // correspondem a quatro movimentos que dizem `Situacao: Cancelado em
  // 26/07/2024` — e na linha do tempo do PJe elas aparecem com o título RISCADO.
  // O PJe não serve documento cancelado, e o 403 é isso.
  //
  // Isso muda o que o relatório significa: a ausência dessas peças não é lacuna
  // do pacote, é o pacote refletindo os autos. Um mandado cancelado não integra
  // o que vale no processo.
  //
  // A ligação movimento -> peça NÃO é automática: o `textoFinalExterno` só traz
  // `Documento: NNNN` em alguns eventos, e nestes não traz. Por isso o CLI
  // OFERECE as movimentações de cancelamento como pista para quem lê, em vez de
  // afirmar qual peça corresponde a qual — afirmar exigiria um pareamento que
  // este dado não sustenta.
  let pistasCancelamento = [];
  if (semPermissao.length) {
    try {
      const movs = await cli.movimentacoes(id);
      pistasCancelamento = (movs || [])
        .map((m) => [m.dsEvento, m.textoFinalExterno].filter(Boolean).join(" | "))
        .filter((t) => /cancelad|sem efeito|tornad[oa] sem efeito/i.test(t))
        .map((t) => t.replace(/\s+/g, " ").trim());
    } catch {
      /* sem as movimentações o relatório continua correto, só menos informativo */
    }
  }

  let arquivoZip = null;
  if (zip) arquivoZip = await gerarZip(pasta, cnj, res, ficha, origemLista);

  return {
    cnj, pasta, id,
    resumo: res.resumo,
    falhas: res.falhasDetalhe,
    cascas, naoServiveis, semPermissao, pistasCancelamento, baixadas, reusadas, orfaos,
    midias,
    total: docs.length,
    jaEmDisco: cache.mapa.size,
    novas: novas.length,
    sessaoMorreu,
    zip: arquivoZip,
    diagnostico: montarDiagnostico(cli, antes, diag, poolObter, Date.now() - t0),
  };
}

// O que a rede fez neste processo — a evidência para o próximo "por que falhou".
// Nunca carrega cookie nem conteúdo: só números.
function montarDiagnostico(cli, antes, diag, pool, ms) {
  const depois = cli.estatisticas ? cli.estatisticas() : null;
  const retentativas = { ...diag.retentativas };
  let esperaMs = diag.esperaMs;
  let requisicoes = null;
  let bytes = null;
  if (depois && antes) {
    requisicoes = depois.requisicoes - antes.requisicoes;
    bytes = depois.bytes - antes.bytes;
    esperaMs += depois.esperaMs - antes.esperaMs;
    for (const [k, v] of Object.entries(depois.retentativas)) {
      const n = v - (antes.retentativas[k] || 0);
      if (n) retentativas[k] = (retentativas[k] || 0) + n;
    }
  }
  const portao = depois && depois.portao;
  return {
    ms,
    requisicoes,
    bytes,
    retentativas,
    esperaMs,
    cascasRecuperadas: diag.cascasRecuperadas,
    maxEmVoo: pool.estatisticas().maxEmVoo,
    // `inicio`/`final` são deste processo; `min`/`max`, da vida do portão (que é
    // do lote inteiro no app).
    concorrencia: portao
      ? { inicio: antes && antes.portao ? antes.portao.limite : null, final: portao.limite, min: portao.limiteMin, max: portao.limiteMax }
      : null,
  };
}

// O `.zip` é montado a partir do que JÁ ESTÁ NA PASTA, não de uma segunda ida ao
// PJe: `lerCache` devolve exatamente o `obter` que `montarZip` precisa. Custa
// leitura de disco e nada de rede.
async function gerarZip(pasta, cnj, res, ficha, origemLista) {
  // `src/zip.js` termina em `window.ZipW = {...}`, e `window` não existe no
  // Node. Uma linha resolve, e o arquivo segue INTOCADO — o que importa, porque
  // ele é content script da extensão publicada.
  if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
  require(path.join(AQUI, "..", "src", "zip.js"));
  const ZipW = globalThis.window.ZipW;

  const cache = lerCache(pasta);
  const docs = res.itens.map((it) => ({
    id: it.id,
    titulo: it.tituloCompleto || it.titulo,
    tipo: it.tipo,
    juntadoEm: it.juntadoEm,
    juntadoPor: it.juntadoPor,
  }));

  const saida = await PjeExport.montarZip({
    docs,
    obter: async (id) => {
      const c = cache.mapa.get(id);
      if (!c) throw new Error("peça não está na pasta");
      return lerDoDisco(c);
    },
    cnj, ficha, origemLista, zip: ZipW,
  });

  const alvo = path.join(path.dirname(pasta), saida.nome);
  fs.writeFileSync(alvo, Buffer.from(await saida.blob.arrayBuffer()));
  return alvo;
}
