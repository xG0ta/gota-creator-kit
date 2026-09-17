import unittest

from service_v2.editorial import EditorialFrame, build_shot_plan


class EditorialTests(unittest.TestCase):
    def test_ignores_brief_speaker_noise(self):
        frames = [
            EditorialFrame(0.0, "A", ("A", "B"), 0.9),
            EditorialFrame(1.0, "A", ("A", "B"), 0.9),
            EditorialFrame(2.0, "B", ("A", "B"), 0.9),
            EditorialFrame(2.2, "A", ("A", "B"), 0.9),
            EditorialFrame(4.0, "A", ("A", "B"), 0.9),
        ]
        plan, _ = build_shot_plan(frames, "podcast_dynamic")
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]["subjectId"], "A")

    def test_split_requires_overlap(self):
        frames = [
            EditorialFrame(0.0, "A", ("A", "B"), 0.9, False),
            EditorialFrame(2.0, "A", ("A", "B"), 0.9, True),
            EditorialFrame(2.5, "A", ("A", "B"), 0.9, True),
            EditorialFrame(4.0, "A", ("A", "B"), 0.9, True),
        ]
        plan, _ = build_shot_plan(frames, "podcast_dynamic")
        self.assertEqual(plan[-1]["mode"], "split")

    def test_custom_minimum_shot_rule_is_applied(self):
        frames = [
            EditorialFrame(0.0, "A", ("A", "B"), 0.9),
            EditorialFrame(1.0, "B", ("A", "B"), 0.9),
            EditorialFrame(2.0, "B", ("A", "B"), 0.9),
            EditorialFrame(3.0, "B", ("A", "B"), 0.9),
            EditorialFrame(6.0, "B", ("A", "B"), 0.9),
        ]
        plan, _ = build_shot_plan(
            frames,
            "podcast_dynamic",
            {"minShotSeconds": 5.0, "speakerDelaySeconds": 0.1},
        )
        self.assertEqual(len(plan), 2)
        self.assertGreaterEqual(plan[0]["endSeconds"], 5.0)


if __name__ == "__main__":
    unittest.main()
