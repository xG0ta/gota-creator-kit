<#!
  Copia el motor actual al instalador de macOS antes de crear un lanzamiento.
  La copia explícita evita que el ZIP incluya un service viejo cuando el panel
  y el instalador ya muestran una versión nueva.
#>
[CmdletBinding()]
param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}
$payloadRoot = Join-Path $Root 'installer-mac\payload'
$excludedNames = @('__pycache__', 'tests')
$excludedExtensions = @('.pyc', '.log', '.sqlite3')

foreach ($folderName in @('service', 'service_v2')) {
  $sourceRoot = Join-Path $Root $folderName
  $destinationRoot = Join-Path $payloadRoot $folderName
  if (-not (Test-Path -LiteralPath $sourceRoot)) {
    throw "No se encontró el motor fuente: $sourceRoot"
  }
  Get-ChildItem -LiteralPath $sourceRoot -File -Recurse | Where-Object {
    $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart([char[]]@('\','/'))
    $parts = $relative -split '[\\/]'
    ($parts | Where-Object { $excludedNames -contains $_ }).Count -eq 0 -and
    $excludedExtensions -notcontains $_.Extension.ToLowerInvariant()
  } | ForEach-Object {
    $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart([char[]]@('\','/'))
    $destination = Join-Path $destinationRoot $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
  }
}

Copy-Item -LiteralPath (Join-Path $Root 'installer-mac\Supervisor.sh') `
  -Destination (Join-Path $payloadRoot 'Supervisor.sh') -Force

Write-Output 'Motor de macOS sincronizado con el código fuente.'
