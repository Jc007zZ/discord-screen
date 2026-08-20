[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$NodeVersion = '24.19.0'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$CacheRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '.cache'))
$NodeRoot = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'node-runtime'))

function Assert-InCache([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $prefix = $CacheRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Caminho fora do cache recusado: $full"
  }
}

if ($env:OS -ne 'Windows_NT') {
  throw 'Este bootstrap portatil foi feito somente para Windows.'
}

$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
switch ($architecture) {
  'x64' { $NodeArchitecture = 'x64' }
  'arm64' { $NodeArchitecture = 'arm64' }
  default { throw "Arquitetura do Windows nao suportada: $architecture" }
}

$NodeExe = Join-Path $NodeRoot 'node.exe'
$NpmCmd = Join-Path $NodeRoot 'npm.cmd'
if ((Test-Path -LiteralPath $NodeExe) -and (Test-Path -LiteralPath $NpmCmd)) {
  try {
    $installed = (& $NodeExe --version 2>$null).TrimStart('v')
    if ($installed -eq $NodeVersion) {
      Write-Host "  Node.js v$NodeVersion ja esta no cache."
      exit 0
    }
  } catch {
    # Runtime incompleto: baixa uma copia integra antes de substituir.
  }
}

New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null

$FileName = "node-v$NodeVersion-win-$NodeArchitecture.zip"
$BaseUrl = "https://nodejs.org/dist/v$NodeVersion"
$TemporaryRoot = Join-Path $CacheRoot ('.node-bootstrap-' + [guid]::NewGuid().ToString('N'))
$Archive = Join-Path $TemporaryRoot $FileName
$Checksums = Join-Path $TemporaryRoot 'SHASUMS256.txt'
$Expanded = Join-Path $TemporaryRoot 'expanded'

Assert-InCache $TemporaryRoot
Assert-InCache $NodeRoot

try {
  New-Item -ItemType Directory -Path $TemporaryRoot -Force | Out-Null

  Write-Host "  Baixando Node.js v$NodeVersion para Windows $NodeArchitecture..."
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$FileName" -OutFile $Archive
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHASUMS256.txt" -OutFile $Checksums

  $escapedName = [regex]::Escape($FileName)
  $checksumLine = Get-Content -LiteralPath $Checksums | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+$escapedName$" } | Select-Object -First 1
  if (-not $checksumLine) {
    throw 'O arquivo oficial de checksums nao contem o pacote baixado.'
  }

  $ExpectedHash = ($checksumLine -split '\s+')[0].ToUpperInvariant()
  $ActualHash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($ActualHash -ne $ExpectedHash) {
    throw 'O checksum do Node.js nao confere. O download foi descartado.'
  }

  Write-Host '  Download verificado. Extraindo...'
  Expand-Archive -LiteralPath $Archive -DestinationPath $Expanded -Force

  $ExtractedRoot = Join-Path $Expanded "node-v$NodeVersion-win-$NodeArchitecture"
  if (-not (Test-Path -LiteralPath (Join-Path $ExtractedRoot 'node.exe'))) {
    throw 'O pacote extraido nao contem node.exe.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $ExtractedRoot 'npm.cmd'))) {
    throw 'O pacote extraido nao contem npm.cmd.'
  }

  if (Test-Path -LiteralPath $NodeRoot) {
    Remove-Item -LiteralPath $NodeRoot -Recurse -Force
  }
  Move-Item -LiteralPath $ExtractedRoot -Destination $NodeRoot

  Write-Host "  Node.js portatil pronto em .cache\node-runtime."
} finally {
  if (Test-Path -LiteralPath $TemporaryRoot) {
    Assert-InCache $TemporaryRoot
    Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
