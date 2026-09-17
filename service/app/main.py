from pathlib import Path
import base64
import hashlib
import json
import os
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
import subprocess
import tempfile
import zipfile
from threading import Lock
from time import time
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from .detector import analyze_video
from .models import AnalyzeRequest, AnalyzeResponse
from .planner import plan_crops, plan_podcast_layout
from service_v2.detector import analyze_identities
from service_v2.editorial import EditorialFrame, PROFILES, build_shot_plan
from service.silence import analyze_silences
from service.licensing import LicenseError, default_store
from service.offline_license import OfflineLicenseError
from service.hybrid_license import (
    activate_license,
    current_license_status,
    remove_license,
)

APP_VERSION = "3.2.87"
app = FastAPI(title="Gota Creator Kit Local Service", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)
license_store = default_store()

jobs: dict[str, dict] = {}
jobs_lock = Lock()
executor = ThreadPoolExecutor(max_workers=1)
JOB_TTL_SECONDS = 10 * 24 * 60 * 60
PREVIEW_TTL_SECONDS = 60 * 60
CLIPBOARD_IMAGE_TTL_SECONDS = 10 * 24 * 60 * 60
preview_items: dict[str, dict] = {}
preview_lock = Lock()
preview_cache_dir = (
    Path(os.environ.get("LOCALAPPDATA", "")) / "GotaCreatorKit" / "preview-cache"
    if os.name == "nt" and os.environ.get("LOCALAPPDATA")
    else Path.home() / "Library" / "Caches" / "GotaCreatorKit" / "preview-cache"
)
clipboard_cache_dir = (
    Path(os.environ.get("LOCALAPPDATA", "")) / "GotaCreatorKit" / "clipboard-cache"
    if os.name == "nt" and os.environ.get("LOCALAPPDATA")
    else Path.home() / "Library" / "Caches" / "GotaCreatorKit" / "clipboard-cache"
)
system_fonts_cache: list[str] | None = None
font_postscript_cache: dict[str, str] | None = None
font_file_cache: dict[str, Path] | None = None
SILENCE_DIAGNOSTIC_LOG = (
    Path(os.environ.get("GOTA_LOG_DIR", "")) / "silence-diagnostics.log"
    if os.environ.get("GOTA_LOG_DIR")
    else Path(__file__).resolve().parents[1] / "silence-diagnostics.log"
)
SILENCE_DIAGNOSTIC_MAX_BYTES = 1_000_000


def write_silence_diagnostic(event: str, **details) -> str:
    """Guarda un resumen legible del análisis sin exponer rutas completas.

    Este archivo queda junto a autoframe-service.log, tanto en Windows como
    en macOS. Se limita a 1 MB para que el diagnóstico no llene el disco.
    """
    entry = {"at": round(time(), 3), "event": event, **details}
    try:
        SILENCE_DIAGNOSTIC_LOG.parent.mkdir(parents=True, exist_ok=True)
        if (
            SILENCE_DIAGNOSTIC_LOG.exists()
            and SILENCE_DIAGNOSTIC_LOG.stat().st_size > SILENCE_DIAGNOSTIC_MAX_BYTES
        ):
            SILENCE_DIAGNOSTIC_LOG.replace(
                SILENCE_DIAGNOSTIC_LOG.with_suffix(".previous.log")
            )
        with SILENCE_DIAGNOSTIC_LOG.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
    except OSError:
        # Un registro nunca debe impedir que el usuario edite.
        pass
    return str(SILENCE_DIAGNOSTIC_LOG)


@app.on_event("startup")
def record_silence_engine_start() -> None:
    # Hace visible desde el inicio la ruta correcta del registro. Si este
    # archivo no aparece, se sabe que se está revisando el ZIP descargado y no
    # la instalación activa del motor local.
    write_silence_diagnostic(
        "service_started",
        version=APP_VERSION,
        platform=os.name,
    )


class AnalyzeV2Request(BaseModel):
    mediaPath: str = Field(min_length=1)
    sampleFps: float = Field(default=4.0, ge=1, le=12)
    profile: str = "podcast_dynamic"
    sensitivity: str = "balanced"
    peopleMode: str = "auto"
    framing: float = Field(default=1.2, ge=0.85, le=1.6)
    rules: dict = Field(default_factory=dict)
    startSeconds: float = Field(default=0, ge=0)
    endSeconds: float | None = Field(default=None, gt=0)


class SilenceRequest(BaseModel):
    mediaPath: str = Field(min_length=1)
    thresholdDb: float = Field(default=-42, ge=-96, le=0)
    minimumSilenceSeconds: float = Field(default=0.4, ge=0.1, le=5)
    paddingSeconds: float = Field(default=0.12, ge=0, le=1)
    startSeconds: float = Field(default=0, ge=0)
    endSeconds: float = Field(gt=0)


class SilenceDiagnosticRequest(BaseModel):
    event: str = Field(min_length=1, max_length=80)
    details: dict = Field(default_factory=dict)


class AccountRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=200)
    deviceId: str = Field(min_length=8, max_length=200)
    deviceName: str = Field(default="Equipo", max_length=80)


class GiftRedeemRequest(BaseModel):
    code: str = Field(min_length=3, max_length=100)


class OfflineLicenseRequest(BaseModel):
    code: str = Field(min_length=4, max_length=4096)
    deviceId: str = Field(min_length=8, max_length=200)


class OfflineLicenseStatusRequest(BaseModel):
    deviceId: str = Field(min_length=8, max_length=200)


class PreviewRegistrationRequest(BaseModel):
    mediaPath: str = Field(min_length=1, max_length=4096)


class ClipboardImageResponse(BaseModel):
    """Una copia privada de la imagen que el usuario ya puso en su portapapeles."""

    mediaPath: str
    filename: str


