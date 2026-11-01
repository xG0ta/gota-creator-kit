"""Servidor local: la pantalla de la app corre en el navegador del usuario."""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
import traceback
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from service.captions import build_caption_png

from . import VERSION, media, system, timeline, titles, transcribe

WEB = Path(__file__).with_name("web")
app = FastAPI(title="Gota Subtítulos", version=VERSION)
# Solo responde a esta computadora: evita que una página web ajena use el
# servidor local con un nombre de dominio que apunte a 127.0.0.1.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])
state: dict = {"video": None, "segments": [], "lastPing": time.time(), "quit": False, "exported": set()}
job_lock = threading.Lock()
job: dict = {"id": 0, "kind": "", "status": "idle", "progress": 0.0, "message": "", "result": None, "error": ""}


def log_path() -> Path:
    return system.data_dir() / "gota-subtitulos.log"


def write_log(message: str) -> None:
    try:
        with log_path().open("a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")
    except OSError:
        pass


def caption_cache() -> Path:
    return system.data_dir() / "imagenes-subtitulos"


class StyleModel(BaseModel):
    style: dict = Field(default_factory=dict)


class TranscribeRequest(BaseModel):
    language: str = "es"
    quality: str = "maxima"
    maxWords: int = 6


class SplitRequest(BaseModel):
    maxWords: int = 6


class UnitsRequest(BaseModel):
    lines: list[dict] = Field(default_factory=list)
    style: dict = Field(default_factory=dict)


class RenderRequest(BaseModel):
    text: str
    style: dict = Field(default_factory=dict)
    highlightIndex: int = -1


class TitleRequest(BaseModel):
    tone: str = ""
    emojis: bool = True
    useImages: bool = False
    model: str = ""
    lines: list[dict] = Field(default_factory=list)


class ExportRequest(BaseModel):
    kind: str = "mp4"
    lines: list[dict] = Field(default_factory=list)
    style: dict = Field(default_factory=dict)
    title: dict = Field(default_factory=dict)


class RevealRequest(BaseModel):
    path: str


class ExportFolderRequest(BaseModel):
    action: str = "choose"  # «choose» abre el selector, «reset» vuelve a la de siempre


def _destination_folder(video_path: str) -> Path:
    folder = system.export_dir()
    if system.same_folder(folder, Path(video_path).parent):
        raise HTTPException(status_code=400, detail=(
            "La carpeta de destino es la misma donde está el video original. Elige otra en «Guardar»: "
            "si esa carpeta la vigila Gota Flow, el video subtitulado se publicaría solo."
        ))
    return folder


class SavedStylesRequest(BaseModel):
    styles: list[dict] = Field(default_factory=list)


class BatchRequest(BaseModel):
    paths: list[str] = Field(default_factory=list)
    language: str = "es"
    quality: str = "maxima"
    maxWords: int = 6
    style: dict = Field(default_factory=dict)
    title: dict = Field(default_factory=dict)


def _start_job(kind: str, target, *args) -> dict:
    with job_lock:
        if job["status"] == "running":
            raise HTTPException(status_code=409, detail="Espera a que termine el trabajo actual.")
        job.update({"id": job["id"] + 1, "kind": kind, "status": "running", "progress": 0.0,
                    "message": "Empezando…", "result": None, "error": "", "cancel": False})
        job_id = job["id"]

    def progress(value: float, message: str | None = None) -> None:
        with job_lock:
            if job["id"] == job_id:
                job["progress"] = max(0.0, min(1.0, float(value)))
                if message:
                    job["message"] = message

    def canceled() -> bool:
        return bool(job.get("cancel")) and job["id"] == job_id

    def runner() -> None:
        try:
            result = target(progress, canceled, *args)
            with job_lock:
                job.update({"status": "done", "progress": 1.0, "result": result, "message": "Listo."})
        except media.Canceled:
            with job_lock:
                job.update({"status": "canceled", "message": "Cancelado."})
        except Exception as error:  # se muestra al usuario y queda en el registro
            write_log(f"{kind} falló: {error}\n{traceback.format_exc()}")
            with job_lock:
                job.update({"status": "error", "error": str(error) or type(error).__name__})

    threading.Thread(target=runner, daemon=True).start()
    return public_job()


def public_job() -> dict:
    with job_lock:
        return {key: job[key] for key in ("id", "kind", "status", "progress", "message", "result", "error")}


def _require_video() -> dict:
    if not state["video"]:
        raise HTTPException(status_code=400, detail="Primero elige un video.")
    return state["video"]


