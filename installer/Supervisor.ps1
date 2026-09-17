$ErrorActionPreference = "SilentlyContinue"

$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonw = Join-Path $installDir "Python\pythonw.exe"
$serviceScript = Join-Path $installDir "service\run_service.py"
$supervisorLog = Join-Path $installDir "supervisor.log"
$serviceProcess = $null

"Supervisor iniciado: $(Get-Date -Format o)" | Set-Content -LiteralPath $supervisorLog

while ($true) {
    $premiere = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -like "*Premiere*" }

    if ($premiere -and (-not $serviceProcess -or $serviceProcess.HasExited)) {
        if (Test-Path -LiteralPath $pythonw) {
            "Premiere detectado; iniciando motor: $(Get-Date -Format o)" |
                Add-Content -LiteralPath $supervisorLog
            $serviceProcess = Start-Process `
                -FilePath $pythonw `
                -ArgumentList "`"$serviceScript`"" `
                -WorkingDirectory $installDir `
                -WindowStyle Hidden `
                -PassThru
            Start-Sleep -Seconds 2
            if ($serviceProcess.HasExited) {
                "El motor se cerro con codigo $($serviceProcess.ExitCode): $(Get-Date -Format o)" |
                    Add-Content -LiteralPath $supervisorLog
                $serviceProcess = $null
                Start-Sleep -Seconds 10
            }
        }
        else {
            "No se encontro Python en $pythonw" |
                Add-Content -LiteralPath $supervisorLog
        }
    }

    if (-not $premiere -and $serviceProcess -and -not $serviceProcess.HasExited) {
        "Premiere cerrado; deteniendo motor: $(Get-Date -Format o)" |
            Add-Content -LiteralPath $supervisorLog
        Stop-Process -Id $serviceProcess.Id -Force -ErrorAction SilentlyContinue
        $serviceProcess = $null
    }

    Start-Sleep -Seconds 2
}
