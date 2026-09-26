#!/bin/bash

# launchd mantiene este proceso durante la sesión del usuario. Mantener el
# motor disponible evita depender del nombre interno de Premiere, que cambia
# entre versiones de macOS y hacía que el panel no pudiera validar licencias.
set -u

INSTALL_DIR="$HOME/Library/Application Support/GotaCreatorKit"
PYTHON_BIN="$INSTALL_DIR/venv/bin/python"
SERVICE_SCRIPT="$INSTALL_DIR/service/run_service.py"
SUPERVISOR_LOG="$INSTALL_DIR/supervisor.log"
SUPERVISOR_ERROR_LOG="$INSTALL_DIR/supervisor-error.log"

# Los diagnósticos viven en la raíz de la instalación, junto a installer.log
# y supervisor.log. Así el usuario no tiene que buscar dentro del ZIP de
# Descargas ni dentro de una copia temporal del motor.
export GOTA_LOG_DIR="$INSTALL_DIR"
# Se crea al arrancar, incluso antes de que FastAPI reciba el primer análisis.
# Así siempre existe una ruta comprobable de diagnóstico en macOS.
: >> "$INSTALL_DIR/silence-diagnostics.log" 2>/dev/null || true
{
  printf '=== Gota Creator Kit 3.3.3 supervisor ===\n'
  printf 'started=%s; pid=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$"
} >> "$SUPERVISOR_LOG" 2>/dev/null || true
trap 'code=$?; printf "[%s] version=3.3.3 exit=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" >> "$SUPERVISOR_ERROR_LOG" 2>/dev/null || true' EXIT

if [ ! -x "$PYTHON_BIN" ] || [ ! -f "$SERVICE_SCRIPT" ]; then
  echo "El motor de Gota Creator Kit no está instalado correctamente."
  exit 1
fi

cd "$INSTALL_DIR" || exit 1
printf 'service_started=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SUPERVISOR_LOG" 2>/dev/null || true
"$PYTHON_BIN" "$SERVICE_SCRIPT"
code=$?
printf 'service_exited=%s; code=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" >> "$SUPERVISOR_LOG" 2>/dev/null || true
exit "$code"
