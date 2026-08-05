"""Real Pipecat PipelineWorker execution with deterministic safe providers."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from dataclasses import replace

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from pipecat_runtime.adapters.pipecat.frames import ConversationTurnFrame
from pipecat_runtime.adapters.pipecat.processors import (
    DeterministicFailurePoint,
    DeterministicPipelineOptions,
)
from pipecat_runtime.adapters.pipecat.runtime import PipecatConversationRuntime
from pipecat_runtime.adapters.providers.profiles import create_profile
from pipecat_runtime.application.models import (
    MAXIMUM_PCM_CHUNK_BYTES,
    AudioChunk,
    AudioStart,
    CancellationReason,
    Cancelled,
    CancelTurn,
    Completed,
    ConversationEvent,
    Failed,
    RuntimeInputError,
    StartTurn,
)
from tests.support import deterministic_runtime_settings, sample_start_turn


async def _collect(events: AsyncIterator[ConversationEvent]) -> list[ConversationEvent]:
    return [event async for event in events]


class _PlaybackLifecycleProbe(FrameProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.observed: list[type[Frame]] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction is FrameDirection.UPSTREAM and isinstance(
            frame, (BotStartedSpeakingFrame, BotStoppedSpeakingFrame)
        ):
            self.observed.append(type(frame))
        await self.push_frame(frame, direction)


class _FramedSpeechProcessor(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, ConversationTurnFrame) and direction is FrameDirection.DOWNSTREAM:
            await self.push_frame(TTSStartedFrame(context_id="provider-context"), direction)
            await self.push_frame(
                TTSAudioRawFrame(
                    audio=b"\x01\x00" * 960,
                    sample_rate=48_000,
                    num_channels=1,
                    context_id="provider-context",
                ),
                direction,
            )
            await self.push_frame(TTSStoppedFrame(context_id="provider-context"), direction)
        await self.push_frame(frame, direction)


class _FramedSpeechProfile:
    profile_id = "framed-speech"

    def __init__(self, probe: _PlaybackLifecycleProbe) -> None:
        self._probe = probe

    def create_processors(
        self,
        request: StartTurn,
        cancellation_requested: asyncio.Event,
    ) -> Sequence[FrameProcessor]:
        del request, cancellation_requested
        return self._probe, _FramedSpeechProcessor()


async def test_deterministic_pipeline_streams_ordered_normalized_pcm() -> None:
    """A fake answer still crosses a real PipelineWorker and Pipecat processors."""
    settings = deterministic_runtime_settings(
        DeterministicPipelineOptions(response_chunks=("Привет. ", "Я слушаю."))
    )
    runtime = PipecatConversationRuntime(profile=create_profile(settings.profile))
    session = await runtime.start(sample_start_turn())

    events = await _collect(session.events())
    await session.wait()

    assert [event.event_sequence for event in events] == list(range(len(events)))
    assert type(events[0]).__name__ == "Accepted"
    assert any(type(event).__name__ == "TextDelta" for event in events)
    assert isinstance(events[-1], Completed)
    audio_start = next(event for event in events if isinstance(event, AudioStart))
    audio_chunks = [event for event in events if isinstance(event, AudioChunk)]
    assert audio_start.sample_rate_hz == 48_000
    assert audio_start.channels == 1
    assert audio_chunks
    assert all(len(event.pcm) <= MAXIMUM_PCM_CHUNK_BYTES for event in audio_chunks)
    assert all(len(event.pcm) % 2 == 0 for event in audio_chunks)


async def test_transportless_pipeline_acknowledges_provider_playback_lifecycle() -> None:
    """gRPC audio delivery supplies the Bot speaking handshake expected by streaming TTS."""
    probe = _PlaybackLifecycleProbe()
    runtime = PipecatConversationRuntime(profile=_FramedSpeechProfile(probe))
    session = await runtime.start(sample_start_turn(voice_profile_id="framed-speech"))

    events = await _collect(session.events())
    await session.wait()

    assert isinstance(events[-1], Completed)
    assert probe.observed == [BotStartedSpeakingFrame, BotStoppedSpeakingFrame]


async def test_deterministic_pipeline_cancels_an_active_turn() -> None:
    """An exact CancelTurn interrupts delayed deterministic Pipecat processing."""
    settings = deterministic_runtime_settings(
        DeterministicPipelineOptions(
            response_chunks=("Первый фрагмент. ", "Второй фрагмент."),
            text_delay_seconds=0.5,
        )
    )
    runtime = PipecatConversationRuntime(profile=create_profile(settings.profile))
    session = await runtime.start(sample_start_turn())
    events = session.events()
    accepted = await anext(events)

    changed = await session.cancel(
        CancelTurn(
            turn_id=accepted.turn_id,
            attempt_id=accepted.attempt_id,
            reason=CancellationReason.BARGE_IN,
        )
    )
    remaining = await _collect(events)
    await session.wait()

    assert changed is True
    assert isinstance(remaining[-1], Cancelled)
    assert remaining[-1].reason.value == "barge-in"


async def test_deterministic_pipeline_reports_safe_failure() -> None:
    """Injected synthetic failures become provider-neutral terminal failures."""
    settings = deterministic_runtime_settings(
        DeterministicPipelineOptions(failure_point=DeterministicFailurePoint.AFTER_FIRST_AUDIO)
    )
    runtime = PipecatConversationRuntime(profile=create_profile(settings.profile))
    session = await runtime.start(sample_start_turn())

    events = await _collect(session.events())
    await session.wait()

    assert isinstance(events[-1], Failed)
    assert events[-1].code == "pipecat-pipeline-failed"


async def test_runtime_rejects_duplicate_idempotency_without_starting_a_second_pipeline() -> None:
    """A repeated boundary request cannot synthesize a second response."""
    settings = deterministic_runtime_settings(
        DeterministicPipelineOptions(text_delay_seconds=0.5)
    )
    runtime = PipecatConversationRuntime(profile=create_profile(settings.profile))
    request = sample_start_turn()
    session = await runtime.start(request)

    with pytest.raises(RuntimeInputError, match="already admitted"):
        await runtime.start(request)

    events = session.events()
    accepted = await anext(events)
    await session.cancel(
        CancelTurn(
            turn_id=accepted.turn_id,
            attempt_id=accepted.attempt_id,
            reason=CancellationReason.RUNTIME_SHUTDOWN,
        )
    )
    await _collect(events)
    await session.wait()


async def test_idempotency_capacity_never_evicts_an_active_turn() -> None:
    """A full registry fails closed until its active key becomes safely evictable."""
    settings = deterministic_runtime_settings(
        DeterministicPipelineOptions(text_delay_seconds=0.5)
    )
    runtime = PipecatConversationRuntime(
        profile=create_profile(settings.profile),
        maximum_idempotency_keys=1,
    )
    first_request = sample_start_turn()
    second_request = replace(
        first_request,
        idempotency_key="idempotency-2",
        turn_id="turn-2",
    )
    first_session = await runtime.start(first_request)

    with pytest.raises(RuntimeInputError, match="occupied by active turns"):
        await runtime.start(second_request)

    first_events = first_session.events()
    accepted = await anext(first_events)
    await first_session.cancel(
        CancelTurn(
            turn_id=accepted.turn_id,
            attempt_id=accepted.attempt_id,
            reason=CancellationReason.RUNTIME_SHUTDOWN,
        )
    )
    await _collect(first_events)
    await first_session.wait()

    second_session = await runtime.start(second_request)
    second_events = await _collect(second_session.events())
    await second_session.wait()

    assert isinstance(second_events[-1], Completed)


async def test_abandoned_consumer_releases_backpressure_and_active_idempotency() -> None:
    """Disconnect with a full queue cannot retain a runner or active registry key."""
    settings = deterministic_runtime_settings(
        DeterministicPipelineOptions(text_delay_seconds=0.5)
    )
    runtime = PipecatConversationRuntime(
        profile=create_profile(settings.profile),
        maximum_idempotency_keys=1,
        maximum_pending_events=1,
    )
    first_request = sample_start_turn()
    second_request = replace(
        first_request,
        idempotency_key="idempotency-after-disconnect",
        turn_id="turn-after-disconnect",
    )
    first_session = await runtime.start(first_request)

    await first_session.cancel(
        CancelTurn(
            turn_id=first_request.turn_id,
            attempt_id=first_session.attempt_id,
            reason=CancellationReason.RUNTIME_SHUTDOWN,
        )
    )
    await asyncio.wait_for(first_session.wait(), timeout=1)
    assert await _collect(first_session.events()) == []

    second_session = await runtime.start(second_request)
    second_events = await _collect(second_session.events())
    await second_session.wait()

    assert isinstance(second_events[-1], Completed)
