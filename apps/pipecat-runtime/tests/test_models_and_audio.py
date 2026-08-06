"""Pure boundary validation and PCM normalization tests."""

from __future__ import annotations

import pytest

from pipecat_runtime.adapters.pipecat.audio import (
    AudioNormalizationError,
    normalize_pcm_s16le,
    split_pcm_chunks,
)
from pipecat_runtime.application.conversation_events import AudioChunk
from pipecat_runtime.application.models import MAXIMUM_PCM_CHUNK_BYTES, RuntimeInputError


def test_audio_chunk_rejects_odd_or_oversized_payloads() -> None:
    """The application boundary never accepts invalid PCM payloads."""
    with pytest.raises(RuntimeInputError):
        AudioChunk(
            turn_id="turn-1",
            attempt_id="attempt-1",
            event_sequence=1,
            audio_sequence=0,
            pcm=b"\x00",
        )
    with pytest.raises(RuntimeInputError):
        AudioChunk(
            turn_id="turn-1",
            attempt_id="attempt-1",
            event_sequence=1,
            audio_sequence=0,
            pcm=b"\x00\x00" * (MAXIMUM_PCM_CHUNK_BYTES // 2 + 1),
        )


def test_normalization_downmixes_and_splits_to_contract_limit() -> None:
    """Stereo provider PCM is converted to aligned mono chunks at the boundary."""
    stereo = b"\x00\x00\xff\x7f" * 10_000
    normalized = normalize_pcm_s16le(audio=stereo, sample_rate_hz=48_000, channels=2)
    chunks = tuple(split_pcm_chunks(normalized))

    assert sum(len(chunk) for chunk in chunks) == len(normalized)
    assert all(0 < len(chunk) <= MAXIMUM_PCM_CHUNK_BYTES for chunk in chunks)
    assert all(len(chunk) % 2 == 0 for chunk in chunks)


def test_normalization_rejects_incomplete_multichannel_frames() -> None:
    """A provider cannot leak partial samples into the public audio stream."""
    with pytest.raises(AudioNormalizationError):
        normalize_pcm_s16le(audio=b"\x00\x00", sample_rate_hz=48_000, channels=2)
