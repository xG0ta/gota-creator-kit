import unittest

from service_v2.tracking import FaceObservation, IdentityTracker, choose_speaker


class TrackingTests(unittest.TestCase):
    def test_identity_survives_small_motion(self):
        tracker = IdentityTracker()
        first = tracker.assign([
            FaceObservation(0, 0.1, 0.2, 0.2, 0.2, 0.9),
            FaceObservation(0, 0.7, 0.2, 0.2, 0.2, 0.9),
        ])
        second = tracker.assign([
            FaceObservation(1, 0.15, 0.2, 0.2, 0.2, 0.9),
            FaceObservation(1, 0.65, 0.2, 0.2, 0.2, 0.9),
        ])
        self.assertEqual([item.subject_id for item in first], ["A", "B"])
        self.assertEqual([item.subject_id for item in second], ["A", "B"])

    def test_speaker_hysteresis_avoids_flicker(self):
        observations = [
            FaceObservation(1, 0.1, 0.2, 0.2, 0.2, 0.9, 0.03, "A"),
            FaceObservation(1, 0.7, 0.2, 0.2, 0.2, 0.9, 0.035, "B"),
        ]
        self.assertEqual(choose_speaker(observations, "A"), "A")

    def test_podcast_tracker_never_invents_third_subject(self):
        tracker = IdentityTracker()
        seen = set()
        for second, positions in enumerate((
            (0.1, 0.7),
            (0.2,),
            (0.8,),
            (0.12, 0.72),
        )):
            assigned = tracker.assign([
                FaceObservation(second, x, 0.2, 0.15, 0.2, 0.9)
                for x in positions
            ])
            seen.update(item.subject_id for item in assigned)
        self.assertLessEqual(seen, {"A", "B"})


if __name__ == "__main__":
    unittest.main()
