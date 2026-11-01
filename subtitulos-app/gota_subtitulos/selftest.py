"""Prueba rápida de la app empaquetada (la usa la compilación automática).

Genera un video de 3 segundos, le pone subtítulos con palabra destacada,
título con emoji y entrada animada, y revisa que FFmpeg lo exporte.
Con --with-model también carga Whisper «tiny» para confirmar que la
transcripción funciona dentro del paquete.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import traceback
from pathlib import Path


def run(report_path: str | None, with_model: bool = False) -> int:
    lines_out: list[str] = []

    def say(message: str) -> None:
        lines_out.append(message)
        if sys.stdout:
            try:
                print(message, flush=True)
            except Exception:
                pass

    ok = True
    try:
        from . import VERSION, media, system, timeline
        from service.captions import build_caption_png, emoji_font_path

        say(f"Gota Subtítulos {VERSION} · Python {sys.version.split()[0]} · {sys.platform}")
        say(f"ffmpeg: {media.ffmpeg()}")
        say(f"fuente: {system.default_font()} · emojis: {emoji_font_path()}")
        with tempfile.TemporaryDirectory(prefix="gota-selftest-") as folder:
            folder = Path(folder)
            source = folder / "prueba.mp4"
            subprocess.run([
                media.ffmpeg(), "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=3",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(source),
            ], check=True, capture_output=True, creationflags=system.NO_WINDOW)
            video = media.probe(str(source))
            say(f"video de prueba: {video['width']}x{video['height']} {video['duration']:.2f}s")
            assert (video["width"], video["height"]) == (360, 640), video
            lines = [{"startSeconds": 0.2, "endSeconds": 2.6, "text": "hola desde gota 😂",
                      "words": [{"text": "hola", "startSeconds": 0.2, "endSeconds": 0.8},
                                {"text": "desde", "startSeconds": 0.9, "endSeconds": 1.5},
                                {"text": "gota", "startSeconds": 1.6, "endSeconds": 2.0},
                                {"text": "😂", "startSeconds": 2.0, "endSeconds": 2.6}]}]
            style = {"style": "gota-pop", "fontSize": 46, "strokeSize": 2, "shadowBlur": 6,
                     "frameWidth": 360, "frameHeight": 640}
            font = system.default_font()
            cache = folder / "cache"
            units = timeline.build_units(lines, True)
            title_path, _ = build_caption_png("POV: ya llegó el viernes 🔥",
                                              {"style": "title-box", "fontSize": 58, "frameWidth": 360,
                                               "frameHeight": 640, "verticalPosition": 14}, cache, font)
            overlay = media.build_overlay(
                units, render=lambda unit: build_caption_png(unit["text"], {**style, "highlightIndex": unit["highlightIndex"]}, cache, font),
                keys_for=lambda unit: timeline.entrance_keys("gota-pop", unit["endSeconds"] - unit["startSeconds"]),
                title=(title_path, 2.0), video=video, folder=folder,
            )
            output = media.export_mp4(video, overlay, folder / "salida.mp4")
            result = media.probe(str(output))
            say(f"exportado: {result['width']}x{result['height']} {result['duration']:.2f}s audio={result['hasAudio']}")
            assert result["hasAudio"] and abs(result["duration"] - 3) < 0.3, result
            (folder / "salida.srt").write_text(timeline.to_srt(lines), encoding="utf-8")
            if with_model:
                from .transcribe import transcribe

                transcribed = transcribe(str(source), video["duration"], "es", "rapida",
                                         lambda value, message=None: None, lambda: False)
                say(f"whisper: modelo {transcribed['model']} cargado, {len(transcribed['segments'])} frases")
        say("SELFTEST OK")
    except Exception:
        ok = False
        say("SELFTEST FALLÓ")
        say(traceback.format_exc())
    if report_path:
        Path(report_path).write_text("\n".join(lines_out) + "\n", encoding="utf-8")
    return 0 if ok else 1
