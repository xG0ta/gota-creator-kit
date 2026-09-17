#!/bin/bash

# launchd mantiene este proceso durante la sesión del usuario. Mantener el
# motor disponible evita depender del nombre interno de Premiere, que cambia
# entre versiones de macOS y hacía que el panel no pudiera validar licencias.
set -u

INSTALL_DIR="$HOME/Library/Application Support/GotaCreatorKit"
PYTHON_BIN="$INSTALL_DIR/venv/bin/python"
SERVICE_SCRIPT="$INSTALL_DIR/service/run_service.py"

# Los diagnósticos viven en la raíz de la instalación, junto a installer.log
# y supervisor.log. Así el usuario no tiene que buscar dentro del ZIP de
# Descargas ni dentro de una copia temporal del motor.
export GOTA_LOG_DIR="$INSTALL_DIR"
# Se crea al arrancar, incluso antes de que FastAPI reciba el primer análisis.
# Así siempre existe una ruta comprobable de diagnóstico en macOS.
: >> "$INSTALL_DIR/silence-diagnostics.log" 2>/dev/null || true

if [ ! -x "$PYTHON_BIN" ] || [ ! -f "$SERVICE_SCRIPT" ]; then
  echo "El motor de Gota Creator Kit no está instalado correctamente."
  exit 1
fi

cd "$INSTALL_DIR" || exit 1
exec "$PYTHON_BIN" "$SERVICE_SCRIPT"
