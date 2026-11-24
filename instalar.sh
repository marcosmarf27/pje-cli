#!/bin/sh
# Instalador do `pje` para WSL, Linux e macOS: o CLI que baixa os autos do PJe e
# a skill que ensina o Claude Code a usa-lo.
#
# UMA LINHA (sem sudo):
#
#   curl -fsSL https://raw.githubusercontent.com/marcosmarf27/pje-cli/main/instalar.sh | sh
#
# Rodar de novo ATUALIZA: o codigo e a skill sao trocados; a sessao do PJe e o
# que ja foi baixado ficam.
#
# O QUE ELE FAZ (tudo dentro do $HOME):
#   1. Node.js 22.4+: usa o da maquina; sem ele, baixa um Node PORTATIL para
#      ~/.local/share/tecjustica-pje/node, conferido pelo SHASUMS256 oficial.
#   2. o codigo (tarball do repositorio publico) em ~/.local/share/tecjustica-pje/app
#   3. o comando `pje` em ~/.local/bin
#   4. a skill em ~/.claude/skills/pje-autos
#
# O que ele NAO faz, e so AVISA, porque exige sudo: instalar o Poppler (o
# Claude Code precisa do `pdftoppm` para ler PDF com mais de 10 paginas) e, no
# WSL, um Chrome do Linux (o `pje login` abre a janela de login nele).
#
# PARA QUEM USA WSL: `pje login` FUNCIONA aqui com um Chrome do Linux --
# medido em 20/08/2026, Ubuntu 24.04 sob WSLg (padrao no Windows 11): login
# concluido e 207 pecas baixadas. Um Chrome do lado Windows NAO serve: abriria a
# porta de depuracao noutro espaco de rede. E a sessao do WSL e a do Windows sao
# ARQUIVOS DIFERENTES (~/.tecjustica-pje x %LOCALAPPDATA%\tecjustica-pje): logar
# de um lado nao loga do outro.
#
# O clone so vale quando este ARQUIVO e executado de dentro dele. Sob
# `curl | sh` o $0 e "sh", e a pasta atual da pessoa nunca e tomada por clone.

set -eu

REPO_TGZ="https://github.com/marcosmarf27/pje-cli/archive/refs/heads/main.tar.gz"
NODE_SHAS="https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt"
BASE="${XDG_DATA_HOME:-$HOME/.local/share}/tecjustica-pje"
APP="$BASE/app"
NODEDIR="$BASE/node"
BIN="$HOME/.local/bin"
SKILL="$HOME/.claude/skills/pje-autos"
TMP="$(mktemp -d 2>/dev/null || echo "/tmp/pje-instalar-$$")"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

passo() { printf '\n=> %s\n' "$1"; }
feito() { printf '   %s\n' "$1"; }
aviso() { printf '   %s\n' "$1"; }
falhar() {
  printf '\n   A instalacao parou: %s\n' "$1" >&2
  printf '   Rode o mesmo comando de novo; o que ja foi feito e reaproveitado.\n' >&2
  exit 1
}

baixar() { # url destino
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else falhar "preciso do curl ou do wget"; fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# 22.4+: o `pje login` fala com o Chrome pelo WebSocket GLOBAL do Node, estavel
# so a partir da 22.4.
node_serve() {
  [ -x "$1" ] || command -v "$1" >/dev/null 2>&1 || return 1
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=4)?0:1)' 2>/dev/null
}

printf 'Instalador do pje -- autos do PJe para o Claude Code\n'
mkdir -p "$BASE"

# --- 1. Node ---------------------------------------------------------------
passo "Node.js"
NODE=""
if command -v node >/dev/null 2>&1 && node_serve "$(command -v node)"; then
  NODE="$(command -v node)"
  feito "usando o Node da maquina: $NODE"
elif node_serve "$NODEDIR/bin/node"; then
  NODE="$NODEDIR/bin/node"
  feito "usando o Node portatil ja instalado"
else
  case "$(uname -s)" in
    Linux) SO=linux ;;
    Darwin) SO=darwin ;;
    *) falhar "sistema nao suportado: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARQ=x64 ;;
    aarch64|arm64) ARQ=arm64 ;;
    *) falhar "processador nao suportado: $(uname -m)" ;;
  esac
  aviso "Node 22.4+ nao encontrado -- baixando um Node portatil (~30 MB, sem sudo)"
  baixar "$NODE_SHAS" "$TMP/SHASUMS256.txt"
  LINHA="$(grep -E "^[0-9a-f]{64}  node-v22\.[0-9]+\.[0-9]+-$SO-$ARQ\.tar\.gz$" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$LINHA" ] || falhar "nao achei o Node 22 para $SO-$ARQ em nodejs.org"
  HASH="${LINHA%% *}"
  NOME="${LINHA##* }"
  baixar "${NODE_SHAS%SHASUMS256.txt}$NOME" "$TMP/$NOME"
  [ "$(sha256 "$TMP/$NOME")" = "$HASH" ] || falhar "o Node baixado nao confere com o SHA-256 publicado"
  mkdir -p "$TMP/node"
  tar -xzf "$TMP/$NOME" -C "$TMP/node"
  rm -rf "$NODEDIR"
  mv "$TMP/node/${NOME%.tar.gz}" "$NODEDIR"
  NODE="$NODEDIR/bin/node"
  node_serve "$NODE" || falhar "o Node portatil nao respondeu depois de instalado"
  feito "Node portatil em $NODEDIR"