def _style_for_video(style: dict, video: dict | None = None) -> dict:
    video = video or _require_video()
    font = style.get("fontPath") or system.default_font()
    return {**style, "frameWidth": video["width"], "frameHeight": video["height"], "fontPath": font}


def _render(text: str, style: dict, highlight: int = -1):
    font = style.get("fontPath")
    clean = {key: value for key, value in style.items() if key != "fontPath"}
    return build_caption_png(text, {**clean, "highlightIndex": highlight}, caption_cache(), font)


@app.get("/", response_class=HTMLResponse)
def index():
    return (WEB / "index.html").read_text(encoding="utf-8")


@app.get("/api/ping")
def ping():
    state["lastPing"] = time.time()
    return {"app": "gota-subtitulos", "version": VERSION}


@app.get("/api/info")
def info():
    return {
        "version": VERSION,
        "exportFolder": str(system.export_dir()),
        "defaultExportFolder": str(system.default_export_dir()),
        "entrances": timeline.ENTRANCES,
        "defaultTone": titles.DEFAULT_TONE,
        "video": state["video"],
    }


@app.get("/api/fonts")
def fonts():
    default = system.default_font()
    return {"fonts": system.list_fonts(), "default": default}


@app.post("/api/choose-video")
def choose_video():
    path = system.choose_video()
    if not path:
        return {"video": state["video"], "canceled": True}
    info = media.probe(path)
    if not info["hasVideo"] or not info["width"]:
        raise HTTPException(status_code=422, detail="Ese archivo no tiene video. Elige un video (MP4, MOV…).")
    state["video"] = info
    state["segments"] = []
    write_log(f"Video elegido: {info}")
    return {"video": info}


@app.get("/api/video")
def video_file():
    video = _require_video()
    return FileResponse(video["path"])


@app.post("/api/transcribe")
def start_transcription(request: TranscribeRequest):
    video = _require_video()

    def work(progress, canceled):
        result = transcribe.transcribe(video["path"], video["duration"], request.language, request.quality,
                                       progress, canceled)
        state["segments"] = result["segments"]
        return {**result, "lines": timeline.split_lines(result["segments"], request.maxWords)}

    return _start_job("transcribe", work)


@app.post("/api/split")
def split(request: SplitRequest):
    return {"lines": timeline.split_lines(state["segments"], request.maxWords)}


@app.post("/api/units")
def units(request: UnitsRequest):
    highlight = str(request.style.get("style") or "minimal") != "minimal"
    return {"units": timeline.build_units(request.lines, highlight)}


@app.post("/api/render")
def render(request: RenderRequest):
    style = _style_for_video(request.style)
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Texto vacío.")
    path, info = _render(request.text, style, request.highlightIndex)
    return FileResponse(path, media_type="image/png", headers={
        "X-Text-Center-X": str(info["textCenterX"]), "X-Text-Center-Y": str(info["textCenterY"]),
        "Cache-Control": "no-store",
    })


@app.get("/api/ollama")
def ollama_status():
    try:
        models = titles.installed_models()
    except titles.OllamaMissing as error:
        return {"available": False, "message": str(error), "models": []}
    return {"available": True, "models": models, "textModel": titles.pick_text_model(models),
            "visionModel": titles.pick_vision_model(models)}


@app.post("/api/titles")
def start_titles(request: TitleRequest):
    video = _require_video()

    def work(progress, canceled):
        models = titles.installed_models()
        model = request.model if request.model in models else titles.pick_text_model(models)
        if not model:
            raise RuntimeError("Ollama no tiene un modelo de texto. Abre la Terminal y escribe: ollama pull qwen3:4b-instruct")
        transcript = " ".join(str(line.get("text") or "") for line in request.lines).strip()
        scene = ""
        vision = titles.pick_vision_model(models)
        note = ""
        if vision and (request.useImages or len(transcript.split()) < 8):
            # En una Mac Intel sin tarjeta de video esto tarda ~3 minutos; si
            # falla, los títulos salen igual con lo que se dice en el video.
            progress(0.15, f"Mirando el video con {vision} (puede tardar unos minutos)…")
            try:
                with tempfile.TemporaryDirectory(prefix="gota-titulo-") as folder:
                    frames = media.extract_frames(video["path"], video["duration"], Path(folder))
                    if frames:
                        scene = titles.describe_frames(vision, frames)
            except Exception as error:
                write_log(f"La IA no pudo mirar el video: {error}")
                note = "La IA no alcanzó a mirar el video; los títulos usan solo lo que se dice."
        if canceled():
            raise media.Canceled()
        progress(0.5, f"Pensando títulos con {model}…")
        suggestions = titles.suggest_titles(model, transcript, scene, request.tone, request.emojis, video["name"])
        if not suggestions:
            raise RuntimeError("La IA no devolvió títulos. Intenta otra vez.")
        return {"titles": suggestions, "model": model, "scene": scene, "note": note}

    return _start_job("titles", work)


