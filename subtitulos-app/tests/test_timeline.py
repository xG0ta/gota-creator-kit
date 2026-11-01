import unittest

from gota_subtitulos.timeline import build_units, entrance_keys, entrance_name, interpolate, split_lines, to_srt

SEGMENT = {
    "startSeconds": 1.0, "endSeconds": 4.0, "text": "uno dos tres cuatro cinco seis siete ocho",
    "words": [{"text": word, "startSeconds": 1 + i * 0.35, "endSeconds": 1.3 + i * 0.35}
              for i, word in enumerate("uno dos tres cuatro cinco seis siete ocho".split())],
}


class TimelineTests(unittest.TestCase):
    def test_split_uses_word_times(self):
        lines = split_lines([SEGMENT], 3)
        self.assertEqual([line["text"] for line in lines], ["uno dos tres", "cuatro cinco seis", "siete ocho"])
        self.assertAlmostEqual(lines[1]["startSeconds"], 1 + 3 * 0.35)
        self.assertEqual(len(lines[2]["words"]), 2)

    def test_units_one_per_word_and_chained(self):
        units = build_units(split_lines([SEGMENT], 4), True)
        self.assertEqual(len(units), 8)
        self.assertTrue(units[0]["lineStart"] and units[4]["lineStart"])
        for left, right in zip(units, units[1:]):
            if not right["lineStart"]:
                self.assertAlmostEqual(left["endSeconds"], right["startSeconds"])

    def test_minimal_is_one_unit_per_line(self):
        units = build_units(split_lines([SEGMENT], 4), False)
        self.assertEqual([unit["highlightIndex"] for unit in units], [-1, -1])

    def test_edited_line_spreads_time(self):
        line = dict(SEGMENT, text="otra cosa distinta")
        units = build_units([line], True)
        self.assertEqual(len(units), 3)
        self.assertEqual(units[0]["startSeconds"], 1.0)
        self.assertEqual(units[-1]["endSeconds"], 4.0)

    def test_entrance_fits_short_words(self):
        keys = entrance_keys("gota-pop", 0.1)
        self.assertLessEqual(keys["scale"][-1][0], 0.09 + 1e-9)
        self.assertEqual(interpolate(keys["opacity"], 0), 0)
        self.assertEqual(interpolate(keys["scale"], 10), 100)

    def test_entrance_choice(self):
        self.assertEqual(entrance_name({"style": "impact"}), "impact")
        self.assertEqual(entrance_name({"style": "impact", "entrance": "auto"}), "impact")
        self.assertEqual(entrance_name({"style": "gota-pop", "entrance": "minimal"}), "minimal")
        self.assertEqual(entrance_name({"style": "title-box"}), "minimal")
        keys = entrance_keys("none", 1.0)
        self.assertIsNone(keys["scale"])
        self.assertIsNone(keys["opacity"])

    def test_pause_starts_new_line_and_releases_highlight(self):
        words = [("a", 30.93, 31.29), ("ver,", 31.29, 31.43), ("no,", 31.47, 32.51), ("va", 35.15, 35.25),
                 ("a", 35.25, 35.31), ("ser", 35.31, 35.35)]
        segment = {"startSeconds": 30.93, "endSeconds": 35.35, "text": " ".join(w[0] for w in words),
                   "words": [{"text": t, "startSeconds": a, "endSeconds": b} for t, a, b in words]}
        lines = split_lines([segment], 6)
        self.assertEqual([line["text"] for line in lines], ["a ver, no,", "va a ser"])
        units = build_units(lines, True)
        stuck = [u for u in units if u["highlightIndex"] == 2]
        self.assertAlmostEqual(stuck[0]["endSeconds"], 32.51)

    def test_highlight_rests_between_slow_words(self):
        line = {"startSeconds": 0.0, "endSeconds": 2.0, "text": "uno dos",
                "words": [{"text": "uno", "startSeconds": 0.0, "endSeconds": 0.3},
                          {"text": "dos", "startSeconds": 0.8, "endSeconds": 2.0}]}
        units = build_units([line], True)
        self.assertEqual([(u["highlightIndex"], round(u["startSeconds"], 2), round(u["endSeconds"], 2)) for u in units],
                         [(0, 0.0, 0.6), (-1, 0.6, 0.8), (1, 0.8, 2.0)])

    def test_sentence_end_splits_line(self):
        words = [("Ay,", 0.0, 0.2), ("perro.", 0.2, 0.5), ("¿Qué", 0.8, 0.9), ("haces?", 0.9, 1.2)]
        segment = {"startSeconds": 0, "endSeconds": 1.2, "text": " ".join(w[0] for w in words),
                   "words": [{"text": t, "startSeconds": a, "endSeconds": b} for t, a, b in words]}
        self.assertEqual([line["text"] for line in split_lines([segment], 6)], ["Ay, perro.", "¿Qué haces?"])

    def test_full_line_breaks_after_punctuation(self):
        text = "¿Qué andas buscando a alguien de Culiacán? Ay, perro, tú vas"
        words = text.split()
        segment = {"startSeconds": 0, "endSeconds": len(words) * 0.3, "text": text,
                   "words": [{"text": w, "startSeconds": i * 0.3, "endSeconds": i * 0.3 + 0.25} for i, w in enumerate(words)]}
        self.assertEqual([line["text"] for line in split_lines([segment], 6)],
                         ["¿Qué andas buscando a alguien de Culiacán?", "Ay, perro, tú vas"])

    def test_srt(self):
        text = to_srt([{"startSeconds": 61.5, "endSeconds": 62.25, "text": "hola 😂"}])
        self.assertEqual(text, "1\n00:01:01,500 --> 00:01:02,250\nhola 😂\n")


if __name__ == "__main__":
    unittest.main()
