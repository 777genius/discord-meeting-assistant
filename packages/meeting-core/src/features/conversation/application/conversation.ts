import {
  detectAddressedConversation,
  type ConversationCancellation,
  type ConversationSession,
} from "../domain/conversation.js";
import { ConversationActiveTurnExecutor } from "./conversation-active-turn-executor.js";
import { ConversationCueOrchestrator } from "./conversation-cue-orchestrator.js";
import type {
  ConversationCoordinatorDependencies,
  ConversationCoordinatorResult,
  ConversationInterruptionResult,
  ConversationTurnPlaybackSettlement,
  FinalizedConversationTurnInput,
  MeetingConversationState,
  PreparedConversationCueInput,
  ProactiveConversationTurnInput,
} from "./conversation-coordinator-types.js";
import {
  advanceConversationState,
  createMeetingConversationState,
  trackConversationTask,
  waitForConversationTasks,
} from "./conversation-state.js";
import { ConversationWakeLatchAdmission } from "./conversation-wake-latch-admission.js";

export type {
  ConversationCoordinatorDependencies,
  ConversationCoordinatorResult,
  ConversationInterruptionResult,
  ConversationTurnPlaybackSettlement,
  FinalizedConversationTurnInput,
  PreparedConversationCueInput,
  ProactiveConversationTurnInput,
} from "./conversation-coordinator-types.js";

type SpeechObservation = (
  session: ConversationSession,
  processedAtMs: number,
) => ConversationCancellation;

/**
 * Provider-neutral facade for one addressed conversation turn at a time.
 * It routes transcript observations to focused wake/admission and execution
 * components while ConversationSession remains the deterministic policy owner.
 */
export class ConversationCoordinator {
  private readonly activeTurns: ConversationActiveTurnExecutor;
  private readonly meetings = new Map<string, MeetingConversationState>();
  private readonly wakeLatches = new ConversationWakeLatchAdmission();

  public constructor(dependencies: ConversationCoordinatorDependencies) {
    if ((dependencies.delay === undefined) !== (dependencies.thinkingCues === undefined)) {
      throw new Error("Thinking cues require both delay and cue ports");
    }
    const cues = new ConversationCueOrchestrator({
      delay: dependencies.delay ?? null,
      playback: dependencies.playback,
      thinkingCues: dependencies.thinkingCues ?? null,
    });
    this.activeTurns = new ConversationActiveTurnExecutor({
      cues,
      ...(dependencies.latencyObserver === undefined
        ? {}
        : { latencyObserver: dependencies.latencyObserver }),
      playback: dependencies.playback,
      runtime: dependencies.runtime,
    });
  }

  public async handleFinalizedTurn(
    input: FinalizedConversationTurnInput,
  ): Promise<ConversationCoordinatorResult> {
    const addressed = detectAddressedConversation(input.text);
    if (addressed === null) {
      return this.handleLatchedPrompt(input);
    }

    const state = this.stateFor(input.meetingId);
    if (state.closing) {
      return Object.freeze({ status: "ignored" as const });
    }
    advanceConversationState(state, input.nowMs);
    if (addressed.usedFallbackPrompt) {
      return this.wakeLatches.arm(state, input, addressed.alias);
    }

    this.wakeLatches.clearForSpeaker(state, input.speakerId);
    return this.admitPrompt(state, input, addressed.prompt);
  }

  public async handleProactiveTurn(
    input: ProactiveConversationTurnInput,
  ): Promise<ConversationCoordinatorResult> {
    const state = this.stateFor(input.meetingId);
    if (state.closing) {
      return Object.freeze({ status: "ignored" as const });
    }
    advanceConversationState(state, input.nowMs);
    this.wakeLatches.clearForSpeaker(state, input.speakerId);
    const admission = this.wakeLatches.admitProactive(state, input);
    if (admission.turnToStart !== null) {
      trackConversationTask(
        state,
        this.activeTurns.start(state, admission.turnToStart),
      );
    }
    return admission.result;
  }

  public async playPreparedCue(
    input: PreparedConversationCueInput,
  ): Promise<ConversationCoordinatorResult> {
    const state = this.stateFor(input.meetingId);
    if (state.closing) {
      return Object.freeze({ status: "ignored" as const });
    }
    advanceConversationState(state, input.nowMs);
    this.wakeLatches.clear(state);
    state.pending.clear();
    const cancellation = state.session.close(
      "superseded",
      state.lastObservedAtMs,
    );
    const admission = this.wakeLatches.admitPreparedCue(state, input);
    if (admission.turnToStart !== null) {
      trackConversationTask(
        state,
        this.activeTurns.start(state, admission.turnToStart),
      );
    }
    if (cancellation.status === "requested") {
      await this.activeTurns.enactCancellation(state, cancellation);
    }
    return admission.result;
  }

