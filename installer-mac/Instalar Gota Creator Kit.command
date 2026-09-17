#!/bin/bash
set -euo pipefail

finish() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo
    echo "La instalación se detuvo con código $status."
    echo "Registro: $HOME/Library/Application Support/GotaCreatorKit/installer.log"
  fi
  read -r -p "Presiona Enter para cerrar esta ventana..."
  exit "$status"
}
trap finish EXIT

PRODUCT_NAME="Gota Creator Kit"
INSTALL_DIR="$HOME/Library/Application Support/GotaCreatorKit"
PAYLOAD_DIR="$(cd "$(dirname "$0")/payload" && pwd)"
LOG_FILE="$INSTALL_DIR/installer.log"
PYTHON_BIN=""
UPIA_BIN=""

mkdir -p "$INSTALL_DIR"
exec > >(tee "$LOG_FILE") 2>&1
echo "Instalando $PRODUCT_NAME..."

find_python() {
  for candidate in \
    "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3" \
    "/opt/homebrew/bin/python3" \
    "/usr/local/bin/python3" \
    "$(command -v python3 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      # El motor se distribuye y se prueba con Python 3.12. Aceptar una versión
      # más reciente puede hacer que pip intente compilar dependencias nativas
      # en Macs que no tienen Xcode, OpenSSL ni pkg-config.
      if "$candidate" -c 'import sys; raise SystemExit(sys.version_info[:2] != (3, 12))'; then
        PYTHON_BIN="$candidate"
        return 0
      fi
    fi
  done
  return 1
}

find_upia() {
  for candidate in \
    "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent" \
    "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/macOS/UnifiedPluginInstallerAgent" \
    "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent"; do
    if [ -x "$candidate" ]; then
      UPIA_BIN="$candidate"
      return 0
    fi
  done
  return 1
}

# Premiere puede estar instalado con nombres y rutas que dependen de la versión,
# idioma o Creative Cloud. No se bloquea la instalación del motor por esa
# comprobación: el CCX y Premiere validarán su compatibilidad por separado.
echo "Preparando el motor local de Gota Creator Kit..."

if ! find_python; then
  PYTHON_PKG="$TMPDIR/python-3.12.10-macos11.pkg"
  echo "Python 3.12 es necesario. Se descargará el instalador universal oficial."
  curl -L --fail \
    "https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg" \
    -o "$PYTHON_PKG"
  echo "macOS solicitará tu contraseña para instalar Python."
  sudo /usr/sbin/installer -pkg "$PYTHON_PKG" -target /
  rm -f "$PYTHON_PKG"
  find_python
fi

pkill -f "$INSTALL_DIR/service/run_service.py" 2>/dev/null || true
launchctl bootout "gui/$UID/com.xg0ta.gotacreatorkit" 2>/dev/null || true

# Cada actualización instala un motor limpio. Esto evita que un módulo viejo,
# caché de Python o archivos de pruebas de una edición anterior sobrevivan y
# apunten a la lógica antigua de licencias.
rm -rf "$INSTALL_DIR/service" "$INSTALL_DIR/service_v2"
ditto "$PAYLOAD_DIR/service" "$INSTALL_DIR/service"
ditto "$PAYLOAD_DIR/service_v2" "$INSTALL_DIR/service_v2"
cp "$PAYLOAD_DIR/Supervisor.sh" "$INSTALL_DIR/Supervisor.sh"
cp "$PAYLOAD_DIR/Gota Creator Kit.ccx" "$INSTALL_DIR/Gota Creator Kit.ccx"
chmod +x "$INSTALL_DIR/Supervisor.sh"
echo "3.2.87" > "$INSTALL_DIR/installed-engine-version.txt"
# El archivo existe desde la instalación. El motor irá agregando los eventos
# de análisis y de edición, sin obligar al usuario a buscar dentro del ZIP.
touch "$INSTALL_DIR/silence-diagnostics.log"
# Estos rastros existen incluso si una dependencia no logra instalarse. Así el
# usuario no queda buscando archivos que aún no pudo crear el servicio.
printf 'Motor preparado; instalando dependencias.\n' > "$INSTALL_DIR/service/autoframe-service.log"
: > "$INSTALL_DIR/supervisor.log"
: > "$INSTALL_DIR/supervisor-error.log"

CCX_FILE="$INSTALL_DIR/Gota Creator Kit.ccx"
if ! /usr/bin/unzip -tq "$CCX_FILE" >/dev/null; then
  echo "El paquete CCX está dañado. Vuelve a descargar el instalador."
  exit 1
fi
if ! /usr/bin/unzip -Z1 "$CCX_FILE" | /usr/bin/grep -qx "manifest.json"; then
  echo "El paquete CCX no contiene el manifiesto en su raíz."
  exit 1
fi
if /usr/bin/unzip -Z1 "$CCX_FILE" | /usr/bin/grep -q '\\'; then
  echo "El paquete CCX contiene rutas incompatibles con macOS."
  exit 1
