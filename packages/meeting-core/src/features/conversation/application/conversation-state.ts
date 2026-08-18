import { ConversationSession } from "../domain/conversation.js";
import { requireNonNegativeInteger } from "../domain/errors.js";
import type {
  ActiveConversationRun,
  ConversationPlaybackFence,
  ConversationTurnPlaybackStart,
  ConversationTurnPlaybackSettlement,
  MeetingConversationState,
  PreparedConversation,
} from "./conversation-coordinator-types.js";

const maximumRememberedPlaybackSettlements = 1_024;

export function createActiveConversationRun(
  prepared: PreparedConversation,
): ActiveConversationRun {
  return {
    answerAudioStarted: false,
    answerAudioWriteAttempted: false,
    answerAudioWritten: false,
    attemptId: null,
    cancellationInFlight: false,
    cueDelays: new Set(),
    cuePlayback: null,
    cuePlaybackOpening: false,
    deliberationCue: null,
    deliberationCueReady: false,
    deliberationCueSelectionInFlight: false,
    finalized: false,
    groundedPlaybackAbortController: null,
    groundedPlaybackAuthority: null,
    playback: null,
    playbackEventsClosed: false,
    playbackFinishRequested: false,
    playbackFinished: false,
    playbackOpenAbortController: null,
    playbackTerminalFinalizationScheduled: false,
    playbackTerminalReceiptMissing: false,
    prepared,
    runtimeCompleted: false,
    runtimeStartAbortController: null,
    runtimeTurn: null,
    ttsAttestation: null,
  };
}

export function createMeetingConversationState(
  meetingId: string,
): MeetingConversationState {
  return {
    active: null,
    admissionFingerprints: new Map(),
    closing: false,
    lastObservedAtMs: 0,
    latestWakeAtBySpeaker: new Map(),
    pending: new Map(),
    playbackFence: null,
    playbackOpenBarrier: Promise.resolve(),
    playbackStartSignals: new Map(),
    playbackStarts: new Map(),
    playbackSettlements: new Map(),
    session: new ConversationSession(meetingId),
    tasks: new Set(),
    wakeLatches: new Map(),
    wakeTurnReceipts: new Map(),
  };
}

export function rememberConversationPlaybackSettlement(
  state: MeetingConversationState,
  turnId: string,
  settlement: ConversationTurnPlaybackSettlement,
): void {
  if (state.playbackSettlements.size >= maximumRememberedPlaybackSettlements) {
    const oldestTurnId = state.playbackSettlements.keys().next().value;
    if (oldestTurnId !== undefined) {
      state.playbackSettlements.delete(oldestTurnId);
    }
  }
  state.playbackSettlements.set(turnId, settlement);
  if (!state.playbackStarts.has(turnId)) {
    if (settlement === "unplayed") {
      rememberConversationPlaybackStart(state, turnId, { status: "unplayed" });
    } else {
      state.playbackStartSignals.get(turnId)?.resolve({ status: "unknown" });
      state.playbackStartSignals.delete(turnId);
    }
  }
}

export function rememberConversationPlaybackStart(
  state: MeetingConversationState,
  turnId: string,
  start: Exclude<ConversationTurnPlaybackStart, { readonly status: "unknown" }>,
): void {
  if (state.playbackStarts.has(turnId)) {
    return;
  }
  if (state.playbackStarts.size >= maximumRememberedPlaybackSettlements) {
    const oldestTurnId = state.playbackStarts.keys().next().value;
    if (oldestTurnId !== undefined) {
      state.playbackStarts.delete(oldestTurnId);
      state.playbackStartSignals.delete(oldestTurnId);
    }
  }
  state.playbackStarts.set(turnId, start);
  state.playbackStartSignals.get(turnId)?.resolve(start);
  state.playbackStartSignals.delete(turnId);
}

export function conversationPlaybackStartSignal(
  state: MeetingConversationState,
  turnId: string,
): Promise<ConversationTurnPlaybackStart> {
  const remembered = state.playbackStarts.get(turnId);
  if (remembered !== undefined) {
    return Promise.resolve(remembered);
  }
  const existing = state.playbackStartSignals.get(turnId);
  if (existing !== undefined) {
    return existing.promise;
  }
  let resolveSignal!: (value: ConversationTurnPlaybackStart) => void;
  const promise = new Promise<ConversationTurnPlaybackStart>((resolve) => {
    resolveSignal = resolve;
  });
  state.playbackStartSignals.set(turnId, { promise, resolve: resolveSignal });
  return promise;
}

