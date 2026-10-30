"""Render de subtítulos y títulos como PNG transparentes.

Lo usan el motor del plugin de Premiere y la app externa Gota Subtítulos.
Vive aparte de app/main.py para poder probarse solo con Pillow, sin FastAPI,
OpenCV ni Whisper. Cada PNG mide exactamente lo mismo que el video o la
secuencia, así se coloca sin escalarlo, sea vertical, horizontal o cuadrado.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from functools import lru_cache
from pathlib import Path

# Cambiar cuando cambie el aspecto de los PNG generados. Forma parte de la
# llave de caché para no reutilizar imágenes de una versión anterior.
CAPTION_PNG_SCHEMA = "png-v3"

REFERENCE_SHORT_SIDE = 1080.0
DEFAULT_FRAME = (1080, 1920)
SIDE_MARGIN_RATIO = 80.0 / 1080.0
IMPACT_TEXT_COLOR = "#101216"
IMPACT_BOX_PAD = (0.12, 0.08)  # proporción del tamaño de letra (x, y)
TITLE_BOX_PAD = (0.28, 0.14)
EMOJI_HEIGHT = 0.92  # alto del emoji respecto al tamaño de letra

# Bloques Unicode donde viven los emojis. Pillow sin libraqm no une
# secuencias (familias, banderas, tonos de piel): se dibuja el emoji base.
_EMOJI_RANGES = (
    (0x1F000, 0x1FAFF), (0x2600, 0x27BF), (0x2300, 0x23FF), (0x2B00, 0x2BFF),
    (0x2190, 0x21FF), (0x3030, 0x3030), (0x303D, 0x303D), (0x3297, 0x3299),
)
_EMOJI_JOINERS = {0x200D, 0xFE0F, 0xFE0E, 0x20E3}
_SKIN_TONES = (0x1F3FB, 0x1F3FF)
_REGIONAL = (0x1F1E6, 0x1F1FF)


def _color(value: object, fallback: str) -> str:
    raw = str(value or "").strip()
    if raw.startswith("#") and len(raw) in (4, 7, 9):
        if all(char in "0123456789abcdefABCDEF" for char in raw[1:]):
            return raw
    return fallback


def _number(value: object, fallback: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:  # NaN
        return fallback
    return max(minimum, min(maximum, number))


def frame_size(style: dict) -> tuple[int, int]:
    """Tamaño de la secuencia que manda el panel; 1080x1920 si no llegó."""
    width = int(round(_number(style.get("frameWidth"), 0, 0, 8192)))
    height = int(round(_number(style.get("frameHeight"), 0, 0, 8192)))
    if width < 160 or height < 160:
        return DEFAULT_FRAME
    return width, height


def apply_case(text: str, case: str) -> str:
    if case == "upper":
        return text.upper()
    if case == "lower":
        return text.lower()
    if case == "title":
        return " ".join(word[:1].upper() + word[1:] for word in text.split(" "))
    return text


@lru_cache(maxsize=32)
def _load_font(font_path: str | None, size: int):
    from PIL import ImageFont

    if font_path:
        try:
            return ImageFont.truetype(font_path, size)
        except OSError:
            pass
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def _is_emoji(code: int) -> bool:
    return any(low <= code <= high for low, high in _EMOJI_RANGES)


def split_runs(word: str) -> list[tuple[str, bool]]:
    """Separa una palabra en tramos de texto normal y emojis sueltos."""
    runs: list[tuple[str, bool]] = []
    text = ""
    index = 0
    while index < len(word):
        code = ord(word[index])
        if _is_emoji(code) and not (_SKIN_TONES[0] <= code <= _SKIN_TONES[1]):
            if text:
                runs.append((text, False))
                text = ""
            if not (_REGIONAL[0] <= code <= _REGIONAL[1]):
                runs.append((word[index], True))
            index += 1
            # Modificadores y uniones del mismo emoji: se omiten.
            while index < len(word):
                following = ord(word[index])
                if following in _EMOJI_JOINERS or _SKIN_TONES[0] <= following <= _SKIN_TONES[1]:
                    index += 2 if following == 0x200D else 1
                elif _REGIONAL[0] <= following <= _REGIONAL[1] and _REGIONAL[0] <= code <= _REGIONAL[1]:
                    index += 1
                else:
                    break
            continue
        if code in _EMOJI_JOINERS or _SKIN_TONES[0] <= code <= _SKIN_TONES[1]:
            index += 1
            continue
        text += word[index]
        index += 1
    if text:
        runs.append((text, False))
    return runs


@lru_cache(maxsize=1)
def emoji_font_path() -> str | None:
    if sys.platform == "darwin":
        candidates = ["/System/Library/Fonts/Apple Color Emoji.ttc"]
    elif os.name == "nt":
        candidates = [str(Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "seguiemj.ttf")]
    else:
        candidates = ["/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
                      "/usr/share/fonts/noto/NotoColorEmoji.ttf"]
    return next((path for path in candidates if Path(path).exists()), None)


@lru_cache(maxsize=512)
def _emoji_image(char: str, height: int):
    """Emoji a color escalado a `height` píxeles, o None si no hay fuente.

    Las fuentes de emoji de mapa de bits (Apple, Noto) solo aceptan tamaños
    fijos: se dibuja en el más grande disponible y luego se reduce.
    """
    from PIL import Image, ImageDraw, ImageFont

    path = emoji_font_path()
    if not path or height < 2:
        return None
    for native in (160, 137, 128, 109, 96, 64):
        try:
            font = ImageFont.truetype(path, native)
            canvas = Image.new("RGBA", (native * 2, native * 2), (0, 0, 0, 0))
            ImageDraw.Draw(canvas).text((native // 4, native // 4), char, font=font, embedded_color=True)
        except (OSError, ValueError):
            continue
        box = canvas.getbbox()
        if not box:
            return None
        glyph = canvas.crop(box)
        ratio = height / glyph.height
        return glyph.resize((max(1, round(glyph.width * ratio)), height), Image.LANCZOS)
    return None


def _run_width(run: tuple[str, bool], font, size: int) -> float:
    text, emoji = run
    if not emoji:
        return font.getlength(text)
    image = _emoji_image(text, max(2, round(size * EMOJI_HEIGHT)))
    return (image.width if image else 0) + size * 0.06


def measure_word(word: str, font, size: int) -> float:
    return sum(_run_width(run, font, size) for run in split_runs(word))


def layout_caption(text: str, style: dict, font_path: str | None) -> dict:
    """Reparte las palabras en renglones que caben en el cuadro.

    La distribución no depende de qué palabra esté destacada: todas las
    imágenes de una misma frase comparten posiciones y el texto no brinca.
    """
    width, height = frame_size(style)
    scale = min(width, height) / REFERENCE_SHORT_SIDE
    size = max(8, round(_number(style.get("fontSize"), 42, 8, 260) * scale))
    stroke = round(_number(style.get("strokeSize"), 0, 0, 40) * scale)
    font = _load_font(font_path, size)
    words = [word for word in text.split() if split_runs(word)]
    margin = width * SIDE_MARGIN_RATIO
    max_width = max(size * 2.0, width - margin * 2)
    # La palabra destacada crece un poco y en Impacto lleva recuadro. El
    # espacio extra (como el `gap` de la vista previa) evita que tape a sus
    # vecinas.
    mode = _highlight_mode(style)
    space = font.getlength(" ")
    if mode == "impact":
        space = max(space, size * 0.55)
    elif mode == "gota-pop":
        space = max(space, size * 0.36)
    if _is_title_box(style):
        max_width -= size * TITLE_BOX_PAD[0] * 2
    widths = [measure_word(word, font, size) for word in words]

    lines: list[list[int]] = []
    current: list[int] = []
    current_width = 0.0
    for index, word_width in enumerate(widths):
        extra = word_width if not current else space + word_width
        if current and current_width + extra + stroke * 2 > max_width:
            lines.append(current)
            current, current_width = [index], word_width
        else:
            current.append(index)
            current_width += extra
    if current:
        lines.append(current)

    ascent, descent = font.getmetrics() if hasattr(font, "getmetrics") else (size, round(size * 0.25))
    glyph_height = ascent + descent
    spacing = round(size * (0.32 if _is_title_box(style) else 0.12))
    line_height = glyph_height + spacing
    block_height = max(1, len(lines)) * line_height - spacing
    center_y = height * _number(style.get("verticalPosition"), 82, 5, 95) / 100.0
    top = center_y - block_height / 2
    top = max(margin * 0.5, min(height - margin * 0.5 - block_height, top))

    align = str(style.get("alignment") or "center").lower()
    placed = []
    for line_index, line in enumerate(lines):
        line_width = sum(widths[i] for i in line) + space * (len(line) - 1)
        if align in ("left", "start"):
            x = margin
        elif align in ("right", "end"):
            x = width - margin - line_width
        else:
            x = (width - line_width) / 2
        middle = top + line_index * line_height + glyph_height / 2
        for i in line:
            placed.append({"index": i, "text": words[i], "x": x, "y": middle, "width": widths[i], "line": line_index})
            x += widths[i] + space

    left = min((word["x"] for word in placed), default=width / 2)
    right = max((word["x"] + word["width"] for word in placed), default=width / 2)
    return {
        "frame": (width, height),
        "scale": scale,
        "size": size,
        "stroke": stroke,
        "font": font,
        "space": space,
        "glyphHeight": glyph_height,
        "words": placed,
        "center": ((left + right) / 2, top + block_height / 2),
        "box": (left, top, right, top + block_height),
    }


def _highlight_mode(style: dict) -> str:
    name = str(style.get("style") or "").lower()
    if name.startswith("gota"):
        return "gota-pop"
    if name.startswith("impact"):
        return "impact"
    return ""


def _is_title_box(style: dict) -> bool:
    return str(style.get("style") or "").lower() == "title-box"


def render_caption(text: str, style: dict, font_path: str | None):
    """Devuelve (imagen RGBA del tamaño de la secuencia, datos de posición)."""
    from PIL import Image, ImageDraw, ImageFilter

    style = style or {}
    text = apply_case(str(text or "").strip(), str(style.get("case") or ""))
    layout = layout_caption(text, style, font_path)
    width, height = layout["frame"]
    scale, size, stroke = layout["scale"], layout["size"], layout["stroke"]
    font = layout["font"]
    text_color = _color(style.get("textColor"), "#ffffff")
    stroke_color = _color(style.get("strokeColor"), "#000000")
    shadow_color = _color(style.get("shadowColor"), "#000000")
    glow_color = _color(style.get("glowColor"), "#20b7ff")
    impact_color = _color(style.get("highlightColor"), "#f5cc38")
    box_color = _color(style.get("boxColor"), "#ffffff")
    shadow_blur = _number(style.get("shadowBlur"), 0, 0, 80) * scale
    shadow_offset = _number(style.get("shadowOffset"), 0, -80, 80) * scale
    mode = _highlight_mode(style)
    try:
        active = int(style.get("highlightIndex"))
    except (TypeError, ValueError):
        active = -1
    if not mode:
        active = -1

    # Cada palabra se dibuja por separado para poder destacar una sola, igual
    # que la vista previa del panel. `x` es el borde izquierdo y `y` la mitad
    # del renglón.
    pieces = []
    for word in layout["words"]:
        piece = {
            "text": word["text"], "x": word["x"], "y": word["y"], "width": word["width"],
            "font": font, "size": size, "fill": text_color, "stroke": stroke, "strokeFill": stroke_color,
            "box": None, "glow": False,
        }
        if word["index"] == active:
            # Crece como en la vista previa, pero en palabras largas solo lo
            # que cabe en el espacio, para no tocar a sus vecinas.
            pad = size * IMPACT_BOX_PAD[0] if mode == "impact" else stroke
            room = max(0.0, layout["space"] * 0.5 - pad)
            grow = min(1.08 if mode == "gota-pop" else 1.06, 1 + 2 * room / max(1.0, word["width"]))
            big_size = max(8, round(size * grow))
            big = _load_font(font_path, big_size)
            big_width = measure_word(word["text"], big, big_size)
            piece.update({
                "x": word["x"] + word["width"] / 2 - big_width / 2,
                "y": word["y"] - (4 * scale if mode == "gota-pop" else 0),
                "width": big_width, "font": big, "size": big_size,
            })
            if mode == "gota-pop":
                piece.update({"fill": glow_color, "glow": True})
            else:
                piece.update({"fill": IMPACT_TEXT_COLOR, "stroke": 0, "box": impact_color})
        pieces.append(piece)

    # Solo se pinta la zona del texto; desenfocar el cuadro completo de 4K
    # por cada palabra haría muy lenta la colocación.
    left, top, right, bottom = layout["box"]
    pad = shadow_blur * 1.5 + abs(shadow_offset) + stroke + size * 0.8 + 12 * scale
    region = (
        max(0, int(left - pad)), max(0, int(top - pad)),
        min(width, int(right + pad) + 1), min(height, int(bottom + pad) + 1),
    )
    ox, oy = region[0], region[1]
    region_size = (max(1, region[2] - region[0]), max(1, region[3] - region[1]))

    def draw_word(target, piece, fill, stroke_width, stroke_fill, dx=0.0, dy=0.0, silhouette=False):
        draw = ImageDraw.Draw(target)
        x = piece["x"] - ox + dx
        y = piece["y"] - oy + dy
        for run in split_runs(piece["text"]):
            run_text, emoji = run
            if emoji:
                image = _emoji_image(run_text, max(2, round(piece["size"] * EMOJI_HEIGHT)))
                if image is not None:
                    if silhouette:
                        solid = Image.new("RGBA", image.size, fill)
                        solid.putalpha(image.getchannel("A"))
                        image = solid
                    target.alpha_composite(image, (round(x), round(y - image.height / 2)))
            else:
                draw.text((x, y), run_text, font=piece["font"], fill=fill, anchor="lm",
                          stroke_width=stroke_width, stroke_fill=stroke_fill)
            x += _run_width(run, piece["font"], piece["size"])

    def ink_box(piece):
        """Caja vertical del texto (no de la línea completa) para el recuadro."""
        x0, y0, x1, y1 = piece["font"].getbbox("HÁgy", anchor="lm")
        half_emoji = piece["size"] * EMOJI_HEIGHT / 2
        has_emoji = any(emoji for _, emoji in split_runs(piece["text"]))
        upper = min(y0, -half_emoji) if has_emoji else y0
        lower = max(y1, half_emoji) if has_emoji else y1
        return (piece["x"] - ox, piece["y"] - oy + upper, piece["x"] - ox + piece["width"], piece["y"] - oy + lower)

    canvas = Image.new("RGBA", region_size, (0, 0, 0, 0))
    if _is_title_box(style):
        # Estilo TikTok: cada renglón con su propia caja redondeada.
        draw = ImageDraw.Draw(canvas)
        for line in sorted({word["line"] for word in layout["words"]}):
            members = [piece for piece, word in zip(pieces, layout["words"]) if word["line"] == line]
            x0 = min(ink_box(piece)[0] for piece in members)
            x1 = max(ink_box(piece)[2] for piece in members)
            y0 = min(ink_box(piece)[1] for piece in members)
            y1 = max(ink_box(piece)[3] for piece in members)
            pad_x, pad_y = size * TITLE_BOX_PAD[0], size * TITLE_BOX_PAD[1]
            draw.rounded_rectangle((x0 - pad_x, y0 - pad_y, x1 + pad_x, y1 + pad_y),
                                   radius=size * 0.28, fill=box_color)
    # En la caja de título la sombra del texto ensuciaría el fondo blanco.
    if (shadow_blur > 0 or shadow_offset) and not _is_title_box(style):
        shadow = Image.new("RGBA", region_size, (0, 0, 0, 0))
        for piece in pieces:
            draw_word(shadow, piece, shadow_color, piece["stroke"], shadow_color, shadow_offset, shadow_offset,
                      silhouette=True)
        if shadow_blur > 0:
            shadow = shadow.filter(ImageFilter.GaussianBlur(shadow_blur / 2))
        canvas.alpha_composite(shadow)
    for piece in pieces:
        if piece["glow"]:
            glow = Image.new("RGBA", region_size, (0, 0, 0, 0))
            draw_word(glow, piece, glow_color, piece["stroke"] + max(2, round(4 * scale)), glow_color, silhouette=True)
            canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(max(2.0, 8 * scale))))
        if piece["box"]:
            x0, y0, x1, y1 = ink_box(piece)
            pad_x, pad_y = size * IMPACT_BOX_PAD[0], size * IMPACT_BOX_PAD[1]
            ImageDraw.Draw(canvas).rounded_rectangle(
                (x0 - pad_x, y0 - pad_y, x1 + pad_x, y1 + pad_y), radius=size * 0.14, fill=piece["box"]
            )
        draw_word(canvas, piece, piece["fill"], piece["stroke"], piece["strokeFill"])

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    image.paste(canvas, (ox, oy))
    return image, layout_info(layout)


def layout_info(layout: dict) -> dict:
    """Centro del texto (0 a 1) para que el panel anime sin moverlo de lugar."""
    width, height = layout["frame"]
    center_x, center_y = layout["center"]
    return {
        "frameWidth": width,
        "frameHeight": height,
        "textCenterX": round(center_x / width, 5),
        "textCenterY": round(center_y / height, 5),
    }


def build_caption_png(text: str, style: dict, cache_dir: Path, font_path: str | None) -> tuple[Path, dict]:
    """Guarda el PNG en caché y devuelve su ruta con los datos de posición."""
    style = dict(style or {})
    cache_dir.mkdir(parents=True, exist_ok=True)
    signature = json.dumps(
        {"schema": CAPTION_PNG_SCHEMA, "text": text, "style": style, "font": font_path},
        sort_keys=True, ensure_ascii=False,
    )
    destination = cache_dir / f"{hashlib.sha256(signature.encode('utf-8')).hexdigest()}.png"
    if destination.exists():
        cased = apply_case(str(text or "").strip(), str(style.get("case") or ""))
        return destination, layout_info(layout_caption(cased, style, font_path))
    image, info = render_caption(text, style, font_path)
    temporary = destination.with_suffix(".tmp.png")
    image.save(temporary, "PNG", compress_level=6)
    temporary.replace(destination)
    return destination, info
