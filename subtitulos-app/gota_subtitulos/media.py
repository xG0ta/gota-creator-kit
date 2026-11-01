"""Lectura de videos y exportación con FFmpeg (incluido en imageio-ffmpeg)."""
from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

from service.caption_motion import entrance_frames, write_concat

from .system import NO_WINDOW


class Canceled(Exception):
    pass


def ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def probe(path: str) -> dict:
    """Duración, tamaño visible (ya girado), cuadros por segundo y pistas."""
    result = subprocess.run(
        [ffmpeg(), "-nostdin", "-hide_banner", "-i", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW, check=False,
    )
    info = result.stderr
    duration = 0.0
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", info)
    if match:
        duration = int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))
    video = re.search(r"Stream #\d+:\d+[^\n]*?: Video: ([^\n]*)", info)
    width = height = 0
    fps = 30.0
    if video:
        size = re.search(r"(?<![0-9])(\d{2,5})x(\d{2,5})(?![0-9])", video.group(1))
        if size:
            width, height = int(size.group(1)), int(size.group(2))
        rate = re.search(r"(\d+(?:\.\d+)?) (?:fps|tbr)", video.group(1))
        if rate and float(rate.group(1)) > 0:
            fps = min(120.0, float(rate.group(1)))
    # Los videos del celular guardan el giro aparte: FFmpeg y el navegador los
    # muestran girados, así que el lienzo de los subtítulos también se gira.
    rotation = re.search(r"rotation of (-?\d+(?:\.\d+)?) degrees|rotate\s*:\s*(-?\d+)", info)
    if rotation:
        degrees = abs(round(float(rotation.group(1) or rotation.group(2)))) % 180
        if degrees == 90:
            width, height = height, width
    return {
        "path": str(path),
        "name": Path(path).name,
        "duration": duration,
        "width": width,
        "height": height,
        "fps": fps,
        "hasVideo": bool(video),
        "hasAudio": bool(re.search(r"Stream #\d+:\d+[^\n]*?: Audio:", info)),
    }


def extract_audio(path: str, destination: Path) -> Path:
    command = [ffmpeg(), "-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-i", str(path),
               "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(destination)]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                            creationflags=NO_WINDOW, check=False)
    if result.returncode != 0 or not destination.is_file():
        raise RuntimeError(result.stderr.strip()[-400:] or "No se pudo leer el audio del video.")
    return destination


def extract_frames(path: str, duration: float, folder: Path, count: int = 1) -> list[Path]:
    """Algunas imágenes del video (JPG pequeños) para que la IA vea de qué trata."""
    frames = []
    for index in range(count):
        at = max(0.0, duration * (index + 1) / (count + 1))
        destination = folder / f"cuadro-{index + 1}.jpg"
        subprocess.run(
            [ffmpeg(), "-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{at:.2f}", "-i", str(path),
             "-frames:v", "1", "-vf", "scale='min(384,iw)':-2", "-q:v", "5", str(destination)],
            capture_output=True, creationflags=NO_WINDOW, check=False,
        )
        if destination.is_file():
            frames.append(destination)
    return frames


def _run_with_progress(command: list[str], duration: float, on_progress: Callable[[float], None] | None,
                       is_canceled: Callable[[], bool] | None) -> None:
    # Los avisos de FFmpeg van a un archivo y no a otro tubo: en Windows el
    # tubo se llena con pocos KB, FFmpeg se queda esperando y nunca termina.
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as errors:
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=errors, stdin=subprocess.DEVNULL, text=True,
            encoding="utf-8", errors="replace", creationflags=NO_WINDOW,
        )
        try:
            for line in process.stdout:
                if is_canceled and is_canceled():
                    process.kill()
                    raise Canceled()
                if line.startswith("out_time_us=") and on_progress and duration > 0:
                    try:
                        on_progress(min(1.0, int(line.split("=", 1)[1]) / 1_000_000 / duration))
                    except ValueError:
                        pass
            if process.wait() != 0:
                errors.seek(0)
                raise RuntimeError(errors.read().strip()[-600:] or "FFmpeg no pudo exportar el video.")
        finally:
            if process.poll() is None:
                process.kill()


