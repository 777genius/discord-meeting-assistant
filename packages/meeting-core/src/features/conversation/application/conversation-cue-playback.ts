import type {
  ConversationCancellationReason,
  ConversationPlaybackObservation,
  ConversationPlaybackObserverPort,
  ConversationPlaybackReadinessPort,
  ConversationThinkingCue,
  ConversationThinkingCueStage,
  VoicePlaybackPort,
  VoicePlaybackSession,
} from "./ports/conversation.js";
import type {
  ActiveConversationRun,
  ConversationPlaybackFence,
  MeetingConversationState,
} from "./conversation-coordinator-types.js";
import {
  advanceConversationState,
  beginConversationPlaybackFence,
  confirmConversationPlaybackTerminal,
  isCurrentConversationRun,
  markConversationPlaybackTerminalMissing,
  trackConversationTask,
  withConversationPlaybackOpen,
} from "./conversation-state.js";

interface ConversationCuePlaybackDependencies {
  readonly onFailed: (run: ActiveConversationRun) => Promise<void>;
  readonly onFinished: (
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ) => Promise<void>;
  readonly playback: VoicePlaybackPort;
  readonly playbackObserver?: ConversationPlaybackObserverPort;
  readonly playbackReadiness?: ConversationPlaybackReadinessPort;
}

/** Owns opening, streaming and terminal-receipt tracking for one cue playback. */
export class ConversationCuePlayback {
  public constructor(
    private readonly dependencies: ConversationCuePlaybackDependencies,
  ) {}

  public async open(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    cue: ConversationThinkingCue,
    stage: ConversationThinkingCueStage,
  ): Promise<void> {
    const playback = await withConversationPlaybackOpen(state, async () => {
      if (!this.canOpen(state, run)) {
        return null;
      }

      const fence = beginConversationPlaybackFence(state);
      let opened: Awaited<ReturnType<VoicePlaybackPort["open"]>>;
      const openAbortController = new AbortController();
      run.playbackOpenAbortController = openAbortController;
      try {
        const readiness = this.dependencies.playbackReadiness;
        if (readiness !== undefined) {
          const ready = await readiness.awaitConversationPlaybackReady({
            expectedPcmBytes: expectedConversationCuePcmBytes(cue),
            expectedPcmSha256: cue.pcmSha256,
            meetingId: run.prepared.request.meetingId,
            participantId: run.prepared.request.speakerId,
            playbackAttemptId: cue.playbackAttemptId,
            playbackKind: "thinking-cue",
            turnId: run.prepared.request.turnId,
          }, { signal: openAbortController.signal });
          if (!isReadyResult(ready)) {
            confirmConversationPlaybackTerminal(state, fence);
            if (
              openAbortController.signal.aborted ||
              run.playbackOpenAbortController !== openAbortController ||
              !this.canOpen(state, run)
            ) {
              return null;
            }
            await this.dependencies.onFailed(run);
            return null;
          }
        }
        if (!this.canOpen(state, run) || openAbortController.signal.aborted) {
          confirmConversationPlaybackTerminal(state, fence);
          return null;
        }
        opened = await this.dependencies.playback.open({
          attemptId: cue.playbackAttemptId,
          meetingId: run.prepared.request.meetingId,
          recordingId: run.prepared.request.recordingId,
          turnId: run.prepared.request.turnId,
        }, {
          signal: openAbortController.signal,
        });
      } catch {
        confirmConversationPlaybackTerminal(state, fence);
        return null;
      } finally {
        if (run.playbackOpenAbortController === openAbortController) {
          run.playbackOpenAbortController = null;
        }
      }
      if (!opened.ok) {
        confirmConversationPlaybackTerminal(state, fence);
        return null;
      }

      run.cuePlayback = opened.value;
      trackConversationTask(
        state,
        this.consume(
          state,
          run,
          opened.value,
          fence,
          cue.playbackAttemptId,
          cue.pcmSha256,
        ),
      );
      if (!this.canKeep(state, run, opened.value)) {
        this.cancel(run, opened.value, "superseded");
        return null;
      }
      if (stage === "deliberation") {
        run.deliberationCueReady = false;
      }
      return opened.value;
    });
    if (playback === null) {
      return;
    }
    await this.stream(state, run, cue, playback);
  }

  public cancel(
    run: ActiveConversationRun,
    playback: VoicePlaybackSession,
    reason: ConversationCancellationReason,
  ): void {
    void playback.cancel(reason).then(
      (result) => {
        if (!result.ok && run.cuePlayback === playback) {
          run.playbackTerminalReceiptMissing = true;
        }
        return null;
      },
      () => {
        if (run.cuePlayback === playback) {
          run.playbackTerminalReceiptMissing = true;
        }
        return null;
      },
    );
  }

