"""Real Pipecat PipelineWorker execution with deterministic safe providers."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Sequence
from dataclasses import replace
from typing import Any, cast

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from pipecat_runtime.adapters.pipecat.frames import ConversationTurnFrame
from pipecat_runtime.adapters.pipecat.processors import (
    ConversationTextCaptureProcessor,
    DeterministicFailurePoint,
    DeterministicPipelineOptions,
)
from pipecat_runtime.adapters.pipecat.runtime import PipecatConversationRuntime
from pipecat_runtime.adapters.providers.profiles import create_profile
from pipecat_runtime.application.conversation_events import (
    AudioChunk,
    AudioStart,
    Cancelled,
    Completed,
    ConversationEvent,
    Failed,
    Latency,
)
from pipecat_runtime.application.models import (
    MAXIMUM_PCM_CHUNK_BYTES,
    CancellationReason,
    CancelTurn,
    RuntimeInputError,
    StartTurn,
)
from pipecat_runtime.application.ports import CancellationSignal
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
            await self.push_frame(LLMFullResponseStartFrame(), direction)
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
            await self.push_frame(LLMFullResponseEndFrame(), direction)
        await self.push_frame(frame, direction)


class _FramedSpeechProfile:
    profile_id = "framed-speech"

    def __init__(self, probe: _PlaybackLifecycleProbe) -> None:
        self._probe = probe

    def create_processors(
        self,
        request: StartTurn,
        cancellation_requested: CancellationSignal,
    ) -> Sequence[FrameProcessor]:
        del request, cancellation_requested
        return self._probe, _FramedSpeechProcessor()


class _CountingTurnProcessor(FrameProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.turn_ids: list[str] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, ConversationTurnFrame) and direction is FrameDirection.DOWNSTREAM:
            self.turn_ids.append(frame.request.turn_id)
            await self.push_frame(LLMFullResponseStartFrame(), direction)
            await self.push_frame(LLMTextFrame(text=f"Ответ {len(self.turn_ids)}."), direction)
            await self.push_frame(LLMFullResponseEndFrame(), direction)
        await self.push_frame(frame, direction)


class _CountingProfile:
    profile_id = "persistent-test"

    def __init__(self) -> None:
        self.create_count = 0
        self.processor = _CountingTurnProcessor()

    def create_processors(
        self,
        request: StartTurn,
        cancellation_requested: CancellationSignal,
    ) -> Sequence[FrameProcessor]:
        del request, cancellation_requested
        self.create_count += 1
        return self.processor, ConversationTextCaptureProcessor()


class _IndependentCountingProfile:
    """Create isolated processors for tests that exercise multiple meeting pipelines."""

    profile_id = "independent-persistent-test"

    def create_processors(
        self,
        request: StartTurn,
        cancellation_requested: CancellationSignal,
    ) -> Sequence[FrameProcessor]:
        del request, cancellation_requested
        return _CountingTurnProcessor(), ConversationTextCaptureProcessor()


class _InterruptibleTurnProcessor(FrameProcessor):
    def __init__(self, cancellation_requested: CancellationSignal) -> None:
        super().__init__()
        self._cancellation_requested = cancellation_requested
        self.started = asyncio.Event()
        self.turn_count = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if (
            not isinstance(frame, ConversationTurnFrame)
            or direction is not FrameDirection.DOWNSTREAM
        ):
            await self.push_frame(frame, direction)
            return
        self.turn_count += 1
        if self.turn_count == 1:
            self.started.set()
            await self._cancellation_requested.wait()
            return
        await self.push_frame(LLMFullResponseStartFrame(), direction)
        await self.push_frame(LLMTextFrame(text="После interruption pipeline жива."), direction)
        await self.push_frame(LLMFullResponseEndFrame(), direction)


class _InterruptibleProfile:
    profile_id = "persistent-interruption-test"

    def __init__(self) -> None:
        self.create_count = 0
        self.processor: _InterruptibleTurnProcessor | None = None

    def create_processors(
        self,
        request: StartTurn,
        cancellation_requested: CancellationSignal,
    ) -> Sequence[FrameProcessor]:
        del request
        self.create_count += 1
        self.processor = _InterruptibleTurnProcessor(cancellation_requested)
        return self.processor, ConversationTextCaptureProcessor()


async def test_two_sequential_turns_reuse_one_warm_meeting_pipeline() -> None:
    """Normal completion retains the same Pipecat worker and provider processors."""
    profile = _CountingProfile()
    runtime = PipecatConversationRuntime(profile=profile)
    first_request = sample_start_turn(voice_profile_id=profile.profile_id)
    first = await runtime.start(first_request)
    first_events = await _collect(first.events())
    await first.wait()

    second_request = replace(
        first_request,
        turn_id="turn-persistent-2",
        idempotency_key="idempotency-persistent-2",
    )
    second = await runtime.start(second_request)
    second_events = await _collect(second.events())
    await second.wait()
    await runtime.close()

    assert isinstance(first_events[-1], Completed)
    assert isinstance(second_events[-1], Completed)
    assert profile.create_count == 1
    assert profile.processor.turn_ids == [first_request.turn_id, second_request.turn_id]


async def test_interruption_preserves_the_warm_pipeline_for_the_queued_turn() -> None:
    """Barge-in ends only the active context; the next turn reuses the same worker."""
    profile = _InterruptibleProfile()
    runtime = PipecatConversationRuntime(profile=profile)
    first_request = sample_start_turn(voice_profile_id=profile.profile_id)
    first = await runtime.start(first_request)
    first_events = first.events()
    accepted = await anext(first_events)
    assert profile.processor is not None
    await asyncio.wait_for(profile.processor.started.wait(), timeout=1)
    changed = await first.cancel(
        CancelTurn(
            turn_id=first_request.turn_id,
            attempt_id=accepted.attempt_id,
            reason=CancellationReason.BARGE_IN,
        )
    )
    first_remaining = await _collect(first_events)
    await first.wait()

    second_request = replace(
        first_request,
        turn_id="turn-after-interruption",
        idempotency_key="idempotency-after-interruption",
    )
    second = await runtime.start(second_request)
    second_events = await _collect(second.events())
    await second.wait()
    await runtime.close()

    assert changed is True
    assert isinstance(first_remaining[-1], Cancelled)
    assert isinstance(second_events[-1], Completed)
    assert profile.create_count == 1
    assert profile.processor.turn_count == 2


async def test_deterministic_pipeline_streams_ordered_normalized_pcm() -> None:
    """A fake answer still crosses a real PipelineWorker and Pipecat processors."""
    settings = deterministic_runtime_settings(
        DeterministicPipelineOptions(response_chunks=("Привет. ", "Я слушаю."))
    )
    runtime = PipecatConversationRuntime(profile=create_profile(settings.profile))
    session = await runtime.start(sample_start_turn())

    events = await _collect(session.events())
    await session.wait()
    await runtime.close()

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


async def test_pipeline_reports_exact_first_audio_latency_stages() -> None:
    """Instrumented turns expose additive end-to-wake, LLM, and TTS stage timings."""
    wake_detected_at_unix_ms = time.time_ns() // 1_000_000
    request = replace(
        sample_start_turn(),
        turn_ended_at_unix_ms=wake_detected_at_unix_ms - 75,
        wake_detected_at_unix_ms=wake_detected_at_unix_ms,
    )
    settings = deterministic_runtime_settings()
    runtime = PipecatConversationRuntime(profile=create_profile(settings.profile))
    session = await runtime.start(request)

    events = await asyncio.wait_for(_collect(session.events()), timeout=2)
    await asyncio.wait_for(session.wait(), timeout=2)
    await asyncio.wait_for(runtime.close(), timeout=2)

    latency = next(event for event in events if isinstance(event, Latency))
    assert latency.end_turn_to_wake_ms == 75
    assert latency.total_to_first_audio_ms == (
        latency.end_turn_to_wake_ms
        + latency.wake_to_first_llm_token_ms
        + latency.first_llm_token_to_audio_ms
    )


async def test_transportless_pipeline_acknowledges_provider_playback_lifecycle() -> None:
    """gRPC audio delivery supplies the Bot speaking handshake expected by streaming TTS."""
    probe = _PlaybackLifecycleProbe()
    runtime = PipecatConversationRuntime(profile=_FramedSpeechProfile(probe))
    session = await runtime.start(sample_start_turn(voice_profile_id="framed-speech"))

    events = await _collect(session.events())
    await session.wait()
    await runtime.close()

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
    await runtime.close()

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
    await runtime.close()

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
    await runtime.close()


async def test_runtime_rejects_concurrent_locales_for_the_same_meeting() -> None:
    """A locale change cannot bypass meeting-scoped overlap protection."""
    settings = deterministic_runtime_settings(
        DeterministicPipelineOptions(text_delay_seconds=0.5)
    )
    runtime = PipecatConversationRuntime(profile=create_profile(settings.profile))
    first_request = sample_start_turn()
    first = await runtime.start(first_request)
    second_request = replace(
        first_request,
        idempotency_key="idempotency-other-locale",
        locale="en-US",
        turn_id="turn-other-locale",
    )

    with pytest.raises(RuntimeInputError, match="pipeline is busy"):
        await runtime.start(second_request)

    events = first.events()
    accepted = await anext(events)
    await first.cancel(
        CancelTurn(
            turn_id=first_request.turn_id,
            attempt_id=accepted.attempt_id,
            reason=CancellationReason.RUNTIME_SHUTDOWN,
        )
    )
    await _collect(events)
    await first.wait()
    await runtime.close()


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
    await runtime.close()

    assert isinstance(second_events[-1], Completed)


async def test_evicted_pipeline_closes_without_holding_global_admission_lock() -> None:
    """A slow provider close cannot block another cached meeting's admission."""
    profile = _IndependentCountingProfile()
    runtime = PipecatConversationRuntime(
        profile=profile,
        maximum_persistent_pipelines=2,
    )
    first_request = sample_start_turn(voice_profile_id=profile.profile_id)
    first_session = await runtime.start(first_request)
    await asyncio.wait_for(_collect(first_session.events()), timeout=2)
    await asyncio.wait_for(first_session.wait(), timeout=2)

    second_request = replace(
        first_request,
        meeting_id="meeting-persistent-2",
        recording_id="recording-persistent-2",
        turn_id="turn-persistent-2",
        idempotency_key="idempotency-persistent-2",
    )
    second_session = await runtime.start(second_request)
    await asyncio.wait_for(_collect(second_session.events()), timeout=2)
    await asyncio.wait_for(second_session.wait(), timeout=2)

    runtime_state = cast(Any, runtime)
    first_pipeline = next(iter(runtime_state._pipelines.values()))
    close_started = asyncio.Event()
    allow_close = asyncio.Event()
    original_close = first_pipeline.close

    async def slow_close() -> None:
        close_started.set()
        await allow_close.wait()
        await original_close()

    first_pipeline.close = slow_close
    third_request = replace(
        first_request,
        meeting_id="meeting-persistent-3",
        recording_id="recording-persistent-3",
        turn_id="turn-persistent-3",
        idempotency_key="idempotency-persistent-3",
    )
    third_start = asyncio.create_task(runtime.start(third_request))
    await asyncio.wait_for(close_started.wait(), timeout=1)
    third_session = await asyncio.wait_for(third_start, timeout=1)

    with pytest.raises(RuntimeInputError, match="pipeline is busy"):
        await runtime.start(
            replace(
                third_request,
                turn_id="turn-persistent-3-overlap",
                idempotency_key="idempotency-persistent-3-overlap",
            )
        )

    second_again = await asyncio.wait_for(
        runtime.start(
            replace(
                second_request,
                turn_id="turn-persistent-2-again",
                idempotency_key="idempotency-persistent-2-again",
            )
        ),
        timeout=1,
    )
    second_again_events = await asyncio.wait_for(_collect(second_again.events()), timeout=2)
    await asyncio.wait_for(second_again.wait(), timeout=2)
    assert isinstance(second_again_events[-1], Completed)
    assert len(runtime_state._pipelines) == 2

    third_events = await asyncio.wait_for(_collect(third_session.events()), timeout=2)
    await asyncio.wait_for(third_session.wait(), timeout=2)
    allow_close.set()
    retained_pipelines = tuple(runtime_state._pipelines.values())
    await asyncio.wait_for(runtime.close(), timeout=15)

    assert isinstance(third_events[-1], Completed)
    assert all(
        pipeline._runner_task is None or pipeline._runner_task.done()
        for pipeline in (first_pipeline, *retained_pipelines)
    )


