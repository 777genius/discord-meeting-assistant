from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ConversationCancellationReason(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    CONVERSATION_CANCELLATION_REASON_UNSPECIFIED: _ClassVar[ConversationCancellationReason]
    CONVERSATION_CANCELLATION_REASON_BARGE_IN: _ClassVar[ConversationCancellationReason]
    CONVERSATION_CANCELLATION_REASON_MEETING_ENDED: _ClassVar[ConversationCancellationReason]
    CONVERSATION_CANCELLATION_REASON_PLAYBACK_FAILED: _ClassVar[ConversationCancellationReason]
    CONVERSATION_CANCELLATION_REASON_RUNTIME_SHUTDOWN: _ClassVar[ConversationCancellationReason]
    CONVERSATION_CANCELLATION_REASON_SUPERSEDED: _ClassVar[ConversationCancellationReason]

class ConversationAudioFormat(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    CONVERSATION_AUDIO_FORMAT_UNSPECIFIED: _ClassVar[ConversationAudioFormat]
    CONVERSATION_AUDIO_FORMAT_PCM_S16LE: _ClassVar[ConversationAudioFormat]
CONVERSATION_CANCELLATION_REASON_UNSPECIFIED: ConversationCancellationReason
CONVERSATION_CANCELLATION_REASON_BARGE_IN: ConversationCancellationReason
CONVERSATION_CANCELLATION_REASON_MEETING_ENDED: ConversationCancellationReason
CONVERSATION_CANCELLATION_REASON_PLAYBACK_FAILED: ConversationCancellationReason
CONVERSATION_CANCELLATION_REASON_RUNTIME_SHUTDOWN: ConversationCancellationReason
CONVERSATION_CANCELLATION_REASON_SUPERSEDED: ConversationCancellationReason
CONVERSATION_AUDIO_FORMAT_UNSPECIFIED: ConversationAudioFormat
CONVERSATION_AUDIO_FORMAT_PCM_S16LE: ConversationAudioFormat

class ConversationRuntimeClientMessage(_message.Message):
    __slots__ = ("schema_version", "start_turn", "cancel_turn")
    SCHEMA_VERSION_FIELD_NUMBER: _ClassVar[int]
    START_TURN_FIELD_NUMBER: _ClassVar[int]
    CANCEL_TURN_FIELD_NUMBER: _ClassVar[int]
    schema_version: int
    start_turn: ConversationStartTurn
    cancel_turn: ConversationCancelTurn
    def __init__(self, schema_version: _Optional[int] = ..., start_turn: _Optional[_Union[ConversationStartTurn, _Mapping]] = ..., cancel_turn: _Optional[_Union[ConversationCancelTurn, _Mapping]] = ...) -> None: ...

class ConversationStartTurn(_message.Message):
    __slots__ = ("meeting_id", "recording_id", "turn_id", "speaker_id", "idempotency_key", "system_prompt", "prompt", "locale", "voice_profile_id", "turn_ended_at_unix_ms", "wake_detected_at_unix_ms", "literal_speech")
    MEETING_ID_FIELD_NUMBER: _ClassVar[int]
    RECORDING_ID_FIELD_NUMBER: _ClassVar[int]
    TURN_ID_FIELD_NUMBER: _ClassVar[int]
    SPEAKER_ID_FIELD_NUMBER: _ClassVar[int]
    IDEMPOTENCY_KEY_FIELD_NUMBER: _ClassVar[int]
    SYSTEM_PROMPT_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    LOCALE_FIELD_NUMBER: _ClassVar[int]
    VOICE_PROFILE_ID_FIELD_NUMBER: _ClassVar[int]
    TURN_ENDED_AT_UNIX_MS_FIELD_NUMBER: _ClassVar[int]
    WAKE_DETECTED_AT_UNIX_MS_FIELD_NUMBER: _ClassVar[int]
    LITERAL_SPEECH_FIELD_NUMBER: _ClassVar[int]
    meeting_id: str
    recording_id: str
    turn_id: str
    speaker_id: str
    idempotency_key: str
    system_prompt: str
    prompt: str
    locale: str
    voice_profile_id: str
    turn_ended_at_unix_ms: int
    wake_detected_at_unix_ms: int
    literal_speech: str
    def __init__(self, meeting_id: _Optional[str] = ..., recording_id: _Optional[str] = ..., turn_id: _Optional[str] = ..., speaker_id: _Optional[str] = ..., idempotency_key: _Optional[str] = ..., system_prompt: _Optional[str] = ..., prompt: _Optional[str] = ..., locale: _Optional[str] = ..., voice_profile_id: _Optional[str] = ..., turn_ended_at_unix_ms: _Optional[int] = ..., wake_detected_at_unix_ms: _Optional[int] = ..., literal_speech: _Optional[str] = ...) -> None: ...

class ConversationCancelTurn(_message.Message):
    __slots__ = ("turn_id", "attempt_id", "reason")
    TURN_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    turn_id: str
    attempt_id: str
    reason: ConversationCancellationReason
    def __init__(self, turn_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., reason: _Optional[_Union[ConversationCancellationReason, str]] = ...) -> None: ...

class ConversationRuntimeServerMessage(_message.Message):
    __slots__ = ("schema_version", "turn_id", "attempt_id", "event_sequence", "accepted", "text_delta", "audio_start", "audio_chunk", "audio_end", "usage", "completed", "cancelled", "failed", "latency")
    SCHEMA_VERSION_FIELD_NUMBER: _ClassVar[int]
    TURN_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    EVENT_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    ACCEPTED_FIELD_NUMBER: _ClassVar[int]
    TEXT_DELTA_FIELD_NUMBER: _ClassVar[int]
    AUDIO_START_FIELD_NUMBER: _ClassVar[int]
    AUDIO_CHUNK_FIELD_NUMBER: _ClassVar[int]
    AUDIO_END_FIELD_NUMBER: _ClassVar[int]
    USAGE_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_FIELD_NUMBER: _ClassVar[int]
    CANCELLED_FIELD_NUMBER: _ClassVar[int]
    FAILED_FIELD_NUMBER: _ClassVar[int]
    LATENCY_FIELD_NUMBER: _ClassVar[int]
    schema_version: int
    turn_id: str
    attempt_id: str
    event_sequence: int
    accepted: ConversationAccepted
    text_delta: ConversationTextDelta
    audio_start: ConversationAudioStart
    audio_chunk: ConversationAudioChunk
    audio_end: ConversationAudioEnd
    usage: ConversationUsage
    completed: ConversationCompleted
    cancelled: ConversationCancelled
    failed: ConversationFailed
    latency: ConversationLatency
    def __init__(self, schema_version: _Optional[int] = ..., turn_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., event_sequence: _Optional[int] = ..., accepted: _Optional[_Union[ConversationAccepted, _Mapping]] = ..., text_delta: _Optional[_Union[ConversationTextDelta, _Mapping]] = ..., audio_start: _Optional[_Union[ConversationAudioStart, _Mapping]] = ..., audio_chunk: _Optional[_Union[ConversationAudioChunk, _Mapping]] = ..., audio_end: _Optional[_Union[ConversationAudioEnd, _Mapping]] = ..., usage: _Optional[_Union[ConversationUsage, _Mapping]] = ..., completed: _Optional[_Union[ConversationCompleted, _Mapping]] = ..., cancelled: _Optional[_Union[ConversationCancelled, _Mapping]] = ..., failed: _Optional[_Union[ConversationFailed, _Mapping]] = ..., latency: _Optional[_Union[ConversationLatency, _Mapping]] = ...) -> None: ...

class ConversationAccepted(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ConversationAudioEnd(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ConversationCompleted(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ConversationTextDelta(_message.Message):
    __slots__ = ("text",)
    TEXT_FIELD_NUMBER: _ClassVar[int]
    text: str
    def __init__(self, text: _Optional[str] = ...) -> None: ...

class ConversationAudioStart(_message.Message):
    __slots__ = ("format", "sample_rate_hz", "channels")
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    SAMPLE_RATE_HZ_FIELD_NUMBER: _ClassVar[int]
    CHANNELS_FIELD_NUMBER: _ClassVar[int]
    format: ConversationAudioFormat
    sample_rate_hz: int
    channels: int
    def __init__(self, format: _Optional[_Union[ConversationAudioFormat, str]] = ..., sample_rate_hz: _Optional[int] = ..., channels: _Optional[int] = ...) -> None: ...

class ConversationAudioChunk(_message.Message):
    __slots__ = ("audio_sequence", "format", "sample_rate_hz", "channels", "pcm")
    AUDIO_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    SAMPLE_RATE_HZ_FIELD_NUMBER: _ClassVar[int]
    CHANNELS_FIELD_NUMBER: _ClassVar[int]
    PCM_FIELD_NUMBER: _ClassVar[int]
    audio_sequence: int
    format: ConversationAudioFormat
    sample_rate_hz: int
    channels: int
    pcm: bytes
    def __init__(self, audio_sequence: _Optional[int] = ..., format: _Optional[_Union[ConversationAudioFormat, str]] = ..., sample_rate_hz: _Optional[int] = ..., channels: _Optional[int] = ..., pcm: _Optional[bytes] = ...) -> None: ...

class ConversationUsage(_message.Message):
    __slots__ = ("input_tokens", "output_tokens", "total_tokens")
    INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    input_tokens: int
    output_tokens: int
    total_tokens: int
    def __init__(self, input_tokens: _Optional[int] = ..., output_tokens: _Optional[int] = ..., total_tokens: _Optional[int] = ...) -> None: ...

class ConversationCancelled(_message.Message):
    __slots__ = ("reason",)
    REASON_FIELD_NUMBER: _ClassVar[int]
    reason: ConversationCancellationReason
    def __init__(self, reason: _Optional[_Union[ConversationCancellationReason, str]] = ...) -> None: ...

class ConversationFailed(_message.Message):
    __slots__ = ("code", "safe_message", "retryable")
    CODE_FIELD_NUMBER: _ClassVar[int]
    SAFE_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    RETRYABLE_FIELD_NUMBER: _ClassVar[int]
    code: str
    safe_message: str
    retryable: bool
    def __init__(self, code: _Optional[str] = ..., safe_message: _Optional[str] = ..., retryable: _Optional[bool] = ...) -> None: ...

class ConversationLatency(_message.Message):
    __slots__ = ("end_turn_to_wake_ms", "wake_to_first_llm_token_ms", "first_llm_token_to_audio_ms", "total_to_first_audio_ms")
    END_TURN_TO_WAKE_MS_FIELD_NUMBER: _ClassVar[int]
    WAKE_TO_FIRST_LLM_TOKEN_MS_FIELD_NUMBER: _ClassVar[int]
    FIRST_LLM_TOKEN_TO_AUDIO_MS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TO_FIRST_AUDIO_MS_FIELD_NUMBER: _ClassVar[int]
    end_turn_to_wake_ms: int
    wake_to_first_llm_token_ms: int
    first_llm_token_to_audio_ms: int
    total_to_first_audio_ms: int
    def __init__(self, end_turn_to_wake_ms: _Optional[int] = ..., wake_to_first_llm_token_ms: _Optional[int] = ..., first_llm_token_to_audio_ms: _Optional[int] = ..., total_to_first_audio_ms: _Optional[int] = ...) -> None: ...

class ConversationRuntimeHealthRequest(_message.Message):
    __slots__ = ("service",)
    SERVICE_FIELD_NUMBER: _ClassVar[int]
    service: str
    def __init__(self, service: _Optional[str] = ...) -> None: ...

class ConversationRuntimeHealthResponse(_message.Message):
    __slots__ = ("status", "runtime_name", "runtime_version", "warning_codes")
    class Status(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
        __slots__ = ()
        STATUS_UNSPECIFIED: _ClassVar[ConversationRuntimeHealthResponse.Status]
        STATUS_SERVING: _ClassVar[ConversationRuntimeHealthResponse.Status]
        STATUS_DEGRADED: _ClassVar[ConversationRuntimeHealthResponse.Status]
        STATUS_NOT_SERVING: _ClassVar[ConversationRuntimeHealthResponse.Status]
    STATUS_UNSPECIFIED: ConversationRuntimeHealthResponse.Status
    STATUS_SERVING: ConversationRuntimeHealthResponse.Status
    STATUS_DEGRADED: ConversationRuntimeHealthResponse.Status
    STATUS_NOT_SERVING: ConversationRuntimeHealthResponse.Status
    STATUS_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_NAME_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_VERSION_FIELD_NUMBER: _ClassVar[int]
    WARNING_CODES_FIELD_NUMBER: _ClassVar[int]
    status: ConversationRuntimeHealthResponse.Status
    runtime_name: str
    runtime_version: str
    warning_codes: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, status: _Optional[_Union[ConversationRuntimeHealthResponse.Status, str]] = ..., runtime_name: _Optional[str] = ..., runtime_version: _Optional[str] = ..., warning_codes: _Optional[_Iterable[str]] = ...) -> None: ...
