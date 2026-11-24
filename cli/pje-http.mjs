// Cliente REST do PJe legacy (Seam/JSF) para uso FORA do navegador.
//
// Porta da camada de rede do `src/pje.js`, que continua INTOCADO. Aqui não há
// DOM, não há `location` e não há sessão JSF viva: o contexto vem por parâmetro
// (a URL base) e a autenticação, por cookie.
//
// TRÊS REGRAS QUE NÃO PODEM CAIR, todas herdadas de `docs/pje-api-rest.md`:
//
// 1. SÓ ROTAS SOB `pje-legacy/`. O `web.xml` mapeia o Seam Filter — que dá o
//    contexto de sessão, e é por isso que o cookie basta e não há token — em
//    `*.seam` e em `/seam/resource/rest/pje-legacy/*`. Rota FORA desse prefixo
//    não recebe o filtro e, na sondagem real, PENDUROU: a conexão foi aceita e
//    nunca voltou, derrubando a execução por timeout, duas vezes. Requisição que
//    não volta é pior que erro, porque prende a leva inteira.
//
// 2. SÓ GET, e só as rotas escritas aqui. O catálogo registra que nem toda
//    escrita no PJe é POST — `painelUsuario/movimentar/...` e
//    `usuario/variaveisSessao/adicionar/...` são GET e ALTERAM ESTADO. Nada de
//    varrer catálogo.
//
// 3. TETO DE TEMPO EM TUDO. Ver a regra 1: o modo de falha observado é pendurar,
//    não errar. Sem `AbortController` um endpoint mudo trava tudo.
//
// O cookie NUNCA vai para log, nem em erro, nem em modo verboso: é credencial ao
// portador e vale a sessão inteira do usuário no tribunal.

import { classificar, criarPortao, espera, lerRetryAfter } from "./retentativa.mjs";
import { midiaPorAssinatura } from "./corpo.mjs";

// O `Accept` do NAVEGADOR, e não um estreito por rota.
//
// Medido em sessão real: `usuario/isAuthenticated` e
// `processos/numero-processo/{CNJ}/validar` respondem **406 Not Acceptable** a
// `Accept: text/plain`, mesmo devolvendo texto puro. Pedir só o que se espera
// parece mais correto e é o que quebra — o servidor negocia conteúdo de um jeito
// que só aceita a lista larga. Mimetizar o navegador é a regra segura.
const ACCEPT_PADRAO = "application/json, text/plain, */*";

const TIMEOUT_PADRAO = 15000;

// DOIS tetos no download, e a diferença é o que decide não abortar o que está
// dando certo.
// - Até os CABEÇALHOS: o servidor pode demorar a montar a peça, mas um minuto
//   sem nem começar a responder é rota pendurada.
// - Durante o CORPO, o teto é de INATIVIDADE, não de tempo total. Antes o
//   relógio era desligado quando chegavam os cabeçalhos, e um corpo que parava
//   no meio segurava a peça para sempre. Um teto total cortaria o PDF grande que
//   chega devagar mas chega — que é o caso normal numa conexão doméstica.
const TIMEOUT_CABECALHOS_DOWNLOAD = 60000;
const INATIVIDADE_DOWNLOAD = 30000;

// Rotas do processo (lista de peças, ficha, movimentações, CNJ): quantas idas ao
// todo, contando a primeira.
const TENTATIVAS_ROTA = 4;

// Gravação de áudio/vídeo reconhecida pelo cabeçalho: não se baixa.
const RE_MIDIA_CT = /^(audio|video)\/|^application\/(vnd\.ms-asf|ogg)\b/;

// Status que não podem ter corpo: `new Response(corpo, {status})` LANÇA com eles.
const SEM_CORPO = new Set([204, 205, 304]);

// Erro com a CLASSE junto, para quem re-tenta não precisar ler a mensagem. A
// mensagem continua a mesma de antes, porque a fila do app a lê
// ("não foi encontrado", "falha de rede em …").
function erroDe(mensagem, extra) {
  return Object.assign(new Error(mensagem), extra);
}

