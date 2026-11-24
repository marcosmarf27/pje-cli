# Instalador do `pje` para Windows: o CLI que baixa os autos do PJe e a skill
# que ensina o Claude Code a usa-lo.
#
# UMA LINHA, num PowerShell comum (nao precisa de administrador):
#
#   irm https://raw.githubusercontent.com/marcosmarf27/pje-cli/main/instalar.ps1 | iex
#
# Rodar de novo ATUALIZA: o codigo e a skill sao trocados, a sessao do PJe e o
# que ja foi baixado ficam.
#
# O QUE ELE FAZ, e nada alem disso (tudo dentro do perfil do usuario):
#   1. Node.js 22.4+: usa o da maquina; sem ele, baixa um Node PORTATIL para
#      %LOCALAPPDATA%\tecjustica-pje\node, conferido pelo SHASUMS256 oficial.
#   2. o codigo (zip do repositorio publico) em %LOCALAPPDATA%\tecjustica-pje\app
#   3. o Poppler (pdftoppm), que o Claude Code exige para ler PDF com mais de 10
#      paginas -- versao FIXA e SHA-256 conferido
#   4. o comando `pje` (pje.cmd para PowerShell/cmd, `pje` para o bash)
#   5. a skill em %USERPROFILE%\.claude\skills\pje-autos
#   6. as pastas no PATH do USUARIO (nunca no da maquina)
#
# REGRAS DESTE ARQUIVO, cada uma ja custou um defeito:
# - TUDO dentro de `& { ... }`, e nenhum `exit`: com `irm | iex` o script roda NA
#   SESSAO de quem colou. Um `exit` fecha a janela antes de a pessoa ler o erro,
#   e um `$ErrorActionPreference` solto vaza para o terminal dela.
# - So ASCII: o Windows PowerShell 5.1 le .ps1 sem BOM como ANSI.
# - Nada de here-string (@" ... "@): exige o terminador na coluna zero e quebra
#   quando o arquivo chega em LF, que e como o GitHub o serve.
# - Compativel com o 5.1 (o PowerShell que vem no Windows): sem `&&`, sem `?:`,
#   sem `??`, e `Invoke-WebRequest` sempre com `-UseBasicParsing`.
# - O diretorio do clone so vale por $PSScriptRoot (rodando o ARQUIVO). Sob `iex`
#   ele e vazio, e o `Get-Location` -- a pasta onde a pessoa estava -- nunca e
#   tomado por um clone.

& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"   # a barra do 5.1 deixa o download 10x mais lento
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }

  $REPO_ZIP = "https://github.com/marcosmarf27/pje-cli/archive/refs/heads/main.zip"
  $NODE_SHAS = "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt"
  # Poppler para Windows (o build que o pdf2image recomenda). FIXO de proposito:
  # um "latest" sem conferencia instalaria qualquer coisa que aparecesse la.
  # O SHA-256 e o que o proprio GitHub publica para o arquivo da release.
  $POPPLER_URL = "https://github.com/oschwartz10612/poppler-windows/releases/download/v26.09.0-0/Release-26.09.0-0.zip"
  $POPPLER_SHA = "7a6f256a0ddf7536182246a5733331bf4677cbcc34f4663774947ad34556c8d0"

  $BASE   = Join-Path $env:LOCALAPPDATA "tecjustica-pje"
  $APP    = Join-Path $BASE "app"
  $BIN    = Join-Path $BASE "bin"
  $NODEDIR = Join-Path $BASE "node"
  $POPDIR = Join-Path $BASE "poppler"
  $SKILL  = Join-Path $env:USERPROFILE ".claude\skills\pje-autos"
  $TMP    = Join-Path $env:TEMP ("pje-instalar-" + [guid]::NewGuid().ToString("N").Substring(0, 8))

  function Write-Passo($t) { Write-Host ""; Write-Host "=> $t" -ForegroundColor Cyan }
  function Write-Feito($t) { Write-Host "   $t" -ForegroundColor Green }
  function Write-Aviso($t) { Write-Host "   $t" -ForegroundColor Yellow }

  function Get-Download($url, $destino) {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $destino
  }

  function Test-Sha256($arquivo, $esperado) {
    $h = (Get-FileHash -Algorithm SHA256 -Path $arquivo).Hash.ToLower()
    if ($h -ne $esperado.ToLower()) {
      throw ("o arquivo baixado nao confere (SHA-256 diferente do publicado): " + (Split-Path $arquivo -Leaf))
    }
  }

  # O tar.exe do Windows 10+ abre .zip e e muito mais rapido que o
  # Expand-Archive do 5.1 (o Poppler tem centenas de arquivos).
  function Expand-Zip($zip, $destino) {
    New-Item -ItemType Directory -Force -Path $destino | Out-Null
    $tar = Join-Path $env:SystemRoot "System32\tar.exe"
    if (Test-Path $tar) {
      & $tar -xf $zip -C $destino
      if ($LASTEXITCODE -eq 0) { return }
    }
    Expand-Archive -Path $zip -DestinationPath $destino -Force
  }

  # 22.4+: o `pje login` fala com o Chrome pelo WebSocket GLOBAL do Node, estavel
  # so a partir da 22.4.
  function Test-NodeServe($exe) {
    if (-not $exe -or -not (Test-Path $exe)) { return $false }
    try { $v = & $exe -e "process.stdout.write(process.versions.node)" } catch { return $false }
    if (-not $v) { return $false }
    $p = $v.Split(".")
    return ([int]$p[0] -gt 22) -or ([int]$p[0] -eq 22 -and [int]$p[1] -ge 4)
  }

  # PATH do USUARIO, direto no registro, e NAO por
  # [Environment]::SetEnvironmentVariable: ele le o valor JA EXPANDIDO e grava
  # como REG_SZ -- o `%USERPROFILE%\...WindowsApps` que o Windows poe ali vira
  # caminho fixo, e o tipo REG_EXPAND_SZ se perde para sempre. Aqui o valor e
  # lido CRU e gravado com o tipo que tinha.
  # PJE_INSTALAR_SEM_PATH=1 pula o registro (teste numa maquina ja configurada).
  # `$nome` existe para o teste exercitar ESTA funcao num valor descartavel.
  function Add-PathUsuario($pasta, $nome = "Path") {
    $env:Path = $env:Path + ";" + $pasta
    if ($env:PJE_INSTALAR_SEM_PATH -eq "1") { return $false }
    $chave = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    try {
      $cru = $chave.GetValue($nome, "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $tipo = [Microsoft.Win32.RegistryValueKind]::ExpandString
      if ($chave.GetValueNames() -contains $nome) { $tipo = $chave.GetValueKind($nome) }
      if (($cru -split ";") -contains $pasta) { return $false }
      $chave.SetValue($nome, (($cru.TrimEnd(";") + ";" + $pasta).TrimStart(";")), $tipo)
    } finally {
      $chave.Close()
    }
    # Avisa o Windows (WM_SETTINGCHANGE), senao o terminal aberto pelo Iniciar
    # so ve o PATH novo depois de sair e entrar na conta. Gravar uma variavel
    # pelo SetEnvironmentVariable e o jeito sem P/Invoke de disparar o aviso; ela
    # e APAGADA pelo registro, porque no PowerShell 7 o `$null` passado ao
    # SetEnvironmentVariable vira texto vazio e a variavel ficava (medido).
    [Environment]::SetEnvironmentVariable("PJE_INSTALAR_AVISO", "1", "User")
    $chave = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    try { $chave.DeleteValue("PJE_INSTALAR_AVISO", $false) } finally { $chave.Close() }
    return $true
  }

  Write-Host "Instalador do pje -- autos do PJe para o Claude Code"

  try {
    New-Item -ItemType Directory -Force -Path $BASE, $TMP | Out-Null
    $mudouPath = $false

    # --- 1. Node -------------------------------------------------------------
    Write-Passo "Node.js"
    $NODE = $null
    $doSistema = Get-Command node -ErrorAction SilentlyContinue
    if ($doSistema -and (Test-NodeServe $doSistema.Source)) {
      $NODE = $doSistema.Source
      Write-Feito "usando o Node da maquina: $NODE"
    } elseif (Test-NodeServe (Join-Path $NODEDIR "node.exe")) {
      $NODE = Join-Path $NODEDIR "node.exe"
      Write-Feito "usando o Node portatil ja instalado"
    } else {
      # PowerShell de 32 bits num Windows de 64 diz "x86" aqui e guarda o real
      # em PROCESSOR_ARCHITEW6432.
      $pa = $env:PROCESSOR_ARCHITECTURE
      if ($env:PROCESSOR_ARCHITEW6432) { $pa = $env:PROCESSOR_ARCHITEW6432 }
      $arq = switch ($pa) { "AMD64" { "x64" } "ARM64" { "arm64" } default { $null } }
      if (-not $arq) { throw "processador nao suportado: $pa (o Node 22 precisa de x64 ou ARM64)" }
      Write-Aviso "Node 22.4+ nao encontrado -- baixando um Node portatil (~30 MB, sem administrador)"
      $shas = (Invoke-WebRequest -UseBasicParsing -Uri $NODE_SHAS).Content
      if ($shas -is [byte[]]) { $shas = [Text.Encoding]::ASCII.GetString($shas) }
      # O nome e lido FORA do Where-Object: o $Matches de dentro dele nao e
      # garantido no escopo de quem chamou.
      $padrao = "^([0-9a-f]{64})\s+(node-v22\.\d+\.\d+-win-" + $arq + "\.zip)\s*$"
      $linha = ($shas -split "`n") | Where-Object { $_ -match $padrao } | Select-Object -First 1
      if (-not $linha -or -not ($linha -match $padrao)) { throw "nao achei o Node 22 para Windows $arq em nodejs.org" }
      $hash = $Matches[1]
      $nome = $Matches[2]
      $zip = Join-Path $TMP $nome
      Get-Download ($NODE_SHAS -replace "SHASUMS256\.txt$", $nome) $zip
      Test-Sha256 $zip $hash
      Expand-Zip $zip (Join-Path $TMP "node")
      $interna = Get-ChildItem (Join-Path $TMP "node") -Directory | Select-Object -First 1
      if (Test-Path $NODEDIR) { Remove-Item -Recurse -Force $NODEDIR }
      Move-Item $interna.FullName $NODEDIR
      $NODE = Join-Path $NODEDIR "node.exe"
      if (-not (Test-NodeServe $NODE)) { throw "o Node portatil nao respondeu depois de instalado" }
      Write-Feito ("Node portatil em " + $NODEDIR)
    }

    # --- 2. Codigo -----------------------------------------------------------
    Write-Passo "Codigo do pje"
    if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "cli\pje.mjs"))) {
      $APP = $PSScriptRoot
      Write-Feito "usando o clone deste diretorio: $APP"
    } else {
      $zip = Join-Path $TMP "pje-cli.zip"
      Get-Download $REPO_ZIP $zip
      Expand-Zip $zip (Join-Path $TMP "codigo")
      $novo = Get-ChildItem (Join-Path $TMP "codigo") -Directory | Select-Object -First 1
      if (-not $novo -or -not (Test-Path (Join-Path $novo.FullName "cli\pje.mjs"))) {
        throw "o pacote baixado nao tem cli\pje.mjs"
      }
      # So o `app` e trocado: a sessao (sessao.json), o perfil do Chrome e o
      # config moram em $BASE, fora dele, e sobrevivem a atualizacao.
      if (Test-Path $APP) { Remove-Item -Recurse -Force $APP }
      Move-Item $novo.FullName $APP
      Write-Feito "codigo em $APP"
    }
    $PJE = Join-Path $APP "cli\pje.mjs"

    # --- 3. Comando pje ------------------------------------------------------
    Write-Passo "Comando pje"
    New-Item -ItemType Directory -Force -Path $BIN | Out-Null
    # UM .cmd so: vale no cmd e no PowerShell e devolve o codigo de saida do
    # node. Um `pje.ps1` ao lado teria precedencia e esconderia defeitos.
    # ASCII porque o interpretador de lote nao entende BOM.
    Set-Content -Path (Join-Path $BIN "pje.cmd") -Encoding ASCII -Value @(
      "@echo off",
      ('"' + $NODE + '" "' + $PJE + '" %*')
    )
    Remove-Item (Join-Path $BIN "pje.ps1") -ErrorAction SilentlyContinue
    # Para o bash do Windows (Git Bash -- o shell do Claude Code): ele nao roda
    # um .cmd pelo nome curto. Sem extensao, LF e sem BOM, senao `/bin/sh^M`.
    $nodeSh = $NODE -replace "\\", "/"
    $pjeSh = $PJE -replace "\\", "/"
    [IO.File]::WriteAllText(
      (Join-Path $BIN "pje"),
      ("#!/bin/sh`n" + 'exec "' + $nodeSh + '" "' + $pjeSh + '" "$@"' + "`n"),
      (New-Object System.Text.UTF8Encoding $false)
    )
    if (Add-PathUsuario $BIN) { $mudouPath = $true }
    $teste = & (Join-Path $BIN "pje.cmd") ajuda 2>&1 | Select-Object -First 2
    if (-not ($teste -match "pje")) { throw "o comando pje nao respondeu: $teste" }
    Write-Feito "pje em $BIN"

    # --- 4. Skill ------------------------------------------------------------
    Write-Passo "Skill do Claude Code"
    $fonte = Join-Path $APP "cli\skill\pje-autos"
    if (-not (Test-Path (Join-Path $fonte "SKILL.md"))) { throw "a skill nao veio no pacote ($fonte)" }
    if (Test-Path $SKILL) { Remove-Item -Recurse -Force $SKILL }
    New-Item -ItemType Directory -Force -Path (Split-Path $SKILL) | Out-Null
    Copy-Item -Recurse $fonte $SKILL
    Write-Feito "skill pje-autos em $SKILL"

    # --- 5. Poppler ----------------------------------------------------------
    # POR ULTIMO e NAO FATAL: numa maquina de tribunal, proxy ou antivirus podem
    # barrar um zip cheio de .exe. Sem o Poppler o `pje` funciona e o Claude Code
    # le tudo, menos PDF com mais de 10 paginas -- nao e motivo para deixar a
    # pessoa sem o comando e sem a skill.
    Write-Passo "Leitor de PDF para o Claude Code (Poppler)"
    try {
      if (Get-Command pdftoppm -ErrorAction SilentlyContinue) {
        Write-Feito "pdftoppm ja disponivel"
      } else {
        $existente = $null
        if (Test-Path $POPDIR) { $existente = Get-ChildItem $POPDIR -Recurse -Filter pdftoppm.exe | Select-Object -First 1 }
        if (-not $existente) {
          Write-Aviso "baixando o Poppler (~44 MB) -- sem ele o Claude Code nao le PDF com mais de 10 paginas"
          $zip = Join-Path $TMP "poppler.zip"
          Get-Download $POPPLER_URL $zip
          Test-Sha256 $zip $POPPLER_SHA
          if (Test-Path $POPDIR) { Remove-Item -Recurse -Force $POPDIR }
          Expand-Zip $zip $POPDIR
          $existente = Get-ChildItem $POPDIR -Recurse -Filter pdftoppm.exe | Select-Object -First 1
          if (-not $existente) { throw "o pacote do Poppler nao tem pdftoppm.exe" }
        }
        if (Add-PathUsuario $existente.DirectoryName) { $mudouPath = $true }
        Write-Feito ("pdftoppm em " + $existente.DirectoryName)
      }
    } catch {
      Write-Aviso ("O Poppler nao foi instalado: " + $_.Exception.Message)
      Write-Aviso "O pje e a skill estao prontos; so PDF com mais de 10 paginas fica sem leitura."
      Write-Aviso "Rode a linha da instalacao de novo mais tarde (ou numa rede sem bloqueio)."
    }

    # --- Fim -----------------------------------------------------------------
    Write-Host ""
    Write-Host "Pronto." -ForegroundColor Green
    Write-Host ""
    if ($mudouPath) {
      Write-Aviso "Feche e abra o terminal (e o Claude Code) para o PATH novo valer."
      Write-Host ""
    }
    @(
      "No Claude Code, e so pedir, por exemplo:",
      "  baixe os autos do processo 0000000-00.0000.0.00.0000 e me faca um relatorio",
      "",
      "Na primeira vez ele pergunta o endereco do seu PJe e abre a janela de login.",
      "",
      "Sem o Claude Code:",
      "  pje login https://pje.SEUTRIBUNAL.jus.br/pje1grau",
      "  pje baixar 0000000-00.0000.0.00.0000",
      "  pje ajuda",
      "",
      "Atualizar: rode a mesma linha da instalacao de novo.",
      "Desinstalar: pje logout, e apague $BASE e $SKILL"
    ) | ForEach-Object { Write-Host $_ }
  } catch {
    Write-Host ""
    Write-Host ("   A instalacao parou: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host "   Rode o mesmo comando de novo; o que ja foi feito e reaproveitado." -ForegroundColor Red
  } finally {
    Remove-Item -Recurse -Force $TMP -ErrorAction SilentlyContinue
  }
}
