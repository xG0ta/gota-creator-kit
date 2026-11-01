import subprocess
import tempfile
import unittest
from pathlib import Path

import imageio_ffmpeg
from PIL import Image

from service.caption_motion import entrance_keys, entrance_name, line_clip
from service.captions import build_caption_png


class LineClipTests(unittest.TestCase):
    def test_line_clip_is_transparent_and_highlights_each_word(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            style = {"style": "impact", "fontSize": 70, "frameWidth": 360, "frameHeight": 640, "highlightColor": "#F5CC38"}
            units = [
                {"text": "HOLA MUNDO", "startSeconds": 10.0, "endSeconds": 10.6, "highlightIndex": 0, "lineStart": True},
                {"text": "HOLA MUNDO", "startSeconds": 10.6, "endSeconds": 11.2, "highlightIndex": 1, "lineStart": False},
            ]
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
            path, duration = line_clip(
                units, render=lambda unit: build_caption_png(unit["text"], {**style, "highlightIndex": unit["highlightIndex"]}, folder, None),
                entrance=entrance_name(style), fps=30, ffmpeg=ffmpeg, cache_dir=folder / "clips", signature={"style": style},
            )
            self.assertAlmostEqual(duration, 1.2)
            self.assertEqual(path.suffix, ".mov")
            # Pedirlo otra vez reutiliza el mismo archivo.
            again, _ = line_clip(units, render=lambda unit: self.fail("no debía volver a dibujar"),
                                 entrance="impact", fps=30, ffmpeg=ffmpeg, cache_dir=folder / "clips", signature={"style": style})
            self.assertEqual(again, path)

            def frame(seconds):
                target = folder / f"f{seconds}.png"
                subprocess.run([ffmpeg, "-nostdin", "-y", "-loglevel", "error", "-ss", str(seconds), "-i", str(path),
                                "-frames:v", "1", str(target)], check=True)
                return Image.open(target).convert("RGBA")

            first, second = frame(0.4), frame(0.9)
            self.assertEqual(first.size, (360, 640))
            self.assertEqual(first.getpixel((0, 0))[3], 0)  # fondo transparente
            # El recuadro amarillo pasa de la primera a la segunda palabra.
            yellow_x = lambda image: [x for x in range(360) for y in range(400, 640, 4)
                                      if (lambda p: p[3] > 200 and p[0] > 200 and p[1] > 160 and p[2] < 110)(image.getpixel((x, y)))]
            self.assertLess(sum(yellow_x(first)) / len(yellow_x(first)), sum(yellow_x(second)) / len(yellow_x(second)))

    def test_entrance_choice(self):
        self.assertEqual(entrance_name({"style": "gota-pop", "entrance": "none"}), "none")
        self.assertIsNone(entrance_keys("none", 1)["opacity"])


if __name__ == "__main__":
    unittest.main()
