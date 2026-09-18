param(
  [string]$Version = '3.2.88',
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($Output)) {
  $Output = Join-Path $root "dist\GotaCreatorKit-Legacy-Premiere-2021-a-2025.5-$Version.zxp"
}
$signTool = Join-Path $PSScriptRoot 'adobe-zxp\ZXPSignCmd.exe'
$secretsDirectory = Join-Path $env:LOCALAPPDATA 'GotaCreatorKitBuild'
$certificate = Join-Path $secretsDirectory 'legacy-signing.p12'
$protectedPassword = Join-Path $secretsDirectory 'legacy-signing-password.txt'

if (-not (Test-Path -LiteralPath $signTool)) {
  throw 'No se encontró el empaquetador oficial de Adobe para firmar Legacy.'
}
if (-not (Test-Path -LiteralPath $certificate) -or -not (Test-Path -LiteralPath $protectedPassword)) {
  throw 'No se encontró la firma de Legacy. No publiques un ZXP sin firmar.'
}

$securePassword = Get-Content -LiteralPath $protectedPassword -Raw | ConvertTo-SecureString
$password = [System.Net.NetworkCredential]::new('', $securePassword).Password
$outputPath = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outputPath) | Out-Null
$temporaryOutput = Join-Path (Split-Path -Parent $outputPath) ('.gota-sign-' + [guid]::NewGuid().ToString() + '.zxp')

& $signTool -sign (Join-Path $root 'legacy-cep') $temporaryOutput $certificate $password
if ($LASTEXITCODE -ne 0) {
  throw "Adobe no pudo firmar el paquete Legacy (código $LASTEXITCODE)."
}

& $signTool -verify $temporaryOutput
if ($LASTEXITCODE -ne 0) {
  throw "La firma de Legacy no se pudo verificar (código $LASTEXITCODE)."
}

# ZXPSignCmd no reemplaza de forma confiable un archivo existente. Firmar a un
# archivo temporal y sustituirlo al final evita publicar accidentalmente el ZIP
# sin firma que pudo quedar de una compilación anterior.
Move-Item -LiteralPath $temporaryOutput -Destination $outputPath -Force

Write-Output "ZXP Legacy firmado: $outputPath"

# Si ya se compiló el instalador moderno, preparar también el ZIP de respaldo.
# Así cada lanzamiento de Windows deja disponible el EXE y el ZXP firmado en un
# único archivo para los casos donde Creative Cloud no registre el panel solo.
$windowsInstaller = Join-Path $root "outputs\GotaCreatorKit-$Version-Windows.exe"
if (Test-Path -LiteralPath $windowsInstaller) {
  & (Join-Path $PSScriptRoot 'Build-WindowsManualInstallZip.ps1') -Version $Version -Root $root
} else {
  Write-Warning "Aún no existe $windowsInstaller. Ejecuta Build-WindowsManualInstallZip.ps1 después de compilar el EXE."
}
