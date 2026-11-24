---
name: pje-autos
description: Baixa os autos de processos do PJe pelo comando `pje` (login do próprio usuário, numa janela do Chrome) e analisa as peças — relatório, resumo, linha do tempo, pedidos e defesa, decisões, situação atual, o que falta. Use SEMPRE que o usuário mandar um número de processo no formato CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO) ou uma planilha/lista de processos, pedir para "baixar os autos", "ler", "analisar" ou "resumir o processo", "fazer um relatório do processo", perguntar "o que aconteceu nesse processo", ou falar em "pje login" ou em sessão do PJe expirada. NÃO use para peticionar, assinar, movimentar ou etiquetar no PJe (o comando só lê), nem para o PJe KZ (endereço com `pjekz`, como o do TRT2), que ele não suporta.
---

# Autos do PJe com o comando `pje`

O `pje` entra no PJe com o login do próprio usuário — uma janela do Chrome em
que ele entra como sempre — e baixa as peças de cada processo para uma pasta.
Ele **só lê**, e fala só com o PJe: nada passa por servidor de terceiros.

## 1. Chamar o comando

Use sempre o **caminho completo**: logo depois da instalação o PATH do terminal
ainda não foi atualizado.

| Onde | Comando |
|---|---|
| Windows, ferramenta Bash (Git Bash) | `"$LOCALAPPDATA/tecjustica-pje/bin/pje"` |
| Windows, ferramenta PowerShell | `& "$env:LOCALAPPDATA\tecjustica-pje\bin\pje.cmd"` |
| WSL, Linux, macOS | `~/.local/bin/pje` |

Daqui em diante, `pje` quer dizer esse caminho.

Se o arquivo não existir, o comando não está instalado. Diga isso ao usuário e
ofereça a instalação — e só rode com o OK dele:

- Windows (PowerShell): `irm https://raw.githubusercontent.com/marcosmarf27/pje-cli/main/instalar.ps1 | iex`
- WSL, Linux, macOS: `curl -fsSL https://raw.githubusercontent.com/marcosmarf27/pje-cli/main/instalar.sh | sh`

## 2. A sessão

```
pje status
```

- `estado ....... VIVA` → vá ao passo 3.
- `base ......... (não definida` → **primeira vez**: pergunte o endereço do PJe.
- `expirada` ou `nenhuma sessão` → login.

### Primeira vez: o endereço do PJe

Pergunte: *"Qual é o endereço do PJe que você usa? É o que aparece na barra do
navegador até o primeiro pedaço depois do domínio."* Exemplos:
`https://pje.tjce.jus.br/pje1grau` (TJCE, 1º grau),
`https://pje1g.trf5.jus.br/pje` (TRF5, 1º grau).

**Não deduza pelo número do processo**: o mesmo tribunal tem endereços
diferentes por grau, e alguns têm mais de uma instalação.

### Login — sempre pela janela, em segundo plano

Bash, com `run_in_background: true` (no WSL, Linux ou macOS, troque o caminho
por `~/.local/bin/pje`):

```bash
mkdir -p ~/autos-pje && "$LOCALAPPDATA/tecjustica-pje/bin/pje" login <ENDERECO> > ~/autos-pje/login.log 2>&1; echo "SAIDA=$?" >> ~/autos-pje/login.log
```

PowerShell, com `run_in_background: true`:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\autos-pje" | Out-Null; & "$env:LOCALAPPDATA\tecjustica-pje\bin\pje.cmd" login <ENDERECO> *> "$env:USERPROFILE\autos-pje\login.log"; "SAIDA=$LASTEXITCODE" | Add-Content "$env:USERPROFILE\autos-pje\login.log"
```

`<ENDERECO>` só na primeira vez; depois, `pje login` sozinho.

Diga ao usuário **só isto**: *"Abri o PJe numa janela do Chrome. Faça o login
lá, do jeito de sempre, que eu sigo sozinho."*

- O comando espera até 10 minutos e termina sozinho quando o login fecha.
  Espere a notificação da tarefa; não fique consultando com `sleep`.
- `SAIDA=0` → confira com `pje status` (VIVA) e siga.
- `SAIDA=2` → a janela foi fechada ou passou o tempo. Ofereça de novo.
- Se o log disser que **a tela de login voltou**: o PJe está aberto e logado
  noutro navegador, e ele não aceita duas sessões. Peça para fechar lá e logar
  de novo na janela.
- **Nunca** peça CPF, senha ou código ao usuário, e nunca o mande ao DevTools
  ("Copy as cURL"). Só se o Chrome não abrir de jeito nenhum (o log diz que
  "o navegador não abriu a porta de depuração", coisa de política da
  máquina), a alternativa é ele mesmo rodar `pje login --sessao-atual` no
  terminal e seguir as instruções que aparecem.
- No WSL, o login precisa de um Chrome do Linux. O Chrome do Windows não serve.

## 3. Baixar

```
pje baixar <CNJ> [<CNJ> ...]
pje baixar --lista "<arquivo>"
```

- `--lista` aceita **planilha** (.xlsx, .ods, .xls), da qual os números saem de
  qualquer coluna, com o dígito verificador conferido, ou **texto** (.txt,
  .csv), com um número por linha. Repasse ao usuário o que o comando disser
  sobre números com dígito errado.
- Destino: `~/autos-pje/processo-<CNJ>/` (no Windows,
  `%USERPROFILE%\autos-pje\...`). Só use `--destino` se o usuário pedir.
- Um a três processos: pode rodar em primeiro plano (timeout de 10 min). Mais
  que isso: em segundo plano, com log, e relate no fim.
- Rodar de novo no mesmo processo busca **só o que apareceu depois**.
  `pje atualizar` faz isso para todos os processos do destino.
- O comando fala com **um PJe por vez**, o do login. Pelo `J.TR` do número
  (`8.06` = TJCE, `4.05` = TRF5), avise se algum processo é de outro tribunal:
  para ele é preciso `pje login <outro endereço>`.
- Não aumente `--concorrencia`.

| Saída | Significado | O que fazer |
|---|---|---|
| 0 | tudo baixado | seguir |
| 3 | concluído, com peças de fora | relatar (seção 6) |
| 2 | a sessão caiu no meio | login e **repetir o mesmo comando** (o que já veio não é baixado de novo) |
| 1 | erro de uso | ler a mensagem |

## 4. O que vem na pasta

```
processo-<CNJ>/
  LEIA-ME.md    convenções e limites do pacote
  indice.txt    ficha do processo (classe, órgão, partes, advogados,
                segredo de justiça) + uma linha por peça
  indice.json   o mesmo, para programa
  midias.json   gravações de audiência que existem no PJe e não foram baixadas
  pecas/        NNN_Titulo-da-peca_ID.pdf  ou  .txt