export function advanceConversationState(
  state: MeetingConversationState,
  nowMs: number,
): number {
  const observedAtMs = requireNonNegativeInteger(nowMs, "conversation.nowMs");
  const processedAtMs = Math.max(state.lastObservedAtMs, observedAtMs);
  const expired = state.session.advance(processedAtMs);
  state.lastObservedAtMs = processedAtMs;
  if (expired !== null) {
    state.pending.delete(expired.turnId);
    rememberConversationPlaybackSettlement(state, expired.turnId, "unplayed");
  }
  return processedAtMs;
}

export function isCurrentConversationRun(
  state: MeetingConversationState,
  run: ActiveConversationRun,
): boolean {
  return state.active === run && !run.finalized;
}

export function shouldDiscardOpenedConversationPlayback(
  state: MeetingConversationState,
  run: ActiveConversationRun,
): boolean {
  return !isCurrentConversationRun(state, run) || run.cancellationInFlight;
}

export function matchesConversationAttempt(
  run: ActiveConversationRun,
  attemptId: string,
): boolean {
  return run.attemptId !== null && run.attemptId === attemptId;
}

export function trackConversationTask(
  state: MeetingConversationState,
  task: Promise<void>,
): void {
  state.tasks.add(task);
  void task.then(
    () => {
      state.tasks.delete(task);
      return null;
    },
    () => {
      state.tasks.delete(task);
      return null;
    },
  );
}

export async function waitForConversationTasks(
  state: MeetingConversationState,
): Promise<void> {
  while (state.tasks.size > 0) {
    await Promise.all(state.tasks);
  }
}

export async function withConversationPlaybackOpen<Value>(
  state: MeetingConversationState,
  operation: () => Promise<Value>,
): Promise<Value> {
  const previous = state.playbackOpenBarrier;
  let release!: () => void;
  state.playbackOpenBarrier = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    await waitForConversationPlaybackTerminal(state);
    return await operation();
  } finally {
    release();
  }
}

/**
 * Acquires the sole audio lease before an adapter open is attempted. A failed
 * open releases it explicitly; a successful open must be released only by the
 * matching terminal playback event.
 */
export function beginConversationPlaybackFence(
  state: MeetingConversationState,
): ConversationPlaybackFence {
  if (state.playbackFence !== null) {
    throw new Error("conversation playback opened before its predecessor terminated");
  }

  let releaseTerminalReceipt!: () => void;
  const fence: ConversationPlaybackFence = {
    receiptState: "awaiting",
    releaseTerminalReceipt: () => {
      if (fence.receiptState !== "received") {
        fence.receiptState = "received";
        releaseTerminalReceipt();
      }
    },
    terminalReceipt: new Promise<void>((resolve) => {
      releaseTerminalReceipt = resolve;
    }),
  };
  state.playbackFence = fence;
  return fence;
}

/** A concrete terminal event proves the transport no longer owns audible audio. */
export function confirmConversationPlaybackTerminal(
  state: MeetingConversationState,
  fence: ConversationPlaybackFence,
): void {
  if (state.playbackFence !== fence) {
    return;
  }
  state.playbackFence = null;
  fence.releaseTerminalReceipt();
}

/**
 * Stream exhaustion is not a terminal receipt. Leave the lease held
 * fail-closed until an explicit receipt arrives (or an operator tears down the
 * meeting), rather than treating it as a successful stop.
 */
export function markConversationPlaybackTerminalMissing(
  state: MeetingConversationState,
  fence: ConversationPlaybackFence,
): void {
  if (state.playbackFence === fence && fence.receiptState === "awaiting") {
    fence.receiptState = "missing";
  }
}

function waitForConversationPlaybackTerminal(
  state: MeetingConversationState,
): Promise<void> {
  return state.playbackFence?.terminalReceipt ?? Promise.resolve();
}

export async function ignoreConversationFailure(
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch {
    // Runtime cancellation is best-effort. Playback slots are guarded separately.
  }
}
