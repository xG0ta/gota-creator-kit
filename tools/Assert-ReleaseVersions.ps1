param(
  [string]$ExpectedVersion = '3.2.86'
)

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$checks = @(
  @{ Name = 'Panel moderno'; Path = (Join-Path $root 'plugin\manifest.json'); Pattern = '"version"\s*:\s*"([^"]+)"' },
  @{ Name = 'Instalador Windows'; Path = (Join-Path $root 'installer\Program.cs'); Pattern = 'PackageVersion\s*=\s*"([^"]+)"' },
  @{ Name = 'Instalador macOS'; Path = (Join-Path $root 'installer-mac\Instalar Gota Creator Kit.command'); Pattern = 'echo\s+"([^"]+)"\s+>\s+"\$INSTALL_DIR/installed-engine-version' },
  @{ Name = 'Panel Legacy'; Path = (Join-Path $root 'legacy-cep\CSXS\manifest.xml'); Pattern = 'ExtensionBundleVersion="([^"]+)"' }
)

$mismatches = @()
foreach ($check in $checks) {
  $content = Get-Content -LiteralPath $check.Path -Raw
  $match = [regex]::Match($content, $check.Pattern)
  if (-not $match.Success) {
    throw "No se pudo leer la versión de $($check.Name)."
  }
  if ($match.Groups[1].Value -ne $ExpectedVersion) {
    $mismatches += "$($check.Name): $($match.Groups[1].Value)"
  }
}

if ($mismatches.Count) {
  throw "No publiques: las ediciones no están alineadas con $ExpectedVersion. " + ($mismatches -join '; ')
}

# El instalador de macOS lleva un payload propio. Verificamos los archivos
# críticos para impedir que se publique un panel moderno con un motor antiguo.
foreach ($relativePath in @('service\run_service.py', 'service\silence.py', 'service\app\main.py')) {
  $sourceFile = Join-Path $root $relativePath
  $payloadFile = Join-Path $root (Join-Path 'installer-mac\payload' $relativePath)
  if (-not (Test-Path -LiteralPath $payloadFile)) {
    throw "Falta el archivo de motor macOS: $payloadFile"
  }
  $sourceHash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash
  $payloadHash = (Get-FileHash -LiteralPath $payloadFile -Algorithm SHA256).Hash
  if ($sourceHash -ne $payloadHash) {
    throw "El payload de macOS está desactualizado: $relativePath. Ejecuta tools\\Sync-MacPayload.ps1 antes de publicar."
  }
}

Write-Output "Versiones alineadas: Windows, macOS y Legacy = $ExpectedVersion"