  public async speechStarted(
    meetingId: string,
    nowMs: number,
  ): Promise<ConversationInterruptionResult> {
    return this.applySpeechObservation(meetingId, nowMs, (session, processedAtMs) =>
      session.speechStarted(nowMs, processedAtMs),
    );
  }

  public async speechActivity(
    meetingId: string,
    nowMs: number,
  ): Promise<ConversationInterruptionResult> {
    return this.applySpeechObservation(meetingId, nowMs, (session, processedAtMs) =>
      session.speechActivity(nowMs, processedAtMs),
    );
  }

  public async speechEnded(
    meetingId: string,
    nowMs: number,
  ): Promise<ConversationInterruptionResult> {
    return this.applySpeechObservation(meetingId, nowMs, (session, processedAtMs) =>
      session.speechEnded(nowMs, processedAtMs),
    );
  }

  /** Lets composition advance deterministic queue expiry without a timer. */
  public advanceMeeting(meetingId: string, nowMs: number): void {
    const state = this.meetings.get(meetingId);
    if (state !== undefined && !state.closing) {
      advanceConversationState(state, nowMs);
    }
  }

  public async closeMeeting(
    meetingId: string,
    nowMs: number,
    reason: "meeting-ended" | "runtime-shutdown" = "meeting-ended",
  ): Promise<void> {
    const state = this.meetings.get(meetingId);
    if (state === undefined) {
      return;
    }
    if (state.closing) {
      await waitForConversationTasks(state);
      return;
    }
    state.closing = true;
    advanceConversationState(state, nowMs);
    state.pending.clear();
    this.wakeLatches.clear(state);
    const cancellation = state.session.close(reason, state.lastObservedAtMs);
    if (cancellation.status === "requested") {
      await this.activeTurns.enactCancellation(state, cancellation);
    }
    await waitForConversationTasks(state);
    if (this.meetings.get(meetingId) === state) {
      this.meetings.delete(meetingId);
    }
  }

  public async close(nowMs: number): Promise<void> {
    const closures: Promise<void>[] = [];
    for (const meetingId of this.meetings.keys()) {
      closures.push(this.closeMeeting(meetingId, nowMs, "runtime-shutdown"));
    }
    await Promise.all(closures);
  }

  /** Test and shutdown helper. It awaits work already started by this coordinator. */
  public async whenIdle(meetingId: string): Promise<void> {
    const state = this.meetings.get(meetingId);
    if (state === undefined) {
      return;
    }

    await waitForConversationTasks(state);
  }

  /** Waits for this turn's work and reports whether audio really reached playback. */
  public async whenTurnPlaybackSettled(
    meetingId: string,
    turnId: string,
  ): Promise<ConversationTurnPlaybackSettlement> {
    const state = this.meetings.get(meetingId);
    if (state === undefined) {
      return "unknown";
    }
    for (;;) {
      const settlement = state.playbackSettlements.get(turnId);
      if (settlement !== undefined) {
        return settlement;
      }
      const tasks = [...state.tasks];
      if (tasks.length === 0) {
        return "unknown";
      }
      await Promise.race(tasks.map(async (task) => {
        try {
          await task;
        } catch {
          // The settlement lookup remains the source of truth after task failure.
        }
      }));
    }
  }

  private async handleLatchedPrompt(
    input: FinalizedConversationTurnInput,
  ): Promise<ConversationCoordinatorResult> {
    const state = this.meetings.get(input.meetingId);
    if (state === undefined || state.closing) {
      return Object.freeze({ status: "ignored" as const });
    }

    const prompt = this.wakeLatches.consumePrompt(state, input);
    if (prompt === null) {
      return Object.freeze({ status: "ignored" as const });
    }

    advanceConversationState(state, input.nowMs);
    this.wakeLatches.clearForSpeaker(state, input.speakerId);
    return this.admitPrompt(state, input, prompt);
  }

  private async admitPrompt(
    state: MeetingConversationState,
    input: FinalizedConversationTurnInput,
    prompt: string,
  ): Promise<ConversationCoordinatorResult> {
    const admission = this.wakeLatches.admit(state, input, prompt);
    if (admission.turnToStart !== null) {
      trackConversationTask(state, this.activeTurns.start(state, admission.turnToStart));
    }
    return admission.result;
  }

  private async applySpeechObservation(
    meetingId: string,
    nowMs: number,
    observe: SpeechObservation,
  ): Promise<ConversationInterruptionResult> {
    const state = this.meetings.get(meetingId);
    if (state === undefined || state.closing) {
      return Object.freeze({ status: "ignored" as const });
    }
    return this.activeTurns.observeSpeech(state, nowMs, observe);
  }

  private stateFor(meetingId: string): MeetingConversationState {
    const existing = this.meetings.get(meetingId);
    if (existing !== undefined) {
      return existing;
    }

    const state = createMeetingConversationState(meetingId);
    this.meetings.set(meetingId, state);
    return state;
  }
}
