"""Fail-closed environment configuration for the Pipecat sidecar."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from pipecat_runtime.adapters.pipecat.processors import (
    DeterministicFailurePoint,
    DeterministicPipelineOptions,
)
from pipecat_runtime.adapters.providers.profiles import (
    ElevenLabsTTSModel,
    RuntimeEnvironment,
    RuntimeProfileName,
    RuntimeProfileSettings,
)
from pipecat_runtime.adapters.subscription_runtime.text_generation import (
    SubscriptionRuntimeTextGenerationSettings,
)


class RuntimeConfigurationError(ValueError):
    """Raised when sidecar composition cannot be configured safely."""


@dataclass(frozen=True, slots=True)
class RuntimeSettings:
    """All concrete values required to compose one local gRPC sidecar."""

    bearer_token: str
    profile: RuntimeProfileSettings
    bind_host: str
    bind_port: int
    maximum_pending_events: int
    deployment: str = "local-unqualified"
    source_revision: str = "local-unqualified"
    subscription_runtime: SubscriptionRuntimeTextGenerationSettings | None = None

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None) -> RuntimeSettings:
        """Read only the selected profile's secrets and reject malformed configuration."""
        values = os.environ if environment is None else environment
        runtime_environment = _enum_value(
            RuntimeEnvironment,
            values.get("PIPECAT_RUNTIME_ENVIRONMENT", RuntimeEnvironment.DEVELOPMENT.value),
            "PIPECAT_RUNTIME_ENVIRONMENT",
        )
        profile_name = _enum_value(
            RuntimeProfileName,
            values.get("PIPECAT_RUNTIME_PROFILE", RuntimeProfileName.DETERMINISTIC_E2E.value),
            "PIPECAT_RUNTIME_PROFILE",
        )
        profile_id = values.get("PIPECAT_RUNTIME_PROFILE_ID", profile_name.value)
        subscription_runtime = _subscription_runtime_settings(values, profile_name)
        bearer_token = _read_secret_file(
            _required(values, "PIPECAT_RUNTIME_BEARER_TOKEN_FILE"),
            "PIPECAT_RUNTIME_BEARER_TOKEN_FILE",
        )
        elevenlabs_api_key = _elevenlabs_api_key(values, profile_name)
        elevenlabs_voice_id = (
            _required(values, "PIPECAT_RUNTIME_ELEVENLABS_VOICE_ID")
            if _uses_subscription_runtime(profile_name)
            else None
        )
        return cls(
            bearer_token=bearer_token,
            deployment=_non_empty(
                values.get("PIPECAT_RUNTIME_DEPLOYMENT", "local-unqualified"),
                "PIPECAT_RUNTIME_DEPLOYMENT",
            ),
            profile=RuntimeProfileSettings(
                environment=runtime_environment,
                profile_name=profile_name,
                profile_id=profile_id,
                deterministic=_deterministic_options(values),
                ollama_base_url=values.get(
                    "PIPECAT_RUNTIME_OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1"
                ),
                ollama_model=values.get("PIPECAT_RUNTIME_OLLAMA_MODEL", "qwen3:8b"),
                piper_base_url=values.get(
                    "PIPECAT_RUNTIME_PIPER_BASE_URL", "http://127.0.0.1:5000"
                ),
                piper_voice_id=values.get("PIPECAT_RUNTIME_PIPER_VOICE_ID", "ru_RU-irina-medium"),
                elevenlabs_api_key=elevenlabs_api_key,
                elevenlabs_model=_enum_value(
                    ElevenLabsTTSModel,
                    values.get(
                        "PIPECAT_RUNTIME_ELEVENLABS_MODEL",
                        ElevenLabsTTSModel.FLASH_V2_5.value,
                    ),
                    "PIPECAT_RUNTIME_ELEVENLABS_MODEL",
                ),
                elevenlabs_voice_id=elevenlabs_voice_id,
            ),
            bind_host=_non_empty(
                values.get("PIPECAT_RUNTIME_BIND_HOST", "127.0.0.1"),
                "PIPECAT_RUNTIME_BIND_HOST",
            ),
            bind_port=_integer(
                values.get("PIPECAT_RUNTIME_BIND_PORT", "50051"),
                "PIPECAT_RUNTIME_BIND_PORT",
                minimum=1,
                maximum=65_535,
            ),
            maximum_pending_events=_integer(
                values.get("PIPECAT_RUNTIME_MAXIMUM_PENDING_EVENTS", "64"),
                "PIPECAT_RUNTIME_MAXIMUM_PENDING_EVENTS",
                minimum=1,
                maximum=1_024,
            ),
            source_revision=_non_empty(
                values.get("PIPECAT_RUNTIME_SOURCE_REVISION", "local-unqualified"),
                "PIPECAT_RUNTIME_SOURCE_REVISION",
            ),
            subscription_runtime=subscription_runtime,
        )


