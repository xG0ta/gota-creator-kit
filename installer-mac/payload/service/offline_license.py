"""Validacion local de licencias firmadas para Gota Creator Kit."""

from __future__ import annotations

import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


PUBLIC_KEY_FILE = Path(__file__).with_name("license_public_key.pem")
STATE_FILE = Path(__file__).with_name("gota-license.json")
FIRST_RUN_FILE = Path(__file__).with_name("gota-first-run.json")
CLOCK_TOLERANCE_SECONDS = 300
GRACE_DAYS = 7


class OfflineLicenseError(Exception):
    pass


def decode_urlsafe(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def format_date(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def verify_signed_code(code: str, device_id: str) -> dict:
    normalized = code.strip()
    marker = normalized.find("GCK1.")
    if marker > 0:
        normalized = normalized[marker:]
    parts = normalized.split(".")
    if len(parts) != 3 or parts[0] != "GCK1":
        raise OfflineLicenseError("El codigo no tiene un formato valido.")
    try:
        payload_bytes = decode_urlsafe(parts[1])
        signature = decode_urlsafe(parts[2])
        payload = json.loads(payload_bytes)
        public_key = serialization.load_pem_public_key(
            PUBLIC_KEY_FILE.read_bytes()
        )
        public_key.verify(
            signature,
            payload_bytes,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.MAX_LENGTH,
            ),
            hashes.SHA256(),
        )
    except (ValueError, KeyError, json.JSONDecodeError, InvalidSignature) as error:
        raise OfflineLicenseError("La firma del codigo no es valida.") from error

    now = int(time.time())
    if int(payload.get("version", 0)) != 1:
        raise OfflineLicenseError("Esta version del codigo no es compatible.")
    perpetual = bool(payload.get("perpetual"))
    if not perpetual and int(payload.get("expiresAt", 0)) <= now:
        raise OfflineLicenseError("Este codigo ya vencio.")
    bound_device = str(payload.get("deviceId") or "").strip()
    if bound_device and bound_device != device_id:
        raise OfflineLicenseError("Este codigo fue creado para otro equipo.")
    return payload


def status_for_payload(payload: dict, last_seen_at: int) -> dict:
    now = int(time.time())
    if now + CLOCK_TOLERANCE_SECONDS < last_seen_at:
        raise OfflineLicenseError(
            "La fecha del equipo retrocedio. Corrige el reloj para validar la licencia."
        )
    perpetual = bool(payload.get("perpetual"))
    expires_at = int(payload.get("expiresAt") or 0)
    remaining_seconds = max(0, expires_at - now) if not perpetual else 0
    return {
        "active": perpetual or remaining_seconds > 0,
        "licenseId": payload["licenseId"],
        "label": payload.get("label") or "Licencia Gota Creator Kit",
        "expiresAt": None if perpetual else format_date(expires_at),
        "daysRemaining": None
        if perpetual else (remaining_seconds + 86399) // 86400,
        "deviceBound": bool(payload.get("deviceId")),
        "perpetual": perpetual,
        "grace": False,
        "testMode": True,
    }


def grace_status() -> dict:
    now = int(time.time())
    if FIRST_RUN_FILE.is_file():
        try:
            state = json.loads(FIRST_RUN_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise OfflineLicenseError(
                "No se pudo leer la prorroga inicial."
            ) from error
    else:
        state = {
            "startedAt": now,
            "expiresAt": now + GRACE_DAYS * 86400,
            "lastSeenAt": now,
        }
    last_seen = int(state.get("lastSeenAt", 0))
    if now + CLOCK_TOLERANCE_SECONDS < last_seen:
        raise OfflineLicenseError(
            "La fecha del equipo retrocedio. Corrige el reloj para continuar."
        )
    state["lastSeenAt"] = now
    FIRST_RUN_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
    expires_at = int(state["expiresAt"])
    remaining_seconds = max(0, expires_at - now)
    return {
        "active": remaining_seconds > 0,
        "status": "grace" if remaining_seconds > 0 else "grace_expired",
        "licenseId": "initial-grace",
        "label": "Prorroga inicial de 7 dias",
        "expiresAt": format_date(expires_at),
        "daysRemaining": (remaining_seconds + 86399) // 86400,
        "deviceBound": False,
        "perpetual": False,
        "grace": True,
        "testMode": True,
    }


def activate_code(code: str, device_id: str) -> dict:
    payload = verify_signed_code(code, device_id)
    now = int(time.time())
    state = {
        "code": code.strip(),
        "deviceId": device_id,
        "activatedAt": now,
        "lastSeenAt": now,
    }
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
    return status_for_payload(payload, now)


def current_status(device_id: str) -> dict:
    if not STATE_FILE.is_file():
        return grace_status()
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if state.get("deviceId") != device_id:
            return {
                "active": False,
                "status": "different_device",
                "testMode": True,
            }
        payload = verify_signed_code(state["code"], device_id)
        result = status_for_payload(payload, int(state.get("lastSeenAt", 0)))
        state["lastSeenAt"] = int(time.time())
        STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
        return result
    except OfflineLicenseError:
        raise
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        raise OfflineLicenseError("No se pudo leer la licencia guardada.") from error


def remove_license():
    STATE_FILE.unlink(missing_ok=True)
