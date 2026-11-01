"""Animación de subtítulos horneada en video transparente.

La comparten el motor del plugin (un clip por línea para Premiere) y la app
externa Gota Subtítulos (una pista para todo el video). Solo necesita Pillow
y FFmpeg (imageio-ffmpeg); nada de Premiere.
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

# Entradas: [segundos, valor]. Iguales a CAPTION_ENTRANCES del panel.
ENTRANCES = {
    "gota-pop": {"scale": [[0, 80], [0.08, 108], [0.16, 100]], "opacity": [[0, 0], [0.06, 100]]},
    "impact": {"scale": [[0, 60], [0.09, 115], [0.18, 100]], "opacity": [[0, 0], [0.05, 100]]},
    "minimal": {"scale": None, "opacity": [[0, 0], [0.15, 100]]},
    "none": {"scale": None, "opacity": None},
}

# Cambiar cuando cambie cómo se arma el video de una línea (llave de caché).
CAPTION_CLIP_SCHEMA = "clip-v3"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def entrance_name(style: dict) -> str:
    """La entrada que eligió el usuario o, en «auto», la propia del estilo."""
    wanted = str(style.get("entrance") or "auto")
    if wanted in ENTRANCES:
        return wanted
    name = str(style.get("style") or "minimal")
    return name if name in ENTRANCES else "minimal"


def entrance_keys(style_name: str, duration: float) -> dict:
    """Keyframes de entrada comprimidos si la imagen dura poco."""
    entrance = ENTRANCES.get(style_name) or ENTRANCES["minimal"]
    limit = max(0.04, float(duration) * 0.9)

    def fit(keys):
        if not keys:
            return None
        factor = min(1.0, limit / keys[-1][0]) if keys[-1][0] > 0 else 1.0
        return [[seconds * factor, value] for seconds, value in keys]

    return {"scale": fit(entrance["scale"]), "opacity": fit(entrance["opacity"])}


def interpolate(keys, seconds: float, fallback: float = 100.0) -> float:
    if not keys:
        return fallback
    if seconds <= keys[0][0]:
        return keys[0][1]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if seconds <= t1:
            ratio = (seconds - t0) / (t1 - t0) if t1 > t0 else 1.0
            return v0 + (v1 - v0) * ratio
    return keys[-1][1]


def entrance_frames(base_path: Path, info: dict, keys: dict, fps: float, duration: float,
                    folder: Path) -> list[tuple[Path, float]]:
    """Cuadros de la animación de entrada: escala desde el centro del texto y fundido."""
    from PIL import Image

    last_key = max((keys[name][-1][0] for name in ("scale", "opacity") if keys.get(name)), default=0.0)
    count = min(int(math.ceil(last_key * fps)), max(0, int(duration * fps) - 1))
    if count <= 0:
        return []
    base = Image.open(base_path).convert("RGBA")
    width, height = base.size
    box = base.getchannel("A").getbbox()
    if not box:
        return []
    region = base.crop(box)
    center_x = info["textCenterX"] * width
    center_y = info["textCenterY"] * height
    frames = []
    for index in range(count):
        seconds = index / fps
        scale = interpolate(keys.get("scale"), seconds) / 100.0
        opacity = interpolate(keys.get("opacity"), seconds) / 100.0
        frame = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        if scale > 0.01 and opacity > 0.003:
            size = (max(1, round(region.width * scale)), max(1, round(region.height * scale)))
            piece = region.resize(size, Image.BILINEAR)
            if opacity < 0.999:
                alpha = piece.getchannel("A").point(lambda value: round(value * opacity))
                piece.putalpha(alpha)
            left = round(center_x + (box[0] - center_x) * scale)
            top = round(center_y + (box[1] - center_y) * scale)
            # alpha_composite no acepta posiciones negativas: se recorta lo
            # que quedaría fuera del cuadro.
            crop_left, crop_top = max(0, -left), max(0, -top)
            if crop_left < piece.width and crop_top < piece.height:
                frame.alpha_composite(piece, (max(0, left), max(0, top)), (crop_left, crop_top))
        destination = folder / f"{base_path.stem}-entrada-{index}.png"
        frame.save(destination, "PNG", compress_level=1)
        frames.append((destination, 1.0 / fps))
    return frames


def _concat_path(path: Path) -> str:
    return str(path.resolve()).replace("\\", "/").replace("'", "'\\''")


def write_concat(timeline: list[tuple[Path, float, float]], destination: Path) -> Path:
    """Lista ffconcat: cada imagen con el tiempo exacto que debe verse."""
    lines = ["ffconcat version 1.0"]
    for path, start, end in timeline:
        if end - start <= 0:
            continue
        lines.append(f"file '{_concat_path(path)}'")
        lines.append(f"duration {end - start:.6f}")
    # FFmpeg ignora la duración de la última entrada si no se repite.
    lines.append(f"file '{_concat_path(timeline[-1][0])}'")
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return destination


def line_clip(units: list[dict], render: Callable[[dict], tuple[Path, dict]], entrance: str, fps: float,
              ffmpeg: str, cache_dir: Path, signature: dict) -> tuple[Path, float]:
    """Un MOV transparente con una línea completa: entrada y palabra destacada.

    `units` son las imágenes de una sola línea (una por palabra o una sola).
    El clip empieza en 0 = inicio de la línea. Se usa el códec Animation
    (qtrle): en esta clase de cuadros es unas 6 veces más rápido y ligero que
    ProRes 4444, y Premiere lo lee en Mac y Windows.
    """
    units = sorted(units, key=lambda unit: float(unit["startSeconds"]))
    origin = float(units[0]["startSeconds"])
    end = max(float(unit["endSeconds"]) for unit in units)
    fps = max(1.0, min(120.0, float(fps or 30.0)))
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = json.dumps({"schema": CAPTION_CLIP_SCHEMA, "units": units, "entrance": entrance, "fps": round(fps, 3),
                      **signature}, sort_keys=True, ensure_ascii=False, default=str)
    destination = cache_dir / f"{hashlib.sha256(key.encode('utf-8')).hexdigest()}.mov"
    if destination.exists():
        return destination, end - origin
    with tempfile.TemporaryDirectory(prefix="gota-linea-") as folder:
        folder = Path(folder)
        timeline: list[tuple[Path, float, float]] = []
        cursor = 0.0
        for index, unit in enumerate(units):
            start = max(cursor, float(unit["startSeconds"]) - origin)
            stop = float(unit["endSeconds"]) - origin
            if stop - start < 0.5 / fps:
                continue
            image_path, info = render(unit)
            if index == 0:
                keys = entrance_keys(entrance, stop - start)
                for frame_path, length in entrance_frames(image_path, info, keys, fps, stop - start, folder):
                    timeline.append((frame_path, start, start + length))
                    start += length
            timeline.append((image_path, start, stop))
            cursor = stop
        if not timeline:
            raise ValueError("La línea dura menos de un cuadro.")
        # Cada cuadro se calcula aquí y se le pasa a FFmpeg tal cual. Con una
        # lista ffconcat de imágenes fijas los tiempos no salían exactos y el
        # clip quedaba más largo o más corto que la línea.
        from PIL import Image

        width, height = Image.open(timeline[0][0]).size
        count = max(1, round((end - origin) * fps))
        partial = destination.with_suffix(".parcial.mov")
        pixels: dict[Path, bytes] = {}
        with tempfile.TemporaryFile() as errors:
            process = subprocess.Popen(
                [ffmpeg, "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
                 "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{width}x{height}", "-r", f"{fps:.5f}", "-i", "-",
                 "-c:v", "qtrle", "-pix_fmt", "argb", str(partial)],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors, creationflags=NO_WINDOW,
            )
            try:
                entry = 0
                for index in range(count):
                    middle = (index + 0.5) / fps
                    while entry + 1 < len(timeline) and timeline[entry + 1][1] <= middle:
                        entry += 1
                    path = timeline[entry][0]
                    if path not in pixels:
                        pixels[path] = Image.open(path).convert("RGBA").tobytes()
                    process.stdin.write(pixels[path])
                process.stdin.close()
                code = process.wait()
            finally:
                if process.poll() is None:
                    process.kill()
            if code != 0 or not partial.is_file():
                errors.seek(0)
                partial.unlink(missing_ok=True)
                message = errors.read().decode("utf-8", errors="replace").strip()
                raise RuntimeError(message[-400:] or "FFmpeg no pudo crear el video del subtítulo.")
        partial.replace(destination)
    return destination, end - origin