class TranscribeRequest(BaseModel):
    """Un tramo ya elegido en Premiere, nunca una ruta explorada por el servicio."""
    mediaPath: str = Field(min_length=1, max_length=4096)
    startSeconds: float = Field(default=0, ge=0)
    endSeconds: float | None = Field(default=None, gt=0)
    language: str = Field(default="es", min_length=2, max_length=12)
    model: str = Field(default="base", pattern="^(tiny|base|small)$")


class CaptionMogrtRequest(BaseModel):
    """Una MOGRT incluida por el propio panel y el texto que debe contener."""
    templatePath: str = Field(min_length=1, max_length=4096)
    text: str = Field(min_length=1, max_length=600)
    style: dict = Field(default_factory=dict)


def bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Inicia sesion para continuar.")
    return authorization[7:].strip()


def license_call(callback):
    try:
        return callback()
    except LicenseError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def offline_license_call(callback):
    try:
        return callback()
    except OfflineLicenseError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def cleanup_expired_jobs():
    cutoff = time() - JOB_TTL_SECONDS
    with jobs_lock:
        expired = [
            job_id for job_id, job in jobs.items()
            if job.get("createdAt", 0) < cutoff
        ]
        for job_id in expired:
            del jobs[job_id]


def cleanup_expired_previews():
    cutoff = time() - PREVIEW_TTL_SECONDS
    with preview_lock:
        expired = [
            token for token, item in preview_items.items()
            if item.get("createdAt", 0) < cutoff
        ]
        for token in expired:
            item = preview_items.pop(token)
            # El medio convertido se conserva en la caché privada para que la
            # próxima apertura sea inmediata. Solo caduca el enlace temporal.


def cleanup_expired_clipboard_images() -> None:
    """El portapapeles es una comodidad temporal, no una biblioteca oculta.

    Conservamos sus copias diez días para que Premiere pueda seguir usando el
    elemento ya colocado, pero impedimos que el caché crezca con cada pegado.
    """
    cutoff = time() - CLIPBOARD_IMAGE_TTL_SECONDS
    try:
        if not clipboard_cache_dir.exists():
            return
        for candidate in clipboard_cache_dir.iterdir():
            if not candidate.is_file():
                continue
            try:
                if candidate.stat().st_mtime < cutoff:
                    candidate.unlink(missing_ok=True)
            except OSError:
                # Un archivo en uso no debe impedir que se pegue una imagen.
                continue
    except OSError:
        pass


def capture_windows_clipboard_image(destination: Path) -> None:
    """Guarda el bitmap del portapapeles de Windows sin añadir dependencias.

    El servicio corre bajo la sesión del editor, por eso PowerShell en modo
    STA puede leer el mismo portapapeles que usa Ctrl+C en el navegador.
    """
    encoded_destination = base64.b64encode(
        str(destination).encode("utf-16le")
    ).decode("ascii")
    command = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "Add-Type -AssemblyName System.Drawing; "
        "$destination = [System.Text.Encoding]::Unicode.GetString("
        f"[System.Convert]::FromBase64String('{encoded_destination}')); "
        "$image = [System.Windows.Forms.Clipboard]::GetImage(); "
        "if ($null -eq $image) { exit 19 }; "
        "$image.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)"
    )
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-STA", "-Command", command],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        check=False,
    )
    if completed.returncode != 0 or not destination.is_file():
        raise RuntimeError(
            "No encontré una imagen en el portapapeles. Copia una imagen y vuelve a presionar Pegar."
        )


