from array import array
import math
from pathlib import Path
import subprocess
from typing import Callable


SAMPLE_RATE = 16000
WINDOW_SECONDS = 0.02
WINDOW_SAMPLES = round(SAMPLE_RATE * WINDOW_SECONDS)
# El nivel introducido a mano puede ser muy alto (por ejemplo -10 dB) y haría
# que una conversación normal parezca silencio. Nunca subimos de este límite:
# sigue siendo posible ser agresivo, pero no a costa de cortar palabras.
MAX_SAFE_THRESHOLD_DB = -30.0


def _percentile(values: list[float], ratio: float) -> float:
    if not values:
        return -96.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * ratio)))
    return ordered[index]


def effective_threshold_for_levels(levels: list[float], threshold_db: float) -> float:
    """Evita que voces grabadas bajitas se clasifiquen como silencio.

    Aparte del máximo absoluto, usamos la voz predominante del propio clip
    como referencia. Así una entrevista grabada a bajo volumen conserva su
    diálogo aunque el usuario haya escogido un valor agresivo por accidente.
    """
    requested = min(float(threshold_db), MAX_SAFE_THRESHOLD_DB)
    speech_reference = _percentile(levels, 0.75)
    relative_guard = max(-60.0, min(MAX_SAFE_THRESHOLD_DB, speech_reference - 10.0))
    return min(requested, relative_guard)


def _dbfs(samples) -> float:
    if not samples:
        return -96.0
    square_mean = sum(float(value) * value for value in samples) / len(samples)
    if square_mean <= 0:
        return -96.0
    return max(-96.0, 20.0 * math.log10(math.sqrt(square_mean) / 32768.0))


def intervals_from_levels(
    levels: list[float],
    threshold_db: float,
    start_seconds: float,
    window_seconds: float = WINDOW_SECONDS,
    minimum_silence: float = 0.4,
    padding: float = 0.12,
) -> list[dict]:
    """Devuelve pausas que son seguras de retirar.

    ``minimum_silence`` describe el tramo final que se va a quitar. La
    protección se reserva antes para conservar el borde de las palabras; por
    tanto una pausa que queda demasiado corta después de proteger ambos lados
    no se convierte en corte. Esto evita que una caída breve de volumen se
    convierta en muchos microcortes en clips largos.
    """
    effective_threshold = effective_threshold_for_levels(levels, threshold_db)
    # Suaviza cinco ventanas de 20 ms (100 ms) para no reaccionar a caídas
    # instantáneas del volumen dentro de una palabra.
    smoothed_levels = []
    radius = 2
    for index, _level in enumerate(levels):
        left = max(0, index - radius)
        right = min(len(levels), index + radius + 1)
        smoothed_levels.append(sum(levels[left:right]) / (right - left))

    intervals = []
    run_start = None
    # El margen conserva un poco de aire en cada extremo; si la pausa es
    # corta, reducimos ese margen de forma simétrica para no convertir el
    # intervalo en uno negativo. La duración mínima se comprueba sobre el
    # intervalo que realmente se va a recortar, no sobre el silencio crudo.
    requested_minimum = max(0.1, float(minimum_silence))
    for index, level in enumerate(smoothed_levels + [float("inf")]):
        if level < effective_threshold and run_start is None:
            run_start = index
        elif level >= effective_threshold and run_start is not None:
            raw_start = start_seconds + run_start * window_seconds
            raw_end = start_seconds + index * window_seconds
            raw_duration = raw_end - raw_start
            usable_padding = min(max(0.0, float(padding)), max(0.0, raw_duration / 2 - 0.025))
            cut_start = raw_start + usable_padding
            cut_end = raw_end - usable_padding
            cut_duration = cut_end - cut_start
            if cut_duration >= requested_minimum:
                intervals.append({
                    "startSeconds": round(cut_start, 4),
                    "endSeconds": round(cut_end, 4),
                    "durationSeconds": round(cut_duration, 4),
                    "rawStartSeconds": round(raw_start, 4),
                    "rawEndSeconds": round(raw_end, 4),
                })
            run_start = None
    return intervals


