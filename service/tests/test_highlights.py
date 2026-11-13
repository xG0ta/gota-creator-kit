import unittest

from service import highlights


def conversation(minutes=30, phrase=6.0):
    """Frases de 6 s seguidas, con una pausa de 2 s cada minuto."""
    segments, t, n = [], 0.0, 0
    while t < minutes * 60:
        n += 1
        segments.append({"startSeconds": t, "endSeconds": t + phrase, "text": f"frase número {n} de la plática"})
        t += phrase + (2.0 if n % 10 == 0 else 0.4)
    return segments


class FakeAi:
    """Propone un momento fuerte cada 5 minutos y contesta revisiones y títulos."""

    def __init__(self, invent_times=False):
        self.calls = []
        self.invent_times = invent_times

    def __call__(self, prompt, options):
        self.calls.append(prompt)
        if "TAREA: elige" in prompt:
            lines = [line for line in prompt.splitlines() if line.startswith("[")]
            first = float(lines[0][1:].split("-")[0])
            last = float(lines[-1][1:].split("-")[1].split("]")[0])
            if self.invent_times:
                return {"clips": [{"start": 99999, "end": 100050, "score": 9}]}
            clips = []
            t = first
            while t + 60 < last:
                clips.append({"start": t + 3.1, "end": t + 63, "score": 9 if int(t) % 600 == 0 else 6,
                              "reason": "historia graciosa"})
                t += 300
            return {"clips": clips}
        if "clip independiente" in prompt:
            return {"completo": True, "interes": 8, "motivo": "se entiende solo"}
        if "line1" in prompt:
            return {"resumen": "Cuenta algo", "line1": "Le pasó algo increíble!", "line2": "y nadie le creyó"}
        return {}


class HighlightTests(unittest.TestCase):
    def test_ai_picks_requested_count_without_overlaps(self):
        segments = conversation(30)
        ai = FakeAi()
        result = highlights.select_highlights(segments, 60, 4, 0, 1800, ask=ai)
        clips = result["clips"]
        self.assertTrue(result["usedAi"])
        self.assertEqual(len(clips), 4)
        ordered = sorted(clips, key=lambda c: c["startSeconds"])
        for left, right in zip(ordered, ordered[1:]):
            self.assertLessEqual(left["endSeconds"], right["startSeconds"])
        for clip in clips:
            length = clip["endSeconds"] - clip["startSeconds"]
            self.assertTrue(50 <= length <= 70, length)
            # Empieza al inicio de una frase y termina al final de otra.
            self.assertIn(clip["startSeconds"], [round(s["startSeconds"], 2) for s in segments])
            self.assertIn(clip["endSeconds"], [round(s["endSeconds"], 2) for s in segments])
            self.assertEqual(clip["line1"], "LE PASÓ ALGO INCREÍBLE!")
        self.assertEqual([c["rank"] for c in clips], [1, 2, 3, 4])

    def test_invented_times_fall_back_to_conversation(self):
        result = highlights.select_highlights(conversation(10), 30, 3, 0, 600, ask=FakeAi(invent_times=True))
        self.assertFalse(result["usedAi"])
        self.assertEqual(len(result["clips"]), 3)
        self.assertTrue(result["notes"])

    def test_without_ollama_uses_dialogue_blocks(self):
        result = highlights.select_highlights(conversation(10), 45, 5, 0, 600, ask=None)
        self.assertFalse(result["usedAi"])
        self.assertEqual(len(result["clips"]), 5)
        for clip in result["clips"]:
            self.assertGreaterEqual(clip["startSeconds"], 0)
            self.assertLessEqual(clip["endSeconds"], 600)
            self.assertTrue(clip["line1"])

    def test_range_offset_is_respected(self):
        segments = [dict(s, startSeconds=s["startSeconds"] + 1000, endSeconds=s["endSeconds"] + 1000)
                    for s in conversation(5)]
        result = highlights.select_highlights(segments, 30, 2, 1000, 1300, ask=None)
        for clip in result["clips"]:
            self.assertGreaterEqual(clip["startSeconds"], 1000)
            self.assertLessEqual(clip["endSeconds"], 1300)

    def test_too_short_or_silent_clip_is_explained(self):
        with self.assertRaises(ValueError):
            highlights.select_highlights([], 30, 2, 0, 600)
        with self.assertRaises(ValueError):
            highlights.select_highlights(conversation(1), 120, 2, 0, 60)

    def test_cancel_stops_the_search(self):
        def cancel():
            raise RuntimeError("cancelado")
        with self.assertRaises(RuntimeError):
            highlights.select_highlights(conversation(10), 30, 3, 0, 600, ask=FakeAi(), check=cancel)

    def test_model_choice_and_json_parsing(self):
        self.assertEqual(highlights.pick_text_model(["llava:7b", "qwen3:4b-instruct"]), "qwen3:4b-instruct")
        self.assertEqual(highlights.pick_text_model(["llava:7b", "mistral:7b"]), "mistral:7b")
        self.assertEqual(highlights.pick_text_model(["mistral:7b"], "mistral:7b"), "mistral:7b")
        self.assertIsNone(highlights.pick_text_model(["nomic-embed-text"]))
        self.assertEqual(highlights.parse_json_object('<think>x</think> ok {"a": 1} fin'), {"a": 1})
        self.assertEqual(highlights.parse_json_object("nada"), {})


if __name__ == "__main__":
    unittest.main()
