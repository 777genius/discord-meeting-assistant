import type { ConversationCancellationReason as DomainConversationCancellationReason } from "../domain/conversation.js";
import type {
  ConversationAudioChunk,
  ConversationCancellationReason,
  VoicePlaybackEvent,
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
  matchesConversationAttempt,
  shouldDiscardOpenedConversationPlayback,
  trackConversationTask,
  withConversationPlaybackOpen,
} from "./conversation-state.js";

type PlaybackTerminalEvent = Extract<
  VoicePlaybackEvent,
  { readonly type: "failed" | "finished" }
>;

interface PlaybackConsumption {
  readonly fence: ConversationPlaybackFence;
  readonly playback: VoicePlaybackSession;
  terminalReceiptReceived: boolean;
}

interface ConversationAnswerPlaybackDependencies {
  readonly finalize: (
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ) => Promise<void>;
  readonly playback: VoicePlaybackPort;
  readonly requestCancellation: (
    state: MeetingConversationState,
    run: ActiveConversationRun,
    reason: DomainConversationCancellationReason,
  ) => Promise<void>;
}

/** Owns answer playback opening, streaming and terminal receipt reconciliation. */
export class ConversationAnswerPlayback {
  public constructor(
    private readonly dependencies: ConversationAnswerPlaybackDependencies,
  ) {}

  public async open(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): Promise<void> {
    await withConversationPlaybackOpen(state, async () => {
      if (
        run.playback !== null ||
        run.attemptId === null ||
        !isCurrentConversationRun(state, run) ||
        run.cancellationInFlight
      ) {
        return;
      }

      const fence = beginConversationPlaybackFence(state);
      let opened: Awaited<ReturnType<VoicePlaybackPort["open"]>>;
      const openAbortController = new AbortController();
      run.playbackOpenAbortController = openAbortController;
      try {
        opened = await this.dependencies.playback.open({
          attemptId: run.attemptId,
          meetingId: run.prepared.request.meetingId,
          recordingId: run.prepared.request.recordingId,
          turnId: run.prepared.request.turnId,
        }, {
          signal: openAbortController.signal,
        });
      } catch {
        confirmConversationPlaybackTerminal(state, fence);
        await this.dependencies.requestCancellation(state, run, "playback-failed");
        return;
      } finally {
        if (run.playbackOpenAbortController === openAbortController) {
          run.playbackOpenAbortController = null;
        }
      }

      if (!opened.ok) {
        confirmConversationPlaybackTerminal(state, fence);
        await this.dependencies.requestCancellation(state, run, "playback-failed");
        return;
      }

      run.playback = opened.value;
      trackConversationTask(
        state,
        this.consume(state, run, opened.value, fence),
      );
      if (shouldDiscardOpenedConversationPlayback(state, run)) {
        this.cancel(run, opened.value, "superseded");
      }
    });
  }

  public cancel(
    run: ActiveConversationRun,
    playback: VoicePlaybackSession,
    reason: ConversationCancellationReason,
  ): void {
    void playback.cancel(reason).then(
      (result) => this.recordCancellationResult(run, playback, result.ok),
      () => this.recordCancellationResult(run, playback, false),
    );
  }

  public async write(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    chunk: ConversationAudioChunk,
  ): Promise<boolean> {
    const playback = run.playback;
    if (playback === null) {
      return false;
    }
    if (await this.operationFailed(() => playback.write(chunk))) {
      await this.dependencies.requestCancellation(state, run, "playback-failed");
      return false;
    }
    return true;
  }

  public async finish(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): Promise<void> {
    const playback = run.playback;
    if (playback === null || run.playbackFinishRequested) {
      return;
    }
    run.playbackFinishRequested = true;
    if (await this.operationFailed(() => playback.finish())) {
      await this.dependencies.requestCancellation(state, run, "playback-failed");
    }
  }

