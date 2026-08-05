"""Pipecat processor that obtains one answer through the consumer-owned text port."""

from __future__ import annotations

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
)
from pipecat_runtime.application.models import (
    TextGenerationCancelled,
    TextGenerationCompleted,
    TextGenerationFailed,
    TextGenerationRequest,
)
from pipecat_runtime.application.ports import CancellationSignal, ConversationTextGenerationPort


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