```

- **NNN** é a ordem cronológica. **ID** é o id da peça no PJe.
- `.txt` é peça redigida no editor do PJe (despachos, decisões, certidões), com
  o texto já extraído. `.pdf` é anexo ou peça digitalizada.
- Cada linha do `indice.txt`: `NNN | arquivo | id | peça | tipo oficial |
  juntado em | juntado por | formato | páginas | tamanho`.
- Um salto na numeração (…002, 004…) é uma peça que não veio. Ela está listada
  no fim do `indice.txt`, com o motivo.
- O pacote traz as **peças**, não as movimentações. O estado atual se lê nas
  últimas peças juntadas.

## 5. Analisar

1. **Leia o `indice.txt` inteiro primeiro.** Ele já responde classe, órgão,
   partes, advogados, se há segredo de justiça, a cronologia das juntadas e o
   tamanho de cada peça.
2. **Escolha as peças pela pergunta.** Para um relatório geral: petição
   inicial, contestação ou defesa, réplica, decisões (tutela, saneamento),
   sentença, recursos e acórdão, e as últimas peças juntadas. Em processo
   grande, não leia tudo por padrão.
3. **Leia** com a ferramenta Read:
   - `.txt`: normalmente.
   - `.pdf` com **até 10 páginas**: sem `pages`. O PDF vai inteiro, e a peça
     digitalizada é lida pela imagem.
   - `.pdf` com **mais de 10 páginas**: com `pages`, em faixas de até 20
     (`"1-20"`, `"21-40"`). O número de páginas está no índice.
   - Isso exige o `pdftoppm` (Poppler). Se o Read disser que ele falta:
     - no Windows, rodar de novo a linha de instalação (ela instala o Poppler) e
       reabrir o Claude Code;
     - no WSL ou Linux, `sudo apt install -y poppler-utils`;
     - no macOS, `brew install poppler`.

     Enquanto isso, diga ao usuário quais peças ficaram sem leitura. **Nunca
     finja que leu.**
4. Em processo grande, anote os achados (já com a citação) num
   `processo-<CNJ>/analise.md` à medida que lê. O `pje` só mexe em `pecas/`, e
   esse arquivo sobrevive às atualizações.
5. **Cite sempre**: `(Título da peça, id 123456, fl. 7)`, em que `fl.` é a
   página dentro do PDF da peça. O id é obrigatório: há várias peças com o
   mesmo nome.
6. Afirme só o que está nas peças lidas. O que depende de peça não lida, ou que
   não veio, é dito como tal.

Roteiro de relatório, quando o pedido for genérico:

- **Identificação**: número, classe, órgão, partes e advogados.
- **Pedido e causa de pedir.**
- **Defesa.**
- **Decisões e atos relevantes**, em ordem cronológica.
- **Situação atual e próximo passo provável.**
- **Pontos de atenção**: prazos em curso, intimações pendentes, peças que não
  vieram.

## 6. O que ficou de fora — e por quê

| Motivo no log ou no índice | O que é | O que fazer |
|---|---|---|
| 403 | quase sempre peça **cancelada** (título riscado no PJe) | nada; a ausência está certa |
| precisa ser aberta no PJe | o PJe só monta certas peças depois de abertas | abrir o processo no PJe e rodar `pje baixar` de novo |
| mídia (`midias.json`) | gravação de audiência | ouvir no próprio PJe |
| não foi encontrado nesta instância | tribunal ou grau errado, dígito errado, sigilo sem acesso ou processo de outro sistema (no TJCE, o e-SAJ) | conferir o número e o endereço do login |
| 404 | o PJe não serve aquele documento | relatar |
| falha de rede ou de tempo | instabilidade | repetir o comando |

Relate **por processo** o que faltou e o motivo, nunca só "concluído com falhas".

## 7. Regras

- **Nunca** abra, mostre ou copie o `sessao.json` nem o cookie. Ele é uma
  credencial ao portador: quem o tiver entra no PJe como o usuário.
- O `pje` não peticiona, não assina e não movimenta. Para isso, o PJe.
- PJe KZ (endereço com `pjekz`): não suportado. Diga isso.
- `pje logout` apaga a sessão e o perfil do Chrome usado pelo `pje`.
