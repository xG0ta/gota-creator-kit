[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version,
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Set-VersionInFile {
  param([string]$Path, [string]$Pattern, [string]$Replacement)
  $text = Get-Content -LiteralPath $Path -Raw
  if (-not [regex]::IsMatch($text, $Pattern)) {
    throw "No se encontró el marcador de versión esperado en $Path"
  }
  $updated = [regex]::Replace($text, $Pattern, $Replacement)
  if ($updated -ne $text) {
    [IO.File]::WriteAllText($Path, $updated, [Text.UTF8Encoding]::new($false))
  }
}

Set-VersionInFile (Join-Path $Root 'plugin\manifest.json') '("version"\s*:\s*")\d+\.\d+\.\d+("\s*,)' "`${1}$Version`${2}"
Set-VersionInFile (Join-Path $Root 'plugin\main.js') '(const CURRENT_VERSION\s*=\s*")\d+\.\d+\.\d+(";)' "`${1}$Version`${2}"
Set-VersionInFile (Join-Path $Root 'service\app\main.py') '(APP_VERSION\s*=\s*")\d+\.\d+\.\d+(")' "`${1}$Version`${2}"
Set-VersionInFile (Join-Path $Root 'installer\Program.cs') '(PackageVersion\s*=\s*")\d+\.\d+\.\d+(")' "`${1}$Version`${2}"
Set-VersionInFile (Join-Path $Root 'installer\AutoFrameInstaller.csproj') '(<Version>)\d+\.\d+\.\d+(</Version>)' "`${1}$Version`${2}"
Set-VersionInFile (Join-Path $Root 'installer\AutoFrameInstaller.csproj') '(EmbeddedResource Include="payload-)\d+\.\d+\.\d+(-clean\.zip")' "`${1}$Version`${2}"
Set-VersionInFile (Join-Path $Root 'installer\Supervisor.ps1') '(version=)\d+\.\d+\.\d+' "`${1}$Version"
Set-VersionInFile (Join-Path $Root 'installer-mac\Supervisor.sh') '(Gota Creator Kit )\d+\.\d+\.\d+( supervisor)' "`${1}$Version`${2}"
Set-VersionInFile (Join-Path $Root 'installer-mac\Supervisor.sh') '(version=)\d+\.\d+\.\d+' "`${1}$Version"
$macInstaller = Join-Path $Root 'installer-mac\Instalar Gota Creator Kit.command'
Set-VersionInFile $macInstaller '\d+\.\d+\.\d+' $Version
Set-VersionInFile (Join-Path $Root 'installer-mac\Instalar Gota Creator Kit.app\Contents\Info.plist') '(<key>CFBundleShortVersionString</key><string>)\d+\.\d+\.\d+(</string>)' "`${1}$Version`${2}"
Set-VersionInFile (Join-Path $Root 'legacy-cep\CSXS\manifest.xml') '(ExtensionBundleVersion=")\d+\.\d+\.\d+(")' "`${1}$Version`${2}"
Set-VersionInFile (Join-Path $Root 'legacy-cep\CSXS\manifest.xml') '(<Extension Id="com\.xg0ta\.gotacreatorkit\.legacy\.panel" Version=")\d+\.\d+\.\d+(")' "`${1}$Version`${2}"
Set-VersionInFile (Join-Path $Root 'tools\Assert-ReleaseVersions.ps1') "(ExpectedVersion = ')\d+\.\d+\.\d+(')" "`${1}$Version`${2}"

Write-Output "Versión fuente sincronizada en todos los componentes: $Version"
