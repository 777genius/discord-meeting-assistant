"""Exact admitted request, response, and attestation rules for conversation generation."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Final

import grpc

from pipecat_runtime.adapters.subscription_runtime.generated import agent_runtime_pb2 as contract
from pipecat_runtime.application.models import (
    TextGenerationCompleted,
    TextGenerationFailed,
    TextGenerationRequest,
    TextGenerationResult,
)

PROTOCOL_VERSION: Final = 1
PURPOSE: Final = "discord_meeting.conversation.answer"
POLICY_VERSION: Final = "meeting-conversation.subscription-runtime.v1"
MODEL: Final = "gpt-5.6-luna"
REASONING_EFFORT: Final = "low"
RUNTIME_ENGINE: Final = "subscription-runtime-app-server"
RUNTIME_PACKAGE_VERSION: Final = "0.1.0-main.27"
MAX_OUTPUT_TOKENS: Final = 512
OUTPUT_SCHEMA_NAME: Final = "discord_meeting_conversation_answer_v1"
ISOLATED_CWD: Final = "/run/discord-meeting-subscription-runtime/workspace"
TENANT_ID: Final = "discord-meeting"
OUTPUT_SCHEMA: Final[dict[str, object]] = {
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


def to_agent_request(
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
        "maxOutputTokens": MAX_OUTPUT_TOKENS,
        "maxTurns": 1,
        "model": MODEL,
        "outputKind": "structured_output",
        "outputSchema": OUTPUT_SCHEMA,
        "outputSchemaName": OUTPUT_SCHEMA_NAME,
        "permissionMode": "read-only",
        "reasoningEffort": REASONING_EFFORT,
        "responseFormat": "json",
        "runtimeOutput": "structured_output",
        "selectedOutputKind": "structured_output",
    }
    run_id = _stable_conversation_request_id(request)
    return contract.AgentRuntimeTaskRequest(
        schema_version=PROTOCOL_VERSION,
        request_id=run_id,
        tenant_id=TENANT_ID,
        workspace_id=request.meeting_id,
        correlation_id=run_id,
        provider=contract.AGENT_RUNTIME_PROVIDER_CODEX,
        provider_instance_id="discord-meeting-summary-v3",
        purpose=PURPOSE,
        system_prompt=request.system_prompt,
        prompt=request.prompt,
        output_schema_json=canonical_json(OUTPUT_SCHEMA),
        controls_json=canonical_json(controls),
        timeout_ms=timeout_ms,
        cwd=ISOLATED_CWD,
        metadata={
            "application": TENANT_ID,
            "executionProfile": "stateless-completion",
            "locale": request.locale,
            "meetingId": request.meeting_id,
            "model": MODEL,
            "policyVersion": POLICY_VERSION,
            "reasoningEffort": REASONING_EFFORT,
            "recordingId": request.recording_id,
            "runtimeOutput": "structured_output",
            "toolsDisabled": "true",
            "turnId": request.turn_id,
        },
    )


def from_agent_response(response: contract.AgentRuntimeTaskResponse) -> TextGenerationResult:
    """Accept only the exact completed schema and map every other outcome safely."""
    if response.schema_version != PROTOCOL_VERSION:
        return invalid_response()
    if response.status == contract.AGENT_RUNTIME_TASK_STATUS_COMPLETED:
        answer = parse_completed_answer(response.structured_output_json)
        return invalid_response() if answer is None else TextGenerationCompleted(answer=answer)
    if response.status == contract.AGENT_RUNTIME_TASK_STATUS_FAILED:
        return failure_from_runtime_code(response.failure.code)
    return invalid_response()


def verify_streamed_completion(
    response: contract.AgentRuntimeTaskResponse,
    request: contract.AgentRuntimeTaskRequest,
) -> str | None:
    """Return the answer only when schema and execution attestation match exactly."""
    if (
        response.schema_version != PROTOCOL_VERSION
        or response.status != contract.AGENT_RUNTIME_TASK_STATUS_COMPLETED
    ):
        return None
    answer = parse_completed_answer(response.structured_output_json)
    if answer is None:
        return None
    structured = {"answer": answer}
    attestation = response.execution_attestation
    expected_request_hash = sha256(canonical_runtime_request(request))
    return answer if (
        attestation.schema_version == PROTOCOL_VERSION
        and attestation.request_id == request.request_id
        and attestation.purpose == PURPOSE
        and attestation.provider == contract.AGENT_RUNTIME_PROVIDER_CODEX
        and attestation.model == MODEL
        and attestation.reasoning_effort == REASONING_EFFORT
        and attestation.runtime_engine == RUNTIME_ENGINE
        and attestation.runtime_package_version == RUNTIME_PACKAGE_VERSION
        and re.fullmatch(r"[0-9a-f]{64}", attestation.launcher_sha256) is not None
        and attestation.selected_output_kind
        == contract.AGENT_RUNTIME_SELECTED_OUTPUT_KIND_STRUCTURED_OUTPUT
        and attestation.canonical_request_sha256 == expected_request_hash
        and attestation.selected_output_sha256 == sha256(structured)
    ) else None


def parse_completed_answer(structured_output_json: str) -> str | None:
    try:
        value = json.loads(structured_output_json, object_pairs_hook=_reject_duplicate_json_keys)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if type(value) is not dict or set(value) != {"answer"}:
        return None
    answer = value["answer"]
    return answer if isinstance(answer, str) and 1 <= len(answer.strip()) <= 2_000 else None


def failure_from_runtime_code(runtime_code: str) -> TextGenerationFailed:
    code, safe_message, retryable = _FAILURES_BY_RUNTIME_CODE.get(
        runtime_code,
        _FAILURES_BY_RUNTIME_CODE["unknown_runtime_failure"],
    )
    return TextGenerationFailed(code=code, safe_message=safe_message, retryable=retryable)


def failure_from_status(status: grpc.StatusCode) -> TextGenerationFailed:
    code, safe_message, retryable = _FAILURES_BY_STATUS.get(
        status,
        _FAILURES_BY_RUNTIME_CODE["unknown_runtime_failure"],
    )
    return TextGenerationFailed(code=code, safe_message=safe_message, retryable=retryable)


def invalid_response() -> TextGenerationFailed:
    return TextGenerationFailed(
        code="subscription-runtime-invalid-response",
        safe_message="Conversation generation returned an invalid response.",
        retryable=True,
    )


def canonical_runtime_request(request: contract.AgentRuntimeTaskRequest) -> dict[str, object]:
    metadata = dict(request.metadata)
    return {
        "context": {
            "application": TENANT_ID,
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
            "outputSchemaName": OUTPUT_SCHEMA_NAME,
            "prompt": request.prompt,
            "systemPrompt": request.system_prompt,
        },
        "timeoutMs": request.timeout_ms,
    }


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def sha256(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _stable_conversation_request_id(request: TextGenerationRequest) -> str:
    kind = "conversation-answer-request"
    digest = hashlib.sha256(kind.encode()).copy()
    for part in (
        request.idempotency_key,
        request.meeting_id,
        request.recording_id,
        request.turn_id,
        POLICY_VERSION,
    ):
        digest.update(f":{len(part)}:".encode())
        digest.update(part.encode())
    return f"{kind}-{digest.hexdigest()[:32]}"
