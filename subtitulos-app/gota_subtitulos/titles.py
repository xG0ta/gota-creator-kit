"""Títulos graciosos con IA local (Ollama), sin servicios de pago."""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import requests

OLLAMA = "http://127.0.0.1:11434"
# Del más recomendable al menos; se usa el primero que esté instalado.
TEXT_MODELS = ("qwen3:4b-instruct", "qwen2.5:7b", "qwen2.5:3b", "qwen3:8b", "llama3.2:3b", "gemma3:4b")
VISION_HINTS = ("vl", "llava", "vision", "moondream", "minicpm-v")
DEFAULT_TONE = "Gracioso, mexicano, estilo Ramoncito el de Culiacán (humor sinaloense, sin groserías fuertes)"


class OllamaMissing(RuntimeError):
    pass


def installed_models() -> list[str]:
    try:
        response = requests.get(f"{OLLAMA}/api/tags", timeout=4)
        response.raise_for_status()
    except requests.RequestException as error:
        raise OllamaMissing(
            "No encontré Ollama. Instálalo gratis desde ollama.com, ábrelo y descarga un modelo "
            "(por ejemplo: ollama pull qwen3:4b-instruct)."
        ) from error
    return [str(model.get("name")) for model in response.json().get("models", []) if model.get("name")]


def pick_text_model(models: list[str]) -> str | None:
    for wanted in TEXT_MODELS:
        if wanted in models:
            return wanted
    usable = [name for name in models if not any(hint in name.lower() for hint in VISION_HINTS)
              and "embed" not in name.lower()]
    return usable[0] if usable else None


def pick_vision_model(models: list[str]) -> str | None:
    return next((name for name in models if any(hint in name.lower() for hint in VISION_HINTS)), None)


def _chat(model: str, messages: list[dict], schema: dict | None = None, timeout: float = 240) -> str:
    body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "think": False,
        "options": {"temperature": 0.9, "num_ctx": 4096},
    }
    if schema:
        body["format"] = schema
    response = requests.post(f"{OLLAMA}/api/chat", json=body, timeout=timeout)
    if response.status_code == 400 and "think" in response.text:
        # Ollama viejo o modelo sin modo de razonamiento.
        body.pop("think", None)
        response = requests.post(f"{OLLAMA}/api/chat", json=body, timeout=timeout)
    response.raise_for_status()
    return str(response.json().get("message", {}).get("content") or "")


def describe_frames(model: str, frames: list[Path]) -> str:
    images = [base64.b64encode(frame.read_bytes()).decode("ascii") for frame in frames]
    content = _chat(model, [{
        "role": "user",
        "content": "Describe en español, en 2 o 3 frases cortas, qué pasa en estas imágenes de un video "
                   "(personas, lugar, acción, ambiente). Sin inventar nombres.",
        "images": images,
    }], timeout=420)
    return re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()


def suggest_titles(model: str, transcript: str, scene: str, tone: str, with_emojis: bool,
                   video_name: str = "", count: int = 5) -> list[str]:
    transcript = " ".join(transcript.split())[:2500]
    emojis = ("Incluye 1 o 2 emojis que vayan con el chiste en cada título."
              if with_emojis else "No uses emojis.")
    context = []
    if transcript:
        context.append(f"Lo que se dice en el video: «{transcript}»")
    if scene:
        context.append(f"Lo que se ve en el video: {scene}")
    if not context:
        context.append(f"Solo sé el nombre del archivo: {video_name}")
    prompt = (
        "Escribe títulos para poner encima de un video de TikTok.\n"
        f"Tono: {tone or DEFAULT_TONE}.\n"
        + "\n".join(context) + "\n\n"
        f"Reglas: {count} títulos distintos, en español de México, máximo 60 caracteres cada uno, "
        "graciosos y con gancho para que la gente se quede a ver el video (curiosidad, exageración, "
        "«POV:», «Cuando…», «Nadie:», reacción). Deben tener que ver con lo que pasa en el video; "
        f"no inventes datos. Sin hashtags ni comillas. {emojis}"
    )
    schema = {
        "type": "object",
        "properties": {"titulos": {"type": "array", "items": {"type": "string"}}},
        "required": ["titulos"],
    }
    content = _chat(model, [
        {"role": "system", "content": "Eres un creador de contenido mexicano experto en videos virales de TikTok."},
        {"role": "user", "content": prompt},
    ], schema=schema)
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    titles: list[str] = []
    try:
        titles = [str(item) for item in json.loads(content).get("titulos", [])]
    except (json.JSONDecodeError, AttributeError):
        titles = [line for line in content.splitlines() if line.strip()]
    cleaned = []
    for title in titles:
        title = re.sub(r"^\s*(?:\d+[.)-]|[-•*])\s*", "", title).strip().strip('"“”«»').strip()
        title = re.sub(r"\s#\w+", "", title).strip()
        if title and title not in cleaned:
            cleaned.append(title[:90])
    return cleaned[:count]
