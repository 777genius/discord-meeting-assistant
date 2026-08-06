import { DomainInvariantError, requireNonEmpty, requireNonNegativeInteger } from "./errors.js";
import {
  createConversationTurn,
  type ConversationTurn,
  type ConversationTurnInput,
} from "./conversation-turn.js";
import type {
  ConversationAdmission,
  ConversationCancellation,
  ConversationCancellationReason,
  ConversationCompletion,
  ConversationTurnDisposition,
} from "./conversation-session-results.js";

export {
  CONVERSATION_ALIAS_ONLY_FALLBACK_PROMPT,
  detectAddressedConversation,
  shouldUseConversationDeliberationCue,
  type AddressedConversation,
  type ConversationAlias,
} from "./conversation-prompt-policy.js";
export {
  createConversationTurn,
  type ConversationTurn,
  type ConversationTurnInput,
} from "./conversation-turn.js";
export type {
  ConversationAdmission,
  ConversationCancellation,
  ConversationCancellationReason,
  ConversationCompletion,
  ConversationTurnDisposition,
} from "./conversation-session-results.js";

export const CONVERSATION_INTERRUPT_GUARD_MS = 4_000;
export const CONVERSATION_QUEUE_TTL_MS = 15_000;
export const CONVERSATION_THINKING_CUE_DELAY_MS = 1_300;
export const CONVERSATION_DELIBERATION_CUE_DELAY_MS = 3_200;
export const CONVERSATION_WAKE_LATCH_MS = 4_000;

interface ActiveConversation {
  cancellationReason: ConversationCancellationReason | null;
  playbackStartedAtMs: number | null;
  speechStartedAtMs: number | null;
  thinkingCueStartedAtMs: number | null;
  readonly turn: ConversationTurn;
}

interface QueuedConversation {
  readonly expiresAtMs: number;
  readonly turn: ConversationTurn;
}

/**
 * A deterministic, meeting-scoped policy object. Time advances only when the
 * caller supplies an explicit timestamp; this object never reads a clock.
 */
export class ConversationSession {
  private active: ActiveConversation | null = null;
  private lastObservedAtMs = 0;
  private readonly meetingId: string;
  private queued: QueuedConversation | null = null;
  private readonly turnDispositions = new Map<string, ConversationTurnDisposition>();

  public constructor(meetingId: string) {
    this.meetingId = requireNonEmpty(meetingId, "conversation.meetingId");
  }

  /** Advances queue expiry at a caller-supplied observation point. */
  public advance(nowMs: number): ConversationTurn | null {
    this.observe(nowMs);
    return this.expireQueued(nowMs);
  }

  public admit(input: ConversationTurnInput, nowMs: number): ConversationAdmission {
    this.observe(nowMs);
    this.expireQueued(nowMs);
    const turn = createConversationTurn(input);
    this.assertMeeting(turn);

    const disposition = this.turnDispositions.get(turn.turnId);
    if (disposition !== undefined) {
      return Object.freeze({
        disposition,
        status: "reused" as const,
        turnId: turn.turnId,
      });
    }

    if (this.active === null) {
      this.active = {
        cancellationReason: null,
        playbackStartedAtMs: null,
        speechStartedAtMs: null,
        thinkingCueStartedAtMs: null,
        turn,
      };
      this.turnDispositions.set(turn.turnId, "active");
      return Object.freeze({ status: "active" as const, turn });
    }

    if (this.queued === null) {
      const expiresAtMs = nowMs + CONVERSATION_QUEUE_TTL_MS;
      this.queued = { expiresAtMs, turn };
      this.turnDispositions.set(turn.turnId, "queued");
      return Object.freeze({ expiresAtMs, status: "queued" as const, turn });
    }

    this.turnDispositions.set(turn.turnId, "busy");
    return Object.freeze({ status: "busy" as const, turnId: turn.turnId });
  }