async def test_failed_evicted_pipeline_close_does_not_retain_meeting_admission() -> None:
    """A detached provider cleanup failure cannot strand the newly admitted turn."""
    profile = _IndependentCountingProfile()
    runtime = PipecatConversationRuntime(
        profile=profile,
        maximum_persistent_pipelines=1,
    )
    first_request = sample_start_turn(voice_profile_id=profile.profile_id)
    first_session = await runtime.start(first_request)
    await asyncio.wait_for(_collect(first_session.events()), timeout=2)
    await asyncio.wait_for(first_session.wait(), timeout=2)

    runtime_state = cast(Any, runtime)
    first_pipeline = next(iter(runtime_state._pipelines.values()))

    async def failed_close() -> None:
        raise RuntimeError("injected provider close failure")

    first_pipeline.close = failed_close
    second_request = replace(
        first_request,
        meeting_id="meeting-after-failed-close",
        recording_id="recording-after-failed-close",
        turn_id="turn-after-failed-close",
        idempotency_key="idempotency-after-failed-close",
    )
    second_session = await asyncio.wait_for(runtime.start(second_request), timeout=1)
    second_events = await asyncio.wait_for(_collect(second_session.events()), timeout=2)
    await asyncio.wait_for(second_session.wait(), timeout=2)

    third_session = await asyncio.wait_for(
        runtime.start(
            replace(
                second_request,
                turn_id="turn-after-cleanup-failure",
                idempotency_key="idempotency-after-cleanup-failure",
            )
        ),
        timeout=1,
    )
    third_events = await asyncio.wait_for(_collect(third_session.events()), timeout=2)
    await asyncio.wait_for(third_session.wait(), timeout=2)
    retained_pipeline = next(iter(runtime_state._pipelines.values()))
    await asyncio.wait_for(runtime.close(), timeout=15)

    assert isinstance(second_events[-1], Completed)
    assert isinstance(third_events[-1], Completed)
    assert first_pipeline._runner_task is None or first_pipeline._runner_task.done()
    assert retained_pipeline._runner_task is None or retained_pipeline._runner_task.done()


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
    await runtime.close()

    assert isinstance(second_events[-1], Completed)
