"""Loopback-only gRPC contract tests for the Pipecat sidecar."""

from __future__ import annotations

import grpc
import pytest

from pipecat_runtime.adapters.grpc.generated import conversation_runtime_pb2 as contract
from pipecat_runtime.adapters.grpc.generated import conversation_runtime_pb2_grpc
from pipecat_runtime.adapters.pipecat.processors import DeterministicPipelineOptions
from pipecat_runtime.composition.bootstrap import create_grpc_server
from tests.support import BEARER_TOKEN, deterministic_runtime_settings, start_message


def _authorization_metadata() -> tuple[tuple[str, str], ...]:
    return (("authorization", f"Bearer {BEARER_TOKEN}"),)


async def _read_messages(
    call: grpc.aio.StreamStreamCall[
        contract.ConversationRuntimeClientMessage,
        contract.ConversationRuntimeServerMessage,
    ],
) -> list[contract.ConversationRuntimeServerMessage]:
    messages: list[contract.ConversationRuntimeServerMessage] = []
    while True:
        response = await call.read()
        if not isinstance(response, contract.ConversationRuntimeServerMessage):
            return messages
        messages.append(response)


async def test_health_requires_bearer_authentication() -> None:
    """Health is private and reports an authenticated serving sidecar."""
    server, port = create_grpc_server(deterministic_runtime_settings(), bind_port=0)
    await server.start()
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
            client = conversation_runtime_pb2_grpc.ConversationRuntimeServiceStub(channel)
            with pytest.raises(grpc.aio.AioRpcError) as error:
                await client.CheckHealth(contract.ConversationRuntimeHealthRequest(service="test"))
            assert error.value.code() is grpc.StatusCode.UNAUTHENTICATED

            health = await client.CheckHealth(
                contract.ConversationRuntimeHealthRequest(service="test"),
                metadata=_authorization_metadata(),
            )
            assert health.status == contract.ConversationRuntimeHealthResponse.STATUS_SERVING
            assert health.runtime_name == "pipecat-runtime"
    finally:
        await server.stop(0)


async def test_converse_streams_ordered_contract_events() -> None:
    """The bidirectional contract streams all normal events in order after StartTurn."""
    server, port = create_grpc_server(deterministic_runtime_settings(), bind_port=0)
    await server.start()
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
            client = conversation_runtime_pb2_grpc.ConversationRuntimeServiceStub(channel)
            call = client.Converse(metadata=_authorization_metadata())
            await call.write(start_message())
            await call.done_writing()

            messages = await _read_messages(call)

            assert [message.event_sequence for message in messages] == list(range(len(messages)))
            assert [message.WhichOneof("payload") for message in messages] == [
                "accepted",
                "text_delta",
                "text_delta",
                "audio_start",
                "audio_chunk",
                "audio_chunk",
                "audio_chunk",
                "audio_chunk",
                "audio_chunk",
                "audio_end",
                "usage",
                "completed",
            ]
            audio_chunks = [
                message.audio_chunk for message in messages if message.HasField("audio_chunk")
            ]
            assert all(
                chunk.format == contract.CONVERSATION_AUDIO_FORMAT_PCM_S16LE
                for chunk in audio_chunks
            )
            assert all(
                chunk.sample_rate_hz == 48_000 and chunk.channels == 1 for chunk in audio_chunks
            )
            assert all(
                0 < len(chunk.pcm) <= 19_200 and len(chunk.pcm) % 2 == 0 for chunk in audio_chunks
            )
    finally:
        await server.stop(0)


async def test_converse_cancellation_interrupts_the_active_attempt() -> None:
    """A matching CancelTurn interrupts a delayed stream with a cancellation terminal state."""
    server, port = create_grpc_server(
        deterministic_runtime_settings(
            DeterministicPipelineOptions(
                response_chunks=("Первый фрагмент. ", "Второй фрагмент."),
                text_delay_seconds=0.5,
            )
        ),
        bind_port=0,
    )
    await server.start()
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
            client = conversation_runtime_pb2_grpc.ConversationRuntimeServiceStub(channel)
            call = client.Converse(metadata=_authorization_metadata())
            await call.write(start_message())
            accepted = await call.read()
            assert isinstance(accepted, contract.ConversationRuntimeServerMessage)
            assert accepted.WhichOneof("payload") == "accepted"

            await call.write(
                contract.ConversationRuntimeClientMessage(
                    schema_version=1,
                    cancel_turn=contract.ConversationCancelTurn(
                        turn_id=accepted.turn_id,
                        attempt_id=accepted.attempt_id,
                        reason=contract.CONVERSATION_CANCELLATION_REASON_BARGE_IN,
                    ),
                )
            )
            await call.done_writing()

            messages = [accepted, *await _read_messages(call)]

            assert messages[-1].WhichOneof("payload") == "cancelled"
            assert (
                messages[-1].cancelled.reason == contract.CONVERSATION_CANCELLATION_REASON_BARGE_IN
            )
            assert [message.event_sequence for message in messages] == list(range(len(messages)))
    finally:
        await server.stop(0)


async def test_converse_rejects_a_stream_without_start_turn() -> None:
    """The contract requires StartTurn as the first client message."""
    server, port = create_grpc_server(deterministic_runtime_settings(), bind_port=0)
    await server.start()
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
            client = conversation_runtime_pb2_grpc.ConversationRuntimeServiceStub(channel)
            call = client.Converse(metadata=_authorization_metadata())
            await call.write(
                contract.ConversationRuntimeClientMessage(
                    schema_version=1,
                    cancel_turn=contract.ConversationCancelTurn(
                        turn_id="turn-1",
                        attempt_id="attempt-1",
                        reason=contract.CONVERSATION_CANCELLATION_REASON_BARGE_IN,
                    ),
                )
            )
            await call.done_writing()

            with pytest.raises(grpc.aio.AioRpcError) as error:
                await call.read()
            assert error.value.code() is grpc.StatusCode.INVALID_ARGUMENT
    finally:
        await server.stop(0)
