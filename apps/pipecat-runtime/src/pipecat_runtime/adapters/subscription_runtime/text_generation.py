"""Subscription Runtime gRPC adapter for one stateless conversation answer."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import suppress
from dataclasses import dataclass

import grpc

from pipecat_runtime.adapters.subscription_runtime.conversation_contract import (
    failure_from_status,
    from_agent_response,
    to_agent_request,
)
from pipecat_runtime.adapters.subscription_runtime.generated import agent_runtime_pb2 as contract
from pipecat_runtime.adapters.subscription_runtime.generated import agent_runtime_pb2_grpc
from pipecat_runtime.adapters.subscription_runtime.streaming_text_generation import (
    stream_agent_task,
)
from pipecat_runtime.application.models import (
    TextGenerationCancelled,
    TextGenerationRequest,
    TextGenerationResult,
    TextGenerationStreamEvent,
)
from pipecat_runtime.application.ports import CancellationSignal, ConversationTextGenerationPort


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
    """Reuse one private gRPC channel for unary and streaming conversation calls."""

    def __init__(self, settings: SubscriptionRuntimeTextGenerationSettings) -> None:
        self._settings = settings
        self._channel = grpc.aio.insecure_channel(
            settings.address,
            options=(
                ("grpc.keepalive_time_ms", 30_000),
                ("grpc.keepalive_timeout_ms", 10_000),
                ("grpc.keepalive_permit_without_calls", 1),
            ),
        )
        self._client = agent_runtime_pb2_grpc.AgentRuntimeServiceStub(self._channel)

    async def generate(
        self,
        request: TextGenerationRequest,
        *,
        cancellation_requested: CancellationSignal,
    ) -> TextGenerationResult:
        """Keep the backward-compatible unary path for non-streaming profiles and tests."""
        if cancellation_requested.is_set():
            return TextGenerationCancelled()
        try:
            call = self._client.RunAgentTask(
                to_agent_request(request, timeout_ms=self._settings.timeout_ms),
                metadata=self._metadata(),
                timeout=self._settings.timeout_seconds,
            )
            response = await _await_or_cancel(call, cancellation_requested)
        except grpc.aio.AioRpcError as error:
            return failure_from_status(error.code())
        except OSError:
            return failure_from_status(grpc.StatusCode.UNAVAILABLE)
        if response is None:
            return TextGenerationCancelled()
        return from_agent_response(response)

    async def stream(
        self,
        request: TextGenerationRequest,
        *,
        cancellation_requested: CancellationSignal,
    ) -> AsyncIterator[TextGenerationStreamEvent]:
        """Stream provisional answer text and accept only an attested terminal result."""
        async for event in stream_agent_task(
            client=self._client,
            metadata=self._metadata(),
            request=to_agent_request(request, timeout_ms=self._settings.timeout_ms),
            timeout_seconds=self._settings.timeout_seconds,
            cancellation_requested=cancellation_requested,
        ):
            yield event

    async def close(self) -> None:
        """Close the persistent private channel during sidecar shutdown."""
        await self._channel.close(grace=1)

    def _metadata(self) -> tuple[tuple[str, str], ...]:
        return (("authorization", f"Bearer {self._settings.service_token}"),)


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
