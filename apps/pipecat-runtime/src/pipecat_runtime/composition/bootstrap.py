"""Concrete sidecar composition kept outside application and adapter layers."""

from __future__ import annotations

import grpc

from pipecat_runtime.adapters.grpc.auth import BearerTokenAuthenticator
from pipecat_runtime.adapters.grpc.generated import conversation_runtime_pb2_grpc
from pipecat_runtime.adapters.grpc.servicer import ConversationRuntimeGrpcServicer
from pipecat_runtime.adapters.pipecat.runtime import PipecatConversationRuntime
from pipecat_runtime.adapters.providers.profiles import create_profile
from pipecat_runtime.adapters.subscription_runtime.text_generation import (
    SubscriptionRuntimeTextGenerationAdapter,
)
from pipecat_runtime.composition.settings import RuntimeSettings


def create_grpc_server(
    settings: RuntimeSettings,
    *,
    bind_host: str | None = None,
    bind_port: int | None = None,
) -> tuple[grpc.aio.Server, int]:
    """Compose a private gRPC server without starting it or making provider calls."""
    text_generator = (
        None
        if settings.subscription_runtime is None
        else SubscriptionRuntimeTextGenerationAdapter(settings.subscription_runtime)
    )
    profile = create_profile(settings.profile, text_generator=text_generator)
    runtime = PipecatConversationRuntime(
        profile=profile,
        maximum_pending_events=settings.maximum_pending_events,
    )
    servicer = ConversationRuntimeGrpcServicer(
        runtime=runtime,
        authenticator=BearerTokenAuthenticator(settings.bearer_token),
    )
    server = grpc.aio.server(
        options=(
            ("grpc.max_receive_message_length", 1_048_576),
            ("grpc.max_send_message_length", 1_048_576),
        )
    )
    conversation_runtime_pb2_grpc.add_ConversationRuntimeServiceServicer_to_server(servicer, server)
    host = bind_host if bind_host is not None else settings.bind_host
    port = bind_port if bind_port is not None else settings.bind_port
    resolved_port = server.add_insecure_port(f"{host}:{port}")
    if resolved_port == 0:
        raise RuntimeError("unable to bind Pipecat runtime gRPC listener")
    return server, resolved_port


async def serve(settings: RuntimeSettings) -> None:
    """Run the configured sidecar until its process receives shutdown."""
    server, _ = create_grpc_server(settings)
    await server.start()
    try:
        await server.wait_for_termination()
    finally:
        await server.stop(grace=5)
