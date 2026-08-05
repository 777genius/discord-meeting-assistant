"""Profile factories and fail-closed secret configuration tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from pipecat_runtime.adapters.providers.profiles import (
    ElevenLabsMultilingualProfile,
    ElevenLabsTTSModel,
    LocalRussianProfile,
    ProfileConfigurationError,
    RuntimeEnvironment,
    RuntimeProfileName,
    RuntimeProfileSettings,
    create_profile,
    elevenlabs_language_for_locale,
)
from pipecat_runtime.application.models import TextGenerationRequest, TextGenerationResult
from pipecat_runtime.application.ports import CancellationSignal
from pipecat_runtime.composition.settings import RuntimeConfigurationError, RuntimeSettings


class _FakeTextGenerator:
    async def generate(
        self,
        request: TextGenerationRequest,
        *,
        cancellation_requested: CancellationSignal,
    ) -> TextGenerationResult:
        del request
        del cancellation_requested
        raise AssertionError("test profile factory must not generate text")


def test_deterministic_profile_is_rejected_in_production() -> None:
    """Fake providers cannot be selected by a production composition."""
    with pytest.raises(ProfileConfigurationError):
        create_profile(
            RuntimeProfileSettings(
                environment=RuntimeEnvironment.PRODUCTION,
                profile_name=RuntimeProfileName.DETERMINISTIC_E2E,
                profile_id="deterministic-e2e",
            )
        )


def test_local_russian_factory_does_not_start_or_download_models() -> None:
    """Factory selection is pure and merely retains external service configuration."""
    profile = create_profile(
        RuntimeProfileSettings(
            environment=RuntimeEnvironment.TEST,
            profile_name=RuntimeProfileName.LOCAL_RUSSIAN,
            profile_id="local-russian",
            ollama_base_url="http://127.0.0.1:11434/v1",
            ollama_model="qwen3:8b",
            piper_base_url="http://127.0.0.1:5000",
            piper_voice_id="ru_RU-irina-medium",
        )
    )

    assert isinstance(profile, LocalRussianProfile)
    assert profile.ollama_model == "qwen3:8b"
    assert profile.piper_voice_id == "ru_RU-irina-medium"


def test_elevenlabs_secret_file_is_required_only_when_selected(tmp_path: Path) -> None:
    """ElevenLabs configuration reads its API key from a file and fails closed when absent."""
    bearer_file = tmp_path / "bearer-token"
    bearer_file.write_text("bearer-secret\n", encoding="utf-8")
    selected_environment = {
        "PIPECAT_RUNTIME_BEARER_TOKEN_FILE": str(bearer_file),
        "PIPECAT_RUNTIME_PROFILE": "elevenlabs-multilingual",
        "PIPECAT_RUNTIME_ELEVENLABS_VOICE_ID": "voice-123",
    }

    with pytest.raises(RuntimeConfigurationError):
        RuntimeSettings.from_environment(selected_environment)

    elevenlabs_file = tmp_path / "elevenlabs-token"
    elevenlabs_file.write_text("eleven-secret\n", encoding="utf-8")
    runtime_token_file = tmp_path / "subscription-runtime-token"
    runtime_token_file.write_text("subscription-runtime-test-token\n", encoding="utf-8")
    settings = RuntimeSettings.from_environment(
        {
            **selected_environment,
            "PIPECAT_RUNTIME_ELEVENLABS_API_KEY_FILE": str(elevenlabs_file),
            "PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_ADDRESS": "127.0.0.1:50052",
            "PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE": str(runtime_token_file),
            "PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_TIMEOUT_MS": "15000",
        }
    )
    profile = create_profile(settings.profile, text_generator=_FakeTextGenerator())

    assert isinstance(profile, ElevenLabsMultilingualProfile)
    assert profile.api_key == "eleven-secret"
    assert profile.model is ElevenLabsTTSModel.FLASH_V2_5
    assert profile.voice_id == "voice-123"
    assert settings.subscription_runtime is not None
    assert settings.subscription_runtime.address == "127.0.0.1:50052"
    assert settings.subscription_runtime.timeout_ms == 15_000


def test_elevenlabs_model_is_an_exact_configurable_allowlist(tmp_path: Path) -> None:
    """Composition can trade latency for quality without accepting arbitrary model IDs."""
    bearer_file = tmp_path / "bearer-token"
    bearer_file.write_text("bearer-secret\n", encoding="utf-8")
    elevenlabs_file = tmp_path / "elevenlabs-token"
    elevenlabs_file.write_text("eleven-secret\n", encoding="utf-8")
    runtime_token_file = tmp_path / "runtime-token"
    runtime_token_file.write_text("runtime-test-secret\n", encoding="utf-8")
    environment = {
        "PIPECAT_RUNTIME_BEARER_TOKEN_FILE": str(bearer_file),
        "PIPECAT_RUNTIME_PROFILE": "elevenlabs-multilingual",
        "PIPECAT_RUNTIME_ELEVENLABS_API_KEY_FILE": str(elevenlabs_file),
        "PIPECAT_RUNTIME_ELEVENLABS_VOICE_ID": "voice-123",
        "PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_ADDRESS": "127.0.0.1:50052",
        "PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE": str(runtime_token_file),
        "PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_TIMEOUT_MS": "15000",
    }

    quality = RuntimeSettings.from_environment(
        {**environment, "PIPECAT_RUNTIME_ELEVENLABS_MODEL": "eleven_multilingual_v2"}
    )
    assert quality.profile.elevenlabs_model is ElevenLabsTTSModel.MULTILINGUAL_V2

    with pytest.raises(RuntimeConfigurationError):
        RuntimeSettings.from_environment(
            {**environment, "PIPECAT_RUNTIME_ELEVENLABS_MODEL": "unqualified-model"}
        )


def test_elevenlabs_locale_mapping_keeps_auto_provider_selected() -> None:
    """Locale parsing supports Russian, English, enum variants, base fallback, and auto."""
    from pipecat.transcriptions.language import Language

    assert elevenlabs_language_for_locale("ru") is Language.RU
    assert elevenlabs_language_for_locale("en_US") is Language.EN_US
    assert elevenlabs_language_for_locale("ru-KZ") is Language.RU
    assert elevenlabs_language_for_locale("auto") is None


def test_settings_reject_empty_bearer_secret_file(tmp_path: Path) -> None:
    """The sidecar never starts with an empty authentication secret."""
    bearer_file = tmp_path / "empty-bearer-token"
    bearer_file.write_text("\n", encoding="utf-8")

    with pytest.raises(RuntimeConfigurationError):
        RuntimeSettings.from_environment({"PIPECAT_RUNTIME_BEARER_TOKEN_FILE": str(bearer_file)})