  private async stream(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    cue: ConversationThinkingCue,
    playback: VoicePlaybackSession,
  ): Promise<void> {
    try {
      for (const [sequence, bytes] of cue.pcmChunks.entries()) {
        if (!this.canStream(state, run, playback)) {
          return;
        }
        const written = await playback.write({
          attemptId: cue.playbackAttemptId,
          bytes,
          channels: 1,
          format: "pcm_s16le",
          sampleRateHz: 48_000,
          sequence,
          turnId: run.prepared.request.turnId,
        });
        if (!written.ok) {
          await this.dependencies.onFailed(run);
          return;
        }
      }
      if (this.canStream(state, run, playback)) {
        const finished = await playback.finish();
        if (!finished.ok) {
          await this.dependencies.onFailed(run);
        }
      }
    } catch {
      await this.dependencies.onFailed(run);
    }
  }

  private canOpen(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): boolean {
    return isCurrentConversationRun(state, run) &&
      !run.cancellationInFlight &&
      !run.runtimeCompleted &&
      !run.answerAudioStarted &&
      run.playback === null &&
      run.cuePlayback === null;
  }

  private canKeep(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    playback: VoicePlaybackSession,
  ): boolean {
    return isCurrentConversationRun(state, run) &&
      !run.cancellationInFlight &&
      !run.runtimeCompleted &&
      !run.answerAudioStarted &&
      run.playback === null &&
      run.cuePlayback === playback;
  }

  private canStream(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    playback: VoicePlaybackSession,
  ): boolean {
    return isCurrentConversationRun(state, run) &&
      !run.answerAudioStarted &&
      !run.cancellationInFlight &&
      run.cuePlayback === playback;
  }

  private async consume(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    playback: VoicePlaybackSession,
    fence: ConversationPlaybackFence,
    expectedAttemptId: string,
    expectedPcmSha256: string,
  ): Promise<void> {
    let terminalReceiptReceived = false;
    let startedReceiptReceived = false;
    try {
      for await (const event of playback.events) {
        if (event.attemptId !== expectedAttemptId) {
          continue;
        }
        if (event.type === "finished") {
          if (terminalReceiptReceived) {
            continue;
          }
          terminalReceiptReceived = true;
          confirmConversationPlaybackTerminal(state, fence);
          if (run.cuePlayback === playback) {
            run.cuePlayback = null;
          }
          run.playbackTerminalReceiptMissing = false;
          if (!isCurrentConversationRun(state, run)) {
            continue;
          }
          this.observePlayback({
            finishedAtMs: event.finishedAtMs,
            meetingId: run.prepared.request.meetingId,
            playbackAttemptId: event.attemptId,
            playbackKind: "thinking-cue",
            status: "finished",
            thinkingCuePcmSha256: expectedPcmSha256,
            turnId: run.prepared.request.turnId,
          });
          advanceConversationState(state, event.finishedAtMs);
          await this.dependencies.onFinished(state, run);
          continue;
        }
        if (event.type === "failed") {
          if (terminalReceiptReceived) {
            continue;
          }
          terminalReceiptReceived = true;
          confirmConversationPlaybackTerminal(state, fence);
          if (run.cuePlayback === playback) {
            run.cuePlayback = null;
          }
          run.playbackTerminalReceiptMissing = false;
          if (isCurrentConversationRun(state, run)) {
            await this.dependencies.onFailed(run);
          }
          continue;
        }
        if (!isCurrentConversationRun(state, run) || run.cuePlayback !== playback) {
          continue;
        }
        if (startedReceiptReceived) {
          continue;
        }
        startedReceiptReceived = true;
        this.observePlayback({
          meetingId: run.prepared.request.meetingId,
          playbackAttemptId: event.attemptId,
          playbackKind: "thinking-cue",
          startedAtMs: event.startedAtMs,
          status: "started",
          thinkingCuePcmSha256: expectedPcmSha256,
          turnId: run.prepared.request.turnId,
        });
        const processedAtMs = advanceConversationState(state, event.startedAtMs);
        state.session.thinkingCueStarted(
          run.prepared.turn.turnId,
          event.startedAtMs,
          processedAtMs,
        );
      }
      if (!terminalReceiptReceived) {
        run.playbackTerminalReceiptMissing = true;
        markConversationPlaybackTerminalMissing(state, fence);
      }
    } catch {
      if (!terminalReceiptReceived) {
        run.playbackTerminalReceiptMissing = true;
        markConversationPlaybackTerminalMissing(state, fence);
      }
    }
  }

  private observePlayback(observation: ConversationPlaybackObservation): void {
    try {
      const result = this.dependencies.playbackObserver
        ?.observeConversationPlayback(observation);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {
          // Observability must never alter conversation delivery or cancellation.
        });
      }
    } catch {
      // Observability must never alter conversation delivery or cancellation.
    }
  }
}

function isReadyResult(result: unknown): boolean {
  return typeof result === "object" && result !== null &&
    "ok" in result && result.ok === true &&
    "value" in result && result.value === "ready";
}

function expectedConversationCuePcmBytes(cue: ConversationThinkingCue): number {
  const expectedPcmBytes = cue.pcmChunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  if (!Number.isSafeInteger(expectedPcmBytes) || expectedPcmBytes <= 0) {
    throw new Error("Thinking cue PCM byte count must be a positive safe integer");
  }
  return expectedPcmBytes;
}
