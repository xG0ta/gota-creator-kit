<#!
  Prepara los artefactos que consumen los instaladores de Windows y macOS.
  Se usa antes de publicar una versión global para que ambos sistemas lleven
  exactamente el mismo panel y motor local.
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

function Add-FilesToZip {
  param(
    [string]$Output,
    [array]$Files,
    [switch]$UnixPermissions
  )
  $temporary = "$Output.building"
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  $archive = [System.IO.Compression.ZipFile]::Open(
    $temporary, [System.IO.Compression.ZipArchiveMode]::Create
  )
  try {
    foreach ($file in $Files) {
      $entry = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, $file.Source, $file.Entry,
        [System.IO.Compression.CompressionLevel]::Optimal
      )
      # Zip creado desde Windows no conserva permisos POSIX. Sin este bit,
      # Finder muestra "no tienes los privilegios necesarios" al abrir un
      # .command o el ejecutable interno de una .app en macOS.
      if ($file.PSObject.Properties.Name -contains 'Executable' -and $file.Executable) {
        $entry.ExternalAttributes = -2115174400 # regular file + 0755 (0x81ED0000)
      }
    }
  } finally {
    $archive.Dispose()
  }
  if ($UnixPermissions) {
    # ZipArchive se ejecuta en Windows y deja "host OS = DOS" en el directorio
    # central. Archive Utility de macOS puede ignorar los bits 0755 si esa
    # marca permanece así. Se marca cada entrada como UNIX después de cerrar
    # el archivo, conservando los atributos externos que ya asignamos.
    $zipBytes = [IO.File]::ReadAllBytes($temporary)
    for ($index = 0; $index -le $zipBytes.Length - 4; $index++) {
      if ($zipBytes[$index] -eq 0x50 -and $zipBytes[$index + 1] -eq 0x4B -and
          $zipBytes[$index + 2] -eq 0x01 -and $zipBytes[$index + 3] -eq 0x02) {
        $zipBytes[$index + 5] = 0x03 # UNIX host OS en la cabecera central ZIP
      }
    }
    [IO.File]::WriteAllBytes($temporary, $zipBytes)
  }
  Move-Item -LiteralPath $temporary -Destination $Output -Force
}

function Get-CleanTreeEntries {
  param([string]$Folder, [string]$Prefix)
  Get-ChildItem -LiteralPath $Folder -File -Recurse | Where-Object {
    $_.FullName -notmatch '[\\/](__pycache__|tests)[\\/]' -and
    $_.Extension.ToLowerInvariant() -notin @('.pyc', '.log', '.sqlite3')
  } | ForEach-Object {
    $relative = $_.FullName.Substring($Folder.Length).TrimStart([char[]]@('\','/'))
    [pscustomobject]@{
      Source = $_.FullName
      Entry = "$Prefix/$($relative -replace '\\','/')"
    }
  }
}

& (Join-Path $PSScriptRoot 'Sync-MacPayload.ps1') -Root $Root
& (Join-Path $PSScriptRoot 'Assert-ReleaseVersions.ps1') -ExpectedVersion $Version

$pluginRoot = Join-Path $Root 'plugin'
$macPayload = Join-Path $Root 'installer-mac\payload'
$ccxPath = Join-Path $macPayload 'Gota Creator Kit.ccx'
$pluginEntries = Get-CleanTreeEntries -Folder $pluginRoot -Prefix '' | ForEach-Object {
  $_.Entry = $_.Entry.TrimStart('/'); $_
}
Add-FilesToZip -Output $ccxPath -Files $pluginEntries

$installerRoot = Join-Path $Root 'installer'
$windowsPayload = Join-Path $installerRoot "payload-$Version-clean.zip"
$windowsEntries = @(
  [pscustomobject]@{ Source = $ccxPath; Entry = 'Gota Creator Kit.ccx' },
  [pscustomobject]@{ Source = (Join-Path $installerRoot 'Start-GotaSupervisor.vbs'); Entry = 'Start-GotaSupervisor.vbs' },
  [pscustomobject]@{ Source = (Join-Path $installerRoot 'Supervisor.ps1'); Entry = 'Supervisor.ps1' }
)
$windowsEntries += Get-CleanTreeEntries -Folder (Join-Path $Root 'service') -Prefix 'service'
$windowsEntries += Get-CleanTreeEntries -Folder (Join-Path $Root 'service_v2') -Prefix 'service_v2'
Add-FilesToZip -Output $windowsPayload -Files $windowsEntries

$macEntries = @(
  [pscustomobject]@{
    Source = (Join-Path $Root 'installer-mac\INSTRUCCIONES PARA MAC.txt')
    Entry = 'INSTRUCCIONES PARA MAC.txt'
  },
  [pscustomobject]@{
    Source = (Join-Path $Root 'installer-mac\Instalar Gota Creator Kit.command')
    Entry = 'Instalar Gota Creator Kit.command'
    Executable = $true
  }
)
$macAppEntries = Get-CleanTreeEntries -Folder (Join-Path $Root 'installer-mac\Instalar Gota Creator Kit.app') -Prefix 'Instalar Gota Creator Kit.app' | ForEach-Object {
  if ($_.Entry -like '*/Contents/MacOS/*') {
    $_ | Add-Member -NotePropertyName Executable -NotePropertyValue $true
  }
  $_
}
$macEntries += $macAppEntries
$macEntries += Get-CleanTreeEntries -Folder $macPayload -Prefix 'payload'
# La app es autosuficiente: contiene una segunda copia interna del instalador
# y de payload. Esto evita errores de ruta cuando Finder abre la .app desde
# Descargas, una ubicación movida o una carpeta con nombre distinto.
$macEntries += [pscustomobject]@{
  Source = (Join-Path $Root 'installer-mac\Instalar Gota Creator Kit.command')
  Entry = 'Instalar Gota Creator Kit.app/Contents/Resources/Instalar Gota Creator Kit.command'
  Executable = $true
}
$macEntries += Get-CleanTreeEntries -Folder $macPayload -Prefix 'Instalar Gota Creator Kit.app/Contents/Resources/payload'
$macOutput = Join-Path $Root "outputs\GotaCreatorKit-$Version-macOS.zip"
Add-FilesToZip -Output $macOutput -Files $macEntries -UnixPermissions

Write-Output "Paquetes listos: $windowsPayload"
Write-Output "Paquete macOS listo: $macOutput"
