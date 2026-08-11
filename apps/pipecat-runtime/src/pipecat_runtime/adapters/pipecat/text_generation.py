"""Pipecat processor that obtains one answer through the consumer-owned text port."""

from __future__ import annotations

import time

from pipecat.frames.frames import (
    ErrorFrame,
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from pipecat_runtime.adapters.pipecat.frames import (
    ConversationTurnFrame,
    TextGenerationFailureFrame,
    TextGenerationFirstTokenFrame,
)
from pipecat_runtime.application.models import (
    TextGenerationCancelled,
    TextGenerationCompleted,
    TextGenerationFailed,
    TextGenerationRequest,
    TextGenerationStreamDelta,
)
from pipecat_runtime.application.ports import (
    CancellationSignal,
    ConversationTextGenerationPort,
    StreamingConversationTextGenerationPort,
)
from pipecat_runtime.application.text_chunking import SpeechPhraseChunker


class LiteralSpeechProcessor(FrameProcessor):
    """Route trusted exact speech to TTS without invoking text generation."""

    def __init__(self, *, cancellation_requested: CancellationSignal) -> None:
        super().__init__()
        self._cancellation_requested = cancellation_requested

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if (
            not isinstance(frame, ConversationTurnFrame)
            or direction is not FrameDirection.DOWNSTREAM
            or frame.request.literal_speech is None
        ):
            await self.push_frame(frame, direction)
            return
        if self._cancellation_requested.is_set():
            return
        await self.push_frame(
            TextGenerationFirstTokenFrame(observed_at_unix_ms=time.time_ns() // 1_000_000),
            direction,
        )
        await self.push_frame(LLMFullResponseStartFrame(), direction)
        await self.push_frame(LLMTextFrame(text=frame.request.literal_speech), direction)
        await self.push_frame(LLMFullResponseEndFrame(), direction)


class SubscriptionRuntimeTextGenerationProcessor(FrameProcessor):
    """Convert one completed port response into the standard Pipecat LLM frame flow."""

    def __init__(
        self,
        *,
        text_generator: ConversationTextGenerationPort,
        cancellation_requested: CancellationSignal,
    ) -> None:
        super().__init__()
        self._text_generator = text_generator
        self._cancellation_requested = cancellation_requested

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Generate only when the isolated turn enters the downstream pipeline."""
        await super().process_frame(frame, direction)
        if (
            not isinstance(frame, ConversationTurnFrame)
            or direction is not FrameDirection.DOWNSTREAM
        ):
            await self.push_frame(frame, direction)
            return
        if self._cancellation_requested.is_set():
            return
        try:
            result = await self._text_generator.generate(
                TextGenerationRequest.from_start_turn(frame.request),
                cancellation_requested=self._cancellation_requested,
            )
        except Exception:
            result = TextGenerationFailed(
                code="text-generation-failed",
                safe_message="Conversation generation failed.",
                retryable=True,
            )
        if self._cancellation_requested.is_set() or isinstance(result, TextGenerationCancelled):
            return
        if isinstance(result, TextGenerationCompleted):
            await self.push_frame(LLMFullResponseStartFrame(), direction)
            await self.push_frame(LLMTextFrame(text=result.answer), direction)
            await self.push_frame(LLMFullResponseEndFrame(), direction)
            return
        await self.push_frame(TextGenerationFailureFrame(failure=result), direction)
        await self.push_frame(ErrorFrame(error=result.safe_message, fatal=True), direction)


class StreamingSubscriptionRuntimeTextGenerationProcessor(FrameProcessor):
    """Feed natural phrase chunks to TTS while the warm LLM is still generating."""

    def __init__(
        self,
        *,
        text_generator: StreamingConversationTextGenerationPort,
        cancellation_requested: CancellationSignal,
    ) -> None:
        super().__init__()
        self._text_generator = text_generator
        self._cancellation_requested = cancellation_requested

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if (
            not isinstance(frame, ConversationTurnFrame)
            or direction is not FrameDirection.DOWNSTREAM
        ):
            await self.push_frame(frame, direction)
            return
        await self._stream_answer(frame, direction)

    async def _stream_answer(
        self,
        frame: ConversationTurnFrame,
        direction: FrameDirection,
    ) -> None:
        if self._cancellation_requested.is_set():
            return
        chunker = SpeechPhraseChunker()
        response_started = False
        try:
            async for event in self._text_generator.stream(
                TextGenerationRequest.from_start_turn(frame.request),
                cancellation_requested=self._cancellation_requested,
            ):
                if self._cancellation_requested.is_set() or isinstance(
                    event, TextGenerationCancelled
                ):
                    return
                if isinstance(event, TextGenerationStreamDelta):
                    if not response_started:
                        response_started = True
                        await self.push_frame(
                            TextGenerationFirstTokenFrame(
                                observed_at_unix_ms=time.time_ns() // 1_000_000
                            ),
                            direction,
                        )
                        await self.push_frame(LLMFullResponseStartFrame(), direction)
                    for phrase in chunker.feed(event.text):
                        await self.push_frame(LLMTextFrame(text=phrase), direction)
                    continue
                if isinstance(event, TextGenerationCompleted):
                    if not response_started:
                        await self._fail(
                            TextGenerationFailed(
                                code="text-generation-invalid-stream",
                                safe_message="Conversation generation returned an invalid stream.",
                                retryable=True,
                            ),
                            direction,
                        )
                        return
                    for phrase in chunker.finish():
                        await self.push_frame(LLMTextFrame(text=phrase), direction)
                    await self.push_frame(LLMFullResponseEndFrame(), direction)
                    return
                if isinstance(event, TextGenerationFailed):
                    await self._fail(event, direction)
                    return
        except Exception:
            await self._fail(
                TextGenerationFailed(
                    code="text-generation-failed",
                    safe_message="Conversation generation failed.",
                    retryable=True,
                ),
                direction,
            )
            return
        await self._fail(
            TextGenerationFailed(
                code="text-generation-incomplete",
                safe_message="Conversation generation ended before completion.",
                retryable=True,
            ),
            direction,
        )

    async def _fail(
        self,
        failure: TextGenerationFailed,
        direction: FrameDirection,
    ) -> None:
        await self.push_frame(TextGenerationFailureFrame(failure=failure), direction)
        await self.push_frame(ErrorFrame(error=failure.safe_message, fatal=True), direction)
