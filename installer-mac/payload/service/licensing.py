"""Licencias locales de prueba para Gota Creator Kit.

Este modulo permite validar la experiencia completa del panel sin cobrar dinero.
La version comercial debera usar una API remota como autoridad de licencias.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
import hashlib
import hmac
import os
from pathlib import Path
import secrets
import sqlite3


TRIAL_DAYS = 7
MAX_DEVICES = 2
PBKDF2_ITERATIONS = 210_000


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None


def parse_date(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def normalize_email(value: str) -> str:
    return value.strip().lower()


def normalize_code(value: str) -> str:
    return "".join(character for character in value.upper() if character.isalnum())


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt),
            int(iterations),
        )
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@dataclass
class LicenseStatus:
    authenticated: bool
    email: str | None = None
    plan: str = "Sin licencia"
    status: str = "signed_out"
    accessUntil: str | None = None
    daysRemaining: int = 0
    deviceCount: int = 0
    maxDevices: int = MAX_DEVICES
    testMode: bool = True


class LicenseError(Exception):
    pass


class LicenseStore:
    def __init__(self, database_path: Path):
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self):
        with self.connect() as database:
            database.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS entitlements (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    plan TEXT NOT NULL,
                    status TEXT NOT NULL,
                    access_until TEXT,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS devices (
                    id INTEGER PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    device_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    UNIQUE(user_id, device_id)
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    device_id TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS gift_codes (
                    id INTEGER PRIMARY KEY,
                    code_hash TEXT NOT NULL UNIQUE,
                    label TEXT NOT NULL,
                    duration_days INTEGER NOT NULL,
                    max_redemptions INTEGER NOT NULL,
                    redemption_count INTEGER NOT NULL DEFAULT 0,
                    expires_at TEXT,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS redemptions (
                    id INTEGER PRIMARY KEY,
                    gift_code_id INTEGER NOT NULL REFERENCES gift_codes(id),
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    redeemed_at TEXT NOT NULL,
                    access_until TEXT NOT NULL,
                    UNIQUE(gift_code_id, user_id)
                );
                """
            )
        self._seed_test_codes()

    def _seed_test_codes(self):
        codes = (
            ("GOTA-PRUEBA-1-MES", "Regalo de prueba: 1 mes", 30, 1000),
            ("GOTA-PRUEBA-3-MESES", "Regalo de prueba: 3 meses", 90, 1000),
            ("GOTA-PRUEBA-1-ANO", "Regalo de prueba: 1 año", 365, 1000),
        )
        with self.connect() as database:
            for code, label, days, maximum in codes:
                database.execute(
                    """
                    INSERT OR IGNORE INTO gift_codes
                    (code_hash, label, duration_days, max_redemptions, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (token_hash(normalize_code(code)), label, days, maximum, iso(utc_now())),
                )

    def _activate_device(
        self, database: sqlite3.Connection, user_id: int, device_id: str, name: str
    ):
        existing = database.execute(
            "SELECT id FROM devices WHERE user_id = ? AND device_id = ?",
            (user_id, device_id),
        ).fetchone()
        if existing:
            database.execute(
                "UPDATE devices SET name = ?, last_seen_at = ? WHERE id = ?",
                (name[:80], iso(utc_now()), existing["id"]),
            )
            return
        count = database.execute(
            "SELECT COUNT(*) AS total FROM devices WHERE user_id = ?", (user_id,)
        ).fetchone()["total"]
        if count >= MAX_DEVICES:
            raise LicenseError(
                "Esta cuenta ya tiene dos equipos activados. "
                "Desactiva uno antes de continuar."
            )
        database.execute(
            """
            INSERT INTO devices (user_id, device_id, name, last_seen_at)
            VALUES (?, ?, ?, ?)
            """,
            (user_id, device_id, name[:80], iso(utc_now())),
        )

    def _create_session(
        self, database: sqlite3.Connection, user_id: int, device_id: str
    ) -> str:
        token = secrets.token_urlsafe(32)
        database.execute(
            """
            INSERT INTO sessions (token_hash, user_id, device_id, expires_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                token_hash(token),
                user_id,
                device_id,
                iso(utc_now() + timedelta(days=30)),
            ),
        )
        return token

    def register(
        self, email: str, password: str, device_id: str, device_name: str
    ) -> tuple[str, dict]:
        email = normalize_email(email)
        if "@" not in email or len(email) > 254:
            raise LicenseError("Escribe un correo valido.")
        if len(password) < 8:
            raise LicenseError("La contraseña debe tener al menos 8 caracteres.")
        if not device_id.strip():
            raise LicenseError("No se pudo identificar este equipo.")
        now = utc_now()
        try:
            with self.connect() as database:
                cursor = database.execute(
                    """
                    INSERT INTO users (email, password_hash, created_at)
                    VALUES (?, ?, ?)
                    """,
                    (email, hash_password(password), iso(now)),
                )
                user_id = cursor.lastrowid
                database.execute(
                    """
                    INSERT INTO entitlements
                    (user_id, plan, status, access_until, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        "Prueba gratuita",
                        "trial",
                        iso(now + timedelta(days=TRIAL_DAYS)),
                        iso(now),
                    ),
                )
                self._activate_device(
                    database, user_id, device_id.strip(), device_name or "Equipo"
                )
                token = self._create_session(database, user_id, device_id.strip())
        except sqlite3.IntegrityError as error:
            raise LicenseError("Ya existe una cuenta con ese correo.") from error
        return token, self.status(token)

    def login(
        self, email: str, password: str, device_id: str, device_name: str
    ) -> tuple[str, dict]:
        with self.connect() as database:
            user = database.execute(
                "SELECT * FROM users WHERE email = ?", (normalize_email(email),)
            ).fetchone()
            if not user or not verify_password(password, user["password_hash"]):
                raise LicenseError("Correo o contraseña incorrectos.")
            self._activate_device(
                database, user["id"], device_id.strip(), device_name or "Equipo"
            )
            token = self._create_session(database, user["id"], device_id.strip())
        return token, self.status(token)

    def _user_for_token(self, database: sqlite3.Connection, token: str):
        session = database.execute(
            """
            SELECT sessions.*, users.email
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ?
            """,
            (token_hash(token),),
        ).fetchone()
        if not session or parse_date(session["expires_at"]) <= utc_now():
            raise LicenseError("La sesion vencio. Inicia sesion nuevamente.")
        database.execute(
            """
            UPDATE devices SET last_seen_at = ?
            WHERE user_id = ? AND device_id = ?
            """,
            (iso(utc_now()), session["user_id"], session["device_id"]),
        )
        return session

    def status(self, token: str | None) -> dict:
        if not token:
            return asdict(LicenseStatus(authenticated=False))
        with self.connect() as database:
            session = self._user_for_token(database, token)
            entitlement = database.execute(
                "SELECT * FROM entitlements WHERE user_id = ?",
                (session["user_id"],),
            ).fetchone()
            device_count = database.execute(
                "SELECT COUNT(*) AS total FROM devices WHERE user_id = ?",
                (session["user_id"],),
            ).fetchone()["total"]
            access_until = parse_date(entitlement["access_until"])
            active = access_until is None or access_until > utc_now()
            days = (
                max(0, (access_until - utc_now()).days + 1) if access_until else 0
            )
            return asdict(
                LicenseStatus(
                    authenticated=True,
                    email=session["email"],
                    plan=entitlement["plan"],
                    status=entitlement["status"] if active else "expired",
                    accessUntil=iso(access_until),
                    daysRemaining=days,
                    deviceCount=device_count,
                )
            )

    def redeem(self, token: str, code: str) -> dict:
        normalized = normalize_code(code)
        if not normalized:
            raise LicenseError("Escribe un codigo de regalo.")
        with self.connect() as database:
            session = self._user_for_token(database, token)
            gift = database.execute(
                "SELECT * FROM gift_codes WHERE code_hash = ?",
                (token_hash(normalized),),
            ).fetchone()
            if not gift or not gift["active"]:
                raise LicenseError("El codigo no existe o fue desactivado.")
            if gift["redemption_count"] >= gift["max_redemptions"]:
                raise LicenseError("Este codigo ya alcanzo su limite de usos.")
            expiry = parse_date(gift["expires_at"])
            if expiry and expiry <= utc_now():
                raise LicenseError("Este codigo ya vencio.")
            used = database.execute(
                """
                SELECT id FROM redemptions
                WHERE gift_code_id = ? AND user_id = ?
                """,
                (gift["id"], session["user_id"]),
            ).fetchone()
            if used:
                raise LicenseError("Esta cuenta ya canjeo ese codigo.")
            entitlement = database.execute(
                "SELECT * FROM entitlements WHERE user_id = ?",
                (session["user_id"],),
            ).fetchone()
            current_end = parse_date(entitlement["access_until"])
            base = max(utc_now(), current_end) if current_end else utc_now()
            new_end = base + timedelta(days=gift["duration_days"])
            database.execute(
                """
                UPDATE entitlements
                SET plan = ?, status = ?, access_until = ?, updated_at = ?
                WHERE user_id = ?
                """,
                (
                    "Acceso de regalo",
                    "gift",
                    iso(new_end),
                    iso(utc_now()),
                    session["user_id"],
                ),
            )
            database.execute(
                """
                INSERT INTO redemptions
                (gift_code_id, user_id, redeemed_at, access_until)
                VALUES (?, ?, ?, ?)
                """,
                (gift["id"], session["user_id"], iso(utc_now()), iso(new_end)),
            )
            database.execute(
                """
                UPDATE gift_codes SET redemption_count = redemption_count + 1
                WHERE id = ?
                """,
                (gift["id"],),
            )
        return self.status(token)

    def create_gift_code(
        self,
        duration_days: int,
        max_redemptions: int = 1,
        expires_in_days: int | None = 30,
        label: str = "Regalo creado por Gota",
        prefix: str = "GOTA-REGALO",
    ) -> str:
        if duration_days < 1 or duration_days > 3650:
            raise LicenseError("La duracion debe estar entre 1 y 3650 dias.")
        if max_redemptions < 1 or max_redemptions > 100_000:
            raise LicenseError("El limite de usos no es valido.")
        suffix = secrets.token_hex(6).upper()
        code = f"{prefix}-{suffix}"
        expires_at = (
            utc_now() + timedelta(days=expires_in_days)
            if expires_in_days is not None
            else None
        )
        with self.connect() as database:
            database.execute(
                """
                INSERT INTO gift_codes
                (code_hash, label, duration_days, max_redemptions,
                 expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    token_hash(normalize_code(code)),
                    label[:120],
                    duration_days,
                    max_redemptions,
                    iso(expires_at),
                    iso(utc_now()),
                ),
            )
        return code

    def logout(self, token: str):
        with self.connect() as database:
            database.execute(
                "DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),)
            )


def default_store() -> LicenseStore:
    override = os.environ.get("GCK_LICENSE_DATABASE")
    database = (
        Path(override)
        if override
        else Path(__file__).resolve().parent / "gota-licenses-test.sqlite3"
    )
    return LicenseStore(database)
