"""Gota Subtítulos: subtítulos animados y títulos con IA local, sin Premiere."""

import os

VERSION = "1.1.3"

# La descarga «xet» de Hugging Face falló y se quedó trabada al bajar el modelo
# de voz grande; la normal por HTTP sí funciona. huggingface_hub lee esta
# variable al importarse, por eso se fija aquí, antes que nada.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
