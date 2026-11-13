<#
  Firma el panel Legacy dentro de GitHub Actions con el firmador oficial de
  Adobe y los secretos LEGACY_P12_BASE64 / LEGACY_P12_PASSWORD. El
  certificado solo existe en el disco temporal del runner y se borra al final.
#>
param([Parameter(Mandatory = $true)][string]$Output)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:LEGACY_P12_BASE64) -or [string]::IsNullOrWhiteSpace($env:LEGACY_P12_PASSWORD)) {
  throw 'Faltan los secretos de firma de Legacy. Corre una vez tools/Export-LegacySigningSecret.ps1 en la laptop Windows.'
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$work = Join-Path $env:RUNNER_TEMP ('gota-sign-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  $signTool = Join-Path $work 'ZXPSignCmd.exe'
  Invoke-WebRequest -UseBasicParsing -OutFile $signTool `
    -Uri 'https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.103/win64/ZXPSignCmd.exe'
  $certificate = Join-Path $work 'legacy-signing.p12'
  [IO.File]::WriteAllBytes($certificate, [Convert]::FromBase64String($env:LEGACY_P12_BASE64))
  $outputPath = [IO.Path]::GetFullPath($Output)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outputPath) | Out-Null
  $temporary = Join-Path $work 'firmado.zxp'
  & $signTool -sign (Join-Path $root 'legacy-cep') $temporary $certificate $env:LEGACY_P12_PASSWORD
  if ($LASTEXITCODE -ne 0) { throw "Adobe no pudo firmar el paquete Legacy (código $LASTEXITCODE)." }
  & $signTool -verify $temporary
  if ($LASTEXITCODE -ne 0) { throw "La firma de Legacy no se pudo verificar (código $LASTEXITCODE)." }
  Move-Item -LiteralPath $temporary -Destination $outputPath -Force
  Write-Output "ZXP Legacy firmado: $outputPath"
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