  /** Starts barge-in protection only after the playback transport confirms output. */
  public playbackStarted(
    turnId: string,
    observedAtMs: number,
    processedAtMs = observedAtMs,
  ): boolean {
    requireNonNegativeInteger(observedAtMs, "conversation.observedAtMs");
    this.observe(processedAtMs);
    this.expireQueued(processedAtMs);
    if (
      this.active === null ||
      this.active.turn.turnId !== turnId ||
      this.active.cancellationReason !== null
    ) {
      return false;
    }

    if (this.active.playbackStartedAtMs !== null) {
      return false;
    }

    this.active.playbackStartedAtMs = observedAtMs;
    this.active.speechStartedAtMs = null;
    this.active.thinkingCueStartedAtMs = null;
    return true;
  }

  /** A thinking cue is interruptible immediately and never starts the answer guard. */
  public thinkingCueStarted(
    turnId: string,
    observedAtMs: number,
    processedAtMs = observedAtMs,
  ): boolean {
    requireNonNegativeInteger(observedAtMs, "conversation.observedAtMs");
    this.observe(processedAtMs);
    this.expireQueued(processedAtMs);
    if (
      this.active === null ||
      this.active.turn.turnId !== turnId ||
      this.active.cancellationReason !== null ||
      this.active.playbackStartedAtMs !== null ||
      this.active.thinkingCueStartedAtMs !== null
    ) {
      return false;
    }

    this.active.thinkingCueStartedAtMs = observedAtMs;
    this.active.speechStartedAtMs = null;
    return true;
  }

  public speechStarted(
    observedAtMs: number,
    processedAtMs = observedAtMs,
  ): ConversationCancellation {
    requireNonNegativeInteger(observedAtMs, "conversation.observedAtMs");
    this.observe(processedAtMs);
    this.expireQueued(processedAtMs);
    const active = this.speechEligibleActive(observedAtMs);
    if (active === null) {
      return Object.freeze({ status: "ignored" as const });
    }

    active.speechStartedAtMs ??= observedAtMs;
    return this.cancelWhenGuardElapsed(observedAtMs, processedAtMs);
  }

  /** Call for subsequent VAD activity while the same participant is speaking. */
  public speechActivity(
    observedAtMs: number,
    processedAtMs = observedAtMs,
  ): ConversationCancellation {
    requireNonNegativeInteger(observedAtMs, "conversation.observedAtMs");
    this.observe(processedAtMs);
    this.expireQueued(processedAtMs);
    const active = this.speechEligibleActive(observedAtMs);
    if (active === null || active.speechStartedAtMs === null) {
      return Object.freeze({ status: "ignored" as const });
    }

    return this.cancelWhenGuardElapsed(observedAtMs, processedAtMs);
  }

  public speechEnded(
    observedAtMs: number,
    processedAtMs = observedAtMs,
  ): ConversationCancellation {
    requireNonNegativeInteger(observedAtMs, "conversation.observedAtMs");
    this.observe(processedAtMs);
    this.expireQueued(processedAtMs);
    const active = this.speechEligibleActive(observedAtMs);
    if (active === null || active.speechStartedAtMs === null) {
      return Object.freeze({ status: "ignored" as const });
    }

    const cancellation = this.cancelWhenGuardElapsed(
      observedAtMs,
      processedAtMs,
    );
    if (cancellation.status === "ignored") {
      active.speechStartedAtMs = null;
    }
    return cancellation;
  }

  public cancelActive(
    turnId: string,
    reason: ConversationCancellationReason,
    nowMs: number,
  ): ConversationCancellation {
    this.observe(nowMs);
    this.expireQueued(nowMs);
    if (
      this.active === null ||
      this.active.turn.turnId !== turnId ||
      this.active.cancellationReason !== null
    ) {
      return Object.freeze({ status: "ignored" as const });
    }

    this.active.cancellationReason = reason;
    this.active.speechStartedAtMs = null;
    this.turnDispositions.set(turnId, "cancelling");
    return Object.freeze({ reason, status: "requested" as const, turn: this.active.turn });
  }

