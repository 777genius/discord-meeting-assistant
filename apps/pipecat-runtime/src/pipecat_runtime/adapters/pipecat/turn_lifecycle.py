"""Route many sequential turns through one persistent Pipecat pipeline."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    ErrorFrame,
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from pipecat_runtime.adapters.pipecat.events import ConversationEventStream
from pipecat_runtime.adapters.pipecat.frames import (
    ConversationTextFrame,
    TextGenerationFailureFrame,
    TextGenerationFirstTokenFrame,
)
from pipecat_runtime.application.models import CancellationReason, StartTurn, TextGenerationFailed


@dataclass(slots=True)
class ActivePipelineTurn:
    """Mutable adapter state for one turn without leaking into application models."""

    request: StartTurn
    attempt_id: str
    events: ConversationEventStream
    cancellation_requested: asyncio.Event = field(default_factory=asyncio.Event)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    cancellation_reason: CancellationReason | None = None
    pipeline_failure: bool = False
    text_generation_failure: TextGenerationFailed | None = None
    first_llm_token_at_unix_ms: int | None = None
    latency_emitted: bool = False
    tts_audio_frame_count: int = 0

    def request_cancellation(self, reason: CancellationReason) -> bool:
        """Record only the first cancellation reason for this exact attempt."""
        if self.finished.is_set() or self.cancellation_reason is not None:
            return False
        self.cancellation_reason = reason
        self.cancellation_requested.set()
        return True


class ActiveTurnCancellationSignal:
    """Present the current turn's signal to processors created only once."""

    def __init__(self) -> None:
        self._active: asyncio.Event | None = None

    def bind(self, turn: ActivePipelineTurn) -> None:
        if self._active is not None:
            raise RuntimeError("persistent pipeline already has a cancellation signal")
        self._active = turn.cancellation_requested

    def release(self, turn: ActivePipelineTurn) -> None:
        if self._active is turn.cancellation_requested:
            self._active = None

    def is_set(self) -> bool:
        active = self._active
        return active is None or active.is_set()

    async def wait(self) -> bool:
        active = self._active
        if active is None:
            return True
        return await active.wait()


class PersistentTurnOutputProcessor(FrameProcessor):
    """Route output to the currently bound turn and signal its drained completion."""

    def __init__(self) -> None:
        super().__init__()
        self._turn: ActivePipelineTurn | None = None
        self._active_tts_contexts: set[str | None] = set()
        self._speaking_tts_contexts: set[str | None] = set()

    def bind(self, turn: ActivePipelineTurn) -> None:
        if self._turn is not None:
            raise RuntimeError("persistent pipeline already has an active output route")
        self._turn = turn
        self._active_tts_contexts.clear()
        self._speaking_tts_contexts.clear()

    def release(self, turn: ActivePipelineTurn) -> None:
        if self._turn is turn:
            self._turn = None
            self._active_tts_contexts.clear()
            self._speaking_tts_contexts.clear()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        turn = self._turn
        if turn is not None and direction is FrameDirection.DOWNSTREAM:
            await self._route_downstream(turn, frame)
        await self.push_frame(frame, direction)

    async def _route_downstream(self, turn: ActivePipelineTurn, frame: Frame) -> None:
        if isinstance(frame, ConversationTextFrame):
            await turn.events.text(frame.text)
        elif isinstance(frame, TTSStartedFrame):
            self._active_tts_contexts.add(frame.context_id)
        elif isinstance(frame, TTSAudioRawFrame):
            await self._route_audio(turn, frame)
        elif isinstance(frame, TTSStoppedFrame):
            await self._route_tts_stopped(frame.context_id)
        elif isinstance(frame, TextGenerationFailureFrame):
            turn.text_generation_failure = frame.failure
        elif isinstance(frame, TextGenerationFirstTokenFrame):
            if turn.first_llm_token_at_unix_ms is None:
                turn.first_llm_token_at_unix_ms = frame.observed_at_unix_ms
        elif isinstance(frame, ErrorFrame):
            turn.pipeline_failure = True
            turn.finished.set()
        elif isinstance(frame, (LLMFullResponseEndFrame, InterruptionFrame)):
            turn.finished.set()

    async def _route_audio(
        self,
        turn: ActivePipelineTurn,
        frame: TTSAudioRawFrame,
    ) -> None:
        turn.tts_audio_frame_count += 1
        first_audio_at_unix_ms = time.time_ns() // 1_000_000
        await turn.events.audio(frame.audio)
        await self._emit_latency(turn, first_audio_at_unix_ms)
        if (
            frame.context_id in self._active_tts_contexts
            and frame.context_id not in self._speaking_tts_contexts
        ):
            should_announce_start = not self._speaking_tts_contexts
            self._speaking_tts_contexts.add(frame.context_id)
            if should_announce_start:
                await self.push_frame(BotStartedSpeakingFrame(), FrameDirection.UPSTREAM)

    @staticmethod
    async def _emit_latency(
        turn: ActivePipelineTurn,
        first_audio_at_unix_ms: int,
    ) -> None:
        first_token = turn.first_llm_token_at_unix_ms
        turn_ended = turn.request.turn_ended_at_unix_ms
        wake_detected = turn.request.wake_detected_at_unix_ms
        if (
            turn.latency_emitted
            or first_token is None
            or turn_ended is None
            or wake_detected is None
        ):
            return
        turn.latency_emitted = True
        end_to_wake = max(0, wake_detected - turn_ended)
        wake_to_token = max(0, first_token - wake_detected)
        token_to_audio = max(0, first_audio_at_unix_ms - first_token)
        await turn.events.latency(
            end_turn_to_wake_ms=end_to_wake,
            wake_to_first_llm_token_ms=wake_to_token,
            first_llm_token_to_audio_ms=token_to_audio,
            total_to_first_audio_ms=end_to_wake + wake_to_token + token_to_audio,
        )

    async def _route_tts_stopped(self, context_id: str | None) -> None:
        was_speaking = context_id in self._speaking_tts_contexts
        self._active_tts_contexts.discard(context_id)
        self._speaking_tts_contexts.discard(context_id)
        if was_speaking and not self._speaking_tts_contexts:
            await self.push_frame(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)
