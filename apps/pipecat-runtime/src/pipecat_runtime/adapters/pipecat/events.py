"""Bounded ordered event emission for one Pipecat conversation attempt."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable

from pipecat_runtime.application.conversation_events import (
    Accepted,
    AudioChunk,
    AudioEnd,
    AudioStart,
    Cancelled,
    Completed,
    ConversationEvent,
    Failed,
    Latency,
    TextDelta,
    TtsAttestation,
    Usage,
)
from pipecat_runtime.application.models import CancellationReason, StartTurn


class ConversationEventStream:
    """Serialize provider-neutral events and apply backpressure to Pipecat processors."""

    def __init__(self, *, request: StartTurn, attempt_id: str, maximum_events: int) -> None:
        if maximum_events < 1:
            raise ValueError("maximum_events must be positive")
        self._request = request
        self._attempt_id = attempt_id
        self._events: asyncio.Queue[ConversationEvent | None] = asyncio.Queue(
            maxsize=maximum_events
        )
        self._sequence = -1
        self._audio_sequence = 0
        self._audio_open = False
        self._consumer_attached = False
        self._consumer_closed = False
        self._terminal = False
        self._output_tokens = 0
        self._lock = asyncio.Lock()

    @property
    def is_terminal(self) -> bool:
        """Return whether a terminal event has been emitted."""
        return self._terminal

    @property
    def has_consumer(self) -> bool:
        """Return whether the unique event consumer is actively draining the queue."""
        return self._consumer_attached and not self._consumer_closed

    def abandon(self) -> None:
        """Release blocked producers after the unique consumer has disconnected."""
        self._consumer_closed = True
        while True:
            try:
                self._events.get_nowait()
            except asyncio.QueueEmpty:
                return

    async def accepted(self) -> None:
        """Publish the first event for a newly created attempt."""
        await self._emit(Accepted)

    async def tts_attestation(
        self,
        *,
        deployment: str,
        key_id: str,
        model: str,
        provider: str,
        signature: str,
        source_revision: str,
        voice: str,
        voice_profile_id: str,
    ) -> None:
        """Publish the signed concrete TTS identity before any PCM event."""
        await self._emit(
            TtsAttestation,
            deployment=deployment,
            key_id=key_id,
            model=model,
            provider=provider,
            signature=signature,
            source_revision=source_revision,
            voice=voice,
            voice_profile_id=voice_profile_id,
        )

    async def text(self, text: str) -> None:
        """Publish one text fragment before it reaches TTS."""
        async with self._lock:
            if self._terminal:
                return
            self._output_tokens += _rough_token_count(text)
            await self._emit_locked(TextDelta, text=text)

    async def audio(self, pcm: bytes) -> None:
        """Publish normalized PCM and its one-time start marker."""
        async with self._lock:
            if self._terminal:
                return
            if not self._audio_open:
                await self._emit_locked(AudioStart)
                self._audio_open = True
            await self._emit_locked(AudioChunk, audio_sequence=self._audio_sequence, pcm=pcm)
            self._audio_sequence += 1

    async def completed(self) -> None:
        """Close a successful response with audio and usage ordering preserved."""
        async with self._lock:
            if self._terminal:
                return
            await self._close_audio_locked()
            input_tokens = _rough_token_count(self._request.system_prompt) + _rough_token_count(
                self._request.prompt
            )
            await self._emit_locked(
                Usage,
                input_tokens=input_tokens,
                output_tokens=self._output_tokens,
                total_tokens=input_tokens + self._output_tokens,
            )
            await self._emit_terminal_locked(Completed)

    async def latency(
        self,
        *,
        end_turn_to_wake_ms: int,
        wake_to_first_llm_token_ms: int,
        first_llm_token_to_audio_ms: int,
        total_to_first_audio_ms: int,
    ) -> None:
        """Publish exact first-audio stage durations once for an instrumented turn."""
        await self._emit(
            Latency,
            end_turn_to_wake_ms=end_turn_to_wake_ms,
            wake_to_first_llm_token_ms=wake_to_first_llm_token_ms,
            first_llm_token_to_audio_ms=first_llm_token_to_audio_ms,
            total_to_first_audio_ms=total_to_first_audio_ms,
        )

    async def cancelled(self, reason: CancellationReason) -> None:
        """Close a cancelled response after any previously streamed audio."""
        async with self._lock:
            if self._terminal:
                return
            await self._close_audio_locked()
            await self._emit_terminal_locked(Cancelled, reason=reason)

    async def failed(self, *, code: str, safe_message: str, retryable: bool) -> None:
        """Close a failed response without exposing provider exception details."""
        async with self._lock:
            if self._terminal:
                return
            await self._close_audio_locked()
            await self._emit_terminal_locked(
                Failed,
                code=code,
                safe_message=safe_message,
                retryable=retryable,
            )

    async def iterate(self) -> AsyncIterator[ConversationEvent]:
        """Yield every ordered event through the unique terminal event."""
        if self._consumer_attached:
            raise RuntimeError("conversation event stream accepts only one consumer")
        self._consumer_attached = True
        try:
            if self._consumer_closed:
                return
            while True:
                event = await self._events.get()
                if event is None:
                    return
                yield event
        finally:
            self.abandon()

    async def _emit(self, event_type: EventFactory, **payload: object) -> None:
        async with self._lock:
            if self._terminal:
                return
            await self._emit_locked(event_type, **payload)

    async def _emit_locked(self, event_type: EventFactory, **payload: object) -> None:
        if self._consumer_closed:
            return
        self._sequence += 1
        event = event_type(
            turn_id=self._request.turn_id,
            attempt_id=self._attempt_id,
            event_sequence=self._sequence,
            **payload,
        )
        await self._events.put(event)

    async def _close_audio_locked(self) -> None:
        if self._audio_open:
            await self._emit_locked(AudioEnd)
            self._audio_open = False

    async def _emit_terminal_locked(self, event_type: EventFactory, **payload: object) -> None:
        await self._emit_locked(event_type, **payload)
        self._terminal = True
        if self._consumer_closed:
            return
        await self._events.put(None)


def _rough_token_count(text: str) -> int:
    """Provide deterministic provider-neutral telemetry without claiming tokenizer precision."""
    return len(text.split())


type EventFactory = Callable[..., ConversationEvent]