def capture_macos_clipboard_image(destination_base: Path) -> Path:
    """Extrae PNG o TIFF desde el portapapeles de macOS con herramientas nativas."""
    script = r'''
ObjC.import('AppKit');
ObjC.import('Foundation');
function run(argv) {
  const outputBase = String(argv[0]);
  const board = $.NSPasteboard.generalPasteboard;
  let data = board.dataForType($.NSPasteboardTypePNG);
  let extension = '.png';
  if (!data) {
    data = board.dataForType($.NSPasteboardTypeTIFF);
    extension = '.tiff';
  }
  if (!data) throw new Error('NO_IMAGE');
  const output = $(outputBase + extension);
  if (!data.writeToFileAtomically(output, true)) throw new Error('WRITE_FAILED');
  return outputBase + extension;
}
'''
    completed = subprocess.run(
        ["/usr/bin/osascript", "-l", "JavaScript", "-e", script, str(destination_base)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "No encontré una imagen en el portapapeles. Copia una imagen y vuelve a presionar Pegar."
        )
    path = Path(completed.stdout.strip())
    if not path.is_file():
        raise RuntimeError("macOS no pudo guardar la imagen copiada.")
    return path


def capture_clipboard_image() -> Path:
    """Crea un archivo importable desde una imagen copiada por el usuario."""
    clipboard_cache_dir.mkdir(parents=True, exist_ok=True)
    cleanup_expired_clipboard_images()
    timestamp = int(time() * 1000)
    stem = clipboard_cache_dir / f"gota-paste-{timestamp}-{uuid4().hex[:8]}"
    if os.name == "nt":
        image_path = stem.with_suffix(".png")
        capture_windows_clipboard_image(image_path)
        return image_path
    if sys.platform == "darwin":
        return capture_macos_clipboard_image(stem)
    raise RuntimeError("Pegar imágenes está disponible en Windows y macOS.")


def make_uxp_preview(source: Path, token: str) -> tuple[Path, str]:
    """Convierte medios a códecs que el reproductor UXP de Premiere soporta.

    No modifica el archivo original. La copia de vista previa se guarda solo en
    temporal y se elimina automáticamente una hora después.
    """
    try:
        import imageio_ffmpeg
    except ImportError as error:
        raise RuntimeError("Falta el componente de vista previa. Reinstala Gota Creator Kit.") from error
    preview_cache_dir.mkdir(parents=True, exist_ok=True)
    audio_extensions = {".mp3", ".wav", ".m4a", ".aac", ".aif", ".aiff", ".ogg", ".flac"}
    is_audio = source.suffix.lower() in audio_extensions
    signature = hashlib.sha256(
        f"{source.resolve()}|{source.stat().st_mtime_ns}|{source.stat().st_size}".encode("utf-8")
    ).hexdigest()[:32]
    target = preview_cache_dir / f"{signature}{'.mp3' if is_audio else '.mp4'}"
    if target.is_file() and target.stat().st_size > 0:
        return target, "audio/mpeg" if is_audio else "video/mp4"
    if is_audio:
        command = [
            imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(source), "-vn", "-c:a", "libmp3lame", "-q:a", "4", str(target),
        ]
        media_type = "audio/mpeg"
    else:
        command = [
            imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(source), "-map", "0:v:0", "-map", "0:a?",
            "-vf", "scale='min(960,iw)':-2:force_original_aspect_ratio=decrease",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(target),
        ]
        media_type = "video/mp4"
    completed = subprocess.run(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        check=False,
    )
    if completed.returncode != 0 or not target.is_file():
        message = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(message or "No se pudo convertir el archivo para la vista previa.")
    return target, media_type


def transcribe_local_media(request: TranscribeRequest) -> dict:
    """Transcribe con Whisper local solo el tramo montado en la secuencia.

    El modelo se descarga una vez a la caché privada de Gota Creator Kit. La
    extracción temporal de audio evita analizar el archivo completo cuando el
    usuario eligió únicamente una parte de su clip en la línea de tiempo.
    """
    source = Path(request.mediaPath).expanduser().resolve()
    if not source.is_file():
        raise ValueError("El medio seleccionado ya no existe en este equipo.")
    try:
        import imageio_ffmpeg
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise RuntimeError(
            "El motor de subtítulos no terminó de instalarse. Actualiza Gota Creator Kit y reinicia Premiere."
        ) from error

    cache_root = preview_cache_dir.parent / "whisper-models"
    cache_root.mkdir(parents=True, exist_ok=True)
    segment_path = cache_root / f"transcribe-{uuid4().hex}.wav"
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{request.startSeconds:.3f}", "-i", str(source),
    ]
    if request.endSeconds is not None:
        duration = max(0.05, request.endSeconds - request.startSeconds)
        command.extend(["-t", f"{duration:.3f}"])
    command.extend(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(segment_path)])
    completed = subprocess.run(
        command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False,
    )
    if completed.returncode != 0 or not segment_path.is_file():
        message = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(message or "No se pudo preparar el audio para los subtítulos.")
    try:
        # CPU int8 funciona en Windows y Mac sin requerir GPU ni cuentas externas.
        model = WhisperModel(
            request.model, device="cpu", compute_type="int8", download_root=str(cache_root),
            cpu_threads=max(1, min(8, os.cpu_count() or 1)),
        )
        segments, info = model.transcribe(
            str(segment_path), language=request.language, vad_filter=True,
            beam_size=5, condition_on_previous_text=True, word_timestamps=True,
        )
        result_segments = []
        for segment in segments:
            text = str(segment.text or "").strip()
            if not text:
                continue
            words = []
            for word in getattr(segment, "words", None) or []:
                word_text = str(getattr(word, "word", "") or "").strip()
                if not word_text:
                    continue
                words.append({
                    "text": word_text,
                    "startSeconds": round(request.startSeconds + float(word.start), 3),
                    "endSeconds": round(request.startSeconds + float(word.end), 3),
                })
            result_segments.append({
                "startSeconds": round(request.startSeconds + float(segment.start), 3),
                "endSeconds": round(request.startSeconds + float(segment.end), 3),
                "text": text,
                "words": words,
            })
        return {
            "segments": result_segments,
            "language": getattr(info, "language", request.language),
            "model": request.model,
        }
    finally:
        try:
            segment_path.unlink(missing_ok=True)
        except OSError:
            pass


