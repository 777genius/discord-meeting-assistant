"""Pipecat-only frames used to start one stateless conversation pipeline."""

from __future__ import annotations

from dataclasses import dataclass

from pipecat.frames.frames import DataFrame

from pipecat_runtime.application.models import StartTurn, TextGenerationFailed


@dataclass
class ConversationTurnFrame(DataFrame):
    """Carry one validated provider-neutral request into the Pipecat pipeline."""

    request: StartTurn


@dataclass
class ConversationTextFrame(DataFrame):
    """Preserve generated speech text across TTS services that consume LLM frames."""

    text: str


@dataclass
class TextGenerationFailureFrame(DataFrame):
    """Carry a safe application failure through Pipecat without provider details."""

    failure: TextGenerationFailed


@dataclass
class TextGenerationFirstTokenFrame(DataFrame):
    """Carry the first raw answer-delta timestamp through provider serialization."""

    observed_at_unix_ms: int
