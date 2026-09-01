"""Provider-neutral runtime backed by bounded persistent Pipecat meeting pipelines."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

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

# PersistentConversationPipeline has its own five-second graceful worker deadline.
# Keep the detached-resource envelope wider so it can complete forced cleanup
# instead of being cancelled at the exact same boundary and leaking its worker.
_PIPELINE_CLOSE_TIMEOUT_SECONDS = 12.0

_TTS_ATTESTATION_KEY_DERIVATION_LABEL = b"discord-meeting/pipecat-tts-attestation/key/v1"


@dataclass(frozen=True, slots=True)
class _TtsAttestationPayload:
    deployment: str
    key_id: str
    model: str
    provider: str
    signature: str
    source_revision: str
    voice: str
    voice_profile_id: str


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
        attestation_secret: str = "local-development-attestation-key",
        deployment: str = "local-unqualified",
        source_revision: str = "local-unqualified",
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
        self._pipeline_close_failures: list[Exception] = []
        self._pipeline_close_tasks: set[asyncio.Task[None]] = set()
        self._attempt_id_factory = attempt_id_factory
        self._attestation_key = _derive_tts_attestation_key(attestation_secret)
        self._deployment = deployment
        self._source_revision = source_revision
        self._state_lock = asyncio.Lock()
        self._closed = False

    async def start(self, request: StartTurn) -> ConversationSession:
        """Admit one turn into its meeting's already-warm pipeline."""
        async with self._state_lock:
            self._validate_request(request)
            self._evict_completed_idempotency_key_if_required()
            if request.meeting_id in self._active_meeting_ids:
                raise RuntimeInputError("meeting conversation pipeline is busy")
            attempt_id = (
                self._attempt_id_factory()
                if self._attempt_id_factory is not None
                else _stable_attempt_id(request.idempotency_key)
            )
            if not attempt_id.strip():
                raise RuntimeInputError("attempt id factory returned an empty identifier")
            events = ConversationEventStream(
                request=request,
                attempt_id=attempt_id,
                maximum_events=self._maximum_pending_events,
            )
            turn = ActivePipelineTurn(request=request, attempt_id=attempt_id, events=events)
            pipeline, detached_pipelines = self._pipeline_for(turn)
            try:
                await pipeline.reserve(turn)
            except RuntimeError as error:
                raise RuntimeInputError("meeting conversation pipeline is busy") from error
            self._idempotency_requests[request.idempotency_key] = request
            self._active_idempotency_keys.add(request.idempotency_key)
            self._active_meeting_ids.add(request.meeting_id)
        self._schedule_pipeline_closes(detached_pipelines)
        await events.accepted()
        identity = self._profile.tts_identity
        signature = _tts_attestation_signature(
            key=self._attestation_key,
            turn_id=request.turn_id,
            attempt_id=attempt_id,
            voice_profile_id=request.voice_profile_id,
            deployment=self._deployment,
            source_revision=self._source_revision,
            provider=identity.provider,
            model=identity.model,
            voice=identity.voice,
        )
        tts_attestation = _TtsAttestationPayload(
            deployment=self._deployment,
            key_id=hashlib.sha256(self._attestation_key).hexdigest(),
            model=identity.model,
            provider=identity.provider,
            signature=signature,
            source_revision=self._source_revision,
            voice=identity.voice,
            voice_profile_id=request.voice_profile_id,
        )
        session = PipecatConversationSession(
            turn=turn,
            pipeline=pipeline,
            tts_attestation=tts_attestation,
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
        self._schedule_pipeline_closes(pipelines)
        pending_closes = tuple(self._pipeline_close_tasks)
        if pending_closes:
            await asyncio.gather(*pending_closes, return_exceptions=True)
        if self._pipeline_close_failures:
            raise RuntimeError("one or more persistent pipelines failed to close") from (
                self._pipeline_close_failures[0]
            )

    def _validate_request(self, request: StartTurn) -> None:
        if self._closed:
            raise RuntimeInputError("conversation runtime is shutting down")
        if request.voice_profile_id != self._profile.profile_id:
            raise RuntimeInputError("request voice_profile_id is not enabled by this runtime")
        existing_request = self._idempotency_requests.get(request.idempotency_key)
        if existing_request is not None:
            if not _same_idempotent_command(existing_request, request):
                raise RuntimeInputError("idempotency key was reused for a different request")
            if request.idempotency_key in self._active_idempotency_keys:
                raise RuntimeInputError("conversation request was already admitted")
            # A boundary owner can disappear after admission but before it durably
            # observes audio. Re-run the identical command with the same stable
            # attempt ID; Craig's required durable attempt dedupe owns audible-once.
            self._idempotency_requests.pop(request.idempotency_key)

    def _pipeline_for(
        self, turn: ActivePipelineTurn
    ) -> tuple[
        PersistentConversationPipeline,
        tuple[PersistentConversationPipeline, ...],
    ]:
        """Select one pipeline while detaching stale resources for out-of-lock closure."""
        request = turn.request
        key = (request.meeting_id, request.voice_profile_id, request.locale.casefold())
        detached: list[PersistentConversationPipeline] = []
        existing = self._pipelines.get(key)
        if existing is not None and existing.is_reusable:
            self._pipelines.move_to_end(key)
            return existing, ()
        if existing is not None:
            self._pipelines.pop(key)
            detached.append(existing)
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
            detached.append(self._pipelines.pop(idle_key))
        created = PersistentConversationPipeline(profile=self._profile, first_turn=turn)
        self._pipelines[key] = created
        return created, tuple(detached)

    def _schedule_pipeline_closes(
        self,
        pipelines: tuple[PersistentConversationPipeline, ...],
    ) -> None:
        for pipeline in pipelines:
            task = asyncio.create_task(
                self._close_pipeline_bounded(pipeline),
                name="pipecat-pipeline-close",
            )
            self._pipeline_close_tasks.add(task)
            task.add_done_callback(self._pipeline_close_tasks.discard)

    async def _close_pipeline_bounded(
        self,
        pipeline: PersistentConversationPipeline,
    ) -> None:
        try:
            await asyncio.wait_for(
                pipeline.close(),
                timeout=_PIPELINE_CLOSE_TIMEOUT_SECONDS,
            )
        except Exception:
            # Detached provider cleanup must not retain admission or fail a new turn.
            try:
                await pipeline.abort()
            except Exception as error:
                self._pipeline_close_failures.append(error)

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
        tts_attestation: _TtsAttestationPayload,
        on_finished: Callable[[], None],
    ) -> None:
        self._turn = turn
        self._pipeline = pipeline
        self._tts_attestation = tts_attestation
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
            attestation = self._tts_attestation
            await self._turn.events.tts_attestation(
                deployment=attestation.deployment,
                key_id=attestation.key_id,
                model=attestation.model,
                provider=attestation.provider,
                signature=attestation.signature,
                source_revision=attestation.source_revision,
                voice=attestation.voice,
                voice_profile_id=attestation.voice_profile_id,
            )
            await self._pipeline.execute(self._turn)
        finally:
            self._on_finished()


