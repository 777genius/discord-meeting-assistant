import type {
  ConversationCancellation,
  ConversationCancellationReason as DomainConversationCancellationReason,
  ConversationSession,
} from "../domain/conversation.js";
import { requireNonNegativeInteger } from "../domain/errors.js";
import type {
  ConversationCancellationReason,
  ConversationLatencyObserverPort,
  ConversationRuntime,
  ConversationRuntimeEvent,
  VoicePlaybackPort,
} from "./ports/conversation.js";
import { ConversationAnswerPlayback } from "./conversation-answer-playback.js";
import { ConversationCueOrchestrator } from "./conversation-cue-orchestrator.js";
import type {
  ActiveConversationRun,
  ConversationInterruptionResult,
  MeetingConversationState,
} from "./conversation-coordinator-types.js";
import {
  advanceConversationState,
  ignoreConversationFailure,
  isCurrentConversationRun,
  matchesConversationAttempt,
  trackConversationTask,
} from "./conversation-state.js";

export interface ConversationActiveTurnExecutorDependencies {
  readonly cues: ConversationCueOrchestrator;
  readonly latencyObserver?: ConversationLatencyObserverPort;
  readonly playback: VoicePlaybackPort;
  readonly runtime: ConversationRuntime;
}

/**
 * Runs the provider-neutral runtime and answer playback for one session-owned
 * active turn. ConversationSession remains the authority for admission and
 * cancellation policy.
 */
export class ConversationActiveTurnExecutor {
  private readonly answerPlayback: ConversationAnswerPlayback;
  private readonly cues: ConversationCueOrchestrator;
  private readonly latencyObserver: ConversationLatencyObserverPort | null;
  private readonly runtime: ConversationRuntime;

  public constructor(dependencies: ConversationActiveTurnExecutorDependencies) {
    this.cues = dependencies.cues;
    this.latencyObserver = dependencies.latencyObserver ?? null;
    this.runtime = dependencies.runtime;
    this.answerPlayback = new ConversationAnswerPlayback({
      finalize: async (state, run) => {
        await this.finalize(state, run);
      },
      playback: dependencies.playback,
      requestCancellation: async (state, run, reason) => {
        await this.requestCancellation(state, run, reason);
      },
    });
  }

  public async start(state: MeetingConversationState, turnId: string): Promise<void> {
    if (state.active !== null) {
      return;
    }

    const prepared = state.pending.get(turnId);
    if (prepared === undefined || !state.session.isActive(turnId)) {
      return;
    }

    const run: ActiveConversationRun = {
      answerAudioStarted: false,
      attemptId: null,
      cancellationInFlight: false,
      cueDelays: new Set(),
      cuePlayback: null,
      cuePlaybackOpening: false,
      deliberationCue: null,
      deliberationCueSelectionInFlight: false,
      deliberationCueReady: false,
      finalized: false,
      playback: null,
      playbackOpenAbortController: null,
      playbackEventsClosed: false,
      playbackFinishRequested: false,
      playbackFinished: false,
      playbackTerminalFinalizationScheduled: false,
      playbackTerminalReceiptMissing: false,
      prepared,
      runtimeCompleted: false,
      runtimeStartAbortController: null,
      runtimeTurn: null,
    };
    state.active = run;
    if (prepared.thinkingCuesEnabled) {
      this.cues.schedule(state, run);
    }

    let started: Awaited<ReturnType<ConversationRuntime["startTurn"]>>;
    const startAbortController = new AbortController();
    run.runtimeStartAbortController = startAbortController;
    try {
      started = await this.runtime.startTurn(prepared.request, {
        signal: startAbortController.signal,
      });
    } catch {
      await this.finalize(state, run);
      return;
    } finally {
      if (run.runtimeStartAbortController === startAbortController) {
        run.runtimeStartAbortController = null;
      }
    }

    if (state.active !== run || !state.session.isActive(turnId)) {
      if (started.ok) {
        await ignoreConversationFailure(() => started.value.cancel("superseded"));
      }
      return;
    }
    if (!started.ok) {
      await this.finalize(state, run);
      return;
    }

    run.runtimeTurn = started.value;
    trackConversationTask(state, this.consumeRuntime(state, run));
  }

  public async observeSpeech(
    state: MeetingConversationState,
    nowMs: number,
    observe: (session: ConversationSession, processedAtMs: number) => ConversationCancellation,
  ): Promise<ConversationInterruptionResult> {
    const observedAtMs = requireNonNegativeInteger(
      nowMs,
      "conversation.observedAtMs",
    );
    const processedAtMs = advanceConversationState(state, observedAtMs);
    const cancellation = observe(state.session, processedAtMs);
    if (cancellation.status === "ignored") {
      return Object.freeze({ status: "ignored" as const });
    }

    await this.enactCancellation(state, cancellation);
    return Object.freeze({
      status: "cancel-requested" as const,
      turnId: cancellation.turn.turnId,
    });
  }

