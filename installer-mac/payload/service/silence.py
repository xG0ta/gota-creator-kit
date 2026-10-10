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
MIN_EFFECTIVE_THRESHOLD_DB = -72.0


def _percentile(values: list[float], ratio: float) -> float:
    if not values:
        return -96.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * ratio)))
    return ordered[index]


def effective_threshold_for_levels(levels: list[float], threshold_db: float) -> float:
    """Calcula un umbral adaptado al ruido y a la voz del propio clip.

    El valor elegido por el usuario ya no se usa como una frontera absoluta.
    Funciona como control de agresividad alrededor de -42 dB. Esto permite
    detectar pausas en una grabación con aire acondicionado a -35 dB sin
    confundir una voz baja de otro clip con silencio.
    """
    if not levels:
        return max(MIN_EFFECTIVE_THRESHOLD_DB, min(float(threshold_db), MAX_SAFE_THRESHOLD_DB))
    requested = max(-96.0, min(float(threshold_db), 0.0))
    noise_reference = _percentile(levels, 0.18)
    speech_reference = _percentile(levels, 0.82)
    dynamic_range = max(0.0, speech_reference - noise_reference)
    if dynamic_range >= 7.0:
        # Separa los dos grupos sin acercarse demasiado a las sílabas suaves.
        adaptive = noise_reference + max(4.0, min(11.0, dynamic_range * 0.42))
    else:
        # En audio casi uniforme es más seguro asumir que hay voz continua.
        adaptive = speech_reference - 9.0
    aggressiveness = (requested - (-42.0)) * 0.5
    threshold = adaptive + aggressiveness
    # Siempre dejamos al menos 6 dB de distancia respecto de la voz típica.
    threshold = min(threshold, speech_reference - 6.0, MAX_SAFE_THRESHOLD_DB)
    return max(MIN_EFFECTIVE_THRESHOLD_DB, threshold)


def _smooth_levels(levels: list[float]) -> list[float]:
    """Suavizado robusto: ignora clics y bajadas de una sola ventana."""
    if not levels:
        return []
    median_levels = []
    for index in range(len(levels)):
        left = max(0, index - 2)
        right = min(len(levels), index + 3)
        local = sorted(levels[left:right])
        median_levels.append(local[len(local) // 2])
    smoothed = []
    for index in range(len(median_levels)):
        left = max(0, index - 2)
        right = min(len(median_levels), index + 3)
        smoothed.append(sum(median_levels[left:right]) / (right - left))
    return smoothed


def _bridge_short_active_islands(mask: list[bool], maximum_windows: int) -> list[bool]:
    """Une una pausa atravesada por un clic o ruido muy breve."""
    result = list(mask)
    index = 0
    while index < len(result):
        if result[index]:
            index += 1
            continue
        start = index
        while index < len(result) and not result[index]:
            index += 1
        if (
            start > 0 and index < len(result) and
            result[start - 1] and result[index] and
            index - start <= maximum_windows
        ):
            result[start:index] = [True] * (index - start)
    return result


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
    smoothed_levels = _smooth_levels(levels)

    # Histéresis: entrar en silencio exige caer claramente por debajo del
    # umbral; para volver a voz hay que superarlo con margen. Así no alterna
    # entre voz/silencio en cada ventana cuando el ruido está justo al límite.
    enter_threshold = effective_threshold - 1.5
    exit_threshold = effective_threshold + 2.5
    silent = bool(smoothed_levels and smoothed_levels[0] < effective_threshold)
    silence_mask = []
    for level in smoothed_levels:
        if silent:
            if level >= exit_threshold:
                silent = False
        elif level <= enter_threshold:
            silent = True
        silence_mask.append(silent)
    silence_mask = _bridge_short_active_islands(
        silence_mask, max(1, round(0.12 / window_seconds))
    )

    intervals = []
    run_start = None
    # El margen conserva un poco de aire en cada extremo; si la pausa es
    # corta, reducimos ese margen de forma simétrica para no convertir el
    # intervalo en uno negativo. La duración mínima se comprueba sobre el
    # intervalo que realmente se va a recortar, no sobre el silencio crudo.
    requested_minimum = max(0.1, float(minimum_silence))
    for index, is_silent in enumerate(silence_mask + [False]):
        if is_silent and run_start is None:
            run_start = index
        elif not is_silent and run_start is not None:
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
            "noiseReferenceDb": round(_percentile(levels, 0.18), 2),
            "speechReferenceDb": round(_percentile(levels, 0.82), 2),
            "requestedMinimumSilenceSeconds": max(0.1, float(minimum_silence)),
            "algorithm": "silence-2.0-adaptive-hysteresis",
        },
    }