def _stable_attempt_id(idempotency_key: str) -> str:
    """Provider command identity survives runtime/process restart without exposing input."""
    digest = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()
    return f"attempt-{digest}"


def _same_idempotent_command(left: StartTurn, right: StartTurn) -> bool:
    """Bind a key to audible content while permitting a new coordinator retry ID."""
    return (
        left.meeting_id,
        left.recording_id,
        left.speaker_id,
        left.system_prompt,
        left.prompt,
        left.literal_speech,
        left.locale,
        left.voice_profile_id,
        left.schema_version,
    ) == (
        right.meeting_id,
        right.recording_id,
        right.speaker_id,
        right.system_prompt,
        right.prompt,
        right.literal_speech,
        right.locale,
        right.voice_profile_id,
        right.schema_version,
    )


def _derive_tts_attestation_key(secret: str) -> bytes:
    return hmac.new(
        secret.encode("utf-8"),
        _TTS_ATTESTATION_KEY_DERIVATION_LABEL,
        hashlib.sha256,
    ).digest()


def _tts_attestation_signature(
    *,
    key: bytes,
    turn_id: str,
    attempt_id: str,
    voice_profile_id: str,
    deployment: str,
    source_revision: str,
    provider: str,
    model: str,
    voice: str,
) -> str:
    canonical = "\n".join((
        "schemaVersion=1",
        f"turnId={turn_id}",
        f"attemptId={attempt_id}",
        f"voiceProfileId={voice_profile_id}",
        f"deployment={deployment}",
        f"sourceRevision={source_revision}",
        f"provider={provider}",
        f"model={model}",
        f"voice={voice}",
    ))
    return hmac.new(key, canonical.encode("utf-8"), hashlib.sha256).hexdigest()
