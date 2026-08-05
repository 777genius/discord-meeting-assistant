"""Provider-neutral conversation runtime implemented by real Pipecat PipelineWorker execution."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable
from uuid import uuid4

from pipecat.frames.frames import EndFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.utils.asyncio.task_manager import TaskManager
from pipecat.workers.base_worker import WorkerParams

from pipecat_runtime.adapters.pipecat.events import ConversationEventStream
from pipecat_runtime.adapters.pipecat.frames import ConversationTurnFrame
from pipecat_runtime.adapters.pipecat.processors import (
    AudioEventProcessor,
    PCMNormalizationProcessor,
    TextEventProcessor,
)
from pipecat_runtime.adapters.providers.profiles import ConversationPipelineProfile
from pipecat_runtime.application.models import (
    PCM_S16LE_SAMPLE_RATE_HZ,
    CancellationReason,
    CancelTurn,
    ConversationEvent,
    RuntimeInputError,
    StartTurn,
)
from pipecat_runtime.application.ports import ConversationRuntime, ConversationSession


class PipecatConversationRuntime(ConversationRuntime):
    """Run one selected provider profile behind the application-owned runtime port."""

    def __init__(
        self,
        *,
        profile: ConversationPipelineProfile,
        maximum_pending_events: int = 64,
        maximum_idempotency_keys: int = 1_024,
        attempt_id_factory: Callable[[], str] | None = None,
    ) -> None:
        if maximum_pending_events < 1:
            raise ValueError("maximum_pending_events must be positive")
        if maximum_idempotency_keys < 1:
            raise ValueError("maximum_idempotency_keys must be positive")
        self._profile = profile
        self._maximum_pending_events = maximum_pending_events
        self._maximum_idempotency_keys = maximum_idempotency_keys
        self._idempotency_requests: OrderedDict[str, StartTurn] = OrderedDict()
        self._active_idempotency_keys: set[str] = set()
        self._attempt_id_factory = attempt_id_factory or _new_attempt_id

    async def start(self, request: StartTurn) -> ConversationSession:
        """Create and run one isolated Pipecat pipeline for the configured voice profile."""
        if request.voice_profile_id != self._profile.profile_id:
            raise RuntimeInputError("request voice_profile_id is not enabled by this runtime")
        existing_request = self._idempotency_requests.get(request.idempotency_key)
        if existing_request is not None:
            if existing_request != request:
                raise RuntimeInputError("idempotency key was reused for a different request")
            raise RuntimeInputError("conversation request was already admitted")
        self._evict_completed_idempotency_key_if_required()
        self._idempotency_requests[request.idempotency_key] = request
        self._active_idempotency_keys.add(request.idempotency_key)
        attempt_id = self._attempt_id_factory()
        if not attempt_id.strip():
            self._remove_idempotency_key(request.idempotency_key)
            raise RuntimeInputError("attempt id factory returned an empty identifier")
        events = ConversationEventStream(
            request=request,
            attempt_id=attempt_id,
            maximum_events=self._maximum_pending_events,
        )
        await events.accepted()
        try:
            session = PipecatConversationSession(
                request=request,
                attempt_id=attempt_id,
                events=events,
                on_finished=lambda: self._active_idempotency_keys.discard(
                    request.idempotency_key
                ),
                profile=self._profile,
            )
            session.start()
        except Exception:
            self._remove_idempotency_key(request.idempotency_key)
            raise
        return session

    def _evict_completed_idempotency_key_if_required(self) -> None:
        if len(self._idempotency_requests) < self._maximum_idempotency_keys:
            return
        completed_key = next(
            (
                key
                for key in self._idempotency_requests
                if key not in self._active_idempotency_keys
            ),
            None,
        )
        if completed_key is None:
            raise RuntimeInputError("idempotency registry capacity is occupied by active turns")
        self._idempotency_requests.pop(completed_key)

    def _remove_idempotency_key(self, idempotency_key: str) -> None:
        self._idempotency_requests.pop(idempotency_key, None)
        self._active_idempotency_keys.discard(idempotency_key)


class PipecatConversationSession(ConversationSession):
    """Own one real PipelineWorker and its bounded public event stream."""

    def __init__(
        self,
        *,
        request: StartTurn,
        attempt_id: str,
        events: ConversationEventStream,
        on_finished: Callable[[], None],
        profile: ConversationPipelineProfile,
    ) -> None:
        self._request = request
        self._attempt_id = attempt_id
        self._events = events
        self._on_finished = on_finished
        self._cancellation_requested = asyncio.Event()
        self._cancellation_reason: CancellationReason | None = None
        self._state_lock = asyncio.Lock()
        self._finished = asyncio.Event()
        profile_processors = profile.create_processors(request, self._cancellation_requested)
        self._audio_events = AudioEventProcessor(events=events)
        pipeline = Pipeline(
            [
                *profile_processors,
                TextEventProcessor(events=events),
                PCMNormalizationProcessor(),
                self._audio_events,
            ]
        )
        self._task = PipelineWorker(
            pipeline,
            cancel_on_idle_timeout=False,
            enable_rtvi=False,
            enable_turn_tracking=False,
            params=PipelineParams(audio_out_sample_rate=PCM_S16LE_SAMPLE_RATE_HZ),
        )
        self._runner_task: asyncio.Task[None] | None = None

    @property
    def attempt_id(self) -> str:
        """Return the attempt identifier announced by the accepted event."""
        return self._attempt_id

    def start(self) -> None:
        """Begin PipelineWorker execution once the session has been returned to the caller."""
        if self._runner_task is not None:
            raise RuntimeError("conversation session has already started")
        self._runner_task = asyncio.create_task(
            self._run_pipeline(),
            name=f"pipecat-conversation-{self._attempt_id}",
        )

    def events(self) -> AsyncIterator[ConversationEvent]:
        """Yield the sidecar's ordered public stream without exposing Pipecat frames."""
        return self._events.iterate()

    def abandon_events(self) -> None:
        """Release a blocked producer when the transport consumer disappears."""
        self._events.abandon()

    async def cancel(self, request: CancelTurn) -> bool:
        """Cancel only the exact attempt requested by the gRPC client."""
        if request.turn_id != self._request.turn_id or request.attempt_id != self._attempt_id:
            raise RuntimeInputError("cancellation does not match the active conversation attempt")
        async with self._state_lock:
            if (
                self._finished.is_set()
                or self._events.is_terminal
                or self._cancellation_reason is not None
            ):
                return False
            self._cancellation_reason = request.reason
            self._cancellation_requested.set()
            if not self._events.has_consumer:
                self._events.abandon()
        await self._task.cancel(reason=request.reason.value)
        return True

    async def wait(self) -> None:
        """Wait for PipelineWorker completion and Pipecat processor cleanup."""
        runner_task = self._runner_task
        if runner_task is None:
            raise RuntimeError("conversation session was not started")
        await runner_task

    async def _run_pipeline(self) -> None:
        try:
            await self._task.queue_frames((ConversationTurnFrame(self._request), EndFrame()))
            await self._task.run(WorkerParams(task_manager=TaskManager()))
            if self._cancellation_reason is not None:
                await self._events.cancelled(self._cancellation_reason)
            elif self._audio_events.text_generation_failure is not None:
                failure = self._audio_events.text_generation_failure
                await self._events.failed(
                    code=failure.code,
                    safe_message=failure.safe_message,
                    retryable=failure.retryable,
                )
            elif self._audio_events.failure_detected:
                await self._events.failed(
                    code="pipecat-pipeline-failed",
                    safe_message="Conversation synthesis failed.",
                    retryable=True,
                )
            else:
                await self._events.completed()
        except Exception:
            if self._cancellation_reason is not None:
                await self._events.cancelled(self._cancellation_reason)
            else:
                await self._events.failed(
                    code="pipecat-runtime-failed",
                    safe_message="Conversation runtime failed.",
                    retryable=True,
                )
        finally:
            if not self._events.is_terminal:
                await self._events.failed(
                    code="pipecat-runtime-incomplete",
                    safe_message="Conversation runtime ended without a terminal outcome.",
                    retryable=True,
                )
            self._finished.set()
            self._on_finished()


def _new_attempt_id() -> str:
    """Create an adapter-owned correlation ID that never crosses into Meeting Core state."""
    return f"attempt-{uuid4().hex}"
