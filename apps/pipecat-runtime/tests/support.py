"""Test-only constructors that never start external providers."""

from __future__ import annotations

from pipecat_runtime.adapters.grpc.generated import conversation_runtime_pb2 as contract
from pipecat_runtime.adapters.pipecat.processors import DeterministicPipelineOptions
from pipecat_runtime.adapters.providers.profiles import (
    RuntimeEnvironment,
    RuntimeProfileName,
    RuntimeProfileSettings,
)
from pipecat_runtime.application.models import StartTurn
from pipecat_runtime.composition.settings import RuntimeSettings

BEARER_TOKEN = "test-bearer-token"
PROFILE_ID = "deterministic-e2e"


def sample_start_turn(
    *,
    voice_profile_id: str = PROFILE_ID,
    locale: str = "ru-RU",
) -> StartTurn:
    """Create a valid stateless request fixture."""
    return StartTurn(
        meeting_id="meeting-1",
        recording_id="recording-1",
        turn_id="turn-1",
        speaker_id="speaker-1",
        idempotency_key="idempotency-1",
        system_prompt="You are Botik.",
        prompt="Привет, Ботик.",
        locale=locale,
        voice_profile_id=voice_profile_id,
    )


def deterministic_runtime_settings(
    options: DeterministicPipelineOptions | None = None,
) -> RuntimeSettings:
    """Create loopback-only server settings for deterministic gRPC tests."""
    return RuntimeSettings(
        bearer_token=BEARER_TOKEN,
        profile=RuntimeProfileSettings(
            environment=RuntimeEnvironment.TEST,
            profile_name=RuntimeProfileName.DETERMINISTIC_E2E,
            profile_id=PROFILE_ID,
            deterministic=options or DeterministicPipelineOptions(),
        ),
        bind_host="127.0.0.1",
        bind_port=50_051,
        maximum_pending_events=32,
    )


def start_message() -> contract.ConversationRuntimeClientMessage:
    """Encode the valid first gRPC client message."""
    request = sample_start_turn()
    return contract.ConversationRuntimeClientMessage(
        schema_version=request.schema_version,
        start_turn=contract.ConversationStartTurn(
            meeting_id=request.meeting_id,
            recording_id=request.recording_id,
            turn_id=request.turn_id,
            speaker_id=request.speaker_id,
            idempotency_key=request.idempotency_key,
            system_prompt=request.system_prompt,
            prompt=request.prompt,
            locale=request.locale,
            voice_profile_id=request.voice_profile_id,
        ),
    )