const msgDe = (e) => (e && e.message ? e.message : String(e));

// ---------------------------------------------------------------------------
// Contexto derivado da URL base
// ---------------------------------------------------------------------------

// Espelha `siglaTribunal()` de src/pje.js: o rótulo IMEDIATAMENTE antes de
// `jus`, exceto quando ele for literalmente `pje`. `pje.tjce.jus.br` -> TJCE;
// `pje1g.trf5.jus.br` -> TRF5; `*.cloud.pje.jus.br` -> null (e aí só existe a
// rota curta de download).
export function siglaTribunal(host) {
  const p = String(host || "").split(".");
  const i = p.indexOf("jus");
  return i > 0 && p[i - 1] && p[i - 1] !== "pje" ? p[i - 1].toUpperCase() : null;
}

// Espelha `grauAtual()`: olha o base path E o hostname, porque os tribunais
// codificam o grau ora num, ora noutro.
export function grauDe(base, host) {
  return /2grau|2g(?![a-z])/.test(String(base) + " " + String(host)) ? "2g" : "1g";
}

// A URL base é o que se copia da barra de endereços até o base path:
// `https://pje.tjce.jus.br/pje1grau`. Dela saem host, base, sigla e grau — os
// quatro dados que no navegador vinham de `location`.
export function lerBase(urlBase) {
  let u;
  try {
    u = new URL(String(urlBase));
  } catch {
    throw new Error(
      "URL base inválida: " + urlBase +
        "\nEsperado algo como https://pje.tjce.jus.br/pje1grau"
    );
  }
  if (u.protocol !== "https:") throw new Error("a URL base precisa ser https");
  const base = u.pathname.split("/").filter(Boolean)[0];
  if (!base) {
    throw new Error(
      "falta o base path na URL: " + urlBase +
        "\nEle é o primeiro segmento do caminho (pje1grau, pje, 1g, primeirograu...)."
    );
  }
  // Portão de dialeto, igual ao `PJE.dialeto` da extensão: o PJe KZ (frontend
  // novo) não tem a árvore `seam` nem o id na querystring. O sinal é POSITIVO (o
  // base path), nunca "a resposta veio vazia".
  if (/^pjekz$/i.test(base)) {
    throw new Error(
      "este tribunal usa o PJe KZ (base path `pjekz`), que não expõe as rotas " +
        "`seam/resource/rest/pje-legacy/` das quais este CLI depende."
    );
  }
  return {
    origem: u.origin,
    host: u.hostname,
    base,
    sigla: siglaTribunal(u.hostname),
    grau: grauDe(base, u.hostname),
  };
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

// `portao`: o semáforo de rede COMPARTILHADO (o app passa um por lote; sem ele,
// o cliente cria o seu). `sono` e `aleatorio` entram para o teste medir as
// esperas sem esperar de verdade.
// `tetos`: {cabecalhosMs, inatividadeMs} do download e `rotaMs` das rotas
// pequenas — só o teste muda.
export function criarCliente({ urlBase, cookie, userAgent, extras, portao, sono, aleatorio, tetos }) {
  const ctx = lerBase(urlBase);
  if (!cookie || !String(cookie).trim()) throw new Error("sessão sem cookie");
  const gate = portao || criarPortao();
  const dormir = sono || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const sortear = aleatorio || Math.random;
  const tetoCabecalhos = (tetos && tetos.cabecalhosMs) || TIMEOUT_CABECALHOS_DOWNLOAD;
  const tetoInatividade = (tetos && tetos.inatividadeMs) || INATIVIDADE_DOWNLOAD;
  const tetoRota = (tetos && tetos.rotaMs) || TIMEOUT_PADRAO;

  // O que o cliente fez desde que nasceu. `baixarProcesso` tira a diferença
  // entre o antes e o depois para o diagnóstico de UM processo.
  const contadores = { requisicoes: 0, bytes: 0, esperaMs: 0, retentativas: {} };

  const prefixo = ctx.origem + "/" + ctx.base + "/seam/resource/rest/pje-legacy/";
  const ua = userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

  // Cabeçalhos `X-pje-*` / `X-no-sso` / `Authorization` capturados do cURL.
  //
  // Quando a sessão nasce no frontend novo do CNJ, o backend legado do tribunal
  // identifica a aplicação por eles (`X-pje-legacy-app`), e o filtro de CORS que
  // atende `/seam/resource/rest/pje-legacy/.*` os lê. Replicar o que o navegador
  // manda é a escolha mais segura: se o backend os exigir, funcionam; se os
  // ignorar, custam alguns bytes. O contrário — omitir e descobrir depois — daria
  // um 401 ou, pior, um 200 sem os dados.
  const cabecalhosExtras = extras && typeof extras === "object" ? extras : {};

  function contarRetentativa(chave, esperaMs) {
    contadores.retentativas[chave] = (contadores.retentativas[chave] || 0) + 1;
    contadores.esperaMs += esperaMs;
  }

  // Toda requisição passa por aqui. Um ponto único é o que garante que o teto de
  // tempo, os cabeçalhos, a guarda de prefixo e o PORTÃO valham para todas — e
  // não só para as que alguém lembrou de proteger.
  //
  // `consumir(resposta)` roda DENTRO do portão: é onde o download lê o corpo, e
  // um corpo sendo lido ocupa a rede tanto quanto os cabeçalhos. Sem `consumir`
  // devolve a Response com o corpo por ler (rotas pequenas).
  //
  // `opts.portao === false`: o diagnóstico (`autenticado`, `statusInfo`) passa
  // por fora. Com o portão fechado por um 429, perguntar "a sessão está viva?"
  // não pode ficar na fila atrás de quem causou o 429.
  //
  // O TETO DE TEMPO VALE ATÉ O FIM DE `consumir`, e não só até os cabeçalhos.
  // Desligá-lo quando os cabeçalhos chegavam deixava o corpo da lista de peças,
  // das movimentações ou do CNJ sem relógio nenhum: um corpo que parasse no meio
  // penduraria o processo — o modo de falha que a regra 3 existe para impedir.
  // Só o download (`opts.tetoSoCabecalhos`) desliga cedo, porque ele tem o teto
  // de INATIVIDADE próprio e um PDF grande pode levar mais que um teto total.
  async function requisitar(caminho, opts, consumir) {
    const url = caminho.startsWith("https:") ? caminho : prefixo + caminho;
    if (!url.startsWith(prefixo)) {
      throw new Error("rota fora de pje-legacy/ é proibida: " + caminho);
    }
    const usarPortao = opts.portao !== false;
    const geracao = usarPortao ? await gate.entrar() : undefined;
    contadores.requisicoes++;
    const ctl = new AbortController();
    const teto = opts.timeout || TIMEOUT_PADRAO;
    let motivo = null;
    const abortar = (m) => {
      motivo = m;
      ctl.abort();
    };
    let saida = { sucesso: true };
    const relogio = setTimeout(() => abortar("teto"), teto);
    try {
      let r;
      try {
        r = await fetch(url, {
          method: "GET",
          redirect: "follow",
          headers: {
            ...cabecalhosExtras,
            Cookie: cookie,
            Accept: opts.accept || ACCEPT_PADRAO,
            // Espelhar o navegador é o comportamento menos surpreendente para o
            // balanceador que emitiu o cookie sticky.
            "User-Agent": ua,
          },
          signal: ctl.signal,
        });
      } catch (e) {
        if (e && e.name === "AbortError") {
          // Rota que não responde é o sinal mais claro de servidor afogado.
          saida = { sobrecarga: true };
          throw erroDe("a rota não respondeu em " + Math.round(teto / 1000) + "s: " + caminho, {
            erroDeRede: true,
            transitorio: true,
          });
        }
        saida = {};
        throw erroDe("falha de rede em " + caminho + ": " + msgDe(e), { erroDeRede: true, transitorio: true });
      } finally {
        if (opts.tetoSoCabecalhos) clearTimeout(relogio);
      }
      if (r.status === 429 || r.status === 503) {
        // O servidor PEDIU para esperar: o portão fecha para todos.
        const pedido = lerRetryAfter(r.headers.get("retry-after"));
        saida = {
          sobrecarga: true,
          esperaMs: pedido != null ? Math.min(pedido, 60000) : gate.fechamentoPadraoMs,
        };
      } else if (r.status >= 500) {
        // 500/502/504: servidor em apuros, sem pedido de espera. Corta o limite.
        saida = { sobrecarga: true };
      }
      if (!consumir) return r;
      try {
        return await consumir(r, { abortar, motivo: () => motivo });
      } catch (e) {
        // Corpo que parou de chegar (ou que estourou o teto) também é servidor afogado.
        if (motivo === "inatividade" || motivo === "teto") saida = { sobrecarga: true };
        throw e;
      }
    } finally {
      clearTimeout(relogio);
      if (usarPortao) gate.sair({ ...saida, geracao });
    }
  }

  // Compatível com o de antes: devolve a Response, com o corpo por ler.
  function pedir(caminho, opts = {}) {
    return requisitar(caminho, opts, null);
  }

  // Tenta de novo o que é transitório, com a espera FORA do portão. O erro que
  // escapa é o da ÚLTIMA tentativa, com a mensagem de sempre.
  async function comRetentativa(fn, tentativas = TENTATIVAS_ROTA) {
    for (let t = 0; ; t++) {
      try {
        return await fn();
      } catch (e) {
        const tipo = e && e.erroDeRede ? "transitoria" : e && e.status ? classificar({ status: e.status }) : "definitiva";
        if (tipo !== "transitoria" || t + 1 >= tentativas) throw e;
        const w = espera(t, { retryAfterMs: e.retryAfterMs ?? null, aleatorio: sortear });
        contarRetentativa(e.status || "rede", w);
        await dormir(w);
      }
    }
  }

  // Descarta o corpo de uma resposta que não interessa — senão a conexão fica
  // presa esperando alguém ler.
  function descartar(r) {
    try {
      if (r.body && !r.bodyUsed) r.body.cancel().catch(() => {});
    } catch {
      /* corpo já fechado */
    }
  }

  function erroHttp(r, mensagem) {
    descartar(r);
    return erroDe(mensagem, {
      status: r.status,
      transitorio: classificar({ status: r.status }) === "transitoria",
      retryAfterMs: lerRetryAfter(r.headers.get("retry-after")),
    });
  }

  async function lerTexto(r, caminho) {
    try {
      return await r.text();
    } catch (e) {
      // A conexão caiu no meio do corpo (`terminated`): é rede, e vale de novo.
      throw erroDe("falha de rede em " + caminho + ": " + msgDe(e), { erroDeRede: true, transitorio: true });
    }
  }

  async function pedirJson(caminho, opts = {}) {
    return comRetentativa(
      () =>
        requisitar(caminho, { timeout: tetoRota, ...opts }, async (r) => {
          if (!r.ok) throw erroHttp(r, "HTTP " + r.status + " em " + caminho);
          const txt = await lerTexto(r, caminho);
          if (!txt.trim()) return null;
          try {
            return JSON.parse(txt);
          } catch {
            throw new Error("resposta não é JSON em " + caminho);
          }
        }),
      opts.tentativas || TENTATIVAS_ROTA
    );
  }

  // O corpo do download, lido em pedaços com teto de INATIVIDADE. Devolve os
  // bytes, ou `{midia}` quando o começo do arquivo é gravação de áudio/vídeo (e
  // aí o resto nem trafega).
  async function lerDownload(r, { abortar, motivo }) {
    const leitor = r.body.getReader();
    const pedacos = [];
    let total = 0;
    let conferido = false;
    for (;;) {
      const relogio = setTimeout(() => abortar("inatividade"), tetoInatividade);
      let lido;
      try {
        lido = await leitor.read();
      } catch (e) {
        if (motivo() === "inatividade") {
          throw erroDe(
            "a peça parou de chegar (" + Math.round(tetoInatividade / 1000) + " s sem dados)",
            { erroDeRede: true, transitorio: true }
          );
        }
        throw erroDe("a conexão caiu no meio da peça (" + msgDe(e) + ")", { erroDeRede: true, transitorio: true });
      } finally {
        clearTimeout(relogio);
      }
      if (lido.done) break;
      pedacos.push(lido.value);
      total += lido.value.length;
      if (!conferido && total >= 1024) {
        conferido = true;
        const m = midiaPorAssinatura(Buffer.concat(pedacos));
        if (m) {
          leitor.cancel().catch(() => {});
          return { midia: m };
        }
      }
    }
    const bytes = Buffer.concat(pedacos, total);
    if (!conferido && bytes.length) {
      const m = midiaPorAssinatura(bytes);
      if (m) return { midia: m };
    }
    return { bytes };
  }

  return {
    ctx,
    prefixo,
    pedir,
    pedirJson,
    portao: gate,

    estatisticas() {
      return {
        requisicoes: contadores.requisicoes,
        bytes: contadores.bytes,
        esperaMs: contadores.esperaMs,
        retentativas: { ...contadores.retentativas },
        portao: gate.estatisticas(),
      };
    },

    // Para quem re-tenta por fora (o baixador): mesma contagem, mesmo sono.
    contarRetentativa,
    esperar: dormir,
    sortear,

    // Versão, tribunal, instância. 12 ms na medição. É o controle POSITIVO da
    // sonda: se responde, o cookie chegou e o Seam Filter aceitou. É
    // DIAGNÓSTICO: uma ida só e por fora do portão — quem pergunta quer saber
    // agora se o PJe responde, não daqui a quatro esperas.
    statusInfo: () => pedirJson("status/info", { portao: false, tentativas: 1 }),

    // "A sessão está viva?" respondida ANTES de gastar qualquer coisa.
    //
    // DUAS rotas, e a segunda não é redundância. `usuario/isAuthenticated`
    // responde **406 Not Acceptable** quando o `Accept` não lhe serve — medido
    // em sessão real, com a sessão PERFEITAMENTE viva. Tratar não-ok como "não
    // autenticado" fazia o CLI anunciar "o cookie expirou" para um cookie bom, e
    // mandar o usuário refazer um login que não era o problema.
    //
    // Por isso: o `Accept` é o mesmo do navegador, e qualquer resposta que não
    // seja um `true`/`false` limpo cai em `usuario/currentUser`, que devolve o
    // usuário da sessão e é inequívoca. Só depois das duas é que se afirma que a
    // sessão morreu.
    // O corpo é lido DENTRO de `requisitar`, sob o teto de tempo.
    autenticado: async () => {
      const opts = { portao: false, timeout: tetoRota };
      try {
        const t = await requisitar("usuario/isAuthenticated", opts, async (r) =>
          r.ok ? (await r.text()).trim().toLowerCase() : null
        );
        if (t === "true") return true;
        if (t === "false") return false;
      } catch {
        /* cai para a segunda rota */
      }
      try {
        return await requisitar("usuario/currentUser", opts, async (r) => {
          if (!r.ok) return false;
          const j = JSON.parse(await r.text());
          return !!(j && (j.idUsuario || j.login || j.nomeUsuario));
        });
      } catch {
        return false;
      }
    },

    // CNJ -> idProcesso. É a rota que dispensa o formulário de Consulta
    // Processual inteiro (6 campos, A4J, views queimadas). Devolve TEXTO PURO,
    // não JSON — daí o accept.
    idPorCnj: (cnj) => {
      const caminho = "processos/numero-processo/" + encodeURIComponent(cnj) + "/validar";
      return comRetentativa(() =>
        requisitar(caminho, { timeout: tetoRota }, async (r) => {
          if (!r.ok) throw erroHttp(r, "HTTP " + r.status + " ao resolver o CNJ " + cnj);
          const txt = (await lerTexto(r, caminho)).trim();
          const m = txt.match(/\d{2,}/);
          if (!m) {
            // Definitivo: sem `status`, não re-tenta. Com a sessão morta a rota
            // devolve uma página sem número, e quem separa os dois casos é quem
            // pergunta ao PJe depois (a fila do app).
            throw new Error(
              "o CNJ " + cnj + " não foi encontrado nesta instância. Confira: " +
                "tribunal certo? grau certo (1º x 2º)? dígito verificador correto? " +
                "processo em segredo de justiça sem acesso deste usuário?"
            );
          }
          return m[0];
        })
      );
    },

    fichaEnxuta: (id) => pedirJson("processos/" + id),
    fichaMni: (id) => pedirJson("api/v1/processos-judiciais/" + id),
    partes: (id) => pedirJson("cadastro-partes/processos/" + id + "/partes"),
    documentos: (id) => pedirJson("processos/" + id + "/documentos"),
    movimentacoes: (id) => pedirJson("processos/" + id + "/movimentacoes"),

    // As DUAS rotas de download, na ordem de `urlsDownload()` do pje.js:
    // 1. COMPLETA — serve os dois tipos de peça (nascida digital e binária);
    // 2. CURTA — retrocompatibilidade, só funciona para PDF. Em peça HTML o
    //    servidor devolve 200 com CASCA VAZIA, porque sem o contexto do processo
    //    ele não sabe montar o documento.
    // Host sem sigla clara (*.cloud.pje.jus.br) só tem a curta.
    urlsDownload(idProcesso, idDoc) {
      const raiz = prefixo + "documento/download/";
      const urls = [];
      if (ctx.sigla && idProcesso) {
        urls.push(raiz + ctx.sigla + "/" + ctx.grau + "/" + idProcesso + "/" + idDoc);
      }
      urls.push(raiz + idDoc);
      return urls;
    },

    // Uma ida à rota de download, com o corpo JÁ LIDO dentro do portão.
    //
    // Devolve uma Response (a mesma forma de antes: `lerCorpo` não muda) ou
    // `{midia, tipo, tamanho, status}` quando a peça é gravação de áudio/vídeo —
    // reconhecida pelo cabeçalho ou pelo primeiro pedaço do arquivo, e o resto
    // nem trafega. Erro de rede no corpo LANÇA com `transitorio: true`: antes
    // um `terminated` no meio da peça virava "formato ilegível" e não tinha
    // segunda chance.
    baixarBruto(url) {
      return requisitar(url, { accept: "*/*", timeout: tetoCabecalhos, tetoSoCabecalhos: true }, async (r, controle) => {
        const ct = (r.headers.get("content-type") || "").toLowerCase().trim();
        const tamanho = Number(r.headers.get("content-length")) || null;
        if (r.ok && RE_MIDIA_CT.test(ct)) {
          descartar(r);
          return { midia: true, tipo: ct.split(";")[0].trim(), tamanho, status: r.status, ok: false };
        }
        const cabecalhos = { status: r.status, statusText: r.statusText, headers: r.headers };
        if (!r.ok || !r.body || SEM_CORPO.has(r.status)) {
          descartar(r);
          return new Response(null, cabecalhos);
        }
        const lido = await lerDownload(r, controle);
        if (lido.midia) {
          return { midia: true, tipo: lido.midia, tamanho, status: r.status, ok: false };
        }
        contadores.bytes += lido.bytes.length;
        return new Response(lido.bytes, cabecalhos);
      });
    },
  };
}