@app.get("/api/job")
def get_job():
    return public_job()


@app.post("/api/job/cancel")
def cancel_job():
    with job_lock:
        if job["status"] == "running":
            job["cancel"] = True
    return public_job()


@app.post("/api/export")
def start_export(request: ExportRequest):
    video = _require_video()
    style = _style_for_video(request.style)
    style_name = str(style.get("style") or "minimal")
    entrance = timeline.entrance_name(style)
    lines = [line for line in request.lines if str(line.get("text") or "").strip()]
    title_text = str(request.title.get("text") or "").strip()
    if not lines and not title_text:
        raise HTTPException(status_code=400, detail="No hay subtítulos ni título para exportar.")
    stem = Path(video["name"]).stem
    target = _destination_folder(video["path"])

    if request.kind == "srt":
        destination = system.unique_path(_destination_folder(video["path"]), f"{stem} - subtítulos", ".srt")
        destination.write_text(timeline.to_srt(lines), encoding="utf-8")
        state["exported"].add(str(destination))
        return {"status": "done", "result": {"path": str(destination)}}

    def work(progress, canceled):
        folder = Path(tempfile.mkdtemp(prefix="gota-export-"))
        try:
            units = timeline.build_units(lines, style_name != "minimal")
            title = None
            if title_text:
                title_style = _style_for_video(request.title.get("style") or {})
                title_path, _ = _render(title_text, title_style)
                seconds = float(request.title.get("seconds") or 0)
                title = (title_path, seconds if seconds > 0 else video["duration"] + 1)
            progress(0.02, "Preparando las imágenes del texto…")
            overlay = media.build_overlay(
                units,
                render=lambda unit: _render(unit["text"], style, unit["highlightIndex"]),
                keys_for=lambda unit: timeline.entrance_keys(entrance, unit["endSeconds"] - unit["startSeconds"]),
                title=title, video=video, folder=folder,
                on_progress=lambda value: progress(0.02 + value * 0.28, "Preparando las imágenes del texto…"),
                is_canceled=canceled,
            )
            if request.kind == "mov":
                destination = system.unique_path(target, f"{stem} - subtítulos transparentes", ".mov")
                exporter = media.export_transparent_mov
            else:
                destination = system.unique_path(target, f"{stem} - subtitulado", ".mp4")
                exporter = media.export_mp4
            progress(0.3, "Creando el video… (no cierres esta ventana)")
            partial = destination.with_name(destination.stem + ".parcial" + destination.suffix)
            try:
                exporter(video, overlay, partial,
                         on_progress=lambda value: progress(0.3 + value * 0.7, "Creando el video…"),
                         is_canceled=canceled)
                partial.replace(destination)
            finally:
                partial.unlink(missing_ok=True)
            state["exported"].add(str(destination))
            return {"path": str(destination)}
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    return _start_job("export", work)


def styles_path() -> Path:
    return system.data_dir() / "mis-estilos.json"


