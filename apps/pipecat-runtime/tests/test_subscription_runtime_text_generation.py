"""Loopback contract tests for Subscription Runtime-backed conversation generation."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator, Iterable, Sequence
from dataclasses import dataclass
from typing import cast

import grpc
from pipecat.processors.frame_processor import FrameProcessor

from pipecat_runtime.adapters.pipecat.processors import (
    ConversationTextCaptureProcessor,
    DeterministicPipelineOptions,
    FixtureSpeechTTSProcessor,
)
from pipecat_runtime.adapters.pipecat.runtime import PipecatConversationRuntime
from pipecat_runtime.adapters.pipecat.text_generation import (
    StreamingSubscriptionRuntimeTextGenerationProcessor,
)
from pipecat_runtime.adapters.providers.profiles import TtsRuntimeIdentity
from pipecat_runtime.adapters.subscription_runtime.generated import agent_runtime_pb2 as contract
from pipecat_runtime.adapters.subscription_runtime.generated import agent_runtime_pb2_grpc
from pipecat_runtime.adapters.subscription_runtime.text_generation import (
    SubscriptionRuntimeTextGenerationAdapter,
    SubscriptionRuntimeTextGenerationSettings,
)
from pipecat_runtime.application.conversation_events import Cancelled, Failed
from pipecat_runtime.application.models import (
    CancellationReason,
    CancelTurn,
    TextGenerationCompleted,
    TextGenerationFailed,
    TextGenerationRequest,
    TextGenerationStreamDelta,
    TextGenerationStreamStarted,
)
from pipecat_runtime.application.ports import (
    CancellationSignal,
    StreamingConversationTextGenerationPort,
)
from pipecat_runtime.assets.deterministic_speech import deterministic_russian_speech_pcm
from tests.support import sample_start_turn

_SERVICE_TOKEN = "subscription-runtime-test-token"


class _RecordingAgentRuntime(agent_runtime_pb2_grpc.AgentRuntimeServiceServicer):
    """A loopback-only unary service that records the admitted request."""

    def __init__(self, response: contract.AgentRuntimeTaskResponse) -> None:
        self.response = response
        self.request: contract.AgentRuntimeTaskRequest | None = None
        self.authorization: str | None = None

    async def RunAgentTask(
        self,
        request: contract.AgentRuntimeTaskRequest,
        context: grpc.aio.ServicerContext[
            contract.AgentRuntimeTaskRequest,
            contract.AgentRuntimeTaskResponse,
        ],
    ) -> contract.AgentRuntimeTaskResponse:
        self.request = request
        self.authorization = _authorization_from_metadata(context.invocation_metadata())
        return self.response

    async def CheckHealth(
        self,
        request: contract.AgentRuntimeHealthRequest,
        context: grpc.aio.ServicerContext[
            contract.AgentRuntimeHealthRequest,
            contract.AgentRuntimeHealthResponse,
        ],
    ) -> contract.AgentRuntimeHealthResponse:
        del request
        del context
        return contract.AgentRuntimeHealthResponse(
            status=contract.AGENT_RUNTIME_HEALTH_STATUS_SERVING,
            runtime_engine="test",
            runtime_version="test",
        )

    async def StreamAgentTask(
        self,
        request: contract.AgentRuntimeTaskStreamRequest,
        context: grpc.aio.ServicerContext[
            contract.AgentRuntimeTaskStreamRequest,
            contract.AgentRuntimeTaskEvent,
        ],
    ) -> AsyncIterator[contract.AgentRuntimeTaskEvent]:
        self.request = request.task
        self.authorization = _authorization_from_metadata(context.invocation_metadata())
        yield contract.AgentRuntimeTaskEvent(
            schema_version=1,
            sequence=1,
            completed=self.response,
        )


class _BlockingAgentRuntime(_RecordingAgentRuntime):
    """A loopback service that observes cancellation of its unary request."""

    def __init__(self) -> None:
        super().__init__(_completed_response('{"answer":"unused"}'))
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def RunAgentTask(
        self,
        request: contract.AgentRuntimeTaskRequest,
        context: grpc.aio.ServicerContext[
            contract.AgentRuntimeTaskRequest,
            contract.AgentRuntimeTaskResponse,
        ],
    ) -> contract.AgentRuntimeTaskResponse:
        self.request = request
        self.authorization = _authorization_from_metadata(context.invocation_metadata())
        self.started.set()
        try:
            await asyncio.Event().wait()
        finally:
            self.cancelled.set()
        raise AssertionError("blocking test RPC unexpectedly resumed")

    async def StreamAgentTask(
        self,
        request: contract.AgentRuntimeTaskStreamRequest,
        context: grpc.aio.ServicerContext[
            contract.AgentRuntimeTaskStreamRequest,
            contract.AgentRuntimeTaskEvent,
        ],
    ) -> AsyncIterator[contract.AgentRuntimeTaskEvent]:
        self.request = request.task
        self.authorization = _authorization_from_metadata(context.invocation_metadata())
        self.started.set()
        try:
            await asyncio.Event().wait()
        finally:
            self.cancelled.set()
        if False:
            yield contract.AgentRuntimeTaskEvent()


class _StreamingAgentRuntime(_RecordingAgentRuntime):
    """A loopback service that emits split structured output before final attestation."""

    def __init__(self, deltas: tuple[str, ...], *, final_answer: str = "Привет, Ботик 🙂!") -> None:
        super().__init__(_completed_response('{"answer":"unused"}'))
        self.deltas = deltas
        self.final_answer = final_answer

    async def StreamAgentTask(
        self,
        request: contract.AgentRuntimeTaskStreamRequest,
        context: grpc.aio.ServicerContext[
            contract.AgentRuntimeTaskStreamRequest,
            contract.AgentRuntimeTaskEvent,
        ],
    ) -> AsyncIterator[contract.AgentRuntimeTaskEvent]:
        task = request.task
        self.request = task
        self.authorization = _authorization_from_metadata(context.invocation_metadata())
        yield contract.AgentRuntimeTaskEvent(
            schema_version=1,
            sequence=1,
            started=contract.AgentRuntimeTaskStarted(),
        )
        for sequence, delta in enumerate(self.deltas, start=2):
            yield contract.AgentRuntimeTaskEvent(
                schema_version=1,
                sequence=sequence,
                text_delta=contract.AgentRuntimeTextDelta(text=delta),
            )
        yield contract.AgentRuntimeTaskEvent(
            schema_version=1,
            sequence=len(self.deltas) + 2,
            completed=_attested_completed_response(task, self.final_answer),
        )


class _MalformedBlockingStreamRuntime(_RecordingAgentRuntime):
    """Emit one invalid provisional delta and observe fail-closed client cancellation."""

    def __init__(self) -> None:
        super().__init__(_completed_response('{"answer":"unused"}'))
        self.cancelled = asyncio.Event()

    async def StreamAgentTask(
        self,
        request: contract.AgentRuntimeTaskStreamRequest,
        context: grpc.aio.ServicerContext[
            contract.AgentRuntimeTaskStreamRequest,
            contract.AgentRuntimeTaskEvent,
        ],
    ) -> AsyncIterator[contract.AgentRuntimeTaskEvent]:
        del request, context
        yield contract.AgentRuntimeTaskEvent(
            schema_version=1,
            sequence=1,
            started=contract.AgentRuntimeTaskStarted(),
        )
        yield contract.AgentRuntimeTaskEvent(
            schema_version=1,
            sequence=2,
            text_delta=contract.AgentRuntimeTextDelta(text="invalid-json"),
        )
        try:
            await asyncio.Event().wait()
        finally:
            self.cancelled.set()
        if False:
            yield contract.AgentRuntimeTaskEvent()


@dataclass(frozen=True, slots=True)
class _SubscriptionRuntimeFixtureProfile:
    """A real Pipecat profile with fake speech around the concrete unary text adapter."""

    profile_id: str
    text_generator: StreamingConversationTextGenerationPort

    @property
    def tts_identity(self) -> TtsRuntimeIdentity:
        return TtsRuntimeIdentity(provider="fixture", model="fixture-tts-v1", voice="fixture")

    def create_processors(
        self,
        request: object,
        cancellation_requested: CancellationSignal,
    ) -> Sequence[FrameProcessor]:
        del request
        options = DeterministicPipelineOptions()
        return (
            StreamingSubscriptionRuntimeTextGenerationProcessor(
                text_generator=self.text_generator,
                cancellation_requested=cancellation_requested,
            ),
            ConversationTextCaptureProcessor(),
            FixtureSpeechTTSProcessor(
                options=options,
                fixture_pcm=deterministic_russian_speech_pcm(),
                cancellation_requested=cancellation_requested,
            ),
        )


async def test_adapter_sends_the_admitted_stateless_conversation_profile() -> None:
    """The unary request has fixed controls, exact schema, supplied token, and one turn only."""
    service = _RecordingAgentRuntime(_completed_response('{"answer":"Привет!"}'))
    server, address = await _start_server(service)
    adapter = _adapter(address)
    try:
        result = await adapter.generate(
            _request(),
            cancellation_requested=asyncio.Event(),
        )

        assert result == TextGenerationCompleted(answer="Привет!")
        assert service.authorization == f"Bearer {_SERVICE_TOKEN}"
        assert service.request is not None
        request = service.request
        assert request.schema_version == 1
        assert (
            request.request_id
            == "conversation-answer-request-a40658c8d2f76ed85b8f76ff1f3df3eb"
        )
        assert request.tenant_id == "discord-meeting"
        assert request.workspace_id == "meeting-1"
        assert request.correlation_id == request.request_id
        assert request.provider == contract.AGENT_RUNTIME_PROVIDER_CODEX
        assert request.provider_instance_id == "discord-meeting-summary-v3"
        assert request.purpose == "discord_meeting.conversation.answer"
        assert request.system_prompt == "You are Botik."
        assert request.prompt == "Привет, Ботик."
        assert request.timeout_ms == 1_500
        assert request.cwd == "/run/discord-meeting-subscription-runtime/workspace"
        assert json.loads(request.output_schema_json) == {
            "additionalProperties": False,
            "properties": {
                "answer": {
                    "maxLength": 2_000,
                    "minLength": 1,
                    "type": "string",
                }
            },
            "required": ["answer"],
            "type": "object",
        }
        controls = json.loads(request.controls_json)
        assert controls["allowedTools"] == []
        assert controls["disableTools"] is True
        assert controls["executionProfile"] == "stateless-completion"
        assert controls["interactive"] is False
        assert controls["maxOutputTokens"] == 512
        assert controls["maxTurns"] == 1
        assert controls["model"] == "gpt-5.6-luna"
        assert controls["outputSchemaName"] == "discord_meeting_conversation_answer_v1"
        assert controls["reasoningEffort"] == "low"
        assert controls["responseFormat"] == "json"
        assert dict(request.metadata) == {
            "application": "discord-meeting",
            "executionProfile": "stateless-completion",
            "locale": "ru-RU",
            "meetingId": "meeting-1",
            "model": "gpt-5.6-luna",
            "policyVersion": "meeting-conversation.subscription-runtime.v1",
            "reasoningEffort": "low",
            "recordingId": "recording-1",
            "runtimeOutput": "structured_output",
            "toolsDisabled": "true",
            "turnId": "turn-1",
        }
    finally:
        await adapter.close()
        await server.stop(0)


async def test_adapter_rejects_malformed_completed_output_and_hides_runtime_messages() -> None:
    """The adapter accepts only exact output and never forwards a provider-safe-message blindly."""
    service = _RecordingAgentRuntime(
        _completed_response('{"answer":"valid", "unexpected": true}')
    )
    server, address = await _start_server(service)
    adapter = _adapter(address)
    try:
        malformed = await adapter.generate(
            _request(),
            cancellation_requested=asyncio.Event(),
        )
        assert malformed == TextGenerationFailed(
            code="subscription-runtime-invalid-response",
            safe_message="Conversation generation returned an invalid response.",
            retryable=True,
        )

        service.response = contract.AgentRuntimeTaskResponse(
            schema_version=1,
            status=contract.AGENT_RUNTIME_TASK_STATUS_FAILED,
            failure=contract.AgentRuntimeFailure(
                code="provider_session_invalid",
                safe_message="provider session secret must not cross the boundary",
                retryable=False,
            ),
        )
        failed = await adapter.generate(
            _request(),
            cancellation_requested=asyncio.Event(),
        )
        assert failed == TextGenerationFailed(
            code="subscription-runtime-session-invalid",
            safe_message="Conversation generation needs provider reconnection.",
            retryable=True,
        )
    finally:
        await adapter.close()
        await server.stop(0)


async def test_stream_adapter_decodes_json_escapes_and_validates_the_final_answer() -> None:
    service = _StreamingAgentRuntime(
        (' {"ans', 'wer":"Hello, \\nAlice \\uD83D', '\\uDE42!"}'),
        final_answer="Hello, \nAlice 🙂!",
    )
    server, address = await _start_server(service)
    adapter = _adapter(address)
    try:
        events = [
            event
            async for event in adapter.stream(
                _request(),
                cancellation_requested=asyncio.Event(),
            )
        ]

        assert isinstance(events[0], TextGenerationStreamStarted)
        assert isinstance(events[-1], TextGenerationCompleted)
        assert "".join(
            event.text for event in events if isinstance(event, TextGenerationStreamDelta)
        ) == "Hello, \nAlice 🙂!"
        assert events[-1].answer == "Hello, \nAlice 🙂!"
    finally:
        await adapter.close()
        await server.stop(0)


async def test_stream_adapter_fails_closed_when_provisional_text_differs_from_final() -> None:
    service = _StreamingAgentRuntime(
        ('{"answer":"Сначала один ответ."}',),
        final_answer="Финальный другой ответ.",
    )
    server, address = await _start_server(service)
    adapter = _adapter(address)
    try:
        events = [
            event
            async for event in adapter.stream(
                _request(),
                cancellation_requested=asyncio.Event(),
            )
        ]

        assert any(isinstance(event, TextGenerationStreamDelta) for event in events)
        assert events[-1] == TextGenerationFailed(
            code="subscription-runtime-invalid-response",
            safe_message="Conversation generation returned an invalid response.",
            retryable=True,
        )
    finally:
        await adapter.close()
        await server.stop(0)


async def test_stream_adapter_accepts_the_full_bounded_delta_event_budget() -> None:
    answer = "a" * 254
    service = _StreamingAgentRuntime(
        ('{"answer":"', *("a" for _ in range(254)), '"}'),
        final_answer=answer,
    )
    server, address = await _start_server(service)
    adapter = _adapter(address)
    try:
        events = [
            event
            async for event in adapter.stream(
                _request(),
                cancellation_requested=asyncio.Event(),
            )
        ]

        assert "".join(
            event.text for event in events if isinstance(event, TextGenerationStreamDelta)
        ) == answer
        assert events[-1] == TextGenerationCompleted(answer=answer)
    finally:
        await adapter.close()
        await server.stop(0)


async def test_stream_adapter_cancels_provider_after_an_early_fail_closed_exit() -> None:
    service = _MalformedBlockingStreamRuntime()
    server, address = await _start_server(service)
    adapter = _adapter(address)
    try:
        events = [
            event
            async for event in adapter.stream(
                _request(),
                cancellation_requested=asyncio.Event(),
            )
        ]

        assert events[-1] == TextGenerationFailed(
            code="subscription-runtime-invalid-response",
            safe_message="Conversation generation returned an invalid response.",
            retryable=True,
        )
        assert await _event_is_set(service.cancelled, limit=1)
    finally:
        await adapter.close()
        await server.stop(0)


async def test_runtime_emits_the_adapter_safe_failure_without_provider_details() -> None:
    """A unary failure reaches the public event stream only through its safe mapped outcome."""
    service = _RecordingAgentRuntime(
        contract.AgentRuntimeTaskResponse(
            schema_version=1,
            status=contract.AGENT_RUNTIME_TASK_STATUS_FAILED,
            failure=contract.AgentRuntimeFailure(
                code="quota_limited",
                safe_message="untrusted provider detail",
                retryable=False,
            ),
        )
    )
    server, address = await _start_server(service)
    adapter = _adapter(address)
    try:
        profile = _SubscriptionRuntimeFixtureProfile(
            profile_id="subscription-runtime-test",
            text_generator=adapter,
        )
        runtime = PipecatConversationRuntime(profile=profile)
        session = await runtime.start(
            sample_start_turn(voice_profile_id="subscription-runtime-test")
        )

        events = [event async for event in session.events()]
        await session.wait()
        await runtime.close()

        assert isinstance(events[-1], Failed)
        assert events[-1].code == "subscription-runtime-quota-limited"
        assert events[-1].safe_message == "Conversation generation is temporarily rate limited."
        assert events[-1].retryable is True
    finally:
        await adapter.close()
        await server.stop(0)


async def test_pipecat_turn_cancellation_cancels_the_streaming_runtime_call() -> None:
    """A Pipecat CancelTurn interrupts the active stream before it can produce text."""
    service = _BlockingAgentRuntime()
    server, address = await _start_server(service)
    adapter = _adapter(address)
    try:
        profile = _SubscriptionRuntimeFixtureProfile(
            profile_id="subscription-runtime-test",
            text_generator=adapter,
        )
        runtime = PipecatConversationRuntime(profile=profile)
        session = await runtime.start(
            sample_start_turn(voice_profile_id="subscription-runtime-test")
        )
        events = session.events()
        accepted = await anext(events)
        await asyncio.wait_for(service.started.wait(), timeout=1)

        changed = await session.cancel(
            CancelTurn(
                turn_id=accepted.turn_id,
                attempt_id=accepted.attempt_id,
                reason=CancellationReason.BARGE_IN,
            )
        )
        remaining = [event async for event in events]
        await session.wait()
        await runtime.close()

        assert changed is True
        assert isinstance(remaining[-1], Cancelled)
        assert await _event_is_set(service.cancelled, limit=1)
    finally:
        await adapter.close()
        await server.stop(0)


async def _start_server(
    service: agent_runtime_pb2_grpc.AgentRuntimeServiceServicer,
) -> tuple[grpc.aio.Server, str]:
    server = grpc.aio.server()
    agent_runtime_pb2_grpc.add_AgentRuntimeServiceServicer_to_server(service, server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    return server, f"127.0.0.1:{port}"


def _adapter(address: str) -> SubscriptionRuntimeTextGenerationAdapter:
    return SubscriptionRuntimeTextGenerationAdapter(
        SubscriptionRuntimeTextGenerationSettings(
            address=address,
            service_token=_SERVICE_TOKEN,
            timeout_ms=1_500,
        )
    )


def _request() -> TextGenerationRequest:
    return TextGenerationRequest(
        meeting_id="meeting-1",
        recording_id="recording-1",
        turn_id="turn-1",
        idempotency_key="idempotency-1",
        system_prompt="You are Botik.",
        prompt="Привет, Ботик.",
        locale="ru-RU",
    )


def _completed_response(answer_json: str) -> contract.AgentRuntimeTaskResponse:
    return contract.AgentRuntimeTaskResponse(
        schema_version=1,
        status=contract.AGENT_RUNTIME_TASK_STATUS_COMPLETED,
        structured_output_json=answer_json,
    )


def _attested_completed_response(
    request: contract.AgentRuntimeTaskRequest,
    answer: str,
) -> contract.AgentRuntimeTaskResponse:
    structured = {"answer": answer}
    return contract.AgentRuntimeTaskResponse(
        schema_version=1,
        status=contract.AGENT_RUNTIME_TASK_STATUS_COMPLETED,
        structured_output_json=_canonical_json(structured),
        execution_attestation=contract.AgentRuntimeExecutionAttestation(
            schema_version=1,
            request_id=request.request_id,
            purpose=request.purpose,
            canonical_request_sha256=_sha256(_canonical_runtime_request(request)),
            provider=contract.AGENT_RUNTIME_PROVIDER_CODEX,
            model="gpt-5.6-luna",
            reasoning_effort="low",
            runtime_engine="subscription-runtime-app-server",
            runtime_package_version="0.1.0-main.27",
            launcher_sha256="a" * 64,
            selected_output_kind=contract.AGENT_RUNTIME_SELECTED_OUTPUT_KIND_STRUCTURED_OUTPUT,
            selected_output_sha256=_sha256(structured),
        ),
    )


def _canonical_runtime_request(request: contract.AgentRuntimeTaskRequest) -> dict[str, object]:
    metadata = dict(request.metadata)
    return {
        "context": {
            "application": "discord-meeting",
            "correlationId": request.correlation_id,
            "metadata": {
                key: metadata[key]
                for key in ("locale", "meetingId", "policyVersion", "recordingId", "turnId")
            },
            "purpose": request.purpose,
        },
        "cwd": request.cwd,
        "protocolVersion": request.schema_version,
        "runId": request.request_id,
        "task": {
            "controls": json.loads(request.controls_json),
            "kind": "structured-prompt",
            "metadata": {
                key: metadata[key]
                for key in (
                    "executionProfile",
                    "model",
                    "policyVersion",
                    "reasoningEffort",
                    "runtimeOutput",
                    "toolsDisabled",
                )
            },
            "outputSchemaName": "discord_meeting_conversation_answer_v1",
            "prompt": request.prompt,
            "systemPrompt": request.system_prompt,
        },
        "timeoutMs": request.timeout_ms,
    }


def _sha256(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode()).hexdigest()


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


async def _event_is_set(event: asyncio.Event, *, limit: float) -> bool:
    try:
        await asyncio.wait_for(event.wait(), timeout=limit)
    except TimeoutError:
        return False
    return True


def _authorization_from_metadata(metadata: grpc.aio.Metadata | None) -> str | None:
    for key, value in cast(Iterable[tuple[str | bytes, str | bytes]], metadata or ()):
        if key == "authorization" and isinstance(value, str):
            return value
    return None
