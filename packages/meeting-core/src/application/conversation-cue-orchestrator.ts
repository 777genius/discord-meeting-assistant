import {
  CONVERSATION_DELIBERATION_CUE_DELAY_MS,
  CONVERSATION_THINKING_CUE_DELAY_MS,
  shouldUseConversationDeliberationCue,
} from "../domain/conversation.js";
import type {
  ConversationCancellationReason,
  ConversationDelay,
  ConversationDelayPort,
  ConversationThinkingCue,
  ConversationThinkingCuePort,
  ConversationThinkingCueStage,
  VoicePlaybackPort,
  VoicePlaybackSession,
} from "./ports.js";
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

export interface ConversationCueOrchestratorDependencies {
  readonly delay: ConversationDelayPort | null;
  readonly playback: VoicePlaybackPort;
  readonly thinkingCues: ConversationThinkingCuePort | null;
}

/** Owns optional acknowledgement and deliberation cue lifecycles. */
export class ConversationCueOrchestrator {
  private readonly delay: ConversationDelayPort | null;
  private readonly playback: VoicePlaybackPort;
  private readonly thinkingCues: ConversationThinkingCuePort | null;

  public constructor(dependencies: ConversationCueOrchestratorDependencies) {
    this.delay = dependencies.delay;
    this.playback = dependencies.playback;
    this.thinkingCues = dependencies.thinkingCues;
  }

  public schedule(state: MeetingConversationState, run: ActiveConversationRun): void {
    if (this.delay === null || this.thinkingCues === null) {
      return;
    }
    this.scheduleStage(
      state,
      run,
      "acknowledgement",
      CONVERSATION_THINKING_CUE_DELAY_MS,
    );
    if (shouldUseConversationDeliberationCue(run.prepared.request.prompt)) {
      this.scheduleStage(
        state,
        run,
        "deliberation",
        CONVERSATION_DELIBERATION_CUE_DELAY_MS,
      );
    }
  }

  public async stop(
    run: ActiveConversationRun,
    reason: ConversationCancellationReason,
  ): Promise<void> {
    run.playbackOpenAbortController?.abort(reason);
    run.playbackOpenAbortController = null;
    run.deliberationCue = null;
    run.deliberationCueReady = false;
    for (const delay of run.cueDelays) {
      delay.cancel();
    }
    run.cueDelays.clear();
    const playback = run.cuePlayback;
    if (playback !== null) {
      this.cancelPlayback(run, playback, reason);
    }
  }

  private scheduleStage(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    stage: ConversationThinkingCueStage,
    delayMs: number,
  ): void {
    if (this.delay === null) {
      return;
    }
    const delay = this.delay.start(delayMs);
    run.cueDelays.add(delay);
    trackConversationTask(state, this.play(state, run, delay, stage));
  }

  private async play(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    delay: ConversationDelay,
    stage: ConversationThinkingCueStage,
  ): Promise<void> {
    const delayResult = await delay.elapsed;
    if (!run.cueDelays.delete(delay) || delayResult === "cancelled") {
      return;
    }
    if (stage === "deliberation") {
      run.deliberationCueReady = true;
    }
    await this.startStage(state, run, stage);
  }

  private async startStage(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    stage: ConversationThinkingCueStage,
  ): Promise<void> {
    if (!this.canStartStage(state, run)) {
      return;
    }
    if (run.cuePlayback !== null || run.cuePlaybackOpening) {
      await this.preloadDeliberationCueIfNeeded(state, run, stage);
      return;
    }
    const cue = this.takeCachedDeliberationCue(run, stage);
    if (cue !== null) {
      await this.openSelectedStage(state, run, cue, stage);
      return;
    }
    if (stage === "deliberation" && run.deliberationCueSelectionInFlight) {
      return;
    }

    await this.selectAndOpenStage(state, run, stage);
  }

  private canStartStage(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): boolean {
    return isCurrentConversationRun(state, run) &&
      !run.cancellationInFlight &&
      !run.runtimeCompleted &&
      !run.answerAudioStarted &&
      run.playback === null &&
      this.thinkingCues !== null;
  }

  private async preloadDeliberationCueIfNeeded(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    stage: ConversationThinkingCueStage,
  ): Promise<void> {
    if (stage === "deliberation") {
      await this.preloadDeliberationCue(state, run);
    }
  }

  private takeCachedDeliberationCue(
    run: ActiveConversationRun,
    stage: ConversationThinkingCueStage,
  ): ConversationThinkingCue | null {
    if (stage !== "deliberation") {
      return null;
    }
    const cue = run.deliberationCue;
    run.deliberationCue = null;
    return cue;
  }

  private async openSelectedStage(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    cue: ConversationThinkingCue,
    stage: ConversationThinkingCueStage,
  ): Promise<void> {
    await this.withCuePlaybackOpening(state, run, stage, async () => {
      await this.openPlayback(state, run, cue, stage);
    });
  }