@app.get("/api/styles")
def saved_styles():
    # Se guardan junto a la app y no en el navegador: el puerto puede cambiar
    # entre aperturas y con él se perdería lo guardado en el navegador.
    try:
        return {"styles": json.loads(styles_path().read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        return {"styles": []}


@app.post("/api/styles")
def save_styles(request: SavedStylesRequest):
    styles = [item for item in request.styles if isinstance(item, dict) and str(item.get("name") or "").strip()][:40]
    temporary = styles_path().with_suffix(".tmp")
    temporary.write_text(json.dumps(styles, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(styles_path())
    return {"styles": styles}


@app.post("/api/batch/choose")
def choose_batch():
    paths = system.choose_videos(True)
    videos = []
    for path in paths:
        info = media.probe(path)
        if info["hasVideo"] and info["width"]:
            videos.append(info)
    return {"videos": videos, "skipped": len(paths) - len(videos)}


@app.post("/api/batch")
def start_batch(request: BatchRequest):
    paths = [path for path in request.paths if Path(path).is_file()]
    if not paths:
        raise HTTPException(status_code=400, detail="Elige al menos un video.")
    style_name = str(request.style.get("style") or "minimal")
    entrance = timeline.entrance_name(request.style)
    title_text = str(request.title.get("text") or "").strip()

    def work(progress, canceled):
        done, failed = [], []
        share = 1.0 / len(paths)
        for number, path in enumerate(paths):
            base = number * share
            name = Path(path).name

            def step(value, message, base=base, name=name, number=number):
                progress(base + value * share, f"Video {number + 1} de {len(paths)} · {name}\n{message}")

            folder = Path(tempfile.mkdtemp(prefix="gota-lote-"))
            try:
                video = media.probe(path)
                step(0.0, "Escuchando el video…")
                result = transcribe.transcribe(path, video["duration"], request.language, request.quality,
                                               lambda value, message=None: step(value * 0.6, message or "Escuchando el video…"),
                                               canceled)
                lines = timeline.split_lines(result["segments"], request.maxWords)
                if not lines and not title_text:
                    failed.append({"name": name, "error": "No encontré voz en el video."})
                    continue
                style = _style_for_video(request.style, video)
                title = None
                if title_text:
                    title_path, _ = _render(title_text, _style_for_video(request.title.get("style") or {}, video))
                    seconds = float(request.title.get("seconds") or 0)
                    title = (title_path, seconds if seconds > 0 else video["duration"] + 1)
                overlay = media.build_overlay(
                    timeline.build_units(lines, style_name != "minimal"),
                    render=lambda unit: _render(unit["text"], style, unit["highlightIndex"]),
                    keys_for=lambda unit: timeline.entrance_keys(entrance, unit["endSeconds"] - unit["startSeconds"]),
                    title=title, video=video, folder=folder,
                    on_progress=lambda value: step(0.6 + value * 0.1, "Preparando las imágenes del texto…"),
                    is_canceled=canceled,
                )
                if system.same_folder(system.export_dir(), Path(path).parent):
                    failed.append({"name": name, "error": "Está en la misma carpeta de destino; elige otra carpeta para no guardarlo junto al original."})
                    continue
                destination = system.unique_path(system.export_dir(), f"{Path(path).stem} - subtitulado", ".mp4")
                partial = destination.with_name(destination.stem + ".parcial" + destination.suffix)
                try:
                    media.export_mp4(video, overlay, partial,
                                     on_progress=lambda value: step(0.7 + value * 0.3, "Creando el video…"),
                                     is_canceled=canceled)
                    partial.replace(destination)
                finally:
                    partial.unlink(missing_ok=True)
                state["exported"].add(str(destination))
                done.append({"name": name, "path": str(destination), "lines": len(lines)})
            except media.Canceled:
                raise
            except Exception as error:  # un video malo no detiene a los demás
                write_log(f"Lote: {name} falló: {error}\n{traceback.format_exc()}")
                failed.append({"name": name, "error": str(error) or type(error).__name__})
            finally:
                shutil.rmtree(folder, ignore_errors=True)
        return {"done": done, "failed": failed}

    return _start_job("batch", work)


@app.post("/api/reveal")
def reveal(request: RevealRequest):
    path = Path(request.path)
    # Solo se muestran archivos que la app creó en esta sesión.
    if str(path) not in state["exported"] or not path.exists():
        raise HTTPException(status_code=404, detail="No encontré ese archivo.")
    system.reveal(str(path))
    return {"ok": True}


@app.post("/api/export-folder")
def export_folder(request: ExportFolderRequest):
    if request.action == "reset":
        return {"exportFolder": str(system.set_export_dir(None))}
    chosen = system.choose_folder()
    if not chosen:
        return {"exportFolder": str(system.export_dir()), "canceled": True}
    video = state["video"]
    if video and system.same_folder(chosen, Path(video["path"]).parent):
        raise HTTPException(status_code=400, detail=(
            "Esa es la carpeta del video original. Elige otra: si la vigila Gota Flow, "
            "el video subtitulado se publicaría solo."
        ))
    folder = system.set_export_dir(chosen)
    write_log(f"Carpeta de destino: {folder}")
    return {"exportFolder": str(folder)}


@app.post("/api/open-export-folder")
def open_export_folder():
    folder = system.export_dir()
    if os.name == "nt":
        os.startfile(str(folder))  # type: ignore[attr-defined]
    else:
        import subprocess

        subprocess.run(["open", str(folder)], check=False)
    return {"ok": True}


@app.post("/api/quit")
def quit_app():
    state["quit"] = True
    return {"ok": True}