def _elevenlabs_api_key(
    values: Mapping[str, str],
    profile_name: RuntimeProfileName,
) -> str | None:
    if not _uses_subscription_runtime(profile_name):
        return None
    return _read_secret_file(
        _required(values, "PIPECAT_RUNTIME_ELEVENLABS_API_KEY_FILE"),
        "PIPECAT_RUNTIME_ELEVENLABS_API_KEY_FILE",
    )


def _subscription_runtime_settings(
    values: Mapping[str, str],
    profile_name: RuntimeProfileName,
) -> SubscriptionRuntimeTextGenerationSettings | None:
    if not _uses_subscription_runtime(profile_name):
        return None
    try:
        return SubscriptionRuntimeTextGenerationSettings(
            address=_required(values, "PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_ADDRESS"),
            service_token=_read_secret_file(
                _required(values, "PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE"),
                "PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE",
            ),
            timeout_ms=_integer(
                _required(values, "PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_TIMEOUT_MS"),
                "PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_TIMEOUT_MS",
                minimum=1,
                maximum=600_000,
            ),
        )
    except ValueError as error:
        raise RuntimeConfigurationError("Subscription Runtime configuration is invalid") from error


def _uses_subscription_runtime(profile_name: RuntimeProfileName) -> bool:
    return profile_name in {
        RuntimeProfileName.ELEVENLABS_MULTILINGUAL,
        RuntimeProfileName.ELEVENLABS_RUSSIAN,
    }


def _deterministic_options(values: Mapping[str, str]) -> DeterministicPipelineOptions:
    chunks = tuple(
        chunk.strip()
        for chunk in values.get(
            "PIPECAT_RUNTIME_DETERMINISTIC_RESPONSE_CHUNKS",
            "Ботик слушает. |Чем могу помочь?",
        ).split("|")
        if chunk.strip()
    )
    try:
        failure_point = DeterministicFailurePoint(
            values.get(
                "PIPECAT_RUNTIME_DETERMINISTIC_FAILURE_POINT",
                DeterministicFailurePoint.NONE.value,
            )
        )
    except ValueError as error:
        raise RuntimeConfigurationError(
            "PIPECAT_RUNTIME_DETERMINISTIC_FAILURE_POINT is invalid"
        ) from error
    try:
        return DeterministicPipelineOptions(
            response_chunks=chunks,
            text_delay_seconds=_milliseconds(
                values.get("PIPECAT_RUNTIME_DETERMINISTIC_TEXT_DELAY_MS", "0"),
                "PIPECAT_RUNTIME_DETERMINISTIC_TEXT_DELAY_MS",
            ),
            audio_delay_seconds=_milliseconds(
                values.get("PIPECAT_RUNTIME_DETERMINISTIC_AUDIO_DELAY_MS", "0"),
                "PIPECAT_RUNTIME_DETERMINISTIC_AUDIO_DELAY_MS",
            ),
            audio_chunk_bytes=_integer(
                values.get("PIPECAT_RUNTIME_DETERMINISTIC_AUDIO_CHUNK_BYTES", "4800"),
                "PIPECAT_RUNTIME_DETERMINISTIC_AUDIO_CHUNK_BYTES",
                minimum=2,
                maximum=19_200,
            ),
            failure_point=failure_point,
        )
    except ValueError as error:
        raise RuntimeConfigurationError("deterministic profile configuration is invalid") from error


def _enum_value[T: RuntimeEnvironment | RuntimeProfileName | ElevenLabsTTSModel](
    enum_type: type[T],
    value: str,
    variable_name: str,
) -> T:
    try:
        return enum_type(value)
    except ValueError as error:
        raise RuntimeConfigurationError(f"{variable_name} is invalid") from error


def _required(values: Mapping[str, str], variable_name: str) -> str:
    value = values.get(variable_name)
    if value is None:
        raise RuntimeConfigurationError(f"{variable_name} is required")
    return _non_empty(value, variable_name)


def _non_empty(value: str, variable_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise RuntimeConfigurationError(f"{variable_name} must not be empty")
    return normalized


def _read_secret_file(file_name: str, variable_name: str) -> str:
    try:
        secret = Path(file_name).read_text(encoding="utf-8").strip()
    except OSError as error:
        raise RuntimeConfigurationError(f"{variable_name} cannot be read") from error
    if not secret:
        raise RuntimeConfigurationError(f"{variable_name} must point to a non-empty file")
    return secret


def _integer(value: str, variable_name: str, *, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise RuntimeConfigurationError(f"{variable_name} must be an integer") from error
    if not minimum <= parsed <= maximum:
        raise RuntimeConfigurationError(f"{variable_name} is outside the supported range")
    return parsed


def _milliseconds(value: str, variable_name: str) -> float:
    try:
        milliseconds = float(value)
    except ValueError as error:
        raise RuntimeConfigurationError(f"{variable_name} must be numeric") from error
    if milliseconds < 0:
        raise RuntimeConfigurationError(f"{variable_name} must not be negative")
    return milliseconds / 1_000
