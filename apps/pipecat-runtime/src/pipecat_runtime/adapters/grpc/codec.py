"""Translation between the published protobuf contract and application models."""

from __future__ import annotations

from typing import Final

from pipecat_runtime.adapters.grpc.generated import conversation_runtime_pb2 as contract
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
    Usage,
)
from pipecat_runtime.application.models import (
    PROTOCOL_VERSION,
    CancellationReason,
    CancelTurn,
    RuntimeInputError,
    StartTurn,
)

_FROM_CONTRACT_CANCELLATION_REASON: Final[
    dict[contract.ConversationCancellationReason, CancellationReason]
] = {
    contract.CONVERSATION_CANCELLATION_REASON_BARGE_IN: CancellationReason.BARGE_IN,
    contract.CONVERSATION_CANCELLATION_REASON_MEETING_ENDED: CancellationReason.MEETING_ENDED,
    contract.CONVERSATION_CANCELLATION_REASON_PLAYBACK_FAILED: CancellationReason.PLAYBACK_FAILED,
    contract.CONVERSATION_CANCELLATION_REASON_RUNTIME_SHUTDOWN: CancellationReason.RUNTIME_SHUTDOWN,
    contract.CONVERSATION_CANCELLATION_REASON_SUPERSEDED: CancellationReason.SUPERSEDED,
}
_TO_CONTRACT_CANCELLATION_REASON: Final[
    dict[CancellationReason, contract.ConversationCancellationReason]
] = {reason: value for value, reason in _FROM_CONTRACT_CANCELLATION_REASON.items()}


def start_turn_from_message(message: contract.ConversationRuntimeClientMessage) -> StartTurn:
    """Decode the required first client message into a validated application request."""
    _require_schema_version(message.schema_version)
    if message.WhichOneof("payload") != "start_turn":
        raise RuntimeInputError("first conversation message must be start_turn")
    payload = message.start_turn
    return StartTurn(
        meeting_id=payload.meeting_id,
        recording_id=payload.recording_id,
        turn_id=payload.turn_id,
        speaker_id=payload.speaker_id,
        idempotency_key=payload.idempotency_key,
        system_prompt=payload.system_prompt,
        prompt=payload.prompt,
        locale=payload.locale,
        voice_profile_id=payload.voice_profile_id,
        turn_ended_at_unix_ms=payload.turn_ended_at_unix_ms or None,
        wake_detected_at_unix_ms=payload.wake_detected_at_unix_ms or None,
        schema_version=message.schema_version,
    )


def cancel_turn_from_message(message: contract.ConversationRuntimeClientMessage) -> CancelTurn:
    """Decode one optional cancellation message for the active stream."""
    _require_schema_version(message.schema_version)
    if message.WhichOneof("payload") != "cancel_turn":
        raise RuntimeInputError("only cancel_turn is allowed after start_turn")
    reason = _FROM_CONTRACT_CANCELLATION_REASON.get(message.cancel_turn.reason)
    if reason is None:
        raise RuntimeInputError("cancel_turn requires a supported cancellation reason")
    payload = message.cancel_turn
    return CancelTurn(
        turn_id=payload.turn_id,
        attempt_id=payload.attempt_id,
        reason=reason,
        schema_version=message.schema_version,
    )


def event_to_message(event: ConversationEvent) -> contract.ConversationRuntimeServerMessage:
    """Encode a fully validated application event without exposing Pipecat frame types."""
    message = _new_server_message(event)
    match event:
        case Accepted():
            message.accepted.CopyFrom(contract.ConversationAccepted())
        case TextDelta(text=text):
            message.text_delta.CopyFrom(contract.ConversationTextDelta(text=text))
        case AudioStart(sample_rate_hz=sample_rate_hz, channels=channels):
            message.audio_start.CopyFrom(
                contract.ConversationAudioStart(
                    format=contract.CONVERSATION_AUDIO_FORMAT_PCM_S16LE,
                    sample_rate_hz=sample_rate_hz,
                    channels=channels,
                )
            )
        case AudioChunk(
            audio_sequence=audio_sequence,
            pcm=pcm,
            sample_rate_hz=sample_rate_hz,
            channels=channels,
        ):
            message.audio_chunk.CopyFrom(
                contract.ConversationAudioChunk(
                    audio_sequence=audio_sequence,
                    format=contract.CONVERSATION_AUDIO_FORMAT_PCM_S16LE,
                    sample_rate_hz=sample_rate_hz,
                    channels=channels,
                    pcm=pcm,
                )
            )
        case AudioEnd():
            message.audio_end.CopyFrom(contract.ConversationAudioEnd())
        case Usage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
        ):
            message.usage.CopyFrom(
                contract.ConversationUsage(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_tokens=total_tokens,
                )
            )
        case Latency(
            end_turn_to_wake_ms=end_turn_to_wake_ms,
            wake_to_first_llm_token_ms=wake_to_first_llm_token_ms,
            first_llm_token_to_audio_ms=first_llm_token_to_audio_ms,
            total_to_first_audio_ms=total_to_first_audio_ms,
        ):
            message.latency.CopyFrom(
                contract.ConversationLatency(
                    end_turn_to_wake_ms=end_turn_to_wake_ms,
                    wake_to_first_llm_token_ms=wake_to_first_llm_token_ms,
                    first_llm_token_to_audio_ms=first_llm_token_to_audio_ms,
                    total_to_first_audio_ms=total_to_first_audio_ms,
                )
            )
        case Completed():
            message.completed.CopyFrom(contract.ConversationCompleted())
        case Cancelled(reason=reason):
            message.cancelled.CopyFrom(
                contract.ConversationCancelled(reason=_TO_CONTRACT_CANCELLATION_REASON[reason])
            )
        case Failed(code=code, safe_message=safe_message, retryable=retryable):
            message.failed.CopyFrom(
                contract.ConversationFailed(
                    code=code,
                    safe_message=safe_message,
                    retryable=retryable,
                )
            )
        case _:
            raise RuntimeError(f"unsupported conversation event type: {type(event).__name__}")
    return message


def _new_server_message(event: ConversationEvent) -> contract.ConversationRuntimeServerMessage:
    return contract.ConversationRuntimeServerMessage(
        schema_version=event.schema_version,
        turn_id=event.turn_id,
        attempt_id=event.attempt_id,
        event_sequence=event.event_sequence,
    )


def _require_schema_version(schema_version: int) -> None:
    if schema_version != PROTOCOL_VERSION:
        raise RuntimeInputError("unsupported conversation runtime schema version")
