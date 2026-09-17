import unittest

from service.app.planner import Detection, DetectionFrame, plan_crops, plan_podcast_layout


class PlannerTests(unittest.TestCase):
    def test_crop_is_bounded_for_face_at_edge(self):
        result = plan_crops(
            [Detection(0, 0.0, 0.1, 0.2, 0.2, 0.8)],
            source_aspect=16 / 9,
            target_aspect=9 / 16,
            margin=1.25,
            smoothing=0.75,
        )[0]
        self.assertGreaterEqual(result["centerX"] - result["width"] / 2, 0)
        self.assertLessEqual(result["centerX"] + result["width"] / 2, 1)

    def test_smoothing_reduces_jump(self):
        faces = [
            Detection(0, 0.1, 0.2, 0.2, 0.2, 0.8),
            Detection(1, 0.7, 0.2, 0.2, 0.2, 0.8),
        ]
        result = plan_crops(faces, 16 / 9, 9 / 16, 1.0, 0.8)
        raw_second_center = 0.8
        self.assertLess(result[1]["centerX"], raw_second_center)
        self.assertGreater(result[1]["centerX"], result[0]["centerX"])

    def test_output_aspect_matches_target(self):
        result = plan_crops(
            [Detection(0, 0.4, 0.3, 0.2, 0.2, 0.9)],
            16 / 9, 1.0, 1.0, 0
        )[0]
        pixel_aspect = (result["width"] * 16 / 9) / result["height"]
        self.assertAlmostEqual(pixel_aspect, 1.0, places=4)

    def test_podcast_uses_split_for_two_faces(self):
        layout = plan_podcast_layout(
            [DetectionFrame(0, (
                Detection(0, 0.1, 0.2, 0.2, 0.2, 0.8),
                Detection(0, 0.7, 0.2, 0.2, 0.2, 0.8),
            ))],
            source_aspect=16 / 9,
            margin=1.2,
            smoothing=0.7,
        )[0]
        self.assertEqual(layout["mode"], "split")
        self.assertEqual([item["slot"] for item in layout["subjects"]], ["top", "bottom"])

    def test_podcast_centers_single_person(self):
        layout = plan_podcast_layout(
            [DetectionFrame(0, (
                Detection(0, 0.4, 0.2, 0.2, 0.2, 0.8),
            ))],
            source_aspect=16 / 9,
            margin=1.2,
            smoothing=0.7,
        )[0]
        self.assertEqual(layout["mode"], "single")
        self.assertEqual(layout["subjects"][0]["slot"], "full")

    def test_scene_cut_resets_layout_smoothing(self):
        layout = plan_podcast_layout(
            [
                DetectionFrame(0, (
                    Detection(0, 0.05, 0.2, 0.2, 0.2, 0.8),
                )),
                DetectionFrame(1, (
                    Detection(1, 0.75, 0.2, 0.2, 0.2, 0.8),
                ), scene_cut=True),
            ],
            source_aspect=16 / 9,
            margin=1.2,
            smoothing=0.95,
        )
        self.assertGreater(layout[1]["subjects"][0]["centerX"], 0.8)


if __name__ == "__main__":
    unittest.main()
