param(
  [string]$ExpectedVersion = '3.3.8'
)

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$utf8 = [Text.UTF8Encoding]::new($false)
$checks = @(
  @{ Name = 'Panel moderno'; Path = (Join-Path $root 'plugin\manifest.json'); Pattern = '"version"\s*:\s*"([^"]+)"' },
  @{ Name = 'JavaScript del panel'; Path = (Join-Path $root 'plugin\main.js'); Pattern = 'CURRENT_VERSION\s*=\s*"([^"]+)"' },
  @{ Name = 'Motor local'; Path = (Join-Path $root 'service\app\main.py'); Pattern = 'APP_VERSION\s*=\s*"([^"]+)"' },
  @{ Name = 'Instalador Windows'; Path = (Join-Path $root 'installer\Program.cs'); Pattern = 'PackageVersion\s*=\s*"([^"]+)"' },
  @{ Name = 'Proyecto del instalador Windows'; Path = (Join-Path $root 'installer\AutoFrameInstaller.csproj'); Pattern = '<Version>([^<]+)</Version>' },
  @{ Name = 'Supervisor Windows'; Path = (Join-Path $root 'installer\Supervisor.ps1'); Pattern = 'version=([0-9]+\.[0-9]+\.[0-9]+)' },
  @{ Name = 'Instalador macOS'; Path = (Join-Path $root 'installer-mac\Instalar Gota Creator Kit.command'); Pattern = 'echo\s+"([^"]+)"\s+>\s+"\$INSTALL_DIR/installed-engine-version' },
  @{ Name = 'Supervisor macOS'; Path = (Join-Path $root 'installer-mac\Supervisor.sh'); Pattern = 'Gota Creator Kit ([0-9]+\.[0-9]+\.[0-9]+) supervisor' },
  @{ Name = 'Aplicación macOS'; Path = (Join-Path $root 'installer-mac\Instalar Gota Creator Kit.app\Contents\Info.plist'); Pattern = 'CFBundleShortVersionString</key><string>([^<]+)</string>' },
  @{ Name = 'Panel Legacy'; Path = (Join-Path $root 'legacy-cep\CSXS\manifest.xml'); Pattern = 'ExtensionBundleVersion="([^"]+)"' }
)

$mismatches = @()
foreach ($check in $checks) {
  $content = [IO.File]::ReadAllText($check.Path, $utf8)
  $match = [regex]::Match($content, $check.Pattern)
  if (-not $match.Success) {
    throw "No se pudo leer la versión de $($check.Name)."
  }
  if ($match.Groups[1].Value -ne $ExpectedVersion) {
    $mismatches += "$($check.Name): $($match.Groups[1].Value)"
  }
}

$projectText = [IO.File]::ReadAllText((Join-Path $root 'installer\AutoFrameInstaller.csproj'), $utf8)
$payloadMatch = [regex]::Match($projectText, 'EmbeddedResource Include="payload-([^\"]+)-clean\.zip"')
if (-not $payloadMatch.Success -or $payloadMatch.Groups[1].Value -ne $ExpectedVersion) {
  throw "El instalador Windows no apunta al payload $ExpectedVersion."
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

# Bloquea dos regresiones que ya llegaron a producción: texto UTF-8 leído
# como ANSI y subtítulos exportados a SVG (Premiere no admite ese formato).
foreach ($relativePath in @('plugin\main.js', 'plugin\manifest.json', 'service\app\main.py', 'installer\Program.cs')) {
  $content = [IO.File]::ReadAllText((Join-Path $root $relativePath), $utf8)
  if ($content -match '[\u00C3\u00C2\uFFFD]' -or $content -match '\u00E2(?:\u02DC|\u20AC)') {
    throw "No publiques: se detectó texto UTF-8 corrupto en $relativePath."
  }
}
$panelText = [IO.File]::ReadAllText((Join-Path $root 'plugin\main.js'), $utf8)
if ($panelText -match 'caption-svg|\.svgPath|caption-svgs|caption-mogrt|insertMogrt|Gota_Subtitulos_Editables') {
  throw 'No publiques: el panel todavía contiene una ruta antigua de subtítulos SVG/MOGRT.'
}

$macInstallerText = [IO.File]::ReadAllText((Join-Path $root 'installer-mac\Instalar Gota Creator Kit.command'), $utf8)
if ($macInstallerText -notmatch 'python-3\.12\.10-macos11\.pkg' -or
    $macInstallerText -notmatch 'http://127\.0\.0\.1:8765/health') {
  throw 'No publiques: el versionador alteró Python o la dirección local del instalador macOS.'
}

Write-Output "Versiones alineadas: Windows, macOS y Legacy = $ExpectedVersion"