def get_system_fonts() -> list[str]:
    """Lista familias visibles para que el panel no limite al usuario a 4 fuentes."""
    global system_fonts_cache
    if system_fonts_cache is not None:
        return system_fonts_cache
    fonts: set[str] = {"Arial", "Helvetica", "Times New Roman"}
    try:
        if os.name == "nt":
            command = (
                "Add-Type -AssemblyName System.Drawing; "
                "(New-Object System.Drawing.Text.InstalledFontCollection).Families | "
                "ForEach-Object { $_.Name }"
            )
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", command],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
            fonts.update(line.strip() for line in result.stdout.splitlines() if line.strip())
        elif sys.platform == "darwin":
            result = subprocess.run(
                ["system_profiler", "SPFontsDataType", "-json"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                check=False,
            )
            data = json.loads(result.stdout or "{}")
            for item in data.get("SPFontsDataType", []):
                name = item.get("_name") or item.get("family")
                if name:
                    fonts.add(str(name).strip())
        else:
            result = subprocess.run(
                ["fc-list", ":family"], stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, encoding="utf-8", check=False,
            )
            for line in result.stdout.splitlines():
                fonts.update(part.strip() for part in line.split(",") if part.strip())
    except Exception:
        # El panel continúa funcionando aunque el sistema no permita enumerar.
        pass
    system_fonts_cache = sorted(font for font in fonts if font)[:1500]
    return system_fonts_cache


def _read_open_type_names(path: Path) -> dict[str, str]:
    """Lee familia y nombre PostScript sin depender de paquetes extra.

    Essential Graphics necesita el nombre PostScript (por ejemplo
    ``BurbankBigCondensed-Black``), no siempre el nombre que muestra Windows.
    """
    try:
        data = path.read_bytes()
        table_count = int.from_bytes(data[4:6], "big")
        name_offset = name_length = None
        for index in range(table_count):
            start = 12 + index * 16
            if data[start:start + 4] == b"name":
                name_offset = int.from_bytes(data[start + 8:start + 12], "big")
                name_length = int.from_bytes(data[start + 12:start + 16], "big")
                break
        if name_offset is None or name_offset + (name_length or 0) > len(data):
            return {}
        count = int.from_bytes(data[name_offset + 2:name_offset + 4], "big")
        storage = name_offset + int.from_bytes(data[name_offset + 4:name_offset + 6], "big")
        names: dict[int, str] = {}
        for index in range(count):
            start = name_offset + 6 + index * 12
            platform = int.from_bytes(data[start:start + 2], "big")
            name_id = int.from_bytes(data[start + 6:start + 8], "big")
            length = int.from_bytes(data[start + 8:start + 10], "big")
            offset = int.from_bytes(data[start + 10:start + 12], "big")
            raw = data[storage + offset:storage + offset + length]
            try:
                value = raw.decode("utf-16-be" if platform in (0, 3) else "mac_roman").strip()
            except UnicodeDecodeError:
                continue
            if value and name_id not in names:
                names[name_id] = value
        return {
            "family": names.get(1, ""),
            "full": names.get(4, ""),
            "postscript": names.get(6, ""),
        }
    except (OSError, ValueError, IndexError):
        return {}


def resolve_postscript_font_name(display_name: str) -> str:
    global font_postscript_cache
    wanted = str(display_name or "Arial").strip()
    if not wanted:
        return "Arial-BoldMT"
    if font_postscript_cache is None:
        font_postscript_cache = {}
        if os.name == "nt":
            font_dir = Path(os.environ.get("WINDIR", r"C:\\Windows")) / "Fonts"
            candidates = list(font_dir.glob("*.ttf")) + list(font_dir.glob("*.otf"))
        elif sys.platform == "darwin":
            candidates = list(Path("/Library/Fonts").glob("*.*tf")) + list((Path.home() / "Library" / "Fonts").glob("*.*tf"))
        else:
            candidates = []
        for candidate in candidates:
            names = _read_open_type_names(candidate)
            postscript = names.get("postscript")
            if not postscript:
                continue
            for value in (names.get("family"), names.get("full"), postscript):
                if value:
                    font_postscript_cache.setdefault(value.casefold(), postscript)
    exact = font_postscript_cache.get(wanted.casefold())
    if exact:
        return exact
    # Algunos instaladores muestran abreviaturas ("Cd Bk") mientras que
    # After Effects pide el PostScript completo ("Condensed Black").
    compact = "".join(character for character in wanted.casefold() if character.isalnum())
    compact = compact.replace("cdbk", "condensedblack").replace("cond", "condensed")
    for known, postscript in font_postscript_cache.items():
        known_compact = "".join(character for character in known if character.isalnum())
        if compact == known_compact or compact in known_compact or known_compact in compact:
            return postscript
    return wanted


def _font_key(value: str) -> str:
    """Normaliza nombres de fuente para resolver familias mostradas por el SO."""
    return "".join(character for character in str(value or "").casefold() if character.isalnum())


def find_system_font_file(display_name: str) -> Path | None:
    """Devuelve el archivo real de una fuente instalada para la vista previa UXP.

    UXP no siempre hereda fuentes que el usuario instaló después de Premiere.
    Servir el TTF/OTF local permite que el panel use exactamente esa familia sin
    subirla ni copiarla fuera del equipo.
    """
    global font_file_cache
    wanted = str(display_name or "").strip()
    if not wanted:
        return None
    if font_file_cache is None:
        font_file_cache = {}
        font_dirs: list[Path] = []
        if os.name == "nt":
            font_dirs = [
                Path(os.environ.get("WINDIR", r"C:\\Windows")) / "Fonts",
                Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts",
            ]
        elif sys.platform == "darwin":
            font_dirs = [
                Path("/Library/Fonts"),
                Path.home() / "Library" / "Fonts",
                Path("/System/Library/Fonts"),
                Path("/System/Library/Fonts/Supplemental"),
            ]
        for font_dir in font_dirs:
            if not font_dir.is_dir():
                continue
            try:
                candidates = list(font_dir.rglob("*.ttf")) + list(font_dir.rglob("*.otf"))
            except OSError:
                continue
            for candidate in candidates:
                names = _read_open_type_names(candidate)
                values = (names.get("family"), names.get("full"), names.get("postscript"), candidate.stem)
                for value in values:
                    key = _font_key(value)
                    if key:
                        font_file_cache.setdefault(key, candidate)
    wanted_key = _font_key(wanted)
    exact = font_file_cache.get(wanted_key)
    if exact:
        return exact
    # Emparejamiento tolerante para nombres abreviados que muestra Premiere.
    for known, candidate in font_file_cache.items():
        if wanted_key in known or known in wanted_key:
            return candidate
    return None


def build_result(request: AnalyzeRequest, progress_callback=None):
    path = Path(request.mediaPath)
    if not path.is_file():
        raise ValueError("El medio local no existe")
    width, height, duration, detections, frames, scene_cuts = analyze_video(
        path,
        request.sampleFps,
        request.startSeconds,
        request.endSeconds,
        progress_callback,
    )
    keyframes = plan_crops(
        detections,
        width / height,
        request.targetAspect,
        request.margin,
        request.smoothing,
    )
    layout_frames = plan_podcast_layout(
        frames, width / height, request.margin, request.smoothing
    )
    single_frames = sum(item["mode"] == "single" for item in layout_frames)
    split_frames = sum(item["mode"] == "split" for item in layout_frames)
    warnings = []
    if not keyframes:
        warnings.append("No se detectaron caras; no se genero un encuadre.")
    mean_confidence = (
        sum(item["confidence"] for item in keyframes) / len(keyframes)
        if keyframes else 0
    )
    return AnalyzeResponse(
        sourceWidth=width,
        sourceHeight=height,
        durationSeconds=duration,
        meanConfidence=mean_confidence,
        warnings=warnings,
        keyframes=keyframes,
        layoutFrames=layout_frames,
        singleFrames=single_frames,
        splitFrames=split_frames,
        sceneCuts=scene_cuts,
        sceneCutCount=len(scene_cuts),
    )


def run_job(job_id: str, request: AnalyzeRequest):
    def update_progress(value: float):
        with jobs_lock:
            jobs[job_id]["progress"] = round(value * 100)
            jobs[job_id]["status"] = "running"

    try:
        result = build_result(request, update_progress)
        with jobs_lock:
            jobs[job_id].update({
                "status": "completed",
                "progress": 100,
                "result": result.model_dump(),
            })
    except Exception as error:
        with jobs_lock:
            jobs[job_id].update({
                "status": "failed",
                "error": str(error),
            })


def build_v2_result(request: AnalyzeV2Request, progress_callback=None):
    path = Path(request.mediaPath)
    if not path.is_file():
        raise ValueError("El medio local no existe")
    model_path = Path(__file__).resolve().parents[2] / "models" / (
        "face_detection_yunet_2023mar.onnx"
    )
    identity_frames = analyze_identities(
        path,
        model_path,
        sample_fps=request.sampleFps,
        start_seconds=request.startSeconds,
        end_seconds=request.endSeconds,
        progress_callback=progress_callback,
        sensitivity=request.sensitivity,
    )
    import cv2
    capture = cv2.VideoCapture(str(path))
    source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration = (
        capture.get(cv2.CAP_PROP_FRAME_COUNT) /
        (capture.get(cv2.CAP_PROP_FPS) or 30.0)
    )
    capture.release()
    editorial_frames = []
    keyframes = []
    layout_frames = []
    for frame in identity_frames:
        subjects = frame["subjects"]
        active_mouths = sum(
            subject["mouthActivity"] >= 0.018 for subject in subjects
        )
        confidence = (
            sum(subject["confidence"] for subject in subjects) / len(subjects)
            if subjects else 0.0
        )
        editorial_frames.append(EditorialFrame(
            time=frame["timeSeconds"],
            speaker_id=frame["speakerId"],
            subject_ids=tuple(subject["id"] for subject in subjects),
            confidence=confidence,
            overlap=len(subjects) >= 2 and active_mouths >= 2,
        ))
        ordered = sorted(subjects, key=lambda item: item["x"])
        layout_subjects = []
        is_two_person_view = len(ordered) >= 2
        for subject in ordered[:2]:
            # El plano doble necesita bastante más aire que un punch-in:
            # cada rostro ocupa aproximadamente 35-45% del ancho de su mitad.
            width_factor = 3.6 if is_two_person_view else 2.0
            height_factor = 4.0 if is_two_person_view else 2.5
            crop_width = min(
                1.0, subject["width"] * width_factor * request.framing
            )
            crop_height = min(
                1.0, subject["height"] * height_factor * request.framing
            )
            center_x = subject["x"] + subject["width"] / 2
            # Coloca los ojos sobre el tercio superior y conserva hombros.
            center_y = subject["y"] + subject["height"] * (
                1.0 if is_two_person_view else 0.95
            )
            center_x = min(1 - crop_width / 2, max(crop_width / 2, center_x))
            center_y = min(1 - crop_height / 2, max(crop_height / 2, center_y))
            layout_subjects.append({
                "centerX": center_x,
                "centerY": center_y,
                "width": crop_width,
                "height": crop_height,
                "confidence": subject["confidence"],
                "subjectId": subject["id"],
            })
        use_split = (
            len(layout_subjects) >= 2 and request.peopleMode != "single"
        )
        layout_frames.append({
            "timeSeconds": frame["timeSeconds"],
            "mode": "split" if use_split else "single",
            "speakerId": frame["speakerId"],
            "subjects": layout_subjects,
        })
        chosen = next(
            (subject for subject in subjects
             if subject["id"] == frame["speakerId"]),
            max(subjects, key=lambda item: item["confidence"])
            if subjects else None,
        )
        if chosen:
            crop_width = min(
                1.0, chosen["width"] * 2.0 * request.framing
            )
            crop_height = min(
                1.0, chosen["height"] * 2.5 * request.framing
            )
            center_x = chosen["x"] + chosen["width"] / 2
            center_y = chosen["y"] + chosen["height"] * 0.95
            center_x = min(1 - crop_width / 2, max(crop_width / 2, center_x))
            center_y = min(1 - crop_height / 2, max(crop_height / 2, center_y))
            keyframes.append({
                "timeSeconds": frame["timeSeconds"],
                "centerX": center_x,
                "centerY": center_y,
                "width": crop_width,
                "height": crop_height,
                "confidence": chosen["confidence"],
                "mouthActivity": chosen["mouthActivity"],
                "subjectId": chosen["id"],
            })
    shots, warnings = build_shot_plan(
        editorial_frames, request.profile, request.rules
    )
    preview_capture = cv2.VideoCapture(str(path))
    for shot in shots[:30]:
        midpoint = (shot["startSeconds"] + shot["endSeconds"]) / 2
        preview_capture.set(cv2.CAP_PROP_POS_MSEC, midpoint * 1000)
        ok, preview_frame = preview_capture.read()
        if not ok:
            continue
        preview_height, preview_width = preview_frame.shape[:2]
        preview_scale = min(1.0, 240 / max(1, preview_width))
        preview_frame = cv2.resize(
            preview_frame,
            (
                max(1, round(preview_width * preview_scale)),
                max(1, round(preview_height * preview_scale)),
            ),
            interpolation=cv2.INTER_AREA,
        )
        encoded, jpeg = cv2.imencode(
            ".jpg", preview_frame, [cv2.IMWRITE_JPEG_QUALITY, 68]
        )
        if encoded:
            shot["previewDataUrl"] = (
                "data:image/jpeg;base64," +
                base64.b64encode(jpeg.tobytes()).decode("ascii")
            )
    preview_capture.release()
    editorial_cuts = [
        round(shot["startSeconds"], 4)
        for shot in shots[1:]
    ]
    if not keyframes:
        warnings.append({
            "type": "no_faces",
            "timeSeconds": request.startSeconds,
            "message": "No se confirmaron rostros reales.",
        })
    if request.peopleMode == "split" and not any(
        frame["mode"] == "split" for frame in layout_frames
    ):
        warnings.append({
            "type": "missing_second_person",
            "timeSeconds": request.startSeconds,
            "message": "Se pidieron dos personas, pero no se confirmó la segunda.",
        })
    mean_confidence = (
        sum(frame["confidence"] for frame in keyframes) / len(keyframes)
        if keyframes else 0.0
    )
    return {
        "version": APP_VERSION,
        "profile": request.profile,
        "sourceWidth": source_width,
        "sourceHeight": source_height,
        "durationSeconds": duration,
        "meanConfidence": mean_confidence,
        "keyframes": keyframes,
        "layoutFrames": layout_frames,
        "singleFrames": sum(
            frame["mode"] == "single" for frame in layout_frames
        ),
        "splitFrames": sum(
            frame["mode"] == "split" for frame in layout_frames
        ),
        "sceneCuts": editorial_cuts,
        "sceneCutCount": len(editorial_cuts),
        "frames": identity_frames,
        "shots": shots,
        "warnings": warnings,
        "summary": {
            "samples": len(identity_frames),
            "shots": len(shots),
            "subjects": sorted({
                subject["id"]
                for frame in identity_frames
                for subject in frame["subjects"]
            }),
        },
    }


def run_v2_job(job_id: str, request: AnalyzeV2Request):
    def update_progress(value: float):
        with jobs_lock:
            if jobs.get(job_id, {}).get("cancelRequested"):
                raise RuntimeError("Analisis cancelado por el usuario")
            jobs[job_id]["progress"] = round(value * 100)
            jobs[job_id]["status"] = "running"

    try:
        result = build_v2_result(request, update_progress)
        with jobs_lock:
            if jobs[job_id].get("cancelRequested"):
                jobs[job_id].update({
                    "status": "canceled",
                    "error": "Analisis cancelado por el usuario",
                })
                return
            jobs[job_id].update({
                "status": "completed",
                "progress": 100,
                "result": result,
            })
    except Exception as error:
        with jobs_lock:
            if job_id not in jobs:
                return
            canceled = jobs[job_id].get("cancelRequested", False)
            jobs[job_id].update({
                "status": "canceled" if canceled else "failed",
                "error": str(error),
            })


def run_silence_job(job_id: str, request: SilenceRequest):
    def update_progress(value: float):
        with jobs_lock:
            if jobs.get(job_id, {}).get("cancelRequested"):
                raise RuntimeError("Análisis cancelado por el usuario")
            jobs[job_id]["progress"] = round(value * 100)
            jobs[job_id]["status"] = "running"

    try:
        path = Path(request.mediaPath)
        if not path.is_file():
            raise ValueError("El medio local no existe")
        write_silence_diagnostic(
            "analysis_started",
            jobId=job_id,
            mediaName=path.name,
            requestedThresholdDb=request.thresholdDb,
            minimumSilenceSeconds=request.minimumSilenceSeconds,
            paddingSeconds=request.paddingSeconds,
            startSeconds=request.startSeconds,
            endSeconds=request.endSeconds,
        )
        result = analyze_silences(
            path,
            request.startSeconds,
            request.endSeconds,
            request.thresholdDb,
            request.minimumSilenceSeconds,
            request.paddingSeconds,
            update_progress,
        )
        diagnostic_log = write_silence_diagnostic(
            "analysis_completed",
            jobId=job_id,
            mediaName=path.name,
            silenceCount=result.get("silenceCount", 0),
            removedDurationSeconds=result.get("removedDurationSeconds", 0),
            requestedThresholdDb=result.get("thresholdDb"),
            effectiveThresholdDb=result.get("effectiveThresholdDb"),
            diagnostics=result.get("diagnostics", {}),
            silences=result.get("silences", [])[:100],
        )
        with jobs_lock:
            jobs[job_id].update({
                "status": "completed",
                "progress": 100,
                "result": result,
                "diagnosticLogPath": diagnostic_log,
            })
    except Exception as error:
        diagnostic_log = write_silence_diagnostic(
            "analysis_failed",
            jobId=job_id,
            mediaName=Path(request.mediaPath).name,
            error=str(error),
            trace=traceback.format_exc(limit=8),
        )
        with jobs_lock:
            if job_id not in jobs:
                return
            canceled = jobs[job_id].get("cancelRequested", False)
            jobs[job_id].update({
                "status": "canceled" if canceled else "failed",
                "error": str(error),
                "diagnosticLogPath": diagnostic_log,
            })


def _caption_control_matches(control: dict) -> bool:
    """Identifica el controlador de texto sin depender del idioma de Premiere."""
    name = control.get("uiName", {})
    if isinstance(name, str):
        return "texto" in name.lower() or "text" in name.lower()
    for item in name.get("strDB", []) if isinstance(name, dict) else []:
        value = str(item.get("str", "")).lower()
        if "texto" in value or "text" in value:
            return True
    return False


def _set_caption_text_in_definition(definition: dict, text: str, style: dict) -> bool:
    """Actualiza la propiedad esencial y el valor inicial de la MOGRT.

    Premiere lee este JSON al importar la plantilla. Prepararlo aquí es más
    fiable que intentar escribir el parámetro de una MOGRT recién insertada,
    API que cambia entre ediciones de Premiere.
    """
    changed = False
    font_name = resolve_postscript_font_name(str(style.get("font") or "Arial"))
    try:
        font_size = max(12, min(180, round(float(style.get("fontSize", 42)), 1)))
    except (TypeError, ValueError):
        font_size = 42
    all_caps = bool(style.get("allCaps", False))
    try:
        duration_seconds = max(0.18, min(100, round(float(style.get("durationSeconds", 2)), 3)))
    except (TypeError, ValueError):
        duration_seconds = 2
    for control in definition.get("clientControls", []):
        if not isinstance(control, dict):
            continue
        control_name = ""
        ui_name = control.get("uiName", {})
        if isinstance(ui_name, str):
            control_name = ui_name.lower()
        elif isinstance(ui_name, dict):
            control_name = " ".join(
                str(item.get("str", "")).lower()
                for item in ui_name.get("strDB", []) if isinstance(item, dict)
            )
        if "duraci" in control_name:
            control["value"] = duration_seconds
            changed = True
            continue
        if not _caption_control_matches(control):
            continue
        value = control.get("value")
        if not isinstance(value, dict):
            continue
        for item in value.get("strDB", []):
            if isinstance(item, dict):
                item["str"] = text
                changed = True
        # Adobe guarda la edición de fuente/tamaño en la definición de la
        # propiedad de texto. Activarlo por copia permite que cada gráfico
        # conserve las elecciones del panel al llegar a Premiere.
        edit_info = control.setdefault("fonteditinfo", {})
        edit_info.update({
            "capPropFontEdit": True,
            "capPropFontFauxStyleEdit": True,
            "capPropFontSizeEdit": True,
            "fontEditValue": font_name,
            "fontFSAllCapsValue": all_caps,
            "fontSizeEditValue": font_size,
        })

    for localized in definition.get("sourceInfoLocalized", {}).values():
        if not isinstance(localized, dict):
            continue
        capsule = localized.get("capsuleparams", {})
        for parameter in capsule.get("capParams", []) if isinstance(capsule, dict) else []:
            if not isinstance(parameter, dict):
                continue
            name = str(parameter.get("capPropUIName", "")).lower()
            if "duraci" in name:
                parameter["capPropDefault"] = duration_seconds
                changed = True
                continue
            if "texto" not in name and "text" not in name:
                continue
            parameter["capPropDefault"] = text
            parameter["textEditValue"] = text
            parameter["capPropTextRunCount"] = 1
            parameter["fontTextRunLength"] = [len(text)]
            parameter["capPropFontEdit"] = True
            parameter["capPropFontFauxStyleEdit"] = True
            parameter["capPropFontSizeEdit"] = True
            parameter["fontEditValue"] = [font_name]
            parameter["fontFSAllCapsValue"] = [all_caps]
            parameter["fontSizeEditValue"] = [font_size]
            changed = True
    return changed


def build_caption_mogrt(template: Path, text: str, style: dict | None = None) -> Path:
    template = template.expanduser().resolve()
    if not template.is_file() or template.suffix.lower() != ".mogrt":
        raise ValueError("No se encontró la plantilla editable de subtítulos.")
    style = style or {}
    style_signature = json.dumps(style, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    key = hashlib.sha256(
        f"{template}|{template.stat().st_mtime_ns}|{text}|{style_signature}".encode("utf-8")
    ).hexdigest()
    destination_dir = preview_cache_dir.parent / "caption-mogrts"
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / f"{key}.mogrt"
    if destination.is_file() and destination.stat().st_size > 0:
        return destination
    temporary = destination.with_suffix(".pending")
    try:
        with zipfile.ZipFile(template, "r") as source, zipfile.ZipFile(
            temporary, "w", compression=zipfile.ZIP_DEFLATED
        ) as target:
            modified = False
            for info in source.infolist():
                content = source.read(info.filename)
                if info.filename == "definition.json":
                    definition = json.loads(content.decode("utf-8"))
                    modified = _set_caption_text_in_definition(definition, text, style)
                    content = json.dumps(
                        definition, ensure_ascii=False, separators=(",", ":")
                    ).encode("utf-8")
                target.writestr(info, content)
        if not modified:
            raise ValueError("La plantilla no expone el campo de texto editable.")
        temporary.replace(destination)
        return destination
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": APP_VERSION,
        "silenceDiagnosticsPath": str(SILENCE_DIAGNOSTIC_LOG),
    }


@app.get("/v1/system-fonts")
def system_fonts():
    return {"fonts": get_system_fonts()}


@app.get("/v1/font-file")
def system_font_file(fontName: str):
    """Expone únicamente una fuente instalada al panel local de Premiere."""
    path = find_system_font_file(fontName)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="No se encontró el archivo de la fuente")
    media_type = "font/otf" if path.suffix.casefold() == ".otf" else "font/ttf"
    return FileResponse(
        path,
        media_type=media_type,
        filename=path.name,
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.post("/v1/transcribe")
def transcribe(request: TranscribeRequest):
    try:
        return transcribe_local_media(request)
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/caption-mogrt")
def caption_mogrt(request: CaptionMogrtRequest):
    try:
        output = build_caption_mogrt(
            Path(request.templatePath), request.text.strip(), request.style
        )
        return {"mogrtPath": str(output)}
    except (ValueError, OSError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/preview/register")
def register_preview(request: PreviewRegistrationRequest):
    """Autoriza temporalmente un recurso elegido en Biblioteca Gota.

    UXP no deja a los elementos HTML de vídeo/audio reproducir de forma fiable
    rutas `file:` del disco. El panel registra explícitamente la entrada que el
    usuario ya eligió y recibe una URL local de corta vida; no se enumeran ni se
    exponen carpetas del equipo.
    """
    path = Path(request.mediaPath).expanduser().resolve()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="El archivo de vista previa ya no existe.")
    allowed_extensions = {
        ".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv",
        ".mp3", ".wav", ".m4a", ".aac", ".aif", ".aiff", ".ogg", ".flac",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    }
    if path.suffix.lower() not in allowed_extensions:
        raise HTTPException(status_code=415, detail="Este formato no admite vista previa interna.")
    cleanup_expired_previews()
    token = uuid4().hex
    try:
        preview_path, media_type = make_uxp_preview(path, token)
    except RuntimeError as error:
        raise HTTPException(status_code=422, detail=f"No se pudo preparar la vista previa: {error}") from error
    with preview_lock:
        preview_items[token] = {
            "path": preview_path,
            "mediaType": media_type,
            "createdAt": time(),
        }
    return {
        "token": token,
        "url": f"/v1/preview/{token}",
        "playerUrl": f"/v1/preview/player/{token}",
        "extension": preview_path.suffix.lower(),
        "mediaType": media_type,
    }


@app.post("/v1/clipboard/image", response_model=ClipboardImageResponse)
def paste_clipboard_image():
    """Recibe una imagen del portapapeles local, nunca una URL ni texto remoto."""
    try:
        image_path = capture_clipboard_image()
    except RuntimeError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return ClipboardImageResponse(
        mediaPath=str(image_path),
        filename=image_path.name,
    )


@app.get("/v1/preview/{token}")
def get_preview(token: str):
    cleanup_expired_previews()
    with preview_lock:
        item = preview_items.get(token)
    if not item:
        raise HTTPException(status_code=404, detail="La vista previa venció. Selecciona el archivo otra vez.")
    path = Path(item["path"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="El archivo de vista previa ya no existe.")
    return FileResponse(path, media_type=item.get("mediaType"))


@app.get("/v1/preview/player/{token}")
def get_preview_player(token: str):
    """Reproductor aislado para WebView de UXP.

    El elemento de vídeo normal de un panel UXP puede recibir el archivo pero
    no dibujarlo en algunas versiones de Premiere. WebView usa el reproductor
    multimedia aislado de UXP y mantiene la reproducción dentro del panel.
    """
    cleanup_expired_previews()
    with preview_lock:
        item = preview_items.get(token)
    if not item or not Path(item["path"]).is_file():
        raise HTTPException(status_code=404, detail="La vista previa venció. Selecciona el archivo otra vez.")
    is_audio = str(item.get("mediaType", "")).startswith("audio/")
    tag = "audio" if is_audio else "video"
    style = "width:100%;height:100%;object-fit:contain;background:#0d0f12;"
    return HTMLResponse(
        "<!doctype html><html><head><meta charset='utf-8'><style>"
        "html,body{width:100%;height:100%;margin:0;background:#0d0f12;overflow:hidden;}"
        "audio{margin-top:42%;}"
        "</style></head><body>"
        f"<{tag} controls preload='auto' style='{style}' src='/v1/preview/{token}'></{tag}>"
        "</body></html>"
    )


@app.post("/v3/account/register")
def register_account(request: AccountRequest):
    token, account = license_call(
        lambda: license_store.register(
            request.email, request.password, request.deviceId, request.deviceName
        )
    )
    return {"token": token, "account": account}


@app.post("/v3/account/login")
def login_account(request: AccountRequest):
    token, account = license_call(
        lambda: license_store.login(
            request.email, request.password, request.deviceId, request.deviceName
        )
    )
    return {"token": token, "account": account}


@app.get("/v3/license/status")
def license_status(authorization: str | None = Header(default=None)):
    token = bearer_token(authorization)
    return license_call(lambda: license_store.status(token))


@app.post("/v3/gifts/redeem")
def redeem_gift(
    request: GiftRedeemRequest,
    authorization: str | None = Header(default=None),
):
    token = bearer_token(authorization)
    return license_call(lambda: license_store.redeem(token, request.code))


@app.post("/v3/account/logout", status_code=204)
def logout_account(authorization: str | None = Header(default=None)):
    token = bearer_token(authorization)
    license_store.logout(token)


@app.post("/v3/billing/checkout")
def test_checkout(authorization: str | None = Header(default=None)):
    bearer_token(authorization)
    return {
        "testMode": True,
        "configured": False,
        "monthlyPriceUsd": 3,
        "annualPriceUsd": 30,
        "message": (
            "El pago esta en modo de prueba. Falta conectar la cuenta comercial "
            "de Stripe antes de aceptar cargos."
        ),
    }


@app.post("/v4/license/activate")
def activate_offline_license(request: OfflineLicenseRequest):
    return offline_license_call(
        lambda: activate_license(request.code, request.deviceId)
    )


@app.post("/v4/license/status")
def offline_license_status(request: OfflineLicenseStatusRequest):
    return offline_license_call(
        lambda: current_license_status(request.deviceId)
    )


@app.delete("/v4/license", status_code=204)
def deactivate_offline_license(device_id: str | None = None):
    remove_license(device_id)


@app.get("/v2/profiles")
def get_v2_profiles():
    return PROFILES


@app.post("/v2/jobs", status_code=202)
def create_v2_job(request: AnalyzeV2Request):
    cleanup_expired_jobs()
    job_id = str(uuid4())
    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "createdAt": time(),
            "engine": "2.0",
        }
    executor.submit(run_v2_job, job_id, request)
    return {"jobId": job_id, "status": "queued", "progress": 0}


@app.post("/v3/silence-jobs", status_code=202)
def create_silence_job(request: SilenceRequest):
    cleanup_expired_jobs()
    job_id = str(uuid4())
    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "createdAt": time(),
            "engine": "silence-1.0",
        }
    executor.submit(run_silence_job, job_id, request)
    return {"jobId": job_id, "status": "queued", "progress": 0}


