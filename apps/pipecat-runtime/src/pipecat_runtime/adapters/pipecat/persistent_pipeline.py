"""A bounded persistent Pipecat worker for sequential turns in one meeting."""

from __future__ import annotations

import asyncio

from pipecat.frames.frames import EndFrame, InterruptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.utils.asyncio.task_manager import TaskManager
from pipecat.workers.base_worker import WorkerParams

from pipecat_runtime.adapters.pipecat.frames import ConversationTurnFrame
from pipecat_runtime.adapters.pipecat.processors import PCMNormalizationProcessor
from pipecat_runtime.adapters.pipecat.turn_lifecycle import (
    ActivePipelineTurn,
    ActiveTurnCancellationSignal,
    PersistentTurnOutputProcessor,
)
from pipecat_runtime.adapters.providers.profiles import ConversationPipelineProfile
from pipecat_runtime.application.models import PCM_S16LE_SAMPLE_RATE_HZ, CancellationReason

_RUNNER_STOP_TIMEOUT_SECONDS = 6


class PersistentConversationPipeline:
    """Keep provider connections warm while admitting at most one turn at a time."""

    def __init__(
        self,
        *,
        profile: ConversationPipelineProfile,
        first_turn: ActivePipelineTurn,
    ) -> None:
        self._profile = profile
        self._signal = ActiveTurnCancellationSignal()
        self._output = PersistentTurnOutputProcessor()
        self._worker = self._create_worker(first_turn)
        self._runner_task: asyncio.Task[None] | None = None
        self._active: ActivePipelineTurn | None = None
        self._state_lock = asyncio.Lock()
        self._closed = False
        self._retired = False

    @property
    def is_active(self) -> bool:
        return self._active is not None

    @property
    def is_reusable(self) -> bool:
        return not self._closed and not self._retired

    async def reserve(self, turn: ActivePipelineTurn) -> None:
        """Fail closed instead of allowing overlapping speech on one meeting pipeline."""
        async with self._state_lock:
            if self._closed or self._retired:
                raise RuntimeError("persistent conversation pipeline is unavailable")
            if self._active is not None:
                raise RuntimeError("persistent conversation pipeline is busy")
            self._active = turn

    async def execute(self, turn: ActivePipelineTurn) -> None:
        """Run one reserved turn and leave a healthy worker connected for the next one."""
        try:
            if self._active is not turn:
                raise RuntimeError("conversation turn was not reserved by this pipeline")
            self._signal.bind(turn)
            self._output.bind(turn)
            async with self._state_lock:
                should_queue = not self._closed and not turn.cancellation_requested.is_set()
                if should_queue:
                    self._ensure_runner_started()
                else:
                    turn.finished.set()
            if should_queue:
                await self._worker.queue_frame(ConversationTurnFrame(turn.request))
            await turn.finished.wait()
            if self._runner_task is not None and not self._runner_task.done():
                drained = await self._worker.flush_pipeline(timeout=5)
                if not drained:
                    turn.pipeline_failure = True
            if turn.pipeline_failure:
                await self._retire_worker()
            await self._publish_terminal(turn)
        except Exception:
            await self._retire_worker()
            await turn.events.failed(
                code="pipecat-runtime-failed",
                safe_message="Conversation runtime failed.",
                retryable=True,
            )
        finally:
            if not turn.events.is_terminal:
                await turn.events.failed(
                    code="pipecat-runtime-incomplete",
                    safe_message="Conversation runtime ended without a terminal outcome.",
                    retryable=True,
                )
            self._output.release(turn)
            self._signal.release(turn)
            async with self._state_lock:
                if self._active is turn:
                    self._active = None

    async def cancel(self, turn: ActivePipelineTurn, reason: CancellationReason) -> bool:
        """Interrupt only the reserved attempt without ending a healthy provider socket."""
        async with self._state_lock:
            if self._active is not turn or not turn.request_cancellation(reason):
                return False
            runner_started = self._runner_task is not None
        if runner_started:
            await self._worker.queue_frame(InterruptionFrame())
        else:
            turn.finished.set()
        return True

    async def close(self) -> None:
        """Gracefully close the provider socket only when the runtime shuts down or evicts."""
        async with self._state_lock:
            if self._closed:
                return
            self._closed = True
            active = self._active
        forced_cleanup = False
        if active is not None:
            await self.cancel(active, CancellationReason.RUNTIME_SHUTDOWN)
            try:
                await asyncio.wait_for(active.finished.wait(), timeout=5)
            except TimeoutError:
                active.finished.set()
                forced_cleanup = True
        async with self._state_lock:
            runner_task = self._runner_task
        if runner_task is not None and not runner_task.done():
            if forced_cleanup:
                stopped = await self._force_stop_runner(
                    runner_task,
                    reason="runtime-shutdown-active-timeout",
                )
            else:
                try:
                    await asyncio.wait_for(
                        self._worker.queue_frame(EndFrame(reason="runtime-shutdown")),
                        timeout=5,
                    )
                    await asyncio.wait_for(asyncio.shield(runner_task), timeout=5)
                    stopped = True
                except Exception:
                    stopped = await self._force_stop_runner(
                        runner_task,
                        reason="runtime-shutdown-timeout",
                    )
            if not stopped:
                raise RuntimeError("persistent Pipecat worker did not stop during shutdown")

    async def abort(self) -> None:
        """Bound forced cleanup after graceful provider closure fails."""
        async with self._state_lock:
            self._closed = True
            self._retired = True
            active = self._active
            runner_task = self._runner_task
        if active is not None:
            active.request_cancellation(CancellationReason.RUNTIME_SHUTDOWN)
            active.finished.set()
        if runner_task is None or runner_task.done():
            return
        if not await self._force_stop_runner(runner_task, reason="runtime-forced-shutdown"):
            raise RuntimeError("persistent Pipecat worker did not stop after forced cleanup")

    def _create_worker(self, first_turn: ActivePipelineTurn) -> PipelineWorker:
        processors = self._profile.create_processors(first_turn.request, self._signal)
        pipeline = Pipeline(
            [
                *processors,
                PCMNormalizationProcessor(),
                self._output,
            ]
        )
        return PipelineWorker(
            pipeline,
            cancel_on_idle_timeout=False,
            cancel_timeout_secs=5,
            enable_rtvi=False,
            enable_turn_tracking=False,
            params=PipelineParams(audio_out_sample_rate=PCM_S16LE_SAMPLE_RATE_HZ),
        )

    def _ensure_runner_started(self) -> None:
        if self._runner_task is not None:
            if self._runner_task.done():
                raise RuntimeError("persistent Pipecat worker stopped unexpectedly")
            return
        self._runner_task = asyncio.create_task(
            self._worker.run(WorkerParams(task_manager=TaskManager())),
            name=f"pipecat-meeting-{self._active.request.meeting_id if self._active else 'idle'}",
        )

    async def _retire_worker(self) -> None:
        async with self._state_lock:
            self._retired = True
            runner_task = self._runner_task
        if runner_task is None or runner_task.done():
            return
        await self._force_stop_runner(runner_task, reason="pipeline-failed")

    async def _force_stop_runner(
        self,
        runner_task: asyncio.Task[None],
        *,
        reason: str,
    ) -> bool:
        """Bound provider cleanup even when the worker ignores graceful cancellation."""
        try:
            await asyncio.wait_for(
                self._worker.cancel(reason=reason),
                timeout=_RUNNER_STOP_TIMEOUT_SECONDS,
            )
        except Exception:
            runner_task.cancel()
        _, pending = await asyncio.wait(
            {runner_task},
            timeout=_RUNNER_STOP_TIMEOUT_SECONDS,
        )
        if pending:
            runner_task.cancel()
            _, pending = await asyncio.wait(
                {runner_task},
                timeout=_RUNNER_STOP_TIMEOUT_SECONDS,
            )
        if pending:
            runner_task.cancel()
            return False
        return True

    @staticmethod
    async def _publish_terminal(turn: ActivePipelineTurn) -> None:
        if turn.cancellation_reason is not None:
            await turn.events.cancelled(turn.cancellation_reason)
        elif turn.text_generation_failure is not None:
            failure = turn.text_generation_failure
            await turn.events.failed(
                code=failure.code,
                safe_message=failure.safe_message,
                retryable=failure.retryable,
            )
        elif turn.pipeline_failure:
            await turn.events.failed(
                code="pipecat-pipeline-failed",
                safe_message="Conversation synthesis failed.",
                retryable=True,
            )
        else:
            await turn.events.completed()
