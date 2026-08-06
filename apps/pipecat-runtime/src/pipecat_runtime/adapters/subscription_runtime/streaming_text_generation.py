"""Ordered server-streaming Subscription Runtime conversation transport."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from contextlib import suppress
from enum import Enum
from typing import Any, Final, cast

import grpc

from pipecat_runtime.adapters.subscription_runtime.conversation_contract import (
    failure_from_status,
    from_agent_response,
    invalid_response,
    verify_streamed_completion,
)
from pipecat_runtime.adapters.subscription_runtime.generated import agent_runtime_pb2 as contract
from pipecat_runtime.adapters.subscription_runtime.generated import agent_runtime_pb2_grpc
from pipecat_runtime.adapters.subscription_runtime.structured_answer_stream import (
    StructuredAnswerStreamDecoder,
)
from pipecat_runtime.application.models import (
    TextGenerationCancelled,
    TextGenerationCompleted,
    TextGenerationStreamDelta,
    TextGenerationStreamEvent,
    TextGenerationStreamStarted,
)
from pipecat_runtime.application.ports import CancellationSignal

_MAXIMUM_DELTA_EVENTS: Final = 256
_MAXIMUM_EVENTS: Final = _MAXIMUM_DELTA_EVENTS + 2
_GRPC_EOF: Final = vars(grpc.aio)["EOF"]


class _ReadSentinel(Enum):
    CANCELLED = "cancelled"
    EOF = "eof"


async def stream_agent_task(
    *,
    client: agent_runtime_pb2_grpc.AgentRuntimeServiceStub,
    metadata: Sequence[tuple[str, str]],
    request: contract.AgentRuntimeTaskRequest,
    timeout_seconds: float,
    cancellation_requested: CancellationSignal,
) -> AsyncIterator[TextGenerationStreamEvent]:
    """Decode provisional answer text and fail closed against the final attestation."""
    if cancellation_requested.is_set():
        yield TextGenerationCancelled()
        return
    call = client.StreamAgentTask(
        contract.AgentRuntimeTaskStreamRequest(task=request),
        metadata=metadata,
        timeout=timeout_seconds,
    )
    decoder = StructuredAnswerStreamDecoder()
    expected_sequence = 1
    started = False
    raw_delta_seen = False
    decoded_answer: list[str] = []
    terminal_received = False
    try:
        while expected_sequence <= _MAXIMUM_EVENTS:
            message = await _read_or_cancel(call, cancellation_requested)
            if message is _ReadSentinel.CANCELLED:
                yield TextGenerationCancelled()
                return
            if message is _ReadSentinel.EOF:
                break
            if (
                message.schema_version != 1
                or message.sequence != expected_sequence
            ):
                yield invalid_response()
                return
            expected_sequence += 1
            event_kind = message.WhichOneof("event")
            if event_kind == "started":
                if started:
                    yield invalid_response()
                    return
                started = True
                yield TextGenerationStreamStarted()
                continue
            if event_kind == "text_delta":
                if not started or not message.text_delta.text:
                    yield invalid_response()
                    return
                raw_delta_seen = True
                try:
                    chunks = decoder.feed(message.text_delta.text)
                except ValueError:
                    yield invalid_response()
                    return
                for text in chunks:
                    decoded_answer.append(text)
                    yield TextGenerationStreamDelta(text=text)
                continue
            if event_kind != "completed":
                yield invalid_response()
                return
            terminal_received = True
            if message.completed.status == contract.AGENT_RUNTIME_TASK_STATUS_FAILED:
                yield from_agent_response(message.completed)
                return
            if not started:
                yield invalid_response()
                return
            answer = verify_streamed_completion(message.completed, request)
            if answer is None:
                yield invalid_response()
                return
            if raw_delta_seen:
                try:
                    decoder.finish()
                except ValueError:
                    yield invalid_response()
                    return
                if "".join(decoded_answer) != answer:
                    yield invalid_response()
                    return
            else:
                yield TextGenerationStreamDelta(text=answer)
            yield TextGenerationCompleted(answer=answer)
            return
    except grpc.aio.AioRpcError as error:
        yield failure_from_status(error.code())
        return
    except OSError:
        yield failure_from_status(grpc.StatusCode.UNAVAILABLE)
        return
    finally:
        if not terminal_received:
            call.cancel()
    yield invalid_response()


async def _read_or_cancel(
    call: Any,
    cancellation_requested: CancellationSignal,
) -> contract.AgentRuntimeTaskEvent | _ReadSentinel:
    response_task = asyncio.ensure_future(call.read())
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
            return _ReadSentinel.CANCELLED
        response = response_task.result()
        if response is _GRPC_EOF:
            return _ReadSentinel.EOF
        return cast(contract.AgentRuntimeTaskEvent, response)
    except asyncio.CancelledError:
        call.cancel()
        if not response_task.done():
            response_task.cancel()
        with suppress(asyncio.CancelledError, grpc.aio.AioRpcError):
            await response_task
        raise
    finally:
        if not cancellation_task.done():
            cancellation_task.cancel()
        with suppress(asyncio.CancelledError):
            await cancellation_task