@app.post("/v3/silence-diagnostics", status_code=202)
def append_silence_diagnostic(request: SilenceDiagnosticRequest):
    """Recibe el rastro de edición del panel de Premiere.

    El análisis de audio ya registraba su información. Este endpoint añade las
    fases que pertenecen a Premiere (clonado, compactación y desactivación del
    original), que son las que antes quedaban invisibles al diagnosticar un
    error en macOS.
    """
    return {
        "diagnosticLogPath": write_silence_diagnostic(
            f"premiere_{request.event}", **request.details
        )
    }


@app.post("/v1/analyze", response_model=AnalyzeResponse)
def analyze(request: AnalyzeRequest):
    try:
        return build_result(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/jobs", status_code=202)
def create_job(request: AnalyzeRequest):
    cleanup_expired_jobs()
    job_id = str(uuid4())
    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "createdAt": time(),
        }
    executor.submit(run_job, job_id, request)
    return {"jobId": job_id, "status": "queued", "progress": 0}


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str):
    cleanup_expired_jobs()
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Trabajo no encontrado")
        return dict(job)


@app.delete("/v1/jobs/{job_id}", status_code=204)
def delete_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return
        if job.get("status") in {"queued", "running"}:
            job["cancelRequested"] = True
            job["status"] = "canceling"
        else:
            jobs.pop(job_id, None)
