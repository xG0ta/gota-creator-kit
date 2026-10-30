import tempfile
import unittest
from pathlib import Path

from service.captions import (
    apply_case, build_caption_png, emoji_font_path, layout_caption, render_caption, split_runs,
)

# Cualquier fuente TrueType del sistema; sin ella Pillow usa su fuente interna.
FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
)
FONT = next((path for path in FONT_CANDIDATES if Path(path).exists()), None)
TEXT = "esto se va a ver increíble en tus videos"


def style(**extra):
    base = {
        "style": "gota-pop", "fontSize": 46, "textColor": "#FFFFFF", "strokeColor": "#072944",
        "strokeSize": 2, "shadowColor": "#001828", "shadowBlur": 8, "shadowOffset": 2,
        "glowColor": "#20B7FF", "highlightColor": "#F5CC38", "verticalPosition": 70,
    }
    base.update(extra)
    return base


def opaque_box(image):
    return image.getchannel("A").getbbox()


class CaptionTests(unittest.TestCase):
    def test_png_matches_sequence_size(self):
        for size in ((1080, 1920), (1920, 1080), (1080, 1080), (3840, 2160)):
            image, info = render_caption(TEXT, style(frameWidth=size[0], frameHeight=size[1]), FONT)
            self.assertEqual(image.size, size)
            self.assertEqual((info["frameWidth"], info["frameHeight"]), size)

    def test_missing_size_keeps_vertical_default(self):
        image, _ = render_caption(TEXT, style(), FONT)
        self.assertEqual(image.size, (1080, 1920))

    def test_text_stays_inside_horizontal_frame(self):
        # Antes el PNG siempre era 1080x1920: en 16:9 el texto quedaba fuera.
        image, info = render_caption(TEXT, style(frameWidth=1920, frameHeight=1080, verticalPosition=90), FONT)
        left, top, right, bottom = opaque_box(image)
        self.assertGreater(left, 0)
        self.assertLess(right, 1920)
        self.assertLess(bottom, 1080)
        self.assertAlmostEqual(info["textCenterX"], 0.5, places=2)

    def test_long_line_wraps_inside_vertical_frame(self):
        long_text = " ".join(["palabra"] * 14)
        image, _ = render_caption(long_text, style(frameWidth=1080, frameHeight=1920, fontSize=60), FONT)
        left, _, right, _ = opaque_box(image)
        self.assertGreaterEqual(left, 40)
        self.assertLessEqual(right, 1040)

    def test_highlight_keeps_word_positions(self):
        # Todas las imágenes de una frase comparten posiciones: el texto no brinca.
        positions = None
        for index in range(len(TEXT.split())):
            layout = layout_caption(TEXT, style(highlightIndex=index), FONT)
            current = [(round(word["x"], 3), round(word["y"], 3)) for word in layout["words"]]
            if positions is None:
                positions = current
            self.assertEqual(current, positions)

    def test_highlight_depends_on_style(self):
        plain, _ = render_caption(TEXT, style(style="minimal"), FONT)
        first, _ = render_caption(TEXT, style(highlightIndex=0), FONT)
        last, _ = render_caption(TEXT, style(highlightIndex=7), FONT)
        self.assertNotEqual(first.tobytes(), last.tobytes())
        # Minimal ignora la palabra destacada.
        minimal_highlight, _ = render_caption(TEXT, style(style="minimal", highlightIndex=3), FONT)
        self.assertEqual(plain.tobytes(), minimal_highlight.tobytes())

    def test_impact_box_uses_highlight_color(self):
        image, _ = render_caption("hola mundo", style(style="impact", highlightIndex=1, shadowBlur=0, shadowOffset=0), FONT)
        colors = {color for _, color in image.getcolors(maxcolors=1 << 20) or []}
        self.assertIn((0xF5, 0xCC, 0x38, 255), colors)

    def test_impact_box_does_not_touch_previous_word(self):
        image, _ = render_caption(
            "VER INCREÍBLE", style(style="impact", highlightIndex=1, shadowBlur=0, shadowOffset=0), FONT
        )
        pixels = image.load()
        _, top, _, bottom = opaque_box(image)
        box_columns = [
            x for x in range(image.width)
            if any(pixels[x, y] == (0xF5, 0xCC, 0x38, 255) for y in range(top, bottom))
        ]
        box_left = min(box_columns)
        gap = [all(pixels[x, y][3] == 0 for y in range(top, bottom)) for x in range(box_left - 4, box_left)]
        self.assertTrue(all(gap))

    def test_emoji_is_drawn_in_color(self):
        if not emoji_font_path():
            self.skipTest("Este equipo no tiene fuente de emojis")
        image, _ = render_caption("jaja 😂", style(style="minimal", shadowBlur=0, shadowOffset=0), FONT)
        # La cara del emoji es amarilla; el texto es blanco con contorno azul oscuro.
        colorful = [pixel for pixel in image.getdata() if pixel[3] > 200 and pixel[0] > 200 and pixel[2] < 120]
        self.assertGreater(len(colorful), 50)

    def test_emoji_modifiers_are_dropped(self):
        self.assertEqual(split_runs("wey🤦🏽‍♂️"), [("wey", False), ("🤦", True)])
        self.assertEqual(split_runs("❤️ok"), [("❤", True), ("ok", False)])

    def test_title_box_draws_background(self):
        image, _ = render_caption("POV: ya llegó", style(style="title-box", textColor="#111111", boxColor="#FFFFFF",
                                                         verticalPosition=14), FONT)
        white = sum(1 for pixel in image.getdata() if pixel == (255, 255, 255, 255))
        self.assertGreater(white, 5000)
        self.assertLess(opaque_box(image)[3], 1920 * 0.3)

    def test_title_case_respects_accents(self):
        self.assertEqual(apply_case("él ya llegó", "title"), "Él Ya Llegó")

    def test_cache_reuses_png_and_reports_center(self):
        with tempfile.TemporaryDirectory() as folder:
            first, info = build_caption_png(TEXT, style(frameWidth=1920, frameHeight=1080), Path(folder), FONT)
            second, cached_info = build_caption_png(TEXT, style(frameWidth=1920, frameHeight=1080), Path(folder), FONT)
            self.assertEqual(first, second)
            self.assertEqual(info, cached_info)
            other, _ = build_caption_png(TEXT, style(frameWidth=1080, frameHeight=1920), Path(folder), FONT)
            self.assertNotEqual(first, other)


if __name__ == "__main__":
    unittest.main()
