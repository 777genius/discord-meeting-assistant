"""Provider-neutral ordered events emitted by the conversation application port."""

from __future__ import annotations

from dataclasses import dataclass, field

from pipecat_runtime.application.models import (
    MAXIMUM_PCM_CHUNK_BYTES,
    PCM_S16LE_CHANNELS,
    PCM_S16LE_SAMPLE_RATE_HZ,
    PROTOCOL_VERSION,
    AudioFormat,
    CancellationReason,
    RuntimeInputError,
    bounded_text,
    identifier,
)


@dataclass(frozen=True, slots=True)
class EventEnvelope:
    turn_id: str
    attempt_id: str
    event_sequence: int
    schema_version: int = field(default=PROTOCOL_VERSION, kw_only=True)

    def __post_init__(self) -> None:
        if self.schema_version != PROTOCOL_VERSION:
            raise RuntimeInputError("unsupported conversation runtime schema version")
        object.__setattr__(self, "turn_id", identifier(self.turn_id, field_name="turn_id"))
        object.__setattr__(
            self,
            "attempt_id",
            identifier(self.attempt_id, field_name="attempt_id"),
        )
        if self.event_sequence < 0:
            raise RuntimeInputError("event_sequence must be non-negative")


@dataclass(frozen=True, slots=True)
class Accepted(EventEnvelope):
    """The runtime accepted the turn and assigned its attempt identity."""


@dataclass(frozen=True, slots=True)
class TextDelta(EventEnvelope):
    text: str

    def __post_init__(self) -> None:
        EventEnvelope.__post_init__(self)
        object.__setattr__(self, "text", bounded_text(self.text, field_name="text", maximum=8_000))


@dataclass(frozen=True, slots=True)
class AudioStart(EventEnvelope):
    format: AudioFormat = AudioFormat.PCM_S16LE
    sample_rate_hz: int = PCM_S16LE_SAMPLE_RATE_HZ
    channels: int = PCM_S16LE_CHANNELS

    def __post_init__(self) -> None:
        EventEnvelope.__post_init__(self)
        if (
            self.format is not AudioFormat.PCM_S16LE
            or self.sample_rate_hz != PCM_S16LE_SAMPLE_RATE_HZ
            or self.channels != PCM_S16LE_CHANNELS
        ):
            raise RuntimeInputError("audio output must be PCM S16LE, 48 kHz, mono")


@dataclass(frozen=True, slots=True)
class AudioChunk(EventEnvelope):
    audio_sequence: int
    pcm: bytes
    format: AudioFormat = AudioFormat.PCM_S16LE
    sample_rate_hz: int = PCM_S16LE_SAMPLE_RATE_HZ
    channels: int = PCM_S16LE_CHANNELS

    def __post_init__(self) -> None:
        EventEnvelope.__post_init__(self)
        if self.audio_sequence < 0:
            raise RuntimeInputError("audio_sequence must be non-negative")
        if (
            self.format is not AudioFormat.PCM_S16LE
            or self.sample_rate_hz != PCM_S16LE_SAMPLE_RATE_HZ
            or self.channels != PCM_S16LE_CHANNELS
        ):
            raise RuntimeInputError("audio output must be PCM S16LE, 48 kHz, mono")
        if not self.pcm or len(self.pcm) > MAXIMUM_PCM_CHUNK_BYTES or len(self.pcm) % 2 != 0:
            raise RuntimeInputError("PCM chunks must be non-empty, even, and bounded")


@dataclass(frozen=True, slots=True)
class AudioEnd(EventEnvelope):
    """Signals that no further PCM payloads belong to the attempt."""


@dataclass(frozen=True, slots=True)
class Usage(EventEnvelope):
    input_tokens: int
    output_tokens: int
    total_tokens: int

    def __post_init__(self) -> None:
        EventEnvelope.__post_init__(self)
        if min(self.input_tokens, self.output_tokens, self.total_tokens) < 0:
            raise RuntimeInputError("usage values must be non-negative")
        if self.total_tokens < self.input_tokens + self.output_tokens:
            raise RuntimeInputError("total_tokens must include input and output tokens")


@dataclass(frozen=True, slots=True)
class Latency(EventEnvelope):
    end_turn_to_wake_ms: int
    wake_to_first_llm_token_ms: int
    first_llm_token_to_audio_ms: int
    total_to_first_audio_ms: int

    def __post_init__(self) -> None:
        EventEnvelope.__post_init__(self)
        stages = (
            self.end_turn_to_wake_ms,
            self.wake_to_first_llm_token_ms,
            self.first_llm_token_to_audio_ms,
        )
        if min(stages) < 0 or self.total_to_first_audio_ms != sum(stages):
            raise RuntimeInputError("conversation latency stages must be non-negative and exact")


@dataclass(frozen=True, slots=True)
class Completed(EventEnvelope):
    """The full requested response finished successfully."""


@dataclass(frozen=True, slots=True)
class Cancelled(EventEnvelope):
    reason: CancellationReason


@dataclass(frozen=True, slots=True)
class Failed(EventEnvelope):
    code: str
    safe_message: str
    retryable: bool

    def __post_init__(self) -> None:
        EventEnvelope.__post_init__(self)
        object.__setattr__(self, "code", bounded_text(self.code, field_name="code", maximum=128))
        object.__setattr__(
            self,
            "safe_message",
            bounded_text(self.safe_message, field_name="safe_message", maximum=512),
        )


type ConversationEvent = (
    Accepted
    | TextDelta
    | AudioStart
    | AudioChunk
    | AudioEnd
    | Usage
    | Latency
    | Completed
    | Cancelled
    | Failed
)

type TerminalConversationEvent = Completed | Cancelled | Failed


def is_terminal_event(event: ConversationEvent) -> bool:
    return isinstance(event, (Completed, Cancelled, Failed))
