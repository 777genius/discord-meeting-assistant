"""A Pipecat processor for an externally managed Piper HTTP service."""

from __future__ import annotations

import wave
from collections.abc import AsyncGenerator
from io import BytesIO
from typing import Any, cast

import aiohttp
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
from pipecat.services.tts_service import TextAggregationMode, TTSService

from pipecat_runtime.application.ports import CancellationSignal

# Pipecat 1.7.0's abstract method metadata models run_tts as a coroutine even
# though its runtime and built-in providers require an async generator.
_PipecatTTSService = cast(Any, TTSService)

_MAXIMUM_PIPER_RESPONSE_BYTES = 32 * 1024 * 1024
_MAXIMUM_PIPER_PCM_BYTES = 24 * 1024 * 1024
_MAXIMUM_PIPER_DURATION_SECONDS = 120


class PiperHttpTTSProcessor(_PipecatTTSService):
    """Sentence-aggregating TTS service backed by an externally managed Piper HTTP process."""

    def __init__(
        self,
        *,
        base_url: str,
        voice_id: str,
        cancellation_requested: CancellationSignal,
    ) -> None:
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            text_aggregation_mode=TextAggregationMode.SENTENCE,
        )
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("Piper HTTP base_url must use HTTP or HTTPS")
        if not voice_id.strip():
            raise ValueError("Piper voice_id is required")
        self._base_url = base_url.rstrip("/")
        self._voice_id = voice_id
        self._cancellation_requested = cancellation_requested
        self._session: aiohttp.ClientSession | None = None

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None]:
        """Synthesize one Pipecat-aggregated sentence instead of one request per LLM token."""
        if self._cancellation_requested.is_set():
            return
        try:
            pcm, sample_rate_hz, channels = await self._synthesize(text)
        except (aiohttp.ClientError, TimeoutError, wave.Error, ValueError):
            yield ErrorFrame(error="Piper HTTP synthesis failed", fatal=True)
            return
        if not self._cancellation_requested.is_set():
            yield TTSAudioRawFrame(
                audio=pcm,
                sample_rate=sample_rate_hz,
                num_channels=channels,
                context_id=context_id,
            )

    async def cleanup(self) -> None:
        """Close only the lazily created local HTTP client."""
        if self._session is not None:
            await self._session.close()
            self._session = None
        await super().cleanup()

    async def _synthesize(self, text: str) -> tuple[bytes, int, int]:
        session = self._session
        if session is None:
            session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20))
            self._session = session
        async with session.post(
            self._base_url,
            json={"text": text, "voice": self._voice_id},
            headers={"Content-Type": "application/json"},
        ) as response:
            response.raise_for_status()
            wav_bytes = await read_bounded_piper_response(response)
        return _read_wav_pcm(wav_bytes)


async def read_bounded_piper_response(response: aiohttp.ClientResponse) -> bytes:
    content_length = response.content_length
    if content_length is not None and content_length > _MAXIMUM_PIPER_RESPONSE_BYTES:
        response.close()
        raise ValueError("Piper HTTP response exceeds the byte limit")
    body = bytearray()
    async for chunk in response.content.iter_chunked(64 * 1024):
        if len(body) + len(chunk) > _MAXIMUM_PIPER_RESPONSE_BYTES:
            response.close()
            raise ValueError("Piper HTTP response exceeds the byte limit")
        body.extend(chunk)
    return bytes(body)


def _read_wav_pcm(wav_bytes: bytes) -> tuple[bytes, int, int]:
    """Extract uncompressed signed 16-bit PCM from a Piper HTTP WAV response."""
    with wave.open(BytesIO(wav_bytes), "rb") as wav_file:
        if wav_file.getcomptype() != "NONE" or wav_file.getsampwidth() != 2:
            raise ValueError("Piper HTTP response must be uncompressed 16-bit PCM WAV")
        channels = wav_file.getnchannels()
        sample_rate_hz = wav_file.getframerate()
        frame_count = wav_file.getnframes()
        expected_pcm_bytes = frame_count * channels * 2
        if (
            expected_pcm_bytes > _MAXIMUM_PIPER_PCM_BYTES
            or frame_count > sample_rate_hz * _MAXIMUM_PIPER_DURATION_SECONDS
        ):
            raise ValueError("Piper HTTP response exceeds the decoded audio limit")
        pcm = wav_file.readframes(frame_count)
    if not pcm:
        raise ValueError("Piper HTTP response contained no PCM audio")
    if len(pcm) > _MAXIMUM_PIPER_PCM_BYTES:
        raise ValueError("Piper HTTP response exceeds the decoded audio limit")
    return pcm, sample_rate_hz, channels
