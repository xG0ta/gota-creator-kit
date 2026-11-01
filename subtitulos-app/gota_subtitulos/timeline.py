"""Tiempos de subtítulos: líneas, imágenes por palabra y animación de entrada.

Es la misma lógica que usa el panel de Premiere (splitCaptionByWords y
buildCaptionUnits en plugin/main.js) para que la app externa y el plugin se
vean igual.
"""
from __future__ import annotations

import math

# La animación de entrada vive en service/caption_motion.py: la comparte el
# motor del plugin. Se reexporta aquí para el resto de la app.
from service.caption_motion import ENTRANCES, entrance_keys, entrance_name, interpolate  # noqa: F401


def _finite(value, fallback=None):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def split_lines(segments: list[dict], maximum_words: int) -> list[dict]:
    """Corta cada frase de Whisper en líneas de pocas palabras."""
    limit = max(2, min(16, round(_finite(maximum_words, 6))))
    result = []
    for segment in segments or []:
        words = str(segment.get("text") or "").split()
        timed = [
            word for word in (segment.get("words") or [])
            if str(word.get("text") or "").strip()
            and _finite(word.get("startSeconds")) is not None
            and _finite(word.get("endSeconds")) is not None
        ]
        start = _finite(segment.get("startSeconds"), 0.0)
        end = _finite(segment.get("endSeconds"), start)
        if len(words) <= limit:
            result.append({"startSeconds": start, "endSeconds": end, "text": " ".join(words), "words": timed})
            continue
        duration = max(0.1, end - start)
        for first in range(0, len(words), limit):
            last = min(len(words), first + limit)
            chunk = timed[first:last]
            result.append({
                "startSeconds": float(chunk[0]["startSeconds"]) if chunk else start + duration * first / len(words),
                "endSeconds": float(chunk[-1]["endSeconds"]) if chunk else start + duration * last / len(words),
                "text": " ".join(words[first:last]),
                "words": chunk,
            })
    return result


def build_units(lines: list[dict], highlight_words: bool) -> list[dict]:
    """Una imagen por palabra (con palabra destacada) o una por línea."""
    units = []
    for line in lines or []:
        text = str(line.get("text") or "").strip()
        start = _finite(line.get("startSeconds"))
        end = _finite(line.get("endSeconds"))
        if not text or start is None or end is None or end <= start:
            continue
        words = text.split()
        if not highlight_words:
            units.append({"text": text, "startSeconds": start, "endSeconds": end, "highlightIndex": -1, "lineStart": True})
            continue
        timed = line.get("words") or []
        if len(timed) == len(words):
            starts = [_finite(word.get("startSeconds")) for word in timed]
        else:
            # El usuario cambió las palabras: el tiempo se reparte por longitud.
            total = sum(len(word) for word in words) or 1
            elapsed = 0
            starts = []
            for word in words:
                starts.append(start + (end - start) * elapsed / total)
                elapsed += len(word)
        minimum = min(0.04, (end - start) / len(words))
        previous = start
        safe = []
        for index, value in enumerate(starts):
            if index == 0:
                safe.append(start)
                continue
            wanted = value if value is not None else previous + minimum
            latest = end - minimum * (len(words) - index)
            previous = min(latest, max(previous + minimum, wanted))
            safe.append(previous)
        for index in range(len(words)):
            units.append({
                "text": text,
                "startSeconds": safe[index],
                "endSeconds": safe[index + 1] if index + 1 < len(words) else end,
                "highlightIndex": index,
                "lineStart": index == 0,
            })
    units.sort(key=lambda unit: unit["startSeconds"])
    return units


def to_srt(lines: list[dict]) -> str:
    def stamp(seconds: float) -> str:
        total = max(0, round(seconds * 1000))
        hours, rest = divmod(total, 3_600_000)
        minutes, rest = divmod(rest, 60_000)
        secs, millis = divmod(rest, 1000)
        return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

    blocks = []
    for line in lines:
        text = str(line.get("text") or "").strip()
        start = _finite(line.get("startSeconds"))
        end = _finite(line.get("endSeconds"))
        if not text or start is None or end is None or end <= start:
            continue
        blocks.append(f"{len(blocks) + 1}\n{stamp(start)} --> {stamp(end)}\n{text}\n")
    return "\n".join(blocks)