  public async enactCancellation(
    state: MeetingConversationState,
    cancellation: Extract<ConversationCancellation, { readonly status: "requested" }>,
  ): Promise<void> {
    const run = state.active;
    if (
      run === null ||
      run.prepared.turn.turnId !== cancellation.turn.turnId ||
      run.cancellationInFlight
    ) {
      return;
    }

    run.cancellationInFlight = true;
    const reason: ConversationCancellationReason = cancellation.reason;
    run.runtimeStartAbortController?.abort(reason);
    run.runtimeStartAbortController = null;
    const cancellations: Promise<void>[] = [this.cues.stop(run, reason)];
    if (run.runtimeTurn !== null) {
      cancellations.push(ignoreConversationFailure(() => run.runtimeTurn!.cancel(reason)));
    }
    if (run.playback !== null) {
      this.answerPlayback.cancel(run, run.playback, reason);
    }
    await Promise.all(cancellations);
    await this.finalize(state, run);
  }

  private async consumeRuntime(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): Promise<void> {
    const runtimeTurn = run.runtimeTurn;
    if (runtimeTurn === null) {
      return;
    }

    try {
      for await (const event of runtimeTurn.events) {
        await this.handleRuntimeEvent(state, run, event);
      }
      if (isCurrentConversationRun(state, run) && !run.runtimeCompleted && !run.cancellationInFlight) {
        await this.requestCancellation(state, run, "runtime-shutdown");
      }
    } catch {
      if (isCurrentConversationRun(state, run)) {
        await this.requestCancellation(state, run, "runtime-shutdown");
      }
    }
  }

  private async handleRuntimeEvent(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    event: ConversationRuntimeEvent,
  ): Promise<void> {
    if (!isCurrentConversationRun(state, run) || run.cancellationInFlight) {
      return;
    }

    if (event.type === "accepted") {
      run.attemptId ??= event.attemptId;
      return;
    }
    if (!matchesConversationAttempt(run, event.attemptId)) {
      return;
    }

    switch (event.type) {
      case "audio-start":
        run.answerAudioStarted = true;
        await this.cues.stop(run, "superseded");
        await this.answerPlayback.open(state, run);
        return;
      case "audio-chunk":
        if (event.turnId === run.prepared.turn.turnId) {
          await this.answerPlayback.write(state, run, event);
        }
        return;
      case "audio-end":
        await this.answerPlayback.finish(state, run);
        return;
      case "cancelled":
        await this.requestCancellation(state, run, event.reason);
        return;
      case "completed":
        run.runtimeCompleted = true;
        await this.answerPlayback.finish(state, run);
        await this.maybeFinalizeAfterRuntime(state, run);
        return;
      case "failed":
        await this.requestCancellation(state, run, "runtime-shutdown");
        return;
      case "text-delta":
      case "usage":
        return;
      case "latency":
        this.observeLatency(run, event);
        return;
    }
  }

  private observeLatency(
    run: ActiveConversationRun,
    event: Extract<ConversationRuntimeEvent, { readonly type: "latency" }>,
  ): void {
    try {
      const observation = this.latencyObserver?.observeConversationLatency({
        attemptId: event.attemptId,
        endTurnToWakeMs: event.endTurnToWakeMs,
        firstLlmTokenToAudioMs: event.firstLlmTokenToAudioMs,
        meetingId: run.prepared.request.meetingId,
        totalToFirstAudioMs: event.totalToFirstAudioMs,
        turnId: run.prepared.request.turnId,
        wakeToFirstLlmTokenMs: event.wakeToFirstLlmTokenMs,
      });
      if (observation !== undefined) {
        void Promise.resolve(observation).catch(() => {
          // Observability must never alter conversation delivery or cancellation.
        });
      }
    } catch {
      // Observability must never alter conversation delivery or cancellation.
    }
  }

  private async maybeFinalizeAfterRuntime(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): Promise<void> {
    if (isCurrentConversationRun(state, run) && !run.cancellationInFlight) {
      await this.finalize(state, run);
    }
  }

  private async requestCancellation(
    state: MeetingConversationState,
    run: ActiveConversationRun,
    reason: DomainConversationCancellationReason,
  ): Promise<void> {
    const cancellation = state.session.cancelActive(
      run.prepared.turn.turnId,
      reason,
      state.lastObservedAtMs,
    );
    if (cancellation.status === "requested") {
      await this.enactCancellation(state, cancellation);
    }
  }

  private async finalize(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): Promise<void> {
    if (state.active !== run || run.finalized) {
      return;
    }

    await this.cues.stop(run, "superseded");
    if (state.playbackFence !== null) {
      this.schedulePlaybackTerminalFinalization(state, run);
      return;
    }

    run.finalized = true;
    state.active = null;
    state.pending.delete(run.prepared.turn.turnId);
    const completion = state.session.completeActive(
      run.prepared.turn.turnId,
      state.lastObservedAtMs,
    );
    if (completion.next !== null) {
      trackConversationTask(state, this.start(state, completion.next.turnId));
    }
  }

  private schedulePlaybackTerminalFinalization(
    state: MeetingConversationState,
    run: ActiveConversationRun,
  ): void {
    const fence = state.playbackFence;
    if (fence === null || run.playbackTerminalFinalizationScheduled) {
      return;
    }

    run.playbackTerminalFinalizationScheduled = true;
    trackConversationTask(state, (async () => {
      await fence.terminalReceipt;
      run.playbackTerminalFinalizationScheduled = false;
      await this.finalize(state, run);
    })());
  }
}
