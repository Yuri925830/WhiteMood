from __future__ import annotations

import io
import threading
import wave
from functools import lru_cache

import numpy as np

from .errors import ComponentUnavailable

TARGET_SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 120
_vad_lock = threading.Lock()


def decode_pcm_wav(data: bytes) -> tuple[np.ndarray, int]:
    """Decode the mono PCM16 format already enforced by the TypeScript gateway."""
    try:
        with wave.open(io.BytesIO(data), "rb") as source:
            channels = source.getnchannels()
            sample_width = source.getsampwidth()
            sample_rate = source.getframerate()
            frame_count = source.getnframes()
            compression = source.getcomptype()
            if (
                channels != 1
                or sample_width != 2
                or compression != "NONE"
                or sample_rate < 8_000
                or sample_rate > 48_000
                or frame_count <= 0
                or frame_count / sample_rate > MAX_AUDIO_SECONDS
            ):
                raise ValueError("unsupported WAV format")
            frames = source.readframes(frame_count)
    except (EOFError, wave.Error) as exc:
        raise ValueError("invalid WAV data") from exc
    if len(frames) != frame_count * 2:
        raise ValueError("truncated WAV data")
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    return samples, sample_rate


@lru_cache(maxsize=1)
def _vad_runtime():
    try:
        import torch
        from silero_vad import get_speech_timestamps, load_silero_vad
    except ImportError as exc:
        raise ComponentUnavailable("Silero VAD dependencies are not installed") from exc
    torch.set_num_threads(1)
    try:
        return torch, load_silero_vad(), get_speech_timestamps
    except (OSError, RuntimeError) as exc:
        raise ComponentUnavailable("Silero VAD weights are unavailable") from exc


def _speech_segments(samples: np.ndarray) -> list[tuple[int, int]]:
    torch, model, get_speech_timestamps = _vad_runtime()
    with _vad_lock:
        raw = get_speech_timestamps(
            torch.from_numpy(np.ascontiguousarray(samples)),
            model,
            sampling_rate=TARGET_SAMPLE_RATE,
            return_seconds=False,
        )
    result: list[tuple[int, int]] = []
    for item in raw:
        start = int(item["start"])
        end = int(item["end"])
        if 0 <= start < end <= samples.size:
            result.append((start, end))
    return result


def analyze_acoustics(data: bytes) -> dict[str, float | int]:
    try:
        import librosa
    except ImportError as exc:
        raise ComponentUnavailable("librosa is not installed") from exc

    samples, sample_rate = decode_pcm_wav(data)
    if sample_rate != TARGET_SAMPLE_RATE:
        samples = librosa.resample(samples, orig_sr=sample_rate, target_sr=TARGET_SAMPLE_RATE)
    samples = np.ascontiguousarray(samples, dtype=np.float32)
    duration_ms = samples.size * 1000 / TARGET_SAMPLE_RATE

    rms = librosa.feature.rms(y=samples, frame_length=1024, hop_length=256, center=True)[0]
    mean_energy = float(np.mean(rms)) if rms.size else 0.0
    peak_energy = float(np.max(rms)) if rms.size else 0.0
    segments = _speech_segments(samples)
    voiced_samples = sum(end - start for start, end in segments)
    voiced_ratio = voiced_samples / max(1, samples.size)

    pauses = [
        next_start - end
        for (_, end), (next_start, _) in zip(segments, segments[1:])
        if next_start - end >= int(0.15 * TARGET_SAMPLE_RATE)
    ]
    pause_duration_ms = sum(pauses) * 1000 / TARGET_SAMPLE_RATE
    max_pause_ms = max(pauses, default=0) * 1000 / TARGET_SAMPLE_RATE

    pitch_values = np.array([], dtype=np.float64)
    if samples.size >= 2048 and peak_energy > 1e-4:
        try:
            f0, voiced, _ = librosa.pyin(
                samples,
                fmin=65.0,
                fmax=1_000.0,
                sr=TARGET_SAMPLE_RATE,
                frame_length=2048,
                hop_length=256,
            )
            pitch_values = f0[np.asarray(voiced, dtype=bool) & np.isfinite(f0)]
        except (ValueError, FloatingPointError):
            pitch_values = np.array([], dtype=np.float64)

    speech_seconds = voiced_samples / TARGET_SAMPLE_RATE
    coverage = min(1.0, speech_seconds / 0.75)
    energy_quality = min(1.0, peak_energy / 0.04)
    quality = max(0.0, min(1.0, 0.55 * coverage + 0.3 * min(1.0, voiced_ratio / 0.5) + 0.15 * energy_quality))
    result: dict[str, float | int] = {
        "durationMs": round(duration_ms),
        "voicedRatio": round(float(voiced_ratio), 4),
        "meanEnergy": round(max(0.0, min(1.0, mean_energy)), 6),
        "peakEnergy": round(max(0.0, min(1.0, peak_energy)), 6),
        "pauseCount": len(pauses),
        "pauseDurationMs": round(pause_duration_ms),
        "maxPauseMs": round(max_pause_ms),
        "quality": round(quality, 4),
    }
    if pitch_values.size:
        result.update(
            pitchMeanHz=round(float(np.mean(pitch_values)), 2),
            pitchRangeHz=round(float(np.ptp(pitch_values)), 2),
            pitchStdHz=round(float(np.std(pitch_values)), 2),
        )
    return result
