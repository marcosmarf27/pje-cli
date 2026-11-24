# pje — os autos do PJe no seu computador, prontos para o Claude Code

O `pje` entra no PJe com **o seu login** e baixa as peças de um processo — ou
de uma planilha inteira de processos — para uma pasta, uma peça por arquivo, em
ordem cronológica e com índice. Junto vem uma **skill para o
[Claude Code](https://claude.com/claude-code)**: você pede *"baixe os autos e
me faça um relatório"* e ele faz o resto — login, download, leitura das peças
(inclusive as digitalizadas) e a análise, citando peça, id e folha.

## Instalar

### Windows

Abra o **PowerShell** (menu Iniciar → digite *PowerShell*) e cole:

```powershell
irm https://raw.githubusercontent.com/marcosmarf27/pje-cli/main/instalar.ps1 | iex
```

Não precisa de administrador. O instalador:

- usa o Node.js da máquina ou, se não houver o 22, baixa um **Node portátil**
  (conferido pelo SHA-256 oficial);
- instala o **Poppler**, que o Claude Code exige para ler PDF com mais de 10
  páginas (versão fixa, SHA-256 conferido);
- cria o comando `pje` e instala a skill em `%USERPROFILE%\.claude\skills\pje-autos`.

Tudo fica dentro do seu perfil (`%LOCALAPPDATA%\tecjustica-pje`). Depois,
**feche e abra o terminal e o Claude Code**.

### WSL, Linux ou macOS

```sh
curl -fsSL https://raw.githubusercontent.com/marcosmarf27/pje-cli/main/instalar.sh | sh
```

Ele instala o `pje` e a skill sem `sudo`, e avisa o que falta e precisa de
`sudo`: o Poppler (`sudo apt install -y poppler-utils`, ou `brew install
poppler` no macOS) e, no WSL ou Linux, um **Chrome do Linux** para a janela de
login. O Chrome do Windows não serve ao WSL.

> No Windows, prefira o Windows mesmo. O WSL funciona, mas tem login e sessão
> próprios, e precisa de um Chrome do Linux.

## Usar com o Claude Code

Abra o Claude Code numa pasta qualquer e peça:

> baixe os autos do processo 0000000-00.0000.0.00.0000 e me faça um relatório

Na primeira vez ele pergunta o **endereço do seu PJe** — o que aparece na barra
do navegador até o primeiro pedaço do caminho, como
`https://pje.tjce.jus.br/pje1grau` — e abre uma **janela do Chrome** para o
login. Você entra do jeito de sempre e ele segue sozinho. A sessão fica guardada
até o PJe expirá-la; aí ele abre a janela de novo.

Outros pedidos:

- *"faça a linha do tempo deste processo, com a peça de cada ato"*
- *"quais são os pedidos da inicial, e o que a contestação rebate?"*
- *"o réu já foi citado? mostre a peça"*
- *"resuma a sentença e diga se houve recurso"*
- *"baixe os processos desta planilha"* (um `.xlsx` do relatório do tribunal)

## Usar sem o Claude Code

| Comando | O que faz |
|---|---|
| `pje login https://pje.SEUTRIBUNAL.jus.br/pje1grau` | Abre a janela de login. Depois da primeira vez, basta `pje login`. |
| `pje baixar 0000000-00.0000.0.00.0000` | Baixa o processo. De novo no mesmo processo, busca só o que apareceu depois. |
| `pje baixar --lista planilha.xlsx` | Baixa todos os processos de uma planilha (.xlsx, .ods, .xls) ou de um .txt com um número por linha. |
| `pje atualizar` | Atualiza todos os processos já baixados. |
| `pje status` | A sessão está viva? O que já foi baixado? |
| `pje logout` | Apaga a sessão e o perfil do Chrome usado pelo `pje`. |
| `pje ajuda` | Todas as opções. |

## O que vem na pasta

Por padrão em `autos-pje`, dentro da sua pasta de usuário:

```
processo-0000000-00.0000.0.00.0000/
  LEIA-ME.md    convenções e limites
  indice.txt    ficha (classe, órgão, partes, advogados) + uma linha por peça
  indice.json   o mesmo, para programa
  midias.json   gravações de audiência que ficaram no PJe
  pecas/
    001_Peticao-Inicial_123456789.pdf
    002_Procuracao_123456790.pdf
    015_Decisao_123499999.txt
    ...
```

`NNN` é a ordem dos autos, e o número no fim é o id da peça no PJe. As peças
feitas no editor do PJe (despachos, decisões, certidões) vêm como `.txt`, já em
texto; o resto, em PDF. Um salto na numeração é uma peça que não veio, e o
motivo está no fim do `indice.txt`.

## Como funciona — e o que ele não faz

- **Login.** O `pje` abre o Chrome num **perfil separado** do seu (desde o
  Chrome 136, só assim um programa pode acompanhar a janela). Você faz o login
  ali. O `pje` nunca vê a sua senha: ele espera o login terminar e guarda a
  **sessão** (o cookie que o PJe deu ao navegador) em
  `%LOCALAPPDATA%\tecjustica-pje\sessao.json` (ou `~/.tecjustica-pje/` no
  Linux e no macOS).
- **A sessão vale como o seu login**: quem tiver esse arquivo entra no PJe como
  você. Não compartilhe a pasta, e use `pje logout` para apagá-la.
- **Leitura.** O `pje` usa as mesmas rotas internas que a tela do PJe usa
  (`/seam/resource/rest/pje-legacy/`). Ele só faz **leitura** (GET), baixa
  poucas peças por vez e recua quando o servidor pede para esperar.
- **Só lê.** Não peticiona, não assina, não movimenta, não etiqueta.
- **Fala só com o PJe.** A análise é feita pelo Claude Code, na sua conta.

## Onde funciona

- **Testado no TJCE** (1º grau).
- Deve funcionar nos outros tribunais com o **PJe 1.x** — o mesmo em que roda a
  extensão TecJustiça PJe —, mas não foi validado neles. Se testar no seu, conte
  numa issue.
- **Não funciona no PJe KZ** (endereço com `pjekz`, como o do TRT2), que não tem
  as rotas de que o `pje` depende. Ele avisa e para.
- Windows 10 ou 11, Linux ou macOS, com Google Chrome (no Windows, o Edge também
  serve).

## Problemas comuns

| Sintoma | Causa e saída |
|---|---|
| *"A tela de login voltou depois de você entrar"* | O PJe está aberto e logado noutro navegador, e ele não aceita duas sessões. Saia de lá e logue de novo na janela. |
| *"o navegador não abriu a porta de depuração"* | Uma política da máquina bloqueia o controle do Chrome. Alternativa: `pje login --sessao-atual`, que aproveita a sessão do seu navegador e explica o passo a passo. |
| Peça com **403** | Quase sempre é peça **cancelada** (o título aparece riscado no PJe). A ausência está certa. |
| *"precisa ser aberta no PJe"* | O PJe só monta certas peças depois de abertas. Abra o processo no PJe e rode o `pje baixar` de novo. |
| *"não foi encontrado nesta instância"* | Tribunal ou grau diferente do login, dígito errado, ou processo sigiloso sem acesso. No TJCE, também processo que ainda está no e-SAJ. |
| O Claude Code diz *"pdftoppm is not installed"* | Falta o Poppler. No Windows, rode a linha de instalação de novo e reabra o Claude Code. No Linux, `sudo apt install -y poppler-utils`. |
| *"pje não é reconhecido como comando"* | Abra um terminal novo (o PATH muda só nos terminais abertos depois da instalação). |

## Atualizar e desinstalar

- **Atualizar**: rode a mesma linha da instalação. A sessão e o que já foi
  baixado ficam.
- **Desinstalar no Windows**: `pje logout`, apague as pastas
  `%LOCALAPPDATA%\tecjustica-pje` e `%USERPROFILE%\.claude\skills\pje-autos`,
  e tire do PATH do usuário as duas entradas que começam por
  `%LOCALAPPDATA%\tecjustica-pje` (Configurações → *Editar as variáveis de
  ambiente da sua conta*).
- **Desinstalar no Linux ou macOS**: `pje logout`, e depois
  `rm -rf ~/.local/share/tecjustica-pje ~/.local/bin/pje ~/.claude/skills/pje-autos`.

## Licença e projeto

[AGPL-3.0-or-later](LICENSE). O `pje` faz parte do projeto **TecJustiça**, o mesmo
da extensão [TecJustiça PJe](https://github.com/marcosmarf27/pje-ia) para o
Chrome. Este repositório é gerado a partir do repositório principal do projeto:
problemas e sugestões, por **issue**.