fi

# La instalación anterior pudo interrumpirse durante pip. Recreamos el entorno
# completo para no heredar paquetes a medio compilar ni dependencias rotas.
rm -rf "$INSTALL_DIR/venv"
"$PYTHON_BIN" -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/python" -m pip install \
  --disable-pip-version-check \
  --only-binary=:all: \
  -r "$INSTALL_DIR/service/requirements-installer.txt"

mkdir -p "$INSTALL_DIR/models"
MODEL="$INSTALL_DIR/models/face_detection_yunet_2023mar.onnx"
if [ ! -f "$MODEL" ] || [ "$(stat -f%z "$MODEL")" -ne 232589 ]; then
  curl -L --fail \
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx" \
    -o "$MODEL"
fi

AGENT_DIR="$HOME/Library/LaunchAgents"
AGENT_FILE="$AGENT_DIR/com.xg0ta.gotacreatorkit.plist"
mkdir -p "$AGENT_DIR"
cat > "$AGENT_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.xg0ta.gotacreatorkit</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALL_DIR/Supervisor.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/supervisor.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/supervisor-error.log</string>
</dict>
</plist>
PLIST

launchctl bootstrap "gui/$UID" "$AGENT_FILE"
launchctl kickstart -k "gui/$UID/com.xg0ta.gotacreatorkit" 2>/dev/null || true

# No damos la instalación por terminada hasta que el motor local responda.
# Así se detecta aquí cualquier problema de Python o dependencias, en lugar
# de mostrar después un error genérico de conexión dentro de Premiere.
SERVICE_READY=0
for attempt in $(seq 1 30); do
  if /usr/bin/curl --silent --fail --max-time 2 "http://127.0.0.1:8765/health" \
    | /usr/bin/grep -q '"status":"ok"'; then
    SERVICE_READY=1
    break
  fi
  sleep 1
done
if [ "$SERVICE_READY" -ne 1 ]; then
  echo "El motor local no pudo iniciarse."
  echo "Revisa: $INSTALL_DIR/service/autoframe-service.log"
  echo "Y: $INSTALL_DIR/supervisor-error.log"
  exit 1
fi

cp "$INSTALL_DIR/Gota Creator Kit.ccx" "$HOME/Downloads/Gota Creator Kit - Plugin.ccx"

if ! find_upia; then
  echo
  echo "No se encontro el instalador UPIA de Adobe."
  echo "Actualiza o reinstala Creative Cloud Desktop y vuelve a intentarlo."
  echo "El archivo CCX quedo guardado en Descargas."
  read -r -p "Presiona Enter para finalizar..."
  exit 1
fi

echo
echo "Instalando el panel directamente con Adobe UPIA..."
echo "Requisito: Adobe Premiere Pro 25.6 o posterior."
set +e
"$UPIA_BIN" --version || true
"$UPIA_BIN" --install "$CCX_FILE" 2>&1 | tee "$INSTALL_DIR/upia-install.log"
UPIA_STATUS=$?
set -e
if [ "$UPIA_STATUS" -ne 0 ] || /usr/bin/grep -Eiq 'failed to install|status = -|installation failed' "$INSTALL_DIR/upia-install.log"; then
  if [ "$UPIA_STATUS" -eq 0 ]; then UPIA_STATUS=1; fi
  echo
  echo "Adobe UPIA no pudo instalar el panel. Codigo: $UPIA_STATUS"
  echo "Revisa: $INSTALL_DIR/upia-install.log"
  echo "También revisa: $HOME/Library/Application Support/Adobe/UPI/Log/"
  echo "Comprueba que Premiere 25.6+ y Creative Cloud se hayan abierto al menos una vez."
  echo "El archivo CCX quedó en Descargas. Se abrirá con Creative Cloud para un segundo intento."
  /usr/bin/open "$HOME/Downloads/Gota Creator Kit - Plugin.ccx" || true
  read -r -p "Presiona Enter para finalizar..."
  exit "$UPIA_STATUS"
fi

# Una copia UXP externa de una edición anterior puede abrirse antes que el
# CCX recién instalado. Se eliminan solo copias antiguas del mismo panel una
# vez que Adobe confirmó la instalación; nada de terceros se toca.
EXTERNAL_DIR="$HOME/Library/Application Support/Adobe/UXP/Plugins/External"
if [ -d "$EXTERNAL_DIR" ]; then
  for folder in "$EXTERNAL_DIR"/com.autoframe.faces.dev_*; do
    [ -d "$folder" ] || continue
    if ! /usr/bin/grep -q '"version"[[:space:]]*:[[:space:]]*"3.2.87"' "$folder/manifest.json" 2>/dev/null; then
      rm -rf "$folder"
      echo "Se eliminó copia externa anterior: $folder"
    fi
  done
fi

echo
echo "Instalación terminada."
echo "Creative Cloud abrirá la confirmación del plugin."
echo "Todo listo."
