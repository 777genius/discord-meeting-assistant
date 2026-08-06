"""Pipecat frame processors used by deterministic and provider-backed profiles."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from enum import StrEnum

from pipecat.frames.frames import (
    ErrorFrame,
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from pipecat_runtime.adapters.pipecat.audio import normalize_pcm_s16le, split_pcm_chunks
from pipecat_runtime.adapters.pipecat.frames import (
    ConversationTextFrame,
    ConversationTurnFrame,
    TextGenerationFirstTokenFrame,
)
from pipecat_runtime.application.models import (
    PCM_S16LE_CHANNELS,
    PCM_S16LE_SAMPLE_RATE_HZ,
)
from pipecat_runtime.application.ports import CancellationSignal


class DeterministicFailurePoint(StrEnum):
    """Deterministic failure switches used only by the test profile."""

    NONE = "none"
    BEFORE_AUDIO = "before-audio"
    AFTER_FIRST_AUDIO = "after-first-audio"


@dataclass(frozen=True, slots=True)
class DeterministicPipelineOptions:
    """Controllable deterministic LLM and TTS timing for local E2E coverage."""

    response_chunks: tuple[str, ...] = ("Ботик слушает. ", "Чем могу помочь?")
    text_delay_seconds: float = 0.0
    audio_delay_seconds: float = 0.0
    audio_chunk_bytes: int = 4_800
    failure_point: DeterministicFailurePoint = DeterministicFailurePoint.NONE

    def __post_init__(self) -> None:
        if not self.response_chunks or any(not chunk for chunk in self.response_chunks):
            raise ValueError("deterministic response chunks must be non-empty")
        if self.text_delay_seconds < 0 or self.audio_delay_seconds < 0:
            raise ValueError("deterministic delays must be non-negative")
        if (
            self.audio_chunk_bytes < 2
            or self.audio_chunk_bytes % 2 != 0
            or self.audio_chunk_bytes > 19_200
        ):
            raise ValueError("audio_chunk_bytes must be an even value no larger than 19,200")


class DeterministicLLMProcessor(FrameProcessor):
    """Stream a test-only answer through real Pipecat frame processing."""

    def __init__(
        self,
        *,
        options: DeterministicPipelineOptions,
        cancellation_requested: CancellationSignal,
    ) -> None:
        super().__init__()
        self._options = options
        self._cancellation_requested = cancellation_requested

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if (
            not isinstance(frame, ConversationTurnFrame)
            or direction is not FrameDirection.DOWNSTREAM
        ):
            await self.push_frame(frame, direction)
            return
        if self._options.failure_point is DeterministicFailurePoint.BEFORE_AUDIO:
            await self.push_frame(
                ErrorFrame(error="deterministic LLM failure", fatal=True),
                direction,
            )
            return
        await self.push_frame(LLMFullResponseStartFrame(), direction)
        for index, text in enumerate(self._options.response_chunks):
            if await _wait_or_cancel(
                self._options.text_delay_seconds,
                self._cancellation_requested,
            ):
                return
            if index == 0:
                await self.push_frame(
                    TextGenerationFirstTokenFrame(
                        observed_at_unix_ms=time.time_ns() // 1_000_000
                    ),
                    direction,
                )
            await self.push_frame(LLMTextFrame(text=text), direction)
        if not self._cancellation_requested.is_set():
            await self.push_frame(LLMFullResponseEndFrame(), direction)


class FixtureSpeechTTSProcessor(FrameProcessor):
    """Turn deterministic LLM frames into fixture-backed Pipecat PCM frames."""

    def __init__(
        self,
        *,
        options: DeterministicPipelineOptions,
        fixture_pcm: bytes,
        cancellation_requested: CancellationSignal,
    ) -> None:
        super().__init__()
        self._options = options
        self._fixture_chunks = tuple(
            fixture_pcm[index : index + options.audio_chunk_bytes]
            for index in range(0, len(fixture_pcm), options.audio_chunk_bytes)
        )
        self._cancellation_requested = cancellation_requested
        self._next_fixture_chunk = 0
        self._audio_emitted = False
        self._failed = False

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction is not FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, LLMFullResponseStartFrame):
            self._next_fixture_chunk = 0
            self._audio_emitted = False
            self._failed = False
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, LLMTextFrame):
            await self._emit_next_fixture_chunk(direction)
            return
        if isinstance(frame, LLMFullResponseEndFrame):
            while self._next_fixture_chunk < len(self._fixture_chunks):
                if not await self._emit_next_fixture_chunk(direction):
                    return
            await self.push_frame(frame, direction)
            return
        await self.push_frame(frame, direction)

    async def _emit_next_fixture_chunk(self, direction: FrameDirection) -> bool:
        if self._failed or self._next_fixture_chunk >= len(self._fixture_chunks):
            return not self._failed
        if await _wait_or_cancel(self._options.audio_delay_seconds, self._cancellation_requested):
            return False
        chunk = self._fixture_chunks[self._next_fixture_chunk]
        self._next_fixture_chunk += 1
        await self.push_frame(
            TTSAudioRawFrame(
                audio=chunk,
                sample_rate=PCM_S16LE_SAMPLE_RATE_HZ,
                num_channels=PCM_S16LE_CHANNELS,
                context_id="deterministic-e2e",
            ),
            direction,
        )
        self._audio_emitted = True
        if self._options.failure_point is DeterministicFailurePoint.AFTER_FIRST_AUDIO:
            self._failed = True
            await self.push_frame(
                ErrorFrame(error="deterministic TTS failure", fatal=True),
                direction,
            )
            return False
        return True


class PCMNormalizationProcessor(FrameProcessor):
    """Ensure every provider output frame satisfies the public PCM contract."""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if not isinstance(frame, TTSAudioRawFrame) or direction is not FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return
        normalized = normalize_pcm_s16le(
            audio=frame.audio,
            sample_rate_hz=frame.sample_rate,
            channels=frame.num_channels,
        )
        for chunk in split_pcm_chunks(normalized):
            await self.push_frame(
                TTSAudioRawFrame(
                    audio=chunk,
                    sample_rate=PCM_S16LE_SAMPLE_RATE_HZ,
                    num_channels=PCM_S16LE_CHANNELS,
                    context_id=frame.context_id,
                ),
                direction,
            )


class ConversationTextCaptureProcessor(FrameProcessor):
    """Copy LLM text into a frame that every downstream TTS must preserve."""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMTextFrame) and direction is FrameDirection.DOWNSTREAM:
            await self.push_frame(ConversationTextFrame(text=frame.text), direction)
        await self.push_frame(frame, direction)


async def _wait_or_cancel(delay_seconds: float, cancellation_requested: CancellationSignal) -> bool:
    """Return promptly when an external cancellation interrupts deterministic timing."""
    if cancellation_requested.is_set():
        return True
    if delay_seconds == 0:
        return False
    try:
        await asyncio.wait_for(cancellation_requested.wait(), timeout=delay_seconds)
    except TimeoutError:
        return False
    return True
