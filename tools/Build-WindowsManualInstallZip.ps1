<#
  Crea un paquete de respaldo para Windows que reúne el instalador moderno
  y el ZXP Legacy firmado. Debe ejecutarse al final de la compilación,
  cuando ambos archivos ya existan.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$windowsInstaller = Join-Path $Root "outputs\GotaCreatorKit-$Version-Windows.exe"
$legacyZxp = Join-Path $Root "dist\GotaCreatorKit-Legacy-Premiere-2021-a-2025.5-$Version.zxp"
$modernCcxSource = Join-Path $Root 'installer-mac\payload\Gota Creator Kit.ccx'
$modernCcx = Join-Path $Root "outputs\GotaCreatorKit-Premiere-2026-$Version.ccx"
$instructions = Join-Path $Root 'installer\INSTRUCCIONES MANUALES WINDOWS.txt'
$output = Join-Path $Root "outputs\GotaCreatorKit-$Version-Windows-Instalacion-Manual.zip"

foreach ($file in @($windowsInstaller, $legacyZxp, $modernCcxSource, $instructions)) {
  if (-not (Test-Path -LiteralPath $file)) {
    throw "No se puede crear el ZIP manual: falta $file"
  }
}

# Publicar el CCX también como archivo individual: es la alternativa manual
# correcta para el panel UXP de Premiere 2026.
Copy-Item -LiteralPath $modernCcxSource -Destination $modernCcx -Force

$temporary = "$output.building"
if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }

$archive = [System.IO.Compression.ZipFile]::Open(
  $temporary, [System.IO.Compression.ZipArchiveMode]::Create
)
try {
  $files = @(
    @{ Source = $windowsInstaller; Entry = (Split-Path -Leaf $windowsInstaller) },
    @{ Source = $modernCcx; Entry = (Split-Path -Leaf $modernCcx) },
    @{ Source = $legacyZxp; Entry = (Split-Path -Leaf $legacyZxp) },
    @{ Source = $instructions; Entry = 'LEEME - instalacion manual Windows.txt' }
  )
  foreach ($file in $files) {
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, $file.Source, $file.Entry,
      [System.IO.Compression.CompressionLevel]::Optimal
    )
  }
} finally {
  $archive.Dispose()
}

Move-Item -LiteralPath $temporary -Destination $output -Force
Write-Output "Paquete de respaldo Windows listo: $output"
