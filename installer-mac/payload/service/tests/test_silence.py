import unittest

from service.silence import intervals_from_levels, invert_intervals


class SilenceTests(unittest.TestCase):
    def test_threshold_and_padding_create_safe_cut(self):
        levels = [-20] * 5 + [-60] * 14 + [-20] * 5
        result = intervals_from_levels(
            levels, -42, 10, 0.1, 0.6, 0.2
        )
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(result[0]["startSeconds"], 10.7)
        self.assertAlmostEqual(result[0]["endSeconds"], 11.7)

    def test_short_pause_is_preserved(self):
        result = intervals_from_levels(
            [-20, -60, -60, -20], -42, 0, 0.1, 0.4, 0
        )
        self.assertEqual(result, [])

    def test_padding_cannot_turn_a_short_pause_into_a_cut(self):
        levels = [-20] * 3 + [-60] * 7 + [-20] * 3
        result = intervals_from_levels(levels, -42, 0, 0.1, 0.4, 0.2)
        self.assertEqual(result, [])

    def test_unsafe_manual_threshold_is_limited(self):
        # -10 dB detectaría gran parte de una conversación. El límite seguro
        # conserva una voz a -20 dB como voz.
        levels = [-20] * 20
        result = intervals_from_levels(levels, -10, 0, 0.1, 0.4, 0)
        self.assertEqual(result, [])

    def test_kept_segments_are_inverse(self):
        result = invert_intervals(
            [{"startSeconds": 2, "endSeconds": 3}], 1, 5
        )
        self.assertEqual(
            result,
            [
                {"startSeconds": 1, "endSeconds": 2, "durationSeconds": 1},
                {"startSeconds": 3, "endSeconds": 5, "durationSeconds": 2},
            ],
        )


if __name__ == "__main__":
    unittest.main()
