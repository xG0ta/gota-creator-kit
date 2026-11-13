<#
  Se corre UNA sola vez en la laptop Windows (donde vive la firma de Legacy).
  Sube el certificado y su contraseña como «secretos» cifrados del repositorio
  en GitHub, para que el workflow de publicación firme el ZXP sin la laptop.

    ./tools/Export-LegacySigningSecret.ps1

  Necesita GitHub CLI (gh) con la sesión iniciada: `gh auth login`.
  Nada se escribe en el repositorio ni en Git: los valores van directo a gh
  por la entrada estándar y GitHub los guarda cifrados.
#>
$ErrorActionPreference = 'Stop'
$secretsDirectory = Join-Path $env:LOCALAPPDATA 'GotaCreatorKitBuild'
$certificate = Join-Path $secretsDirectory 'legacy-signing.p12'
$protectedPassword = Join-Path $secretsDirectory 'legacy-signing-password.txt'
if (-not (Test-Path -LiteralPath $certificate) -or -not (Test-Path -LiteralPath $protectedPassword)) {
  throw "No encontré la firma de Legacy en $secretsDirectory."
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'Instala GitHub CLI (winget install GitHub.cli) y corre gh auth login.'
}
$repo = 'xG0ta/gota-creator-kit'
$securePassword = Get-Content -LiteralPath $protectedPassword -Raw | ConvertTo-SecureString
$password = [System.Net.NetworkCredential]::new('', $securePassword).Password
[Convert]::ToBase64String([IO.File]::ReadAllBytes($certificate)) | gh secret set LEGACY_P12_BASE64 --repo $repo
if ($LASTEXITCODE -ne 0) { throw 'GitHub no aceptó el certificado.' }
$password | gh secret set LEGACY_P12_PASSWORD --repo $repo
if ($LASTEXITCODE -ne 0) { throw 'GitHub no aceptó la contraseña.' }
$password = $null
Write-Output 'Listo: GitHub ya puede firmar la Legacy. Puedes cerrar esta ventana.'
