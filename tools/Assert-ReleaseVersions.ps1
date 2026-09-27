param(
  [string]$ExpectedVersion = '3.3.6'
)

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$checks = @(
  @{ Name = 'Panel moderno'; Path = (Join-Path $root 'plugin\manifest.json'); Pattern = '"version"\s*:\s*"([^"]+)"' },
  @{ Name = 'JavaScript del panel'; Path = (Join-Path $root 'plugin\main.js'); Pattern = 'CURRENT_VERSION\s*=\s*"([^"]+)"' },
  @{ Name = 'Motor local'; Path = (Join-Path $root 'service\app\main.py'); Pattern = 'APP_VERSION\s*=\s*"([^"]+)"' },
  @{ Name = 'Instalador Windows'; Path = (Join-Path $root 'installer\Program.cs'); Pattern = 'PackageVersion\s*=\s*"([^"]+)"' },
  @{ Name = 'Proyecto del instalador Windows'; Path = (Join-Path $root 'installer\AutoFrameInstaller.csproj'); Pattern = '<Version>([^<]+)</Version>' },
  @{ Name = 'Supervisor Windows'; Path = (Join-Path $root 'installer\Supervisor.ps1'); Pattern = 'version=([0-9]+\.[0-9]+\.[0-9]+)' },
  @{ Name = 'Instalador macOS'; Path = (Join-Path $root 'installer-mac\Instalar Gota Creator Kit.command'); Pattern = 'echo\s+"([^"]+)"\s+>\s+"\$INSTALL_DIR/installed-engine-version' },
  @{ Name = 'Supervisor macOS'; Path = (Join-Path $root 'installer-mac\Supervisor.sh'); Pattern = 'Gota Creator Kit ([0-9]+\.[0-9]+\.[0-9]+) supervisor' },
  @{ Name = 'AplicaciÃ³n macOS'; Path = (Join-Path $root 'installer-mac\Instalar Gota Creator Kit.app\Contents\Info.plist'); Pattern = 'CFBundleShortVersionString</key><string>([^<]+)</string>' },
  @{ Name = 'Panel Legacy'; Path = (Join-Path $root 'legacy-cep\CSXS\manifest.xml'); Pattern = 'ExtensionBundleVersion="([^"]+)"' }
)

$mismatches = @()
foreach ($check in $checks) {
  $content = Get-Content -LiteralPath $check.Path -Raw
  $match = [regex]::Match($content, $check.Pattern)
  if (-not $match.Success) {
    throw "No se pudo leer la versiÃ³n de $($check.Name)."
  }
  if ($match.Groups[1].Value -ne $ExpectedVersion) {
    $mismatches += "$($check.Name): $($match.Groups[1].Value)"
  }
}

$projectText = Get-Content -LiteralPath (Join-Path $root 'installer\AutoFrameInstaller.csproj') -Raw
$payloadMatch = [regex]::Match($projectText, 'EmbeddedResource Include="payload-([^\"]+)-clean\.zip"')
if (-not $payloadMatch.Success -or $payloadMatch.Groups[1].Value -ne $ExpectedVersion) {
  throw "El instalador Windows no apunta al payload $ExpectedVersion."
}

if ($mismatches.Count) {
  throw "No publiques: las ediciones no estÃ¡n alineadas con $ExpectedVersion. " + ($mismatches -join '; ')
}

# El instalador de macOS lleva un payload propio. Verificamos los archivos
# crÃ­ticos para impedir que se publique un panel moderno con un motor antiguo.
foreach ($relativePath in @('service\run_service.py', 'service\silence.py', 'service\app\main.py')) {
  $sourceFile = Join-Path $root $relativePath
  $payloadFile = Join-Path $root (Join-Path 'installer-mac\payload' $relativePath)
  if (-not (Test-Path -LiteralPath $payloadFile)) {
    throw "Falta el archivo de motor macOS: $payloadFile"
  }
  $sourceHash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash
  $payloadHash = (Get-FileHash -LiteralPath $payloadFile -Algorithm SHA256).Hash
  if ($sourceHash -ne $payloadHash) {
    throw "El payload de macOS estÃ¡ desactualizado: $relativePath. Ejecuta tools\\Sync-MacPayload.ps1 antes de publicar."
  }
}

Write-Output "Versiones alineadas: Windows, macOS y Legacy = $ExpectedVersion"
