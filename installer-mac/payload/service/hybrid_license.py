"""Licencias remotas con respaldo temporal sin conexion y compatibilidad GCK1."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from service.offline_license import (
    OfflineLicenseError,
    activate_code as activate_signed_code,
    current_status as signed_status,
    remove_license as remove_signed_license,
)


CLOUD_STATE_FILE = Path(__file__).with_name("gota-cloud-license.json")
DEFAULT_API_URL = "https://bygota-creatorkit.djm4pf2v57.workers.dev"
DEFAULT_OFFLINE_TOLERANCE_HOURS = 72
LICENSE_DIAGNOSTIC_LOG = Path(__file__).with_name("license-connection.log")


def _api_url() -> str:
    """Return the only production licensing endpoint.

    Las primeras versiones permitían reemplazar esta dirección con una
    variable de entorno. Eso hacía que una configuración de pruebas olvidada
    sobreviviera a las actualizaciones y enviara el plugin a un servidor que
    ya no existe. Las versiones distribuidas no deben tener esa ambigüedad.
    """
    return DEFAULT_API_URL


def _cloud_call(path: str, body: dict) -> dict | None:
    base_url = _api_url()
    if not base_url:
        raise OfflineLicenseError(
            "El servicio de licencias en linea aun no esta configurado."
        )
    # Usamos curl del sistema primero tanto en Windows como en macOS. Esto usa
    # el almacén de certificados nativo y evita que el Python empaquetado
    # falle al validar certificados, proxies o IPv6 en otros equipos.
    curl = (
        shutil.which("curl.exe")
        or shutil.which("curl")
        or ("/usr/bin/curl" if Path("/usr/bin/curl").is_file() else None)
    )
    if curl:
        return _system_curl_cloud_call(curl, base_url, path, body)

    request = Request(
        f"{base_url}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": "GotaCreatorKit/3.2",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=8) as response:
            if response.status == 204:
                return None
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
            message = str(payload.get("detail") or f"Error {error.code}")
        except Exception:
            message = f"Error {error.code} al validar la licencia."
        raise OfflineLicenseError(message) from error
    except (URLError, TimeoutError, OSError) as error:
        try:
            LICENSE_DIAGNOSTIC_LOG.write_text(
                "transport=python-urlopen\n" +
                "detail=" + str(error).replace("\n", " | ")[-800:] + "\n",
                encoding="utf-8",
            )
        except OSError:
            pass
        raise OfflineLicenseError(
            "No se pudo conectar al servidor de licencias."
        ) from error


def _system_curl_cloud_call(curl: str, base_url: str, path: str, body: dict) -> dict | None:
    def run_curl(insecure: bool = False):
        command = [
            curl, "--silent", "--show-error", "--location",
            "--connect-timeout", "10", "--max-time", "25",
            "--retry", "2", "--retry-delay", "1",
            "--http1.1",
        ]
        # Algunos Macs conservan un almacén de certificados dañado o un proxy
        # escolar/empresarial. Solo después del intento seguro normal se usa
        # esta ruta de respaldo para poder validar la licencia.
        if insecure:
            command.append("--insecure")
        command.extend([
            "-X", "POST", f"{base_url}{path}",
            "-H", "content-type: application/json",
            "-H", "accept: application/json",
            "-H", "user-agent: GotaCreatorKit/3.2",
            "--data-binary", json.dumps(body),
        ])
        return subprocess.run(command, capture_output=True, text=True, check=False)

    def write_diagnostic(completed, used_fallback: bool):
        try:
            # No se guarda el código, token ni datos privados de la licencia.
            detail = completed.stderr.strip().replace("\n", " | ")[-800:]
            LICENSE_DIAGNOSTIC_LOG.write_text(
                "endpoint=" + f"{base_url}{path}" + "\n" +
                "returncode=" + str(completed.returncode) + "\n" +
                "fallback_tls=" + str(used_fallback).lower() + "\n" +
                "detail=" + detail + "\n",
                encoding="utf-8",
            )
        except OSError:
            pass

    try:
        completed = run_curl()
    except OSError as error:
        raise OfflineLicenseError("No se pudo conectar al servidor de licencias.") from error
    used_fallback = False
    if completed.returncode != 0 and sys.platform == "darwin":
        try:
            completed = run_curl(insecure=True)
            used_fallback = True
        except OSError:
            pass
    write_diagnostic(completed, used_fallback)
    text = completed.stdout.strip()
    if completed.returncode == 0:
        if not text:
            return None
        try:
            payload = json.loads(text)
            if isinstance(payload, dict) and payload.get("detail"):
                raise OfflineLicenseError(str(payload["detail"]))
            return payload
        except json.JSONDecodeError as error:
            raise OfflineLicenseError("El servidor devolvio una respuesta invalida.") from error
    try:
        payload = json.loads(text)
        message = str(payload.get("detail") or "No se pudo validar la licencia.")
    except (TypeError, ValueError, json.JSONDecodeError):
        detail = completed.stderr.strip().splitlines()[-1:] or []
        suffix = f" ({detail[0]})" if detail else ""
        message = f"No se pudo conectar al servidor de licencias{suffix}"
    raise OfflineLicenseError(message)


def _public(result: dict) -> dict:
    output = dict(result)
    output.pop("activationToken", None)
    return output


def _save_cloud_state(result: dict, device_id: str):
    state = {
        "deviceId": device_id,
        "activationToken": result["activationToken"],
        "license": _public(result),
        "checkedAt": int(time.time()),
    }
    CLOUD_STATE_FILE.write_text(
        json.dumps(state, indent=2), encoding="utf-8"
    )


def _load_cloud_state(device_id: str) -> dict | None:
    if not CLOUD_STATE_FILE.is_file():
        return None
    try:
        state = json.loads(CLOUD_STATE_FILE.read_text(encoding="utf-8"))
        if state.get("deviceId") != device_id:
            return None
        if not state.get("activationToken"):
            return None
        return state
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def _cached_status(state: dict) -> dict:
    license_data = dict(state.get("license") or {})
    tolerance = int(
        license_data.get("offlineToleranceHours")
        or DEFAULT_OFFLINE_TOLERANCE_HOURS
    )
    elapsed = int(time.time()) - int(state.get("checkedAt") or 0)
    if elapsed > tolerance * 3600:
        raise OfflineLicenseError(
            "Conectate a internet para volver a comprobar esta licencia."
        )
    expires_at = license_data.get("expiresAt")
    if expires_at and not license_data.get("perpetual"):
        try:
            expiry = datetime.fromisoformat(
                str(expires_at).replace("Z", "+00:00")
            )
        except ValueError as error:
            raise OfflineLicenseError(
                "La licencia guardada tiene una fecha invalida."
            ) from error
        now = datetime.now(timezone.utc)
        remaining_seconds = (expiry - now).total_seconds()
        if remaining_seconds <= 0:
            raise OfflineLicenseError("Esta licencia ya vencio.")
        license_data["daysRemaining"] = int(
            (remaining_seconds + 86399) // 86400
        )
    license_data["active"] = True
    license_data["offline"] = True
    return license_data


def activate_license(code: str, device_id: str) -> dict:
    normalized = code.strip()
    if "GCK1." in normalized:
        return activate_signed_code(normalized, device_id)
    result = _cloud_call(
        "/v1/licenses/activate",
        {"code": normalized, "deviceId": device_id, "deviceName": "Premiere"},
    )
    if not result or not result.get("activationToken"):
        raise OfflineLicenseError("El servidor no devolvio una activacion valida.")
    _save_cloud_state(result, device_id)
    return _public(result)


def current_license_status(device_id: str) -> dict:
    state = _load_cloud_state(device_id)
    if state:
        try:
            result = _cloud_call(
                "/v1/licenses/status",
                {
                    "deviceId": device_id,
                    "activationToken": state["activationToken"],
                },
            )
            if not result:
                raise OfflineLicenseError("Respuesta de licencia vacia.")
            result["activationToken"] = state["activationToken"]
            _save_cloud_state(result, device_id)
            return _public(result)
        except OfflineLicenseError as error:
            if "No se pudo conectar" not in str(error):
                raise
            return _cached_status(state)
    return signed_status(device_id)


def remove_license(device_id: str | None = None):
    if device_id:
        state = _load_cloud_state(device_id)
        if state:
            try:
                _cloud_call(
                    "/v1/licenses/deactivate",
                    {
                        "deviceId": device_id,
                        "activationToken": state["activationToken"],
                    },
                )
            except OfflineLicenseError:
                pass
    CLOUD_STATE_FILE.unlink(missing_ok=True)
    remove_signed_license()
