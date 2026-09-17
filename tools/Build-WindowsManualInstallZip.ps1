<#
  Crea el paquete para Premiere 2026 sin Creative Cloud. Reúne el instalador
  completo (motor local incluido) y el CCX del panel en un solo ZIP.
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
$modernCcxSource = Join-Path $Root 'installer-mac\payload\Gota Creator Kit.ccx'
$instructions = Join-Path $Root 'installer\INSTRUCCIONES MANUALES WINDOWS.txt'
$output = Join-Path $Root "outputs\GotaCreatorKit-$Version-Premiere-2026-sin-Creative-Cloud.zip"

foreach ($file in @($windowsInstaller, $modernCcxSource, $instructions)) {
  if (-not (Test-Path -LiteralPath $file)) {
    throw "No se puede crear el ZIP para Premiere 2026: falta $file"
  }
}

$temporary = "$output.rebuild"
if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }

$archive = [System.IO.Compression.ZipFile]::Open(
  $temporary, [System.IO.Compression.ZipArchiveMode]::Create
)
try {
  $files = @(
    @{ Source = $windowsInstaller; Entry = (Split-Path -Leaf $windowsInstaller) },
    @{ Source = $modernCcxSource; Entry = 'Gota Creator Kit.ccx' },
    @{ Source = $instructions; Entry = 'LEEME - Premiere 2026 sin Creative Cloud.txt' }
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
Write-Output "Paquete Premiere 2026 sin Creative Cloud listo: $output"
