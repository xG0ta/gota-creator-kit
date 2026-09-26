$ErrorActionPreference = "Stop"

$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonw = Join-Path $installDir "Python\pythonw.exe"
$serviceScript = Join-Path $installDir "service\run_service.py"
$supervisorLog = Join-Path $installDir "supervisor.log"
$supervisorErrorLog = Join-Path $installDir "supervisor-error.log"
$serviceProcess = $null

@(
    "=== Gota Creator Kit supervisor ===",
    "started=$(Get-Date -Format o)",
    "script=$($MyInvocation.MyCommand.Path)",
    "script_hash=$((Get-FileHash -LiteralPath $MyInvocation.MyCommand.Path -Algorithm SHA256).Hash)"
) | Add-Content -LiteralPath $supervisorLog

try {
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
}
catch {
    "[$(Get-Date -Format o)] version=3.3.3`n$($_ | Out-String)" |
        Add-Content -LiteralPath $supervisorErrorLog
    exit 1
}
