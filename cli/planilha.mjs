// Números de processo de uma PLANILHA — para `pje baixar --lista planilha.xlsx`.
//
// Por que no CLI, e não num script à parte: quem chega pelo instalador público
// pode não ter Python, e pode nem ter `node` no PATH (o instalador usa um Node
// PORTÁTIL quando a máquina não tem o 22). O único programa garantido é o `pje`.
//
// O QUE ELE FAZ: varre o TEXTO INTEIRO do arquivo — todas as abas, todas as
// colunas — atrás do padrão do número CNJ, e não uma coluna fixa. O relatório do
// tribunal muda de layout, e procurar pelo padrão não depende disso. Cada número
// tem o dígito verificador conferido (módulo 97, Res. CNJ 65/2008): um dígito
// trocado na digitação vira "fora da lista, e dito", não "não encontrado no PJe"
// depois de uma ida ao servidor.
//
// Formatos: .xlsx/.xlsm (ZIP de XMLs), .ods (ZIP com `content.xml`) e .xls
// antigo (binário: o texto é procurado em Latin-1 e em UTF-16, as duas formas
// em que o Excel 97-2003 guarda as strings). CSV e TXT seguem pelo caminho de
// sempre do `--lista`, uma linha por vez.
//
// Sem dependência: o ZIP é lido à mão (diretório central + `inflateRawSync`),
// o mesmo desenho do `src/docx-importar.js` da extensão.

import zlib from "node:zlib";

// Com e sem a máscara. Os separadores são opcionais um a um, então "20 dígitos
// colados" (planilha que perdeu a formatação) também casa — o DV filtra o resto.
const RE_CNJ = /(?<!\d)(\d{7})-?(\d{2})\.?(\d{4})\.?(\d)\.?(\d{2})\.?(\d{4})(?!\d)/g;

export function ehPlanilha(nome) {
  return /\.(xlsx|xlsm|ods|xls)$/i.test(String(nome || ""));
}

export function dvConfere(n, dd, ano, j, tr, orgao) {
  const resto = BigInt(n + ano + j + tr + orgao + "00") % 97n;
  return 98n - resto === BigInt(dd);
}

// ---------------------------------------------------------------------------
// ZIP mínimo (só leitura)
// ---------------------------------------------------------------------------

function abrirZip(buf) {
  // O fim do diretório central (EOCD) é procurado de trás para frente: depois
  // dele pode haver um comentário de até 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entradas = new Map();
  for (let k = 0; k < total && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const tamanho = buf.readUInt32LE(p + 20);
    const nLen = buf.readUInt16LE(p + 28);
    const xLen = buf.readUInt16LE(p + 30);
    const cLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    entradas.set(buf.toString("utf8", p + 46, p + 46 + nLen), { metodo, tamanho, local });
    p += 46 + nLen + xLen + cLen;
  }
  return {
    nomes: [...entradas.keys()],
    // Os tamanhos vêm do diretório CENTRAL, não do cabeçalho local: com o bit 3
    // (data descriptor) o local traz zero, e é assim que o Excel grava às vezes.
    ler(nome) {
      const e = entradas.get(nome);
      if (!e) return null;
      const ini = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const dados = buf.subarray(ini, ini + e.tamanho);
      if (e.metodo === 0) return dados.toString("utf8");
      if (e.metodo === 8) return zlib.inflateRawSync(dados).toString("utf8");
      return null; // outro método: não é planilha que conhecemos
    },
  };
}

// O texto de um XML de planilha, uma célula por linha. As tags que FECHAM uma
// célula viram quebra; as de dentro (`<r>`, `<t>`, `<text:span>`, os pedaços de
// texto rico) somem SEM separador — senão um número formatado em dois trechos
// sairia partido ao meio.
function textoDoXml(xml) {
  return String(xml || "")
    .replace(/<\/(?:si|c|v|is|row|text:p|table:table-cell)>/g, "\n")
    .replace(/<(?:br|text:line-break)\b[^>]*\/?>/g, "\n")
    .replace(/<[^>]*>/g, "");
}

function textosDe(buf, nome) {
  const ext = String(nome || "").toLowerCase().split(".").pop();
  if (ext === "xls") {
    // BIFF: a string vem em Latin-1 (comprimida) ou em UTF-16LE. Procurar nas
    // duas leituras é mais simples e mais robusto que decodificar o formato.
    return [buf.toString("latin1"), buf.toString("utf16le"), buf.subarray(1).toString("utf16le")];
  }
  const zip = abrirZip(buf);
  if (!zip) throw new Error("o arquivo não parece uma planilha ." + ext + " (não é um ZIP válido)");
  const partes = ext === "ods"
    ? ["content.xml"]
    : zip.nomes.filter((n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort();
  return partes.map((n) => textoDoXml(zip.ler(n)));
}

// Devolve `{cnjs, invalidos}`: os números com DV certo, sem repetição, na ordem
// em que aparecem; e os que casaram o padrão mas não o dígito verificador.
export function cnjsDaPlanilha(buf, nome) {
  const cnjs = [];
  const invalidos = [];
  for (const texto of textosDe(buf, nome)) {
    for (const m of texto.matchAll(RE_CNJ)) {
      const [, n, dd, ano, j, tr, orgao] = m;
      const cnj = n + "-" + dd + "." + ano + "." + j + "." + tr + "." + orgao;
      if (dvConfere(n, dd, ano, j, tr, orgao)) {
        if (!cnjs.includes(cnj)) cnjs.push(cnj);
      } else if (!invalidos.includes(cnj)) {
        invalidos.push(cnj);
      }
    }
  }
  // Um número que aparece certo numa célula e errado noutra não é inválido.
  return { cnjs, invalidos: invalidos.filter((c) => !cnjs.includes(c)) };
}
