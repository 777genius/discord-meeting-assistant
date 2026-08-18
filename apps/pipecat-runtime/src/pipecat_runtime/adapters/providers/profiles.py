"""Pipecat provider profiles assembled without leaking provider types to application code."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from pipecat.processors.frame_processor import FrameProcessor
    from pipecat.transcriptions.language import Language

from pipecat_runtime.adapters.pipecat.processors import (
    ConversationTextCaptureProcessor,
    DeterministicLLMProcessor,
    DeterministicPipelineOptions,
    FixtureSpeechTTSProcessor,
)
from pipecat_runtime.adapters.pipecat.text_generation import (
    LiteralSpeechProcessor,
    StreamingSubscriptionRuntimeTextGenerationProcessor,
)
from pipecat_runtime.adapters.providers.piper_http import PiperHttpTTSProcessor
from pipecat_runtime.application.models import StartTurn
from pipecat_runtime.application.ports import (
    CancellationSignal,
    StreamingConversationTextGenerationPort,
)
from pipecat_runtime.assets.deterministic_speech import deterministic_russian_speech_pcm


class RuntimeEnvironment(StrEnum):
    """Environment values relevant to safe profile selection."""

    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


class RuntimeProfileName(StrEnum):
    """Supported composition-time provider bundles."""

    DETERMINISTIC_E2E = "deterministic-e2e"
    LOCAL_RUSSIAN = "local-russian"
    ELEVENLABS_MULTILINGUAL = "elevenlabs-multilingual"
    ELEVENLABS_RUSSIAN = "elevenlabs-russian"


class ElevenLabsTTSModel(StrEnum):
    """Qualified multilingual models selectable without changing application code."""

    FLASH_V2_5 = "eleven_flash_v2_5"
    MULTILINGUAL_V2 = "eleven_multilingual_v2"


class ProfileConfigurationError(ValueError):
    """Raised when selected provider composition cannot safely start."""


@dataclass(frozen=True, slots=True)
class TtsRuntimeIdentity:
    """Exact TTS implementation selected by runtime composition."""

    provider: str
    model: str
    voice: str


class ConversationPipelineProfile(Protocol):
    """Build Pipecat-only processors for one preconfigured voice profile."""

    @property
    def profile_id(self) -> str:
        """Return the only request voice profile this composition accepts."""
        ...

    @property
    def tts_identity(self) -> TtsRuntimeIdentity:
        """Return the concrete runtime-selected TTS identity."""
        ...

    def create_processors(
        self,
        request: StartTurn,
        cancellation_requested: CancellationSignal,
    ) -> Sequence[FrameProcessor]:
        """Build providers lazily for one isolated stateless request."""
        ...


@dataclass(frozen=True, slots=True)
class RuntimeProfileSettings:
    """Composition-only settings for all supported local and cloud profiles."""

    environment: RuntimeEnvironment
    profile_name: RuntimeProfileName
    profile_id: str
    deterministic: DeterministicPipelineOptions = field(
        default_factory=DeterministicPipelineOptions
    )
    ollama_base_url: str = "http://127.0.0.1:11434/v1"
    ollama_model: str = "qwen3:8b"
    piper_base_url: str = "http://127.0.0.1:5000"
    piper_voice_id: str = "ru_RU-irina-medium"
    elevenlabs_api_key: str | None = None
    elevenlabs_model: ElevenLabsTTSModel = ElevenLabsTTSModel.FLASH_V2_5
    elevenlabs_voice_id: str | None = None

    def __post_init__(self) -> None:
        if not self.profile_id.strip():
            raise ProfileConfigurationError("voice profile id is required")


def create_profile(
    settings: RuntimeProfileSettings,
    *,
    text_generator: StreamingConversationTextGenerationPort | None = None,
) -> ConversationPipelineProfile:
    """Select a concrete adapter bundle while preventing fake providers in production."""
    match settings.profile_name:
        case RuntimeProfileName.DETERMINISTIC_E2E:
            if settings.environment is RuntimeEnvironment.PRODUCTION:
                raise ProfileConfigurationError("deterministic-e2e is prohibited in production")
            return DeterministicE2EProfile(settings.profile_id, settings.deterministic)
        case RuntimeProfileName.LOCAL_RUSSIAN:
            return LocalRussianProfile(
                profile_id=settings.profile_id,
                ollama_base_url=settings.ollama_base_url,
                ollama_model=settings.ollama_model,
                piper_base_url=settings.piper_base_url,
                piper_voice_id=settings.piper_voice_id,
            )
        case (
            RuntimeProfileName.ELEVENLABS_MULTILINGUAL
            | RuntimeProfileName.ELEVENLABS_RUSSIAN
        ):
            api_key = settings.elevenlabs_api_key
            voice_id = settings.elevenlabs_voice_id
            if not api_key or not voice_id or text_generator is None:
                raise ProfileConfigurationError(
                    "ElevenLabs profile requires an API key, voice id, and text generator"
                )
            return ElevenLabsMultilingualProfile(
                profile_id=settings.profile_id,
                api_key=api_key,
                model=settings.elevenlabs_model,
                voice_id=voice_id,
                text_generator=text_generator,
            )
    raise ProfileConfigurationError("unsupported runtime profile")


@dataclass(frozen=True, slots=True)
class DeterministicE2EProfile:
    """Test-only streaming fake LLM and fixture speech behind real Pipecat processors."""

    profile_id: str
    options: DeterministicPipelineOptions

    @property
    def tts_identity(self) -> TtsRuntimeIdentity:
        return TtsRuntimeIdentity(
            provider="fixture",
            model="deterministic-speech-v1",
            voice="deterministic-russian-v1",
        )

    def create_processors(
        self,
        request: StartTurn,
        cancellation_requested: CancellationSignal,
    ) -> Sequence[FrameProcessor]:
        """Build providerless processors without external network or model side effects."""
        del request
        return (
            LiteralSpeechProcessor(cancellation_requested=cancellation_requested),
            DeterministicLLMProcessor(
                options=self.options,
                cancellation_requested=cancellation_requested,
            ),
            ConversationTextCaptureProcessor(),
            FixtureSpeechTTSProcessor(
                options=self.options,
                fixture_pcm=deterministic_russian_speech_pcm(),
                cancellation_requested=cancellation_requested,
            ),
        )


@dataclass(frozen=True, slots=True)
class LocalRussianProfile:
    """Ollama plus an existing Piper HTTP service with no model provisioning side effects."""

    profile_id: str
    ollama_base_url: str
    ollama_model: str
    piper_base_url: str
    piper_voice_id: str

    @property
    def tts_identity(self) -> TtsRuntimeIdentity:
        return TtsRuntimeIdentity(
            provider="piper",
            model="piper-http",
            voice=self.piper_voice_id,
        )

    def create_processors(
        self,
        request: StartTurn,
        cancellation_requested: CancellationSignal,
    ) -> Sequence[FrameProcessor]:
        """Construct Pipecat providers but never start them until a real turn executes."""
        del request
        from pipecat.services.ollama.llm import OLLamaLLMService

        from pipecat_runtime.adapters.providers.prompt_context import PromptToContextProcessor

        llm = OLLamaLLMService(
            base_url=self.ollama_base_url,
            settings=OLLamaLLMService.Settings(model=self.ollama_model),
        )
        return (
            LiteralSpeechProcessor(cancellation_requested=cancellation_requested),
            PromptToContextProcessor(),
            llm,
            ConversationTextCaptureProcessor(),
            PiperHttpTTSProcessor(
                base_url=self.piper_base_url,
                voice_id=self.piper_voice_id,
                cancellation_requested=cancellation_requested,
            ),
        )


@dataclass(frozen=True, slots=True)
class ElevenLabsMultilingualProfile:
    """Subscription Runtime text generation plus configured multilingual ElevenLabs speech."""

    profile_id: str
    api_key: str
    model: ElevenLabsTTSModel
    voice_id: str
    text_generator: StreamingConversationTextGenerationPort

    @property
    def tts_identity(self) -> TtsRuntimeIdentity:
        return TtsRuntimeIdentity(
            provider="elevenlabs",
            model=self.model.value,
            voice=self.voice_id,
        )

    def create_processors(
        self,
        request: StartTurn,
        cancellation_requested: CancellationSignal,
    ) -> Sequence[FrameProcessor]:
        """Create one stateless text-to-speech pipeline without opening a provider socket."""
        from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
        from pipecat.services.tts_service import TextAggregationMode

        tts = ElevenLabsTTSService(
            api_key=self.api_key,
            sample_rate=48_000,
            auto_mode=True,
            text_aggregation_mode=TextAggregationMode.TOKEN,
            settings=ElevenLabsTTSService.Settings(
                model=self.model.value,
                voice=self.voice_id,
                language=elevenlabs_language_for_locale(request.locale),
            ),
        )
        return (
            LiteralSpeechProcessor(cancellation_requested=cancellation_requested),
            StreamingSubscriptionRuntimeTextGenerationProcessor(
                text_generator=self.text_generator,
                cancellation_requested=cancellation_requested,
            ),
            ConversationTextCaptureProcessor(),
            tts,
        )


ElevenLabsRussianProfile = ElevenLabsMultilingualProfile


def elevenlabs_language_for_locale(locale: str) -> Language | None:
    """Map BCP-47-like input to Pipecat language metadata without forcing an auto locale."""
    from pipecat.transcriptions.language import Language

    normalized = locale.strip().replace("_", "-")
    if not normalized or normalized.casefold() == "auto":
        return None
    normalized_folded = normalized.casefold()
    for language in Language:
        if language.value.casefold() == normalized_folded:
            return language
    base = normalized_folded.split("-", maxsplit=1)[0]
    return next((language for language in Language if language.value.casefold() == base), None)
