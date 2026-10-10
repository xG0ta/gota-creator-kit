import unittest

from service.silence import (
    effective_threshold_for_levels,
    intervals_from_levels,
    invert_intervals,
)


class SilenceTests(unittest.TestCase):
    def test_threshold_and_padding_create_safe_cut(self):
        levels = [-20] * 5 + [-60] * 14 + [-20] * 5
        result = intervals_from_levels(
            levels, -42, 10, 0.1, 0.6, 0.2
        )
        self.assertEqual(len(result), 1)
        # El filtro robusto conserva 100 ms extra junto a cada palabra.
        self.assertAlmostEqual(result[0]["startSeconds"], 10.8)
        self.assertAlmostEqual(result[0]["endSeconds"], 11.6)

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

    def test_noisy_room_is_detected_adaptively(self):
        # Ruido constante a -35 dB con voz a -17 dB. Un umbral fijo de -42
        # nunca detectaría esta pausa; el adaptativo sí debe separarla.
        levels = [-17] * 12 + [-35] * 20 + [-17] * 12
        result = intervals_from_levels(levels, -42, 0, 0.05, 0.5, 0.1)
        self.assertEqual(len(result), 1)

    def test_quiet_voice_is_not_cut(self):
        levels = [-38, -37, -40, -36, -39] * 10
        result = intervals_from_levels(levels, -30, 0, 0.02, 0.3, 0.05)
        self.assertEqual(result, [])

    def test_brief_noise_inside_pause_does_not_split_it(self):
        levels = [-18] * 8 + [-58] * 15 + [-20] * 2 + [-58] * 15 + [-18] * 8
        result = intervals_from_levels(levels, -42, 0, 0.02, 0.3, 0.05)
        self.assertEqual(len(result), 1)

    def test_aggressiveness_control_moves_adaptive_threshold(self):
        levels = [-55] * 30 + [-20] * 30
        conservative = effective_threshold_for_levels(levels, -54)
        aggressive = effective_threshold_for_levels(levels, -30)
        self.assertGreater(aggressive, conservative)

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
