"""Provider-neutral models for the published conversation runtime contract."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final

PROTOCOL_VERSION: Final = 1
PCM_S16LE_SAMPLE_RATE_HZ: Final = 48_000
PCM_S16LE_CHANNELS: Final = 1
MAXIMUM_PCM_CHUNK_BYTES: Final = 19_200


class RuntimeInputError(ValueError):
    """Raised when a boundary payload violates the versioned contract."""


class CancellationReason(StrEnum):
    """Reasons a caller may stop an active conversation attempt."""

    BARGE_IN = "barge-in"
    MEETING_ENDED = "meeting-ended"
    PLAYBACK_FAILED = "playback-failed"
    RUNTIME_SHUTDOWN = "runtime-shutdown"
    SUPERSEDED = "superseded"


class AudioFormat(StrEnum):
    """The only audio format allowed across the runtime boundary."""

    PCM_S16LE = "pcm_s16le"


def _bounded_text(value: str, *, field_name: str, maximum: int, minimum: int = 1) -> str:
    normalized = value.strip()
    if not minimum <= len(normalized) <= maximum:
        message = f"{field_name} must contain between {minimum} and {maximum} characters"
        raise RuntimeInputError(message)
    return normalized


def _identifier(value: str, *, field_name: str) -> str:
    return _bounded_text(value, field_name=field_name, maximum=128)


@dataclass(frozen=True, slots=True)
class StartTurn:
    """A stateless request to answer one addressed participant utterance."""

    meeting_id: str
    recording_id: str
    turn_id: str
    speaker_id: str
    idempotency_key: str
    system_prompt: str
    prompt: str
    locale: str
    voice_profile_id: str
    schema_version: int = field(default=PROTOCOL_VERSION, kw_only=True)

    def __post_init__(self) -> None:
        if self.schema_version != PROTOCOL_VERSION:
            raise RuntimeInputError("unsupported conversation runtime schema version")
        for field_name in (
            "meeting_id",
            "recording_id",
            "turn_id",
            "speaker_id",
            "idempotency_key",
            "voice_profile_id",
        ):
            object.__setattr__(
                self,
                field_name,
                _identifier(getattr(self, field_name), field_name=field_name),
            )
        object.__setattr__(
            self,
            "system_prompt",
            _bounded_text(self.system_prompt, field_name="system_prompt", maximum=16_000),
        )
        object.__setattr__(
            self,
            "prompt",
            _bounded_text(self.prompt, field_name="prompt", maximum=8_000),
        )
        object.__setattr__(
            self,
            "locale",
            _bounded_text(self.locale, field_name="locale", maximum=35, minimum=2),
        )


@dataclass(frozen=True, slots=True)
class TextGenerationRequest:
    """Provider-neutral input for generating one stateless conversation answer."""

    meeting_id: str
    recording_id: str
    turn_id: str
    idempotency_key: str
    system_prompt: str
    prompt: str
    locale: str

    def __post_init__(self) -> None:
        for field_name in (
            "meeting_id",
            "recording_id",
            "turn_id",
            "idempotency_key",
        ):
            object.__setattr__(
                self,
                field_name,
                _identifier(getattr(self, field_name), field_name=field_name),
            )
        object.__setattr__(
            self,
            "system_prompt",
            _bounded_text(self.system_prompt, field_name="system_prompt", maximum=16_000),
        )
        object.__setattr__(
            self,
            "prompt",
            _bounded_text(self.prompt, field_name="prompt", maximum=8_000),
        )
        object.__setattr__(
            self,
            "locale",
            _bounded_text(self.locale, field_name="locale", maximum=35, minimum=2),
        )

    @classmethod
    def from_start_turn(cls, request: StartTurn) -> TextGenerationRequest:
        """Project the one-turn model input without introducing conversational history."""
        return cls(
            meeting_id=request.meeting_id,
            recording_id=request.recording_id,
            turn_id=request.turn_id,
            idempotency_key=request.idempotency_key,
            system_prompt=request.system_prompt,
            prompt=request.prompt,
            locale=request.locale,
        )


@dataclass(frozen=True, slots=True)
class TextGenerationCompleted:
    """A validated answer from one text-generation attempt."""

    answer: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "answer",
            _bounded_text(self.answer, field_name="answer", maximum=2_000),
        )


@dataclass(frozen=True, slots=True)
class TextGenerationFailed:
    """A safe provider-neutral failure for one text-generation attempt."""

    code: str
    safe_message: str
    retryable: bool

    def __post_init__(self) -> None:
        object.__setattr__(self, "code", _bounded_text(self.code, field_name="code", maximum=128))
        object.__setattr__(
            self,
            "safe_message",
            _bounded_text(self.safe_message, field_name="safe_message", maximum=512),
        )


@dataclass(frozen=True, slots=True)
class TextGenerationCancelled:
    """A text-generation call stopped because its Pipecat turn was cancelled."""


type TextGenerationResult = TextGenerationCompleted | TextGenerationFailed | TextGenerationCancelled


@dataclass(frozen=True, slots=True)
class CancelTurn:
    """An idempotent request to cancel a specific conversation attempt."""

    turn_id: str
    attempt_id: str
    reason: CancellationReason
    schema_version: int = PROTOCOL_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != PROTOCOL_VERSION:
            raise RuntimeInputError("unsupported conversation runtime schema version")
        object.__setattr__(
            self,
            "turn_id",
            _identifier(self.turn_id, field_name="turn_id"),
        )
        object.__setattr__(
            self,
            "attempt_id",
            _identifier(self.attempt_id, field_name="attempt_id"),
        )


@dataclass(frozen=True, slots=True)
class EventEnvelope:
    """Ordered provider-neutral metadata shared by each emitted event."""

    turn_id: str
    attempt_id: str
    event_sequence: int
    schema_version: int = field(default=PROTOCOL_VERSION, kw_only=True)

    def __post_init__(self) -> None:
        if self.schema_version != PROTOCOL_VERSION:
            raise RuntimeInputError("unsupported conversation runtime schema version")
        object.__setattr__(
            self,
            "turn_id",
            _identifier(self.turn_id, field_name="turn_id"),
        )
        object.__setattr__(
            self,
            "attempt_id",
            _identifier(self.attempt_id, field_name="attempt_id"),
        )
        if self.event_sequence < 0:
            raise RuntimeInputError("event_sequence must be non-negative")


@dataclass(frozen=True, slots=True)
class Accepted(EventEnvelope):
    """The runtime accepted the turn and assigned its attempt identity."""


@dataclass(frozen=True, slots=True)
class TextDelta(EventEnvelope):
    """A streaming, provider-neutral text fragment."""

    text: str

    def __post_init__(self) -> None:
        EventEnvelope.__post_init__(self)
        object.__setattr__(self, "text", _bounded_text(self.text, field_name="text", maximum=8_000))


@dataclass(frozen=True, slots=True)
class AudioStart(EventEnvelope):
    """Signals the start of normalized mono 48 kHz PCM output."""

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
    """One bounded normalized PCM payload."""

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
    """Provider-neutral token accounting for one stateless answer."""

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
class Completed(EventEnvelope):
    """The full requested response finished successfully."""


@dataclass(frozen=True, slots=True)
class Cancelled(EventEnvelope):
    """The active response stopped due to an explicit cancellation reason."""

    reason: CancellationReason


@dataclass(frozen=True, slots=True)
class Failed(EventEnvelope):
    """A safe, provider-neutral terminal failure."""

    code: str
    safe_message: str
    retryable: bool

    def __post_init__(self) -> None:
        EventEnvelope.__post_init__(self)
        object.__setattr__(self, "code", _bounded_text(self.code, field_name="code", maximum=128))
        object.__setattr__(
            self,
            "safe_message",
            _bounded_text(self.safe_message, field_name="safe_message", maximum=512),
        )


type ConversationEvent = (
    Accepted
    | TextDelta
    | AudioStart
    | AudioChunk
    | AudioEnd
    | Usage
    | Completed
    | Cancelled
    | Failed
)

type TerminalConversationEvent = Completed | Cancelled | Failed


def is_terminal_event(event: ConversationEvent) -> bool:
    """Return whether an event closes the runtime stream."""
    return isinstance(event, (Completed, Cancelled, Failed))