  private async selectAndOpenStage(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    stage: ConversationThinkingCueStage,
  ): Promise<void> {
    try {
      await this.withCuePlaybackOpening(state, run, stage, async () => {
        const selected = await this.selectCue(run, stage);
        if (selected !== null && isCurrentConversationRun(state, run)) {
          await this.openPlayback(state, run, selected, stage);
        }
      });
    } catch {
      return;
    }
  }

  private async withCuePlaybackOpening(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    stage: ConversationThinkingCueStage,
    operation: () => Promise<void>,
  ): Promise<void> {
    run.cuePlaybackOpening = true;
    try {
      await operation();
    } finally {
      run.cuePlaybackOpening = false;
      await this.startReadyDeliberationAfterAcknowledgement(state, run, stage);
    }
  }

  private async startReadyDeliberationAfterAcknowledgement(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    stage: ConversationThinkingCueStage,
  ): Promise<void> {
    if (
      stage !== "acknowledgement" ||
      !run.deliberationCueReady ||
      run.cuePlayback !== null ||
      !isCurrentConversationRun(state, run)
    ) {
      return;
    }
    await this.startStage(state, run, "deliberation");
  }

  private async preloadDeliberationCue(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): Promise<void> {
    if (
      this.thinkingCues === null ||
      run.deliberationCue !== null ||
      run.deliberationCueSelectionInFlight
    ) {
      return;
    }

    run.deliberationCueSelectionInFlight = true;
    try {
      const selected = await this.selectCue(run, "deliberation");
      if (
        selected !== null &&
        isCurrentConversationRun(state, run) &&
        !run.cancellationInFlight &&
        !run.runtimeCompleted &&
        !run.answerAudioStarted
      ) {
        run.deliberationCue = selected;
      }
    } catch {
      return;
    } finally {
      run.deliberationCueSelectionInFlight = false;
    }

    if (
      run.deliberationCueReady &&
      run.cuePlayback === null &&
      !run.cuePlaybackOpening
    ) {
      await this.startStage(state, run, "deliberation");
    }
  }

  private async selectCue(
    run: ActiveConversationRun,
    stage: ConversationThinkingCueStage,
  ): Promise<ConversationThinkingCue | null> {
    if (this.thinkingCues === null) {
      return null;
    }

    const selected = await this.thinkingCues.select({
      locale: run.prepared.thinkingCueLocale,
      meetingId: run.prepared.request.meetingId,
      stage,
      turnId: run.prepared.request.turnId,
      voiceProfileId: run.prepared.request.voiceProfileId,
    });
    return selected.ok ? selected.value : null;
  }

  private async openPlayback(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    cue: ConversationThinkingCue,
    stage: ConversationThinkingCueStage,
  ): Promise<void> {
    const playback = await withConversationPlaybackOpen(state, async () => {
      if (!this.canOpenPlayback(state, run)) {
        return null;
      }

      const fence = beginConversationPlaybackFence(state);
      let opened: Awaited<ReturnType<VoicePlaybackPort["open"]>>;
      const openAbortController = new AbortController();
      run.playbackOpenAbortController = openAbortController;
      try {
        opened = await this.playback.open({
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
        this.consumePlayback(state, run, opened.value, fence, cue.playbackAttemptId),
      );
      if (!this.canKeepPlayback(state, run, opened.value)) {
        this.cancelPlayback(run, opened.value, "superseded");
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
    try {
      for (const [sequence, bytes] of cue.pcmChunks.entries()) {
        if (
          !isCurrentConversationRun(state, run) ||
          run.answerAudioStarted ||
          run.cancellationInFlight ||
          run.cuePlayback !== playback
        ) {
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
          await this.stop(run, "playback-failed");
          return;
        }
      }
      if (
        isCurrentConversationRun(state, run) &&
        !run.answerAudioStarted &&
        !run.cancellationInFlight &&
        run.cuePlayback === playback
      ) {
        const finished = await playback.finish();
        if (!finished.ok) {
          await this.stop(run, "playback-failed");
        }
      }
    } catch {
      await this.stop(run, "playback-failed");
    }
  }

  private canOpenPlayback(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): boolean {
    return (
      isCurrentConversationRun(state, run) &&
      !run.cancellationInFlight &&
      !run.runtimeCompleted &&
      !run.answerAudioStarted &&
      run.playback === null &&
      run.cuePlayback === null
    );
  }

  private canKeepPlayback(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    playback: VoicePlaybackSession,
  ): boolean {
    return (
      isCurrentConversationRun(state, run) &&
      !run.cancellationInFlight &&
      !run.runtimeCompleted &&
      !run.answerAudioStarted &&
      run.playback === null &&
      run.cuePlayback === playback
    );
  }

  private async consumePlayback(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    playback: VoicePlaybackSession,
    fence: ConversationPlaybackFence,
    expectedAttemptId: string,
  ): Promise<void> {
    let terminalReceiptReceived = false;
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
          advanceConversationState(state, event.finishedAtMs);
          if (run.deliberationCueReady) {
            await this.startStage(state, run, "deliberation");
          }
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
            await this.stop(run, "playback-failed");
          }
          continue;
        }
        if (!isCurrentConversationRun(state, run) || run.cuePlayback !== playback) {
          continue;
        }
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

  private cancelPlayback(
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
}