  /** Cancels active work and discards queued operational state when a meeting ends. */
  public close(
    reason: ConversationCancellationReason,
    nowMs: number,
  ): ConversationCancellation {
    this.observe(nowMs);
    this.expireQueued(nowMs);
    if (this.queued !== null) {
      this.turnDispositions.set(this.queued.turn.turnId, "cancelled");
      this.queued = null;
    }
    if (this.active === null || this.active.cancellationReason !== null) {
      return Object.freeze({ status: "ignored" as const });
    }
    this.active.cancellationReason = reason;
    this.active.speechStartedAtMs = null;
    this.turnDispositions.set(this.active.turn.turnId, "cancelling");
    return Object.freeze({
      reason,
      status: "requested" as const,
      turn: this.active.turn,
    });
  }

  /** Completes exactly one active turn and promotes an unexpired queued turn. */
  public completeActive(turnId: string, nowMs: number): ConversationCompletion {
    this.observe(nowMs);
    this.expireQueued(nowMs);
    if (this.active === null || this.active.turn.turnId !== turnId) {
      return Object.freeze({ next: null, status: "ignored" as const });
    }

    const active = this.active;
    this.active = null;
    const status = active.cancellationReason === null ? "completed" : "cancelled";
    this.turnDispositions.set(active.turn.turnId, status);

    const next = this.queued;
    this.queued = null;
    if (next === null) {
      return Object.freeze({ next: null, status, turn: active.turn });
    }

    this.active = {
      cancellationReason: null,
      playbackStartedAtMs: null,
      speechStartedAtMs: null,
      thinkingCueStartedAtMs: null,
      turn: next.turn,
    };
    this.turnDispositions.set(next.turn.turnId, "active");
    return Object.freeze({ next: next.turn, status, turn: active.turn });
  }

  public isActive(turnId: string): boolean {
    return this.active?.turn.turnId === turnId;
  }

  private assertMeeting(turn: ConversationTurn): void {
    if (turn.meetingId !== this.meetingId) {
      throw new DomainInvariantError(
        "INVALID_LIFECYCLE_STATE",
        "conversation turn must belong to its session meeting",
      );
    }
  }

  private speechEligibleActive(observedAtMs: number): ActiveConversation | null {
    const active = this.active;
    const audibleStartedAtMs = active?.playbackStartedAtMs ?? active?.thinkingCueStartedAtMs;
    if (
      active === null ||
      active.cancellationReason !== null ||
      audibleStartedAtMs === null ||
      audibleStartedAtMs === undefined ||
      observedAtMs < audibleStartedAtMs
    ) {
      return null;
    }
    return active;
  }

  private cancelWhenGuardElapsed(
    observedAtMs: number,
    processedAtMs: number,
  ): ConversationCancellation {
    const active = this.active;
    if (active === null) {
      return Object.freeze({ status: "ignored" as const });
    }

    if (
      active.playbackStartedAtMs === null &&
      active.thinkingCueStartedAtMs !== null
    ) {
      return this.cancelActive(active.turn.turnId, "barge-in", processedAtMs);
    }
    if (active.playbackStartedAtMs === null) {
      return Object.freeze({ status: "ignored" as const });
    }

    const guardEndsAtMs = active.playbackStartedAtMs + CONVERSATION_INTERRUPT_GUARD_MS;
    if (observedAtMs < guardEndsAtMs) {
      return Object.freeze({ status: "ignored" as const });
    }

    return this.cancelActive(active.turn.turnId, "barge-in", processedAtMs);
  }

  private expireQueued(nowMs: number): ConversationTurn | null {
    if (this.queued === null || nowMs < this.queued.expiresAtMs) {
      return null;
    }

    const expired = this.queued.turn;
    this.queued = null;
    this.turnDispositions.set(expired.turnId, "expired");
    return expired;
  }

  private observe(nowMs: number): void {
    requireNonNegativeInteger(nowMs, "conversation.nowMs");
    if (nowMs < this.lastObservedAtMs) {
      throw new DomainInvariantError(
        "INVALID_NUMBER",
        "conversation timestamps must not move backwards",
      );
    }
    this.lastObservedAtMs = nowMs;
  }
}
