$ErrorActionPreference = "Stop"

$productName = "Gota Creator Kit " + [char]0x2614
$installDir = Join-Path $env:LOCALAPPDATA "GotaCreatorKit"
$legacyInstallDir = Join-Path $env:LOCALAPPDATA "AutoFrameByGota"
$pythonDir = Join-Path $installDir "Python"
$pythonExe = Join-Path $pythonDir "python.exe"
$payload = Join-Path $PSScriptRoot "payload.zip"
$log = Join-Path $installDir "installer.log"
$popup = New-Object -ComObject WScript.Shell

try {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    "Instalacion $(Get-Date -Format o)" | Set-Content -LiteralPath $log

    # Detiene una version anterior antes de reemplazar sus archivos.
    Get-CimInstance Win32_Process |
        Where-Object {
            ($_.CommandLine -like "*AutoFrameByGota*service*run_service.py*") -or
            ($_.CommandLine -like "*AutoFrameByGota*Supervisor.ps1*") -or
            ($_.CommandLine -like "*GotaCreatorKit*service*run_service.py*") -or
            ($_.CommandLine -like "*GotaCreatorKit*Supervisor.ps1*")
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    Start-Sleep -Milliseconds 800

    # Extrae primero a una carpeta temporal. Así los registros que el motor aún
    # tenga abiertos no bloquean la actualización del resto de archivos.
    $stageDir = Join-Path $env:TEMP ("gota-creatorkit-" + [guid]::NewGuid().ToString("N"))
    Expand-Archive -LiteralPath $payload -DestinationPath $stageDir -Force
    & robocopy $stageDir $installDir /E /R:2 /W:1 /XF *.log /XD __pycache__ tests | Out-Null
    if ($LASTEXITCODE -gt 7) {
        throw "No se pudo actualizar el contenido del plugin (codigo $LASTEXITCODE)."
    }
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue

    # Conserva solamente la activación del usuario al migrar desde las rutas
    # antiguas; ningún script, motor o registro viejo acompaña la migración.
    $legacyService = Join-Path $legacyInstallDir "service"
    $newService = Join-Path $installDir "service"
    foreach ($licenseFile in @(
        "gota-license.json",
        "gota-first-run.json",
        "gota-cloud-license.json"
    )) {
        $oldLicense = Join-Path $legacyService $licenseFile
        $newLicense = Join-Path $newService $licenseFile
        if ((Test-Path -LiteralPath $oldLicense) -and -not (Test-Path -LiteralPath $newLicense)) {
            Copy-Item -LiteralPath $oldLicense -Destination $newLicense -Force
        }
    }

    if (-not (Test-Path -LiteralPath $pythonExe)) {
        $pythonInstaller = Join-Path $env:TEMP "autoframe-python.exe"
        Invoke-WebRequest `
            -Uri "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe" `
            -OutFile $pythonInstaller `
            -UseBasicParsing
        $pythonProcess = Start-Process `
            -FilePath $pythonInstaller `
            -ArgumentList @(
                "/quiet",
                "InstallAllUsers=0",
                "TargetDir=`"$pythonDir`"",
                "Include_pip=1",
                "Include_test=0",
                "Include_launcher=0",
                "PrependPath=0"
            ) `
            -Wait `
            -PassThru
        Remove-Item -LiteralPath $pythonInstaller -Force -ErrorAction SilentlyContinue
        if ($pythonProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $pythonExe)) {
            throw "Python no pudo instalarse (codigo $($pythonProcess.ExitCode))."
        }
    }

    $requirements = Join-Path $installDir "service\requirements-installer.txt"
    & $pythonExe -m pip install `
        --disable-pip-version-check `
        --no-warn-script-location `
        -r $requirements *>> $log
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudieron instalar las dependencias del motor."
    }

    $modelDir = Join-Path $installDir "models"
    $yunetModel = Join-Path $modelDir "face_detection_yunet_2023mar.onnx"
    $expectedModelSize = 232589
    $modelIsValid = (
        (Test-Path -LiteralPath $yunetModel) -and
        ((Get-Item -LiteralPath $yunetModel).Length -eq $expectedModelSize)
    )
    if (-not $modelIsValid) {
        New-Item -ItemType Directory -Path $modelDir -Force | Out-Null
        Invoke-WebRequest `
            -Uri "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx" `
            -OutFile $yunetModel `
            -UseBasicParsing
        if ((Get-Item -LiteralPath $yunetModel).Length -ne $expectedModelSize) {
            throw "El modelo facial 2.0 no se descargo correctamente."
        }
    }

    $supervisor = Join-Path $installDir "Supervisor.ps1"
    $launcher = Join-Path $installDir "Start-GotaSupervisor.vbs"
    if (-not (Test-Path -LiteralPath $launcher)) {
        throw "No se encontro el iniciador silencioso de Gota Creator Kit."
    }
    # wscript no crea una ventana de PowerShell al iniciar sesión. El
    # supervisor se queda oculto y solo inicia el motor al detectar Premiere.
    $runCommand = "wscript.exe //B `"$launcher`""
    New-ItemProperty `
        -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
        -Name "GotaCreatorKitSupervisor" `
        -Value $runCommand `
        -PropertyType String `
        -Force | Out-Null

    Get-CimInstance Win32_Process |
        Where-Object {
            ($_.CommandLine -like "*AutoFrameByGota*Supervisor.ps1*") -or
            ($_.CommandLine -like "*GotaCreatorKit*Supervisor.ps1*")
        } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    Start-Process `
        -FilePath "wscript.exe" `
        -ArgumentList "//B `"$launcher`"" `
        -WindowStyle Hidden

    $ccx = Get-ChildItem -LiteralPath $installDir -Filter "*.ccx" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $ccx) {
        throw "No se encontro el plugin de Premiere."
    }

    $downloads = $null
    try {
        $shellFolders = New-Object -ComObject Shell.Application
        $downloads = $shellFolders.NameSpace("shell:Downloads").Self.Path
    }
    catch {
        $downloads = Join-Path $env:USERPROFILE "Downloads"
    }
    if (-not (Test-Path -LiteralPath $downloads)) {
        New-Item -ItemType Directory -Path $downloads -Force | Out-Null
    }
    $visibleCcx = Join-Path $downloads "Gota Creator Kit - Plugin.ccx"
    Copy-Item -LiteralPath $ccx.FullName -Destination $visibleCcx -Force

    # UPIA es el instalador oficial de Adobe para CCX. Ejecutarlo aquí evita
    # depender de que Creative Cloud recargue una versión anterior al abrir el
    # archivo con doble clic.
    $upiaCandidates = @(
        (Join-Path $env:CommonProgramFiles "Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"),
        "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
    ) | Select-Object -Unique
    $upia = $upiaCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($upia) {
        & $upia /install $visibleCcx *>> $log
        if ($LASTEXITCODE -ne 0) {
            throw "Adobe no pudo actualizar el panel (codigo $LASTEXITCODE). Revisa: $log"
        }
    }
    else {
        Start-Process -FilePath $visibleCcx
    }

    # La nueva ruta evita que una instalación antigua vuelva a iniciar un
    # motor desactualizado. Se borra solo después de instalar correctamente.
    Remove-ItemProperty `
        -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
        -Name "AutoFrameByGota" `
        -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $legacyInstallDir) {
        Remove-Item -LiteralPath $legacyInstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    $popup.Popup(
        "El motor y el inicio automatico quedaron instalados.`n`nEl panel se actualizo con Adobe. Si no aparece al reiniciar Premiere, usa el archivo guardado en Descargas como:`nGota Creator Kit - Plugin.ccx",
        0,
        $productName,
        64
    ) | Out-Null
}
catch {
    $_ | Out-String | Add-Content -LiteralPath $log -ErrorAction SilentlyContinue
    $popup.Popup(
        "No se pudo completar la instalacion.`n`n$($_.Exception.Message)`n`nRegistro: $log",
        0,
        $productName,
        16
    ) | Out-Null
    exit 1
}
