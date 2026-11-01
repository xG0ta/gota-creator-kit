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


# Una pausa más larga que esto dentro de una frase empieza otra línea: si no,
# la palabra destacada se quedaba pegada mientras nadie hablaba.
PAUSE_SECONDS = 0.6
# Al terminar de decirse, la palabra sigue destacada este tiempo como máximo;
# después la línea queda sin destacar hasta la siguiente palabra.
HIGHLIGHT_TAIL_SECONDS = 0.3


def _line(words: list[str], timed: list[dict]) -> dict:
    return {"startSeconds": float(timed[0]["startSeconds"]), "endSeconds": float(timed[-1]["endSeconds"]),
            "text": " ".join(words), "words": timed}


def split_lines(segments: list[dict], maximum_words: int) -> list[dict]:
    """Corta cada frase de Whisper en líneas de pocas palabras.

    Con el tiempo de cada palabra también se corta en las pausas y al final
    de una oración, para que cada línea sea algo que se dice de corrido.
    """
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
        if words and len(timed) == len(words):
            first = 0
            index = 1
            while index <= len(words):
                if index < len(words):
                    gap = float(timed[index]["startSeconds"]) - float(timed[index - 1]["endSeconds"])
                    sentence_end = words[index - 1][-1:] in ".?!…" and index - first >= 2 and gap > 0.15
                    if index - first < limit and gap <= PAUSE_SECONDS and not sentence_end:
                        index += 1
                        continue
                    if index - first >= limit:
                        # Línea llena: mejor cortar después de un signo (¿…?, coma)
                        # que partir la frase a la mitad.
                        ahead = next((stop for stop in range(index + 1, min(len(words), index + 2) + 1)
                                      if words[stop - 1][-1:] in ".?!…"
                                      and all(float(timed[k]["startSeconds"]) - float(timed[k - 1]["endSeconds"])
                                              <= PAUSE_SECONDS for k in range(index, stop))), None)
                        if ahead:
                            # A una o dos palabras termina la pregunta: se deja junta.
                            index = ahead
                        else:
                            for cut in range(index - 1, first + 1, -1):
                                if words[cut - 1][-1:] in ".?!…,;:":
                                    index = cut
                                    break
                result.append(_line(words[first:index], timed[first:index]))
                first = index
                index += 1
            continue
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
        ends = None
        if len(timed) == len(words):
            starts = [_finite(word.get("startSeconds")) for word in timed]
            ends = [_finite(word.get("endSeconds")) for word in timed]
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
            following = safe[index + 1] if index + 1 < len(words) else end
            stop = following
            # Si la palabra ya se dijo y viene un silencio, se quita el
            # destacado en vez de dejarlo pegado hasta la siguiente.
            spoken_end = ends[index] if ends else None
            if spoken_end is not None:
                stop = min(following, max(safe[index] + minimum, spoken_end + HIGHLIGHT_TAIL_SECONDS))
            units.append({
                "text": text,
                "startSeconds": safe[index],
                "endSeconds": stop,
                "highlightIndex": index,
                "lineStart": index == 0,
            })
            if following - stop > 0.05:
                units.append({"text": text, "startSeconds": stop, "endSeconds": following,
                              "highlightIndex": -1, "lineStart": False})
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