fi

# --- 2. Codigo -------------------------------------------------------------
passo "Codigo do pje"
AQUI=""
case "$0" in
  */instalar.sh|instalar.sh) AQUI="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" ;;
esac
if [ -n "$AQUI" ] && [ -f "$AQUI/cli/pje.mjs" ]; then
  APP="$AQUI"
  feito "usando o clone deste diretorio: $APP"
else
  baixar "$REPO_TGZ" "$TMP/pje-cli.tar.gz"
  mkdir -p "$TMP/codigo"
  tar -xzf "$TMP/pje-cli.tar.gz" -C "$TMP/codigo"
  NOVO="$(find "$TMP/codigo" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [ -n "$NOVO" ] && [ -f "$NOVO/cli/pje.mjs" ] || falhar "o pacote baixado nao tem cli/pje.mjs"
  # So o `app` e trocado: a sessao e o config moram fora dele.
  rm -rf "$APP"
  mv "$NOVO" "$APP"
  feito "codigo em $APP"
fi

# --- 3. Comando pje --------------------------------------------------------
passo "Comando pje"
mkdir -p "$BIN"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE" "$APP/cli/pje.mjs" > "$BIN/pje"
chmod +x "$BIN/pje"
"$BIN/pje" ajuda >/dev/null 2>&1 || falhar "o comando pje nao respondeu"
feito "pje em $BIN/pje"

# --- 4. Skill --------------------------------------------------------------
passo "Skill do Claude Code"
[ -f "$APP/cli/skill/pje-autos/SKILL.md" ] || falhar "a skill nao veio no pacote"
rm -rf "$SKILL"
mkdir -p "$(dirname "$SKILL")"
cp -R "$APP/cli/skill/pje-autos" "$SKILL"
feito "skill pje-autos em $SKILL"

# --- 5. PATH ---------------------------------------------------------------
passo "PATH"
case ":$PATH:" in
  *":$BIN:"*) feito "$BIN ja esta no PATH" ;;
  *)
    RC="$HOME/.bashrc"
    [ "$(basename "${SHELL:-}")" = "zsh" ] && RC="$HOME/.zshrc"
    LINHA_PATH='export PATH="$HOME/.local/bin:$PATH"'
    if [ -f "$RC" ] && grep -qF "$LINHA_PATH" "$RC"; then
      feito "$RC ja tinha a linha do PATH"
    else
      printf '\n# pje (autos do PJe)\n%s\n' "$LINHA_PATH" >> "$RC"
      feito "adicionado ao $RC"
    fi
    aviso "Abra um terminal NOVO (ou: . $RC) para o comando pje existir."
    ;;
esac

# --- 6. O que fica por conta da pessoa ---------------------------------------
PENDENTE=""
if ! command -v pdftoppm >/dev/null 2>&1; then
  PENDENTE=1
  passo "Falta o Poppler (o Claude Code precisa dele para PDF com mais de 10 paginas)"
  if [ "$(uname -s)" = "Darwin" ]; then aviso "brew install poppler"
  else aviso "sudo apt install -y poppler-utils"; fi
fi
if [ "$(uname -s)" = "Linux" ]; then
  ACHOU=""
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$c" >/dev/null 2>&1 && ACHOU=1
  done
  if [ -z "$ACHOU" ]; then
    PENDENTE=1
    passo "Falta um Chrome do Linux (o pje login abre a janela de login nele)"
    aviso "wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
    aviso "sudo apt install -y ./google-chrome-stable_current_amd64.deb"
  fi
fi

cat <<EOF

Pronto.

No Claude Code, e so pedir, por exemplo:
  baixe os autos do processo 0000000-00.0000.0.00.0000 e me faca um relatorio

Na primeira vez ele pergunta o endereco do seu PJe e abre a janela de login.

Sem o Claude Code:
  pje login https://pje.SEUTRIBUNAL.jus.br/pje1grau
  pje baixar 0000000-00.0000.0.00.0000
  pje ajuda

Atualizar: rode a mesma linha da instalacao de novo.
Desinstalar: pje logout ; rm -rf "$BASE" "$BIN/pje" "$SKILL"
EOF
