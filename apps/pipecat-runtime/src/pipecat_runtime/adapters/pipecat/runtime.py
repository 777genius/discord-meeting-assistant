"""Provider-neutral runtime backed by bounded persistent Pipecat meeting pipelines."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable
from uuid import uuid4

from pipecat_runtime.adapters.pipecat.events import ConversationEventStream
from pipecat_runtime.adapters.pipecat.persistent_pipeline import PersistentConversationPipeline
from pipecat_runtime.adapters.pipecat.turn_lifecycle import ActivePipelineTurn
from pipecat_runtime.adapters.providers.profiles import ConversationPipelineProfile
from pipecat_runtime.application.conversation_events import ConversationEvent
from pipecat_runtime.application.models import (
    CancelTurn,
    RuntimeInputError,
    StartTurn,
)
from pipecat_runtime.application.ports import ConversationRuntime, ConversationSession

type PipelineKey = tuple[str, str, str]


class PipecatConversationRuntime(ConversationRuntime):
    """Reuse one isolated provider pipeline for sequential turns in each meeting."""

    def __init__(
        self,
        *,
        profile: ConversationPipelineProfile,
        maximum_pending_events: int = 64,
        maximum_idempotency_keys: int = 1_024,
        maximum_persistent_pipelines: int = 64,
        attempt_id_factory: Callable[[], str] | None = None,
    ) -> None:
        if min(
            maximum_pending_events,
            maximum_idempotency_keys,
            maximum_persistent_pipelines,
        ) < 1:
            raise ValueError("runtime capacity limits must be positive")
        self._profile = profile
        self._maximum_pending_events = maximum_pending_events
        self._maximum_idempotency_keys = maximum_idempotency_keys
        self._maximum_persistent_pipelines = maximum_persistent_pipelines
        self._idempotency_requests: OrderedDict[str, StartTurn] = OrderedDict()
        self._active_idempotency_keys: set[str] = set()
        self._active_meeting_ids: set[str] = set()
        self._pipelines: OrderedDict[PipelineKey, PersistentConversationPipeline] = OrderedDict()
        self._attempt_id_factory = attempt_id_factory or _new_attempt_id
        self._state_lock = asyncio.Lock()
        self._closed = False

    async def start(self, request: StartTurn) -> ConversationSession:
        """Admit one turn into its meeting's already-warm pipeline."""
        async with self._state_lock:
            self._validate_request(request)
            self._evict_completed_idempotency_key_if_required()
            if request.meeting_id in self._active_meeting_ids:
                raise RuntimeInputError("meeting conversation pipeline is busy")
            attempt_id = self._attempt_id_factory()
            if not attempt_id.strip():
                raise RuntimeInputError("attempt id factory returned an empty identifier")
            events = ConversationEventStream(
                request=request,
                attempt_id=attempt_id,
                maximum_events=self._maximum_pending_events,
            )
            turn = ActivePipelineTurn(request=request, attempt_id=attempt_id, events=events)
            pipeline = await self._pipeline_for(turn)
            try:
                await pipeline.reserve(turn)
            except RuntimeError as error:
                raise RuntimeInputError("meeting conversation pipeline is busy") from error
            self._idempotency_requests[request.idempotency_key] = request
            self._active_idempotency_keys.add(request.idempotency_key)
            self._active_meeting_ids.add(request.meeting_id)
        await events.accepted()
        session = PipecatConversationSession(
            turn=turn,
            pipeline=pipeline,
            on_finished=lambda: self._release_turn(request),
        )
        session.start()
        return session

    async def close(self) -> None:
        """Close every warm provider connection during process shutdown."""
        async with self._state_lock:
            if self._closed:
                return
            self._closed = True
            pipelines = tuple(self._pipelines.values())
            self._pipelines.clear()
        await asyncio.gather(*(pipeline.close() for pipeline in pipelines))

    def _validate_request(self, request: StartTurn) -> None:
        if self._closed:
            raise RuntimeInputError("conversation runtime is shutting down")
        if request.voice_profile_id != self._profile.profile_id:
            raise RuntimeInputError("request voice_profile_id is not enabled by this runtime")
        existing_request = self._idempotency_requests.get(request.idempotency_key)
        if existing_request is not None:
            if existing_request != request:
                raise RuntimeInputError("idempotency key was reused for a different request")
            raise RuntimeInputError("conversation request was already admitted")

    async def _pipeline_for(self, turn: ActivePipelineTurn) -> PersistentConversationPipeline:
        request = turn.request
        key = (request.meeting_id, request.voice_profile_id, request.locale.casefold())
        existing = self._pipelines.get(key)
        if existing is not None and existing.is_reusable:
            self._pipelines.move_to_end(key)
            return existing
        if existing is not None:
            self._pipelines.pop(key)
            await existing.close()
        if len(self._pipelines) >= self._maximum_persistent_pipelines:
            idle_key = next(
                (
                    candidate
                    for candidate, pipeline in self._pipelines.items()
                    if not pipeline.is_active
                ),
                None,
            )
            if idle_key is None:
                raise RuntimeInputError(
                    "persistent pipeline capacity is occupied by active meetings"
                )
            evicted = self._pipelines.pop(idle_key)
            await evicted.close()
        created = PersistentConversationPipeline(profile=self._profile, first_turn=turn)
        self._pipelines[key] = created
        return created

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

    def _release_turn(self, request: StartTurn) -> None:
        self._active_idempotency_keys.discard(request.idempotency_key)
        self._active_meeting_ids.discard(request.meeting_id)


class PipecatConversationSession(ConversationSession):
    """Expose one turn while its provider pipeline remains alive for later turns."""

    def __init__(
        self,
        *,
        turn: ActivePipelineTurn,
        pipeline: PersistentConversationPipeline,
        on_finished: Callable[[], None],
    ) -> None:
        self._turn = turn
        self._pipeline = pipeline
        self._on_finished = on_finished
        self._runner_task: asyncio.Task[None] | None = None

    @property
    def attempt_id(self) -> str:
        return self._turn.attempt_id

    def start(self) -> None:
        if self._runner_task is not None:
            raise RuntimeError("conversation session has already started")
        self._runner_task = asyncio.create_task(
            self._run_turn(),
            name=f"pipecat-conversation-{self._turn.attempt_id}",
        )

    def events(self) -> AsyncIterator[ConversationEvent]:
        return self._turn.events.iterate()

    def abandon_events(self) -> None:
        self._turn.events.abandon()

    async def cancel(self, request: CancelTurn) -> bool:
        if (
            request.turn_id != self._turn.request.turn_id
            or request.attempt_id != self._turn.attempt_id
        ):
            raise RuntimeInputError("cancellation does not match the active conversation attempt")
        if not self._turn.events.has_consumer:
            self._turn.events.abandon()
        return await self._pipeline.cancel(self._turn, request.reason)

    async def wait(self) -> None:
        if self._runner_task is None:
            raise RuntimeError("conversation session was not started")
        await self._runner_task

    async def _run_turn(self) -> None:
        try:
            await self._pipeline.execute(self._turn)
        finally:
            self._on_finished()


def _new_attempt_id() -> str:
    return f"attempt-{uuid4().hex}"
