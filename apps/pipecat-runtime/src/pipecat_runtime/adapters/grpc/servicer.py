"""gRPC inbound adapter for the versioned conversation runtime contract."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import suppress

import grpc

from pipecat_runtime.adapters.grpc.auth import BearerTokenAuthenticator
from pipecat_runtime.adapters.grpc.codec import (
    cancel_turn_from_message,
    event_to_message,
    start_turn_from_message,
)
from pipecat_runtime.adapters.grpc.generated import conversation_runtime_pb2 as contract
from pipecat_runtime.adapters.grpc.generated import conversation_runtime_pb2_grpc
from pipecat_runtime.application.models import (
    CancellationReason,
    CancelTurn,
    RuntimeInputError,
    StartTurn,
)
from pipecat_runtime.application.ports import ConversationRuntime, ConversationSession


class ConversationRuntimeGrpcServicer(
    conversation_runtime_pb2_grpc.ConversationRuntimeServiceServicer
):
    """Authenticate and translate bidirectional gRPC streams into runtime sessions."""

    def __init__(
        self,
        *,
        runtime: ConversationRuntime,
        authenticator: BearerTokenAuthenticator,
        runtime_name: str = "pipecat-runtime",
        runtime_version: str = "0.1.0",
    ) -> None:
        self._runtime = runtime
        self._authenticator = authenticator
        self._runtime_name = runtime_name
        self._runtime_version = runtime_version

    async def CheckHealth(
        self,
        request: contract.ConversationRuntimeHealthRequest,
        context: grpc.aio.ServicerContext[
            contract.ConversationRuntimeHealthRequest,
            contract.ConversationRuntimeHealthResponse,
        ],
    ) -> contract.ConversationRuntimeHealthResponse:
        """Return serving status only to the private authenticated caller."""
        del request
        await self._require_authorized(context)
        return contract.ConversationRuntimeHealthResponse(
            status=contract.ConversationRuntimeHealthResponse.STATUS_SERVING,
            runtime_name=self._runtime_name,
            runtime_version=self._runtime_version,
        )

    async def Converse(
        self,
        request_iterator: AsyncIterator[contract.ConversationRuntimeClientMessage],
        context: grpc.aio.ServicerContext[
            contract.ConversationRuntimeClientMessage,
            contract.ConversationRuntimeServerMessage,
        ],
    ) -> AsyncIterator[contract.ConversationRuntimeServerMessage]:
        """Serve exactly one StartTurn followed by optional matching CancelTurn messages."""
        await self._require_authorized(context)
        try:
            first_message = await anext(request_iterator)
            start_turn = start_turn_from_message(first_message)
            session = await self._runtime.start(start_turn)
        except StopAsyncIteration:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "start_turn is required")
            return
        except RuntimeInputError:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "invalid conversation request")
            return

        receiver_task = asyncio.create_task(
            self._receive_optional_cancellations(request_iterator, session, start_turn),
            name=f"conversation-cancellations-{session.attempt_id}",
        )
        try:
            async for event in session.events():
                input_error = _completed_input_error(receiver_task)
                if input_error is not None:
                    await context.abort(
                        grpc.StatusCode.INVALID_ARGUMENT,
                        "invalid conversation request",
                    )
                    return
                yield event_to_message(event)
        finally:
            session.abandon_events()
            await _cancel_active_session(session, start_turn)
            if not receiver_task.done():
                receiver_task.cancel()
            with suppress(asyncio.CancelledError):
                await receiver_task
            await session.wait()

    async def _require_authorized[RequestT, ResponseT](
        self,
        context: grpc.aio.ServicerContext[RequestT, ResponseT],
    ) -> None:
        if not self._authenticator.is_authorized(context.invocation_metadata()):
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing or invalid bearer token")

    async def _receive_optional_cancellations(
        self,
        request_iterator: AsyncIterator[contract.ConversationRuntimeClientMessage],
        session: ConversationSession,
        start_turn: StartTurn,
    ) -> RuntimeInputError | None:
        try:
            async for message in request_iterator:
                cancel_turn = cancel_turn_from_message(message)
                await session.cancel(cancel_turn)
        except RuntimeInputError as error:
            await _cancel_active_session(session, start_turn)
            return error
        return None


async def _cancel_active_session(session: ConversationSession, start_turn: StartTurn) -> None:
    """Stop a live task during client disconnect, malformed input, or adapter cleanup."""
    try:
        await session.cancel(
            CancelTurn(
                turn_id=start_turn.turn_id,
                attempt_id=session.attempt_id,
                reason=CancellationReason.RUNTIME_SHUTDOWN,
            )
        )
    except RuntimeInputError:
        return


def _completed_input_error(
    task: asyncio.Task[RuntimeInputError | None],
) -> RuntimeInputError | None:
    if not task.done() or task.cancelled():
        return None
    return task.result()