  private recordCancellationResult(
    run: ActiveConversationRun,
    playback: VoicePlaybackSession,
    confirmed: boolean,
  ): null {
    if (!confirmed && run.playback === playback) {
      run.playbackTerminalReceiptMissing = true;
    }
    return null;
  }

  private async operationFailed(
    operation: () => Promise<{ readonly ok: boolean }>,
  ): Promise<boolean> {
    try {
      return !(await operation()).ok;
    } catch {
      return true;
    }
  }

  private async consume(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    playback: VoicePlaybackSession,
    fence: ConversationPlaybackFence,
  ): Promise<void> {
    const consumption: PlaybackConsumption = {
      fence,
      playback,
      terminalReceiptReceived: false,
    };
    try {
      for await (const event of playback.events) {
        await this.handleEvent(state, run, event, consumption);
      }
      await this.handleEventsClosed(state, run, consumption);
    } catch {
      if (!consumption.terminalReceiptReceived) {
        await this.handleMissingTerminal(state, run, consumption);
      }
    }
  }

  private async handleEvent(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    event: VoicePlaybackEvent,
    consumption: PlaybackConsumption,
  ): Promise<void> {
    if (!matchesConversationAttempt(run, event.attemptId)) {
      return;
    }
    if (isPlaybackTerminalEvent(event)) {
      await this.handleTerminalEvent(state, run, event, consumption);
      return;
    }
    if (!isCurrentConversationRun(state, run) || run.cancellationInFlight) {
      return;
    }
    const processedAtMs = advanceConversationState(state, event.startedAtMs);
    state.session.playbackStarted(
      run.prepared.turn.turnId,
      event.startedAtMs,
      processedAtMs,
    );
  }

  private async handleTerminalEvent(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    event: PlaybackTerminalEvent,
    consumption: PlaybackConsumption,
  ): Promise<void> {
    if (consumption.terminalReceiptReceived) {
      return;
    }
    consumption.terminalReceiptReceived = true;
    confirmConversationPlaybackTerminal(state, consumption.fence);
    if (run.playback === consumption.playback) {
      run.playback = null;
    }
    run.playbackTerminalReceiptMissing = false;
    if (!isCurrentConversationRun(state, run)) {
      return;
    }
    if (event.type === "failed") {
      await this.dependencies.requestCancellation(state, run, "playback-failed");
      return;
    }

    run.playbackFinished = true;
    advanceConversationState(state, event.finishedAtMs);
    await this.handleFinished(state, run);
  }

  private async handleFinished(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): Promise<void> {
    if (run.runtimeCompleted || run.cancellationInFlight) {
      await this.dependencies.finalize(state, run);
      return;
    }
    if (!run.playbackFinishRequested) {
      await this.dependencies.requestCancellation(state, run, "playback-failed");
    }
  }

  private async handleEventsClosed(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    consumption: PlaybackConsumption,
  ): Promise<void> {
    run.playbackEventsClosed = true;
    if (!consumption.terminalReceiptReceived) {
      await this.handleMissingTerminal(state, run, consumption);
      return;
    }
    if (this.shouldCancelAfterEventsClosed(state, run)) {
      await this.dependencies.requestCancellation(state, run, "playback-failed");
    }
  }

  private async handleMissingTerminal(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    consumption: PlaybackConsumption,
  ): Promise<void> {
    run.playbackTerminalReceiptMissing = true;
    markConversationPlaybackTerminalMissing(state, consumption.fence);
    if (isCurrentConversationRun(state, run) && !run.cancellationInFlight) {
      await this.dependencies.requestCancellation(state, run, "playback-failed");
    }
  }

  private shouldCancelAfterEventsClosed(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): boolean {
    return isCurrentConversationRun(state, run) &&
      !run.runtimeCompleted &&
      !run.playbackFinishRequested &&
      !run.cancellationInFlight;
  }
}

function isPlaybackTerminalEvent(event: VoicePlaybackEvent): event is PlaybackTerminalEvent {
  return event.type === "failed" || event.type === "finished";
}
