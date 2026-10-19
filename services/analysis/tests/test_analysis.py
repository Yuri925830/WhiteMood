import io
import unittest
import wave

import numpy as np

from services.analysis.audio import decode_pcm_wav
from services.analysis.face import aggregate_expression_scores


def wav_bytes(samples: np.ndarray, sample_rate: int = 16_000, channels: int = 1) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(channels)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(np.asarray(samples, dtype="<i2").tobytes())
    return output.getvalue()


class AudioBoundaryTests(unittest.TestCase):
    def test_decodes_mono_pcm16_without_changing_scale(self):
        source = np.array([-32768, -1024, 0, 1024, 32767], dtype=np.int16)
        decoded, rate = decode_pcm_wav(wav_bytes(source))
        self.assertEqual(rate, 16_000)
        np.testing.assert_allclose(decoded, source.astype(np.float32) / 32768.0)

    def test_rejects_stereo_and_truncated_wav(self):
        with self.assertRaises(ValueError):
            decode_pcm_wav(wav_bytes(np.zeros(100, dtype=np.int16), channels=2))
        with self.assertRaises(ValueError):
            decode_pcm_wav(b"not a wav")


class FaceAggregationTests(unittest.TestCase):
    def test_aggregates_probabilities_and_keeps_quality_separate(self):
        result = aggregate_expression_scores(
            np.array([[0.8, 0.2], [0.4, 0.6]], dtype=np.float32),
            {0: "Neutral", 1: "Happiness"},
            detected_frames=2,
            total_frames=3,
            area_ratios=[0.16, 0.25],
        )
        self.assertAlmostEqual(result["features"]["expression_neutral"], 0.6)
        self.assertAlmostEqual(result["features"]["expression_happiness"], 0.4)
        self.assertGreaterEqual(result["quality"], 0.5)
        self.assertEqual(result["framesAnalyzed"], 2)

    def test_rejects_score_shapes_that_do_not_match_labels(self):
        with self.assertRaises(ValueError):
            aggregate_expression_scores(np.ones((2, 3)), {0: "A", 1: "B"}, 2, 2, [0.2, 0.2])


if __name__ == "__main__":
    unittest.main()
