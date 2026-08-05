"""Subscription Runtime gRPC adapter for one stateless conversation answer."""

from __future__ import annotations

import asyncio
import hashlib
import json
from contextlib import suppress
from dataclasses import dataclass
from typing import Final

import grpc

from pipecat_runtime.adapters.subscription_runtime.generated import agent_runtime_pb2 as contract
from pipecat_runtime.adapters.subscription_runtime.generated import agent_runtime_pb2_grpc
from pipecat_runtime.application.models import (
    TextGenerationCancelled,
    TextGenerationCompleted,
    TextGenerationFailed,
    TextGenerationRequest,
    TextGenerationResult,
)
from pipecat_runtime.application.ports import CancellationSignal, ConversationTextGenerationPort

_PROTOCOL_VERSION: Final = 1
_PURPOSE: Final = "discord_meeting.conversation.answer"
_POLICY_VERSION: Final = "meeting-conversation.subscription-runtime.v1"
_MODEL: Final = "gpt-5.6-luna"
_REASONING_EFFORT: Final = "low"
_MAX_OUTPUT_TOKENS: Final = 512
_OUTPUT_SCHEMA_NAME: Final = "discord_meeting_conversation_answer_v1"
_ISOLATED_CWD: Final = "/run/discord-meeting-subscription-runtime/workspace"
_TENANT_ID: Final = "discord-meeting"
_PROVIDER_INSTANCE_ID: Final = "discord-meeting-summary-v3"
_OUTPUT_SCHEMA: Final[dict[str, object]] = {
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
_FAILURES_BY_RUNTIME_CODE: Final[dict[str, tuple[str, str, bool]]] = {
    "backend_unavailable": (
        "subscription-runtime-unavailable",
        "Conversation generation is temporarily unavailable.",
        True,
    ),
    "needs_reconnect": (
        "subscription-runtime-needs-reconnect",
        "Conversation generation needs provider reconnection.",
        True,
    ),
    "permission_required": (
        "subscription-runtime-permission-required",
        "Conversation generation is not authorized.",
        False,
    ),
    "provider_output_invalid": (
        "subscription-runtime-invalid-response",
        "Conversation generation returned an invalid response.",
        True,
    ),
    "provider_session_invalid": (
        "subscription-runtime-session-invalid",
        "Conversation generation needs provider reconnection.",
        True,
    ),
    "quota_limited": (
        "subscription-runtime-quota-limited",
        "Conversation generation is temporarily rate limited.",
        True,
    ),
    "stale_generation": (
        "subscription-runtime-stale-generation",
        "Conversation generation is no longer current.",
        False,
    ),
    "task_cancelled": (
        "subscription-runtime-task-cancelled",
        "Conversation generation was cancelled.",
        False,
    ),
    "task_mode_unsupported": (
        "subscription-runtime-mode-unsupported",
        "Conversation generation is not supported by the runtime.",
        False,
    ),
    "task_timeout": (
        "subscription-runtime-timeout",
        "Conversation generation timed out.",
        True,
    ),
    "telemetry_unavailable": (
        "subscription-runtime-telemetry-unavailable",
        "Conversation generation is temporarily unavailable.",
        True,
    ),
    "unknown_runtime_failure": (
        "subscription-runtime-failed",
        "Conversation generation failed.",
        True,
    ),
}
_FAILURES_BY_STATUS: Final[dict[grpc.StatusCode, tuple[str, str, bool]]] = {
    grpc.StatusCode.DEADLINE_EXCEEDED: (
        "subscription-runtime-timeout",
        "Conversation generation timed out.",
        True,
    ),
    grpc.StatusCode.PERMISSION_DENIED: (
        "subscription-runtime-permission-required",
        "Conversation generation is not authorized.",
        False,
    ),
    grpc.StatusCode.UNAUTHENTICATED: (
        "subscription-runtime-authentication-failed",
        "Conversation generation is not authorized.",
        False,
    ),
    grpc.StatusCode.UNAVAILABLE: (
        "subscription-runtime-unavailable",
        "Conversation generation is temporarily unavailable.",
        True,
    ),
    grpc.StatusCode.RESOURCE_EXHAUSTED: (
        "subscription-runtime-quota-limited",
        "Conversation generation is temporarily rate limited.",
        True,
    ),
}


@dataclass(frozen=True, slots=True)
class SubscriptionRuntimeTextGenerationSettings:
    """Concrete connection settings read only by the Pipecat composition root."""

    address: str
    service_token: str
    timeout_ms: int

    def __post_init__(self) -> None:
        address = self.address.strip()
        if not address or any(character.isspace() for character in address):
            raise ValueError("Subscription Runtime address is invalid")
        service_token = self.service_token.strip()
        if len(service_token) < 16:
            raise ValueError("Subscription Runtime service token is too short")
        if not 1 <= self.timeout_ms <= 600_000:
            raise ValueError("Subscription Runtime timeout is outside the supported range")
        object.__setattr__(self, "address", address)
        object.__setattr__(self, "service_token", service_token)

    @property
    def timeout_seconds(self) -> float:
        """Expose the configured deadline in grpc.aio's seconds unit."""
        return self.timeout_ms / 1_000


class SubscriptionRuntimeTextGenerationAdapter(ConversationTextGenerationPort):
    """Translate the application port to the admitted unary Subscription Runtime task."""

    def __init__(self, settings: SubscriptionRuntimeTextGenerationSettings) -> None:
        self._settings = settings

    async def generate(
        self,
        request: TextGenerationRequest,
        *,
        cancellation_requested: CancellationSignal,
    ) -> TextGenerationResult:
        """Call the private unary runtime once and cancel it with the Pipecat turn."""
        if cancellation_requested.is_set():
            return TextGenerationCancelled()
        try:
            async with grpc.aio.insecure_channel(self._settings.address) as channel:
                client = agent_runtime_pb2_grpc.AgentRuntimeServiceStub(channel)
                call = client.RunAgentTask(
                    _to_agent_request(request, timeout_ms=self._settings.timeout_ms),
                    metadata=(("authorization", f"Bearer {self._settings.service_token}"),),
                    timeout=self._settings.timeout_seconds,
                )
                response = await _await_or_cancel(call, cancellation_requested)
        except grpc.aio.AioRpcError as error:
            return _failure_from_status(error.code())
        except OSError:
            return _failure_from_status(grpc.StatusCode.UNAVAILABLE)
        if response is None:
            return TextGenerationCancelled()
        return _from_agent_response(response)


async def _await_or_cancel(
    call: grpc.aio.UnaryUnaryCall[
        contract.AgentRuntimeTaskRequest,
        contract.AgentRuntimeTaskResponse,
    ],
    cancellation_requested: CancellationSignal,
) -> contract.AgentRuntimeTaskResponse | None:
    """Race the unary response with the active Pipecat turn and propagate cancellation."""
    response_task = asyncio.ensure_future(call)
    cancellation_task = asyncio.ensure_future(cancellation_requested.wait())
    try:
        done, _ = await asyncio.wait(
            (response_task, cancellation_task),
            return_when=asyncio.FIRST_COMPLETED,
        )
        if cancellation_task in done:
            call.cancel()
            with suppress(asyncio.CancelledError, grpc.aio.AioRpcError):
                await response_task
            return None
        return response_task.result()
    finally:
        if not cancellation_task.done():
            cancellation_task.cancel()
        with suppress(asyncio.CancelledError):
            await cancellation_task


def _to_agent_request(
    request: TextGenerationRequest,
    *,
    timeout_ms: int,
) -> contract.AgentRuntimeTaskRequest:
    """Encode the fixed allowed profile and the sole current conversation turn."""
    controls = {
        "allowedTools": [],
        "disableTools": True,
        "executionProfile": "stateless-completion",
        "interactive": False,
        "maxOutputTokens": _MAX_OUTPUT_TOKENS,
        "maxTurns": 1,
        "model": _MODEL,
        "outputKind": "structured_output",
        "outputSchema": _OUTPUT_SCHEMA,
        "outputSchemaName": _OUTPUT_SCHEMA_NAME,
        "permissionMode": "read-only",
        "reasoningEffort": _REASONING_EFFORT,
        "responseFormat": "json",
        "runtimeOutput": "structured_output",
        "selectedOutputKind": "structured_output",
    }
    run_id = _stable_conversation_request_id(request)
    return contract.AgentRuntimeTaskRequest(
        schema_version=_PROTOCOL_VERSION,
        request_id=run_id,
        tenant_id=_TENANT_ID,
        workspace_id=request.meeting_id,
        correlation_id=run_id,
        provider=contract.AGENT_RUNTIME_PROVIDER_CODEX,
        provider_instance_id=_PROVIDER_INSTANCE_ID,
        purpose=_PURPOSE,
        system_prompt=request.system_prompt,
        prompt=request.prompt,
        output_schema_json=_canonical_json(_OUTPUT_SCHEMA),
        controls_json=_canonical_json(controls),
        timeout_ms=timeout_ms,
        cwd=_ISOLATED_CWD,
        metadata={
            "application": _TENANT_ID,
            "executionProfile": "stateless-completion",
            "locale": request.locale,
            "meetingId": request.meeting_id,
            "model": _MODEL,
            "policyVersion": _POLICY_VERSION,
            "reasoningEffort": _REASONING_EFFORT,
            "recordingId": request.recording_id,
            "runtimeOutput": "structured_output",
            "toolsDisabled": "true",
            "turnId": request.turn_id,
        },
    )


def _from_agent_response(response: contract.AgentRuntimeTaskResponse) -> TextGenerationResult:
    """Accept only the exact completed schema and map every other outcome safely."""
    if response.schema_version != _PROTOCOL_VERSION:
        return _invalid_response()
    if response.status == contract.AGENT_RUNTIME_TASK_STATUS_COMPLETED:
        return _parse_completed_answer(response.structured_output_json)
    if response.status == contract.AGENT_RUNTIME_TASK_STATUS_FAILED:
        return _failure_from_runtime_code(response.failure.code)
    return _invalid_response()


def _parse_completed_answer(structured_output_json: str) -> TextGenerationResult:
    try:
        value = json.loads(
            structured_output_json,
            object_pairs_hook=_reject_duplicate_json_keys,
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        return _invalid_response()
    if type(value) is not dict or set(value) != {"answer"}:
        return _invalid_response()
    answer = value["answer"]
    if not isinstance(answer, str):
        return _invalid_response()
    try:
        return TextGenerationCompleted(answer=answer)
    except ValueError:
        return _invalid_response()


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _failure_from_runtime_code(runtime_code: str) -> TextGenerationFailed:
    code, safe_message, retryable = _FAILURES_BY_RUNTIME_CODE.get(
        runtime_code,
        _FAILURES_BY_RUNTIME_CODE["unknown_runtime_failure"],
    )
    return TextGenerationFailed(code=code, safe_message=safe_message, retryable=retryable)


def _failure_from_status(status: grpc.StatusCode) -> TextGenerationFailed:
    code, safe_message, retryable = _FAILURES_BY_STATUS.get(
        status,
        _FAILURES_BY_RUNTIME_CODE["unknown_runtime_failure"],
    )
    return TextGenerationFailed(code=code, safe_message=safe_message, retryable=retryable)


def _invalid_response() -> TextGenerationFailed:
    return TextGenerationFailed(
        code="subscription-runtime-invalid-response",
        safe_message="Conversation generation returned an invalid response.",
        retryable=True,
    )


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _stable_conversation_request_id(request: TextGenerationRequest) -> str:
    """Match the TypeScript contract's stable cross-transport request identity."""
    kind = "conversation-answer-request"
    digest = hashlib.sha256(kind.encode()).copy()
    for part in (
        request.idempotency_key,
        request.meeting_id,
        request.recording_id,
        request.turn_id,
        _POLICY_VERSION,
    ):
        digest.update(f":{len(part)}:".encode())
        digest.update(part.encode())
    return f"{kind}-{digest.hexdigest()[:32]}"
