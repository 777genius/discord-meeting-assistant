"""Ports owned by the provider-neutral runtime application boundary."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable
from typing import Protocol

from pipecat_runtime.application.models import (
    CancelTurn,
    ConversationEvent,
    StartTurn,
    TextGenerationRequest,
    TextGenerationResult,
)


class CancellationSignal(Protocol):
    """The minimal cancellation capability needed by a consumer-owned outbound port."""

    def is_set(self) -> bool:
        """Return whether the active turn has already been cancelled."""
        ...

    def wait(self) -> Awaitable[bool]:
        """Resolve when the active turn has been cancelled."""
        ...


class ConversationSession(Protocol):
    """One active stream created by a conversation runtime implementation."""

    @property
    def attempt_id(self) -> str:
        """Return the stable attempt identifier needed for cancellation."""
        ...

    def events(self) -> AsyncIterator[ConversationEvent]:
        """Yield ordered events until one terminal event has been observed."""
        ...

    def abandon_events(self) -> None:
        """Release event backpressure after the unique consumer disconnects."""
        ...

    async def cancel(self, request: CancelTurn) -> bool:
        """Request cancellation and return whether it changed active execution."""
        ...

    async def wait(self) -> None:
        """Wait until Pipecat resources backing the stream are cleaned up."""
        ...


class ConversationRuntime(Protocol):
    """Execute one stateless addressed turn behind a provider-neutral boundary."""

    async def start(self, request: StartTurn) -> ConversationSession:
        """Start one runtime session after validating the selected voice profile."""
        ...


class ConversationTextGenerationPort(Protocol):
    """Generate one stateless answer without exposing a provider or transport."""

    async def generate(
        self,
        request: TextGenerationRequest,
        *,
        cancellation_requested: CancellationSignal,
    ) -> TextGenerationResult:
        """Return a validated answer, safe failure, or caller-driven cancellation."""
        ...
