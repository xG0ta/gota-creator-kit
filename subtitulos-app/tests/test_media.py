import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from gota_subtitulos import media
from gota_subtitulos.timeline import build_units, entrance_keys
from service.captions import build_caption_png


class MediaTests(unittest.TestCase):
    def test_rotated_phone_video_reports_visible_size(self):
        with tempfile.TemporaryDirectory() as folder:
            flat = Path(folder) / "plano.mp4"
            source = Path(folder) / "girado.mp4"
            subprocess.run([
                media.ffmpeg(), "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", str(flat),
            ], check=True)
            # Así guarda el iPhone sus videos verticales: 1920x1080 con giro aparte.
            subprocess.run([media.ffmpeg(), "-y", "-loglevel", "error", "-display_rotation", "-90", "-i", str(flat),
                            "-c", "copy", str(source)], check=True)
            info = media.probe(str(source))
            self.assertEqual((info["width"], info["height"]), (180, 320))

    def test_overlay_burns_title_and_highlight(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            source = folder / "base.mp4"
            subprocess.run([
                media.ffmpeg(), "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:size=360x640:rate=30:duration=2",
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-shortest",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
            ], check=True)
            video = media.probe(str(source))
            style = {"style": "impact", "fontSize": 60, "frameWidth": 360, "frameHeight": 640, "highlightColor": "#F5CC38"}
            lines = [{"startSeconds": 0.0, "endSeconds": 1.6, "text": "HOLA MUNDO",
                      "words": [{"text": "HOLA", "startSeconds": 0, "endSeconds": 0.8},
                                {"text": "MUNDO", "startSeconds": 0.8, "endSeconds": 1.6}]}]
            title, _ = build_caption_png("TÍTULO 🔥", {"style": "title-box", "fontSize": 60, "frameWidth": 360,
                                                     "frameHeight": 640, "verticalPosition": 14}, folder, None)
            overlay = media.build_overlay(
                build_units(lines, True),
                render=lambda unit: build_caption_png(unit["text"], {**style, "highlightIndex": unit["highlightIndex"]}, folder, None),
                keys_for=lambda unit: entrance_keys("impact", unit["endSeconds"] - unit["startSeconds"]),
                title=(title, 1.0), video=video, folder=folder,
            )
            output = media.export_mp4(video, overlay, folder / "salida.mp4")
            frames = {}
            for seconds in (0.5, 1.2, 1.8):
                frame = folder / f"f{seconds}.png"
                subprocess.run([media.ffmpeg(), "-y", "-loglevel", "error", "-ss", str(seconds), "-i", str(output),
                                "-frames:v", "1", str(frame)], check=True)
                frames[seconds] = Image.open(frame).convert("RGB")
            top = lambda image: image.crop((0, 0, 360, 200)).getextrema()
            bottom = lambda image: image.crop((0, 400, 360, 640)).getextrema()
            # Título blanco arriba solo el primer segundo.
            self.assertGreater(top(frames[0.5])[0][1], 200)
            self.assertLess(top(frames[1.2])[0][1], 40)
            # Subtítulo con recuadro amarillo mientras se habla; luego nada.
            yellow = lambda image: any(r > 200 and g > 160 and b < 110 for r, g, b in image.crop((0, 400, 360, 640)).getdata())
            self.assertTrue(yellow(frames[1.2]))
            self.assertLess(bottom(frames[1.8])[0][1], 40)


if __name__ == "__main__":
    unittest.main()
