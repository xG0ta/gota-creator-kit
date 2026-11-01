"""Transcripción local con Whisper (faster-whisper), sin internet después de
descargar el modelo la primera vez."""
from __future__ import annotations

import gc
import os
import tempfile
from pathlib import Path
from typing import Callable

from .media import Canceled, extract_audio
from .system import data_dir

# «Máxima» usa large-v3-turbo: en un video real con habla rápida y un niño
# acertó mucho más que small (que inventaba palabras); en una Mac Intel tarda
# casi lo mismo que dura el video y el modelo pesa ~1.6 GB (se baja una vez).
MODELS = {"rapida": "base", "precisa": "small", "maxima": "large-v3-turbo"}
BEAMS = {"rapida": 1, "precisa": 5, "maxima": 5}
SIZES = {"base": "140 MB", "small": "480 MB", "large-v3-turbo": "1.6 GB"}
PROMPTS = {
    "es": "Transcripción en español mexicano. Conserva nombres propios, muletillas y palabras coloquiales.",
    "en": None,
}
_loaded: dict[str, object] = {}


def models_dir() -> Path:
    folder = data_dir() / "modelos-voz"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def model_downloaded(name: str) -> bool:
    return any(models_dir().glob(f"models--*faster-whisper-{name}*/snapshots/*/model.bin"))


def read_wav(path: Path):
    """WAV mono de 16 kHz (lo deja así FFmpeg) a números para Whisper.

    Se evita el lector de audio de faster-whisper: depende de PyAV y cambia
    entre versiones (PyAV 15+ rompe faster-whisper 1.1.1).
    """
    import wave

    import numpy as np

    with wave.open(str(path), "rb") as handle:
        frames = handle.readframes(handle.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def _is_memory_error(error: BaseException) -> bool:
    message = str(error).lower()
    return isinstance(error, MemoryError) or any(marker in message for marker in (
        "mkl_malloc", "failed to allocate memory", "out of memory", "not enough memory", "bad allocation",
    ))


def _load(name: str):
    from faster_whisper import WhisperModel

    if name not in _loaded:
        _loaded[name] = WhisperModel(
            name, device="cpu", compute_type="int8", download_root=str(models_dir()),
            cpu_threads=max(1, min(4, os.cpu_count() or 2)),
        )
    return _loaded[name]


def transcribe(path: str, duration: float, language: str, quality: str,
               on_progress: Callable[[float, str], None], is_canceled: Callable[[], bool]) -> dict:
    """Devuelve las frases con el tiempo de cada palabra."""
    requested = MODELS.get(quality, "large-v3-turbo")
    beam = BEAMS.get(quality, 5)
    # Si no alcanza la memoria se prueba con modelos más ligeros.
    order = ["large-v3-turbo", "small", "base", "tiny"]
    candidates = order[order.index(requested):] if requested in order else [requested, "base", "tiny"]
    lang = language if language in ("es", "en") else None
    with tempfile.TemporaryDirectory(prefix="gota-subtitulos-") as folder:
        on_progress(0.02, "Leyendo el audio del video…")
        audio = read_wav(extract_audio(path, Path(folder) / "audio.wav"))
        last_error: BaseException | None = None
        for name in candidates:
            if is_canceled():
                raise Canceled()
            if not model_downloaded(name):
                size = SIZES.get(name, "")
                on_progress(0.05, f"Descargando el modelo de voz{f' ({size})' if size else ''}: solo la primera vez, puede tardar unos minutos…")
            else:
                on_progress(0.05, "Cargando el modelo de voz…")
            try:
                model = _load(name)
                segments, info = model.transcribe(
                    audio, language=lang, vad_filter=True, word_timestamps=True,
                    beam_size=beam, best_of=beam, temperature=0.0, condition_on_previous_text=False,
                    initial_prompt=PROMPTS.get(lang or "", None),
                )
                result = []
                for segment in segments:
                    if is_canceled():
                        raise Canceled()
                    text = str(segment.text or "").strip()
                    if text:
                        result.append({
                            "startSeconds": round(float(segment.start), 3),
                            "endSeconds": round(float(segment.end), 3),
                            "text": text,
                            "words": [
                                {"text": str(word.word).strip(), "startSeconds": round(float(word.start), 3),
                                 "endSeconds": round(float(word.end), 3)}
                                for word in (segment.words or []) if str(word.word).strip()
                            ],
                        })
                    if duration > 0:
                        on_progress(0.08 + 0.9 * min(1.0, float(segment.end) / duration), "Transcribiendo…")
                return {"segments": result, "language": getattr(info, "language", lang), "model": name}
            except Canceled:
                raise
            except Exception as error:
                if not _is_memory_error(error):
                    raise
                last_error = error
                _loaded.pop(name, None)
                gc.collect()
                on_progress(0.05, "Poca memoria: probando con un modelo más ligero…")
        raise RuntimeError(f"No hubo memoria suficiente para transcribir: {last_error}")