def build_overlay(units: list[dict], render: Callable[[dict], tuple[Path, dict]], keys_for: Callable[[dict], dict],
                  title: tuple[Path, float] | None, video: dict, folder: Path,
                  on_progress: Callable[[float], None] | None = None,
                  is_canceled: Callable[[], bool] | None = None) -> Path:
    """Arma la lista de imágenes con su duración (ffconcat) para FFmpeg.

    El resultado es una «pista» transparente del mismo tamaño que el video:
    subtítulos, entradas animadas y el título, cada uno el tiempo exacto.
    """
    from PIL import Image

    width, height = video["width"], video["height"]
    fps = video["fps"] or 30.0
    total = max(0.1, video["duration"])
    blank = folder / "vacio.png"
    Image.new("RGBA", (width, height), (0, 0, 0, 0)).save(blank, "PNG")

    timeline: list[tuple[Path, float, float]] = []  # (imagen, inicio, fin)
    cursor = 0.0
    for index, unit in enumerate(units):
        if is_canceled and is_canceled():
            raise Canceled()
        start = max(cursor, float(unit["startSeconds"]))
        end = min(total, float(unit["endSeconds"]))
        if end - start < 0.5 / fps:
            continue
        if start > cursor:
            timeline.append((blank, cursor, start))
        image_path, info = render(unit)
        if unit.get("lineStart"):
            for frame_path, length in entrance_frames(image_path, info, keys_for(unit), fps, end - start, folder):
                timeline.append((frame_path, start, start + length))
                start += length
        timeline.append((image_path, start, end))
        cursor = end
        if on_progress:
            on_progress((index + 1) / max(1, len(units)))
    if cursor < total:
        timeline.append((blank, cursor, total))

    if title:
        timeline = _with_title(timeline, title[0], title[1], folder)

    return write_concat(timeline, folder / "pista.ffconcat")


def _with_title(timeline, title_path: Path, title_end: float, folder: Path):
    """Pone el título encima de cada imagen mientras deba verse."""
    from PIL import Image

    title_image = Image.open(title_path).convert("RGBA")
    merged: dict[Path, Path] = {}
    result = []
    for path, start, end in timeline:
        if start >= title_end:
            result.append((path, start, end))
            continue
        if path not in merged:
            combined = Image.open(path).convert("RGBA")
            combined.alpha_composite(title_image)
            destination = folder / f"{path.stem}-con-titulo.png"
            combined.save(destination, "PNG", compress_level=1)
            merged[path] = destination
        split = min(end, title_end)
        result.append((merged[path], start, split))
        if split < end:
            result.append((path, split, end))
    return result


def export_mp4(video: dict, overlay: Path, destination: Path, on_progress=None, is_canceled=None) -> Path:
    command = [
        ffmpeg(), "-nostdin", "-y", "-hide_banner", "-nostats", "-progress", "pipe:1",
        "-i", video["path"], "-f", "concat", "-safe", "0", "-i", str(overlay),
        "-filter_complex", "[1:v]format=rgba[sub];[0:v][sub]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[v]",
        "-map", "[v]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(destination),
    ]
    _run_with_progress(command, video["duration"], on_progress, is_canceled)
    return destination


def export_transparent_mov(video: dict, overlay: Path, destination: Path, on_progress=None, is_canceled=None) -> Path:
    """Solo los subtítulos sobre fondo transparente, para otros editores."""
    fps = video["fps"] or 30.0
    command = [
        ffmpeg(), "-nostdin", "-y", "-hide_banner", "-nostats", "-progress", "pipe:1",
        "-f", "concat", "-safe", "0", "-i", str(overlay),
        "-r", f"{fps:.3f}", "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
        "-vendor", "apl0", str(destination),
    ]
    _run_with_progress(command, video["duration"], on_progress, is_canceled)
    return destination