def invert_intervals(
    silences: list[dict], start_seconds: float, end_seconds: float
) -> list[dict]:
    kept = []
    cursor = start_seconds
    for silence in silences:
        silence_start = max(start_seconds, silence["startSeconds"])
        silence_end = min(end_seconds, silence["endSeconds"])
        if silence_start - cursor >= 0.05:
            kept.append({
                "startSeconds": round(cursor, 4),
                "endSeconds": round(silence_start, 4),
                "durationSeconds": round(silence_start - cursor, 4),
            })
        cursor = max(cursor, silence_end)
    if end_seconds - cursor >= 0.05:
        kept.append({
            "startSeconds": round(cursor, 4),
            "endSeconds": round(end_seconds, 4),
            "durationSeconds": round(end_seconds - cursor, 4),
        })
    return kept


def analyze_silences(
    media_path: Path,
    start_seconds: float,
    end_seconds: float,
    threshold_db: float,
    minimum_silence: float,
    padding: float,
    progress_callback: Callable[[float], None] | None = None,
) -> dict:
    try:
        import imageio_ffmpeg
    except ImportError as error:
        raise RuntimeError(
            "Falta el componente de audio. Reinstala Gota Creator Kit."
        ) from error
    duration = max(0.0, end_seconds - start_seconds)
    if duration <= 0:
        raise ValueError("El tramo seleccionado no tiene duración")
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-hide_banner", "-loglevel", "error",
        "-ss", f"{start_seconds:.6f}",
        "-t", f"{duration:.6f}",
        "-i", str(media_path),
        "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-f", "s16le", "-",
    ]
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    levels = []
    bytes_per_window = WINDOW_SAMPLES * 2
    pending = b""
    expected_windows = max(1, math.ceil(duration / WINDOW_SECONDS))
    try:
        while True:
            chunk = process.stdout.read(64 * 1024)
            if not chunk:
                break
            pending += chunk
            while len(pending) >= bytes_per_window:
                window = pending[:bytes_per_window]
                pending = pending[bytes_per_window:]
                samples = array("h")
                samples.frombytes(window)
                levels.append(_dbfs(samples))
            if progress_callback:
                progress_callback(min(0.98, len(levels) / expected_windows))
        if pending:
            samples = array("h")
            samples.frombytes(pending[:len(pending) - len(pending) % 2])
            levels.append(_dbfs(samples))
        if process.wait() != 0:
            raise RuntimeError(
                "No se pudo leer el audio. Comprueba que el clip tenga audio."
            )
    finally:
        if process.poll() is None:
            process.kill()

    effective_threshold = effective_threshold_for_levels(levels, threshold_db)
    silences = intervals_from_levels(
        levels,
        threshold_db,
        start_seconds,
        minimum_silence=minimum_silence,
        padding=padding,
    )
    kept = invert_intervals(silences, start_seconds, end_seconds)
    removed_duration = sum(item["durationSeconds"] for item in silences)
    if progress_callback:
        progress_callback(1.0)
    return {
        "thresholdDb": threshold_db,
        "effectiveThresholdDb": effective_threshold,
        "minimumSilenceSeconds": minimum_silence,
        "paddingSeconds": padding,
        "startSeconds": start_seconds,
        "endSeconds": end_seconds,
        "durationSeconds": round(duration, 4),
        "silences": silences,
        "keptSegments": kept,
        "silenceCount": len(silences),
        "removedDurationSeconds": round(removed_duration, 4),
        "speechDurationSeconds": round(duration - removed_duration, 4),
        "diagnostics": {
            "windowSeconds": WINDOW_SECONDS,
            "levelWindows": len(levels),
            "thresholdWasLimited": effective_threshold != threshold_db,
            "speechReferenceDb": round(_percentile(levels, 0.75), 2),
            "requestedMinimumSilenceSeconds": max(0.1, float(minimum_silence)),
            "algorithm": "silence-1.2-natural-padding",
        },
    }
