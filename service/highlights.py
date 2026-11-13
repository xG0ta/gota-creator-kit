"""Mejores momentos: elige los clips más interesantes de una conversación larga.

Idea tomada de «La perra que hace mi trabajo» (app de escritorio de un amigo
del usuario) y adaptada al motor de Gota Creator Kit:

  1. Whisper local transcribe el clip (lo hace main.py).
  2. Ollama local lee la transcripción por partes de ~10 minutos y propone
     momentos con puntaje (historia, pregunta con respuesta, humor, opinión
     fuerte, consejo, momento emotivo).
  3. Cada candidato se ajusta al inicio y al fin de una frase, sin encimarse
     con los demás, y la IA lo vuelve a leer solo para confirmar que se
     entiende sin contexto.
  4. Se entregan los N mejores con un título de dos líneas.

Sin Ollama se usa un plan B transparente: bloques de conversación continua
repartidos por el video. Todo es local y gratis.
"""
from __future__ import annotations

import json
import math
import re
import urllib.error
import urllib.request
from typing import Callable

OLLAMA_URL = "http://127.0.0.1:11434"
# Del más recomendable al menos; se usa el primero que esté instalado.
TEXT_MODELS = ("qwen3:4b-instruct", "qwen3:4b", "qwen2.5:7b", "qwen2.5:3b", "qwen3:8b", "llama3.2:3b", "gemma3:4b")
VISION_HINTS = ("vl", "llava", "vision", "moondream", "minicpm-v")
GAP_SECONDS = 20.0   # separación preferida entre clips: evita el mismo momento con variaciones
MIN_SCORE = 6.0      # puntaje (1-10) a partir del cual un momento se considera bueno

PLACEHOLDER_REASONS = {"", "...", "una frase", "de qué trata, en pocas palabras", "de que trata, en pocas palabras"}

Ask = Callable[[str, dict], dict]
Progress = Callable[[float, str], None]


