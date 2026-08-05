"""Audio normalization at the Pipecat infrastructure boundary."""

from __future__ import annotations

from collections.abc import Iterator

import numpy as np
import soxr
from numpy.typing import NDArray

from pipecat_runtime.application.models import (
    MAXIMUM_PCM_CHUNK_BYTES,
    PCM_S16LE_CHANNELS,
    PCM_S16LE_SAMPLE_RATE_HZ,
)


class AudioNormalizationError(ValueError):
    """Raised when provider audio cannot safely cross the PCM contract boundary."""


def normalize_pcm_s16le(*, audio: bytes, sample_rate_hz: int, channels: int) -> bytes:
    """Downmix and resample signed 16-bit PCM to 48 kHz mono without provider details."""
    if sample_rate_hz <= 0:
        raise AudioNormalizationError("audio sample rate must be positive")
    if channels <= 0:
        raise AudioNormalizationError("audio channel count must be positive")
    sample_width = 2
    if not audio or len(audio) % (sample_width * channels) != 0:
        raise AudioNormalizationError("audio must contain complete signed 16-bit PCM frames")

    samples = np.frombuffer(audio, dtype="<i2").astype(np.float32)
    frames = samples.reshape(-1, channels)
    mono: NDArray[np.float32]
    if channels == PCM_S16LE_CHANNELS:
        mono = frames[:, 0]
    else:
        mono = frames.mean(axis=1, dtype=np.float32)

    if sample_rate_hz != PCM_S16LE_SAMPLE_RATE_HZ:
        resampled = soxr.resample(
            mono,
            sample_rate_hz,
            PCM_S16LE_SAMPLE_RATE_HZ,
            quality="HQ",
        )
        mono = np.asarray(resampled, dtype=np.float32)

    clipped = np.clip(np.rint(mono), -32_768, 32_767).astype("<i2")
    return clipped.tobytes()


def split_pcm_chunks(pcm: bytes) -> Iterator[bytes]:
    """Yield contract-sized even PCM chunks while preserving sample order."""
    if not pcm or len(pcm) % 2 != 0:
        raise AudioNormalizationError("normalized PCM must be non-empty and sample-aligned")
    for offset in range(0, len(pcm), MAXIMUM_PCM_CHUNK_BYTES):
        chunk = pcm[offset : offset + MAXIMUM_PCM_CHUNK_BYTES]
        if len(chunk) % 2 != 0:
            raise AudioNormalizationError("normalized PCM chunk must be sample-aligned")
        yield chunk
