"""Provider adapter that turns a stateless request into Pipecat's LLM context frame."""

from __future__ import annotations

from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from pipecat_runtime.adapters.pipecat.frames import ConversationTurnFrame


class PromptToContextProcessor(FrameProcessor):
    """Pass exactly the system prompt and the current user prompt to an LLM provider."""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, ConversationTurnFrame) and direction is FrameDirection.DOWNSTREAM:
            context = LLMContext(
                messages=[
                    {"role": "system", "content": frame.request.system_prompt},
                    {"role": "user", "content": frame.request.prompt},
                ]
            )
            await self.push_frame(LLMContextFrame(context=context), direction)
            return
        await self.push_frame(frame, direction)