class OllamaUnavailable(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Ollama
# --------------------------------------------------------------------------
def _http_json(path: str, body: dict | None = None, timeout: float = 5.0) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        OLLAMA_URL + path, data=data,
        headers={"content-type": "application/json"} if data else {},
        method="POST" if data else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def installed_models() -> list[str]:
    try:
        tags = _http_json("/api/tags", timeout=4)
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise OllamaUnavailable("Ollama no está abierto en este equipo.") from error
    return [str(item.get("name")) for item in tags.get("models", []) if item.get("name")]


def pick_text_model(models: list[str], preferred: str = "") -> str | None:
    if preferred and preferred in models:
        return preferred
    for wanted in TEXT_MODELS:
        if wanted in models:
            return wanted
    usable = [name for name in models
              if not any(hint in name.lower() for hint in VISION_HINTS) and "embed" not in name.lower()]
    return usable[0] if usable else None


def ollama_ask(model: str) -> Ask:
    """Devuelve una función que manda un prompt y regresa el JSON que contestó el modelo."""
    def ask(prompt: str, options: dict) -> dict:
        body = {
            "model": model, "prompt": prompt, "stream": False, "think": False, "format": "json",
            "options": options,
        }
        try:
            data = _http_json("/api/generate", body, timeout=600)
        except urllib.error.HTTPError as error:
            if error.code != 400:
                raise
            body.pop("think", None)   # Ollama viejo o modelo sin modo de razonamiento
            data = _http_json("/api/generate", body, timeout=600)
        return parse_json_object(str(data.get("response") or ""))
    return ask


def parse_json_object(raw: str) -> dict:
    raw = re.sub(r"<think>.*?</think>", "", raw or "", flags=re.S)
    try:
        value = json.loads(raw)
    except ValueError:
        match = re.search(r"\{.*\}", raw, re.S)
        if not match:
            return {}
        try:
            value = json.loads(match.group(0))
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


# --------------------------------------------------------------------------
# Utilidades de tiempo
# --------------------------------------------------------------------------
def _norm(segments: list[dict]) -> list[dict]:
    """Acepta el formato del motor (startSeconds/endSeconds) o el corto (start/end)."""
    out = []
    for item in segments:
        start = float(item.get("startSeconds", item.get("start", 0)))
        end = float(item.get("endSeconds", item.get("end", start)))
        text = " ".join(str(item.get("text") or "").split())
        if text and end > start:
            out.append({"start": start, "end": end, "text": text})
    out.sort(key=lambda s: s["start"])
    return out


def _clock(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, rest = divmod(seconds, 3600)
    return (f"{hours}:" if hours else "") + f"{rest // 60:02d}:{rest % 60:02d}"


def split_windows(segments: list[dict], window_seconds: float) -> list[list[dict]]:
    windows, current, window_start = [], [], 0.0
    for segment in segments:
        if current and segment["end"] - window_start > window_seconds:
            windows.append(current)
            current = []
        if not current:
            window_start = segment["start"]
        current.append(segment)
    if current:
        windows.append(current)
    return windows


def text_between(segments: list[dict], start: float, end: float, limit: int = 3000) -> str:
    text = " ".join(s["text"] for s in segments if s["end"] > start and s["start"] < end).strip()
    if len(text) > limit:
        half = limit // 2
        text = text[:half] + " [...] " + text[-half:]
    return text


def _overlaps(clip: dict, others: list[dict], gap: float) -> bool:
    return any(clip["start"] < other["end"] + gap and clip["end"] + gap > other["start"] for other in others)


def snap_to_sentences(candidate: dict, segments: list[dict], length: float, range_start: float, range_end: float) -> dict:
    """Empieza al inicio de una frase y termina al final de otra, con un largo cercano al pedido."""
    starts = [s["start"] for s in segments]
    ends = [s["end"] for s in segments]
    tolerance = min(0.25, max(3.0, length * 0.12) / max(1.0, length))

    def nearest(values: list[float], target: float, low: float, high: float) -> float | None:
        pool = [v for v in values if low <= v <= high]
        return min(pool, key=lambda v: abs(v - target)) if pool else None

    a0 = max(range_start, float(candidate["start"]))
    start = nearest(starts, a0, a0 - 4, a0 + 4)
    start = a0 if start is None else start
    low, high = start + length * (1 - tolerance), start + length * (1 + tolerance)
    wanted = float(candidate.get("end", start + length))
    target = wanted if low <= wanted <= high else start + length
    end = nearest(ends, target, low, high)
    end = start + length if end is None else end
    if end > range_end:
        end = range_end
        start = max(range_start, end - length)
        snapped = nearest(starts, start, start, start + 4)
        start = snapped if snapped is not None and end - snapped >= length * 0.6 else start
    return {**candidate, "start": round(start, 2), "end": round(end, 2)}


def fallback_candidates(segments: list[dict], length: float, range_start: float, range_end: float) -> list[dict]:
    """Plan B sin IA: bloques de conversación continua (pocas pausas) repartidos por el video."""
    candidates = []
    for index, segment in enumerate(segments):
        if segment["start"] + length > range_end + 0.5:
            break
        window_end = segment["start"] + length
        inside = [s for s in segments[index:] if s["start"] < window_end]
        spoken = sum(min(s["end"], window_end) - s["start"] for s in inside)
        words = sum(len(s["text"].split()) for s in inside)
        density = spoken / max(1.0, length)
        candidates.append({
            "start": segment["start"], "end": window_end,
            "score": round(2 + 4 * min(1.0, density) + min(2.0, words / max(1.0, length) / 1.5), 2),
            "reason": "Bloque continuo de conversación (elegido sin IA)",
        })
    return candidates


# --------------------------------------------------------------------------
# Selección
# --------------------------------------------------------------------------
def propose_with_ai(segments: list[dict], length: float, count: int, ask: Ask,
                    progress: Progress, check: Callable[[], None]) -> list[dict]:
    low, high = max(3, int(length * 0.75)), int(length * 1.25) + 1
    windows = split_windows(segments, max(600.0, min(length * 3, 2700.0)))
    per_window = max(2, math.ceil(count * 1.5 / max(1, len(windows))))
    candidates = []
    for index, window in enumerate(windows, 1):
        check()
        progress(0.55 * (index - 1) / len(windows), f"La IA busca momentos: parte {index} de {len(windows)}")
        w_start, w_end = window[0]["start"], window[-1]["end"]
        lines = "\n".join(f"[{s['start']:.1f}-{s['end']:.1f}] {s['text']}" for s in window)
        prompt = (
            "Eres editor profesional de podcasts y videos en español. Abajo hay una parte de la transcripción; "
            "cada línea es [inicio-fin en segundos] texto.\n\nTRANSCRIPCIÓN:\n@@TEXTO@@\n\n"
            f"TAREA: elige los {per_window} mejores momentos de ESTA parte para clips de redes, del mejor al peor. "
            "Un buen momento es una historia con principio y final, una pregunta con su respuesta, humor, una opinión "
            "fuerte, un consejo concreto o un momento emotivo, y se entiende solo, sin contexto. Cada clip empieza al "
            f"inicio de una frase y dura entre {low} y {high} segundos (puedes juntar líneas seguidas). NO elijas "
            "saludos, despedidas, silencios, relleno ni frases sueltas. Si hay pocos buenos, da igual los mejores con "
            "un score bajo y honesto. Usa SOLO tiempos que aparezcan en la transcripción. Score de 1 a 10 (10 = excelente). "
            "Responde ÚNICAMENTE con JSON en este formato exacto: "
            f"{{\"clips\":[{{\"start\":{w_start:.1f},\"end\":{min(w_end, w_start + length):.1f},\"score\":8,"
            "\"reason\":\"de qué trata, en pocas palabras\"}]}"
        ).replace("@@TEXTO@@", lines)   # después de armar el texto: un «{» o «%» hablado no rompe nada
        context = min(32768, max(4096, (int(len(prompt) / 3.2) + 800) // 1024 * 1024 + 1024))
        try:
            answer = ask(prompt, {"temperature": 0.2, "num_ctx": context, "num_predict": 1200})
        except Exception:   # noqa: BLE001 - una parte fallida no tumba el resto
            continue
        for item in answer.get("clips") or []:
            try:
                start, end = float(item["start"]), float(item["end"])
            except (KeyError, TypeError, ValueError):
                continue
            if not (w_start - 1 <= start <= w_end) or end <= start:
                continue   # tiempos inventados o de otra parte
            try:
                score = float(item.get("score", 5))
            except (TypeError, ValueError):
                score = 5.0
            candidates.append({
                "start": start, "end": end, "score": max(0.0, min(10.0, score)),
                "reason": "" if str(item.get("reason") or "").strip(" .").lower() in PLACEHOLDER_REASONS
                else " ".join(str(item.get("reason") or "").split())[:140],
            })
    return candidates


def review_with_ai(clip: dict, segments: list[dict], ask: Ask) -> tuple[float, str] | None:
    """Segunda pasada: la IA lee solo el clip y dice si se entiende solo y si engancha."""
    text = text_between(segments, clip["start"], clip["end"])
    if not text:
        return None
    prompt = (
        "Eres editor de clips para redes en español. Evalúa si este fragmento funciona como clip independiente.\n\n"
        f"TRANSCRIPCIÓN DEL FRAGMENTO:\n{text}\n\n"
        "CRITERIOS: (1) se entiende sin haber visto lo anterior; (2) empieza y termina de forma natural, sin quedar a "
        "media idea; (3) es interesante: historia, humor, opinión fuerte, consejo o momento emotivo. Sé exigente: un "
        "saludo, relleno o una charla sin gancho merece nota baja. Responde ÚNICAMENTE con JSON: "
        "{\"completo\":true,\"interes\":7,\"motivo\":\"...\"} (interes de 1 a 10; motivo = en pocas palabras de qué trata "
        "el clip y por qué engancha)."
    )
    try:
        answer = ask(prompt, {"temperature": 0.1, "num_ctx": 4096, "num_predict": 150})
        interest = float(answer.get("interes", 0))
    except Exception:   # noqa: BLE001 - se conserva su puntaje original
        return None
    if answer.get("completo") is False:
        interest -= 3
    reason = " ".join(str(answer.get("motivo") or "").split())[:140]
    if reason.strip(" .").lower() in PLACEHOLDER_REASONS:
        reason = ""   # el modelo copió el ejemplo: se queda el motivo de la primera pasada
    return max(0.0, min(10.0, interest)), reason


def title_with_ai(clip: dict, segments: list[dict], ask: Ask | None) -> dict:
    text = text_between(segments, clip["start"], clip["end"], 2600) or clip.get("reason", "")
    clean = lambda value: " ".join(re.sub(r"[^\wÁÉÍÓÚÜÑáéíóúüñ¿?¡! ]", "", str(value or "")).upper().split())[:48]
    if ask is not None:
        prompt = (
            "Eres editor de clips virales en español de México. Lee la transcripción del clip y escribe un título "
            "que diga de qué trata de verdad, para que alguien quiera verlo.\n\nREGLAS: usa solo hechos y palabras de la "
            "transcripción; no inventes nombres ni polémicas (no se sabe quién habla). Primero resume el clip en una "
            "frase (resumen). Luego line1 (el tema o gancho) y line2 (el giro o el detalle curioso): de 2 a 6 palabras "
            "cada una, en MAYÚSCULAS, sin emojis, sin comillas y sin repetir lo mismo.\n"
            "Ejemplo: {\"resumen\":\"Cuenta cómo perdió sus ahorros con un amigo\",\"line1\":\"PERDIÓ TODOS SUS AHORROS\","
            "\"line2\":\"POR CONFIAR EN UN AMIGO\"}\n\n"
            f"PISTA DEL EDITOR (manda la transcripción): {str(clip.get('reason', ''))[:140]}\n\n"
            f"TRANSCRIPCIÓN DEL CLIP:\n{text}\n\nResponde ÚNICAMENTE con el JSON (resumen, line1, line2)."
        )
        try:
            answer = ask(prompt, {"temperature": 0.3, "num_predict": 300})
            line1, line2 = clean(answer.get("line1")), clean(answer.get("line2"))
            if line1 and line2:
                return {"line1": line1, "line2": line2, "summary": " ".join(str(answer.get("resumen") or "").split())[:200]}
        except Exception:   # noqa: BLE001 - se usa el respaldo
            pass
    words = text.split()
    return {"line1": clean(" ".join(words[:5])) or "UN MOMENTO DEL VIDEO",
            "line2": clean(" ".join(words[5:10])), "summary": ""}


def select_highlights(segments: list[dict], clip_seconds: float, count: int, range_start: float, range_end: float,
                      ask: Ask | None = None, progress: Progress | None = None,
                      check: Callable[[], None] | None = None) -> dict:
    """Devuelve {"clips": [...], "usedAi": bool, "notes": [...]}. Los tiempos son del archivo original."""
    progress = progress or (lambda value, text="": None)
    check = check or (lambda: None)
    segments = _norm(segments)
    notes: list[str] = []
    if not segments:
        raise ValueError("No se escuchó conversación en el clip: no hay de dónde sacar momentos.")
    count = max(1, min(30, int(count)))
    length = max(5.0, min(600.0, float(clip_seconds)))
    available = range_end - range_start
    if available < length:
        raise ValueError(f"El clip dura {_clock(available)} y pediste momentos de {_clock(length)}.")

    candidates = propose_with_ai(segments, length, count, ask, progress, check) if ask else []
    used_ai = bool(candidates)
    if ask and not candidates:
        notes.append("La IA no propuso momentos utilizables; se eligieron por cantidad de conversación.")
    if not candidates:
        candidates = fallback_candidates(segments, length, range_start, range_end)

    snapped = [snap_to_sentences(c, segments, length, range_start, range_end) for c in candidates]
    snapped = [c for c in snapped if c["end"] - c["start"] >= length * 0.6]
    snapped.sort(key=lambda c: -c["score"])
    pool: list[dict] = []
    wanted = max(count, int(math.ceil(count * 1.5))) if used_ai else count
    for gap in (GAP_SECONDS, 10.0, 5.0, 0.0):   # primero bien separados; si no alcanzan, más juntos (nunca encimados)
        for clip in snapped:
            if len(pool) >= wanted:
                break
            if clip not in pool and not _overlaps(clip, pool, gap):
                pool.append(clip)
        if len(pool) >= wanted:
            break

    if used_ai:
        for index, clip in enumerate(pool, 1):
            check()
            progress(0.55 + 0.25 * (index - 1) / max(1, len(pool)), f"La IA revisa el clip {index} de {len(pool)}")
            reviewed = review_with_ai(clip, segments, ask)
            if reviewed:
                clip["score"] = round((clip["score"] + reviewed[0] * 2) / 3, 1)
                if reviewed[1]:
                    clip["reason"] = reviewed[1]
        pool.sort(key=lambda c: -c["score"])
        if sum(1 for c in pool if c["score"] >= MIN_SCORE) < min(count, len(pool)):
            notes.append("Hay pocos momentos muy buenos; se completó con los siguientes mejores.")

    chosen = pool[:count]
    if len(chosen) < count:
        notes.append(f"Solo salieron {len(chosen)} momentos distintos de {count}: el video no da para más sin repetir.")
    for index, clip in enumerate(chosen, 1):
        check()
        progress(0.8 + 0.2 * (index - 1) / max(1, len(chosen)), f"Escribiendo título {index} de {len(chosen)}")
        clip.update(title_with_ai(clip, segments, ask if used_ai else None))
        clip["text"] = text_between(segments, clip["start"], clip["end"], 400)
    chosen.sort(key=lambda c: -c["score"])
    for rank, clip in enumerate(chosen, 1):
        clip["rank"] = rank
        clip["startSeconds"] = clip.pop("start")
        clip["endSeconds"] = clip.pop("end")
        clip["score"] = round(float(clip["score"]), 1)
    progress(1.0, "Momentos listos")
    return {"clips": chosen, "usedAi": used_ai, "notes": notes}
