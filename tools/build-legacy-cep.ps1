param(
  [string]$Output = (Join-Path $PSScriptRoot '..\dist\GotaCreatorKit-Legacy-Premiere-2021-a-2025.5-3.2.88.zxp')
)

$source = Join-Path $PSScriptRoot '..\legacy-cep'
$outputPath = [IO.Path]::GetFullPath($Output)
$staging = Join-Path ([IO.Path]::GetTempPath()) ('gota-cep-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $staging | Out-Null
try {
  Copy-Item -LiteralPath $source -Destination (Join-Path $staging 'com.xg0ta.gotacreatorkit.legacy') -Recurse
  New-Item -ItemType Directory -Force -Path (Split-Path $outputPath) | Out-Null
  if (Test-Path $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
  # Compress-Archive solo escribe .zip. Se genera uno temporal y se renombra
  # después a .zxp: ambos usan el formato ZIP internamente.
  $zipPath = [IO.Path]::ChangeExtension($outputPath, '.zip')
  if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $packageRoot = Join-Path $staging 'com.xg0ta.gotacreatorkit.legacy'
  $archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Get-ChildItem -LiteralPath $packageRoot -Recurse -File | ForEach-Object {
      # Las rutas ZXP siempre usan '/'. Esto evita que el archivo creado en
      # Windows sea rechazado por instalaciones de macOS.
      $relative = $_.FullName.Substring($packageRoot.Length + 1).Replace('\', '/')
      $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
      $sourceStream = [IO.File]::OpenRead($_.FullName)
      $targetStream = $entry.Open()
      try { $sourceStream.CopyTo($targetStream) } finally { $targetStream.Dispose(); $sourceStream.Dispose() }
    }
  } finally {
    $archive.Dispose()
  }
  Move-Item -LiteralPath $zipPath -Destination $outputPath -Force
  Write-Output "Paquete CEP creado: $outputPath"
  Write-Warning 'El ZIP/ZXP debe firmarse con ZXPSignCmd antes de distribuirlo fuera de modo de desarrollo.'
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
