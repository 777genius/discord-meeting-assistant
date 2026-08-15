import type {
  ConversationLatencyObserverPort,
  ConversationPlaybackObserverPort,
  ConversationPlaybackSettlement,
  ConversationRuntimeEvent,
} from "./ports/conversation.js";
import type { ActiveConversationRun } from "./conversation-coordinator-types.js";

export function observeConversationLatency(
  observer: ConversationLatencyObserverPort | null,
  run: ActiveConversationRun,
  event: Extract<ConversationRuntimeEvent, { readonly type: "latency" }>,
): void {
  safelyObserve(() => observer?.observeConversationLatency({
    attemptId: event.attemptId,
    endTurnToWakeMs: event.endTurnToWakeMs,
    firstLlmTokenToAudioMs: event.firstLlmTokenToAudioMs,
    meetingId: run.prepared.request.meetingId,
    totalToFirstAudioMs: event.totalToFirstAudioMs,
    turnId: run.prepared.request.turnId,
    wakeToFirstLlmTokenMs: event.wakeToFirstLlmTokenMs,
  }));
}

export function observeConversationPlaybackSettlement(
  observer: ConversationPlaybackObserverPort | null,
  run: ActiveConversationRun,
  settlement: ConversationPlaybackSettlement,
  settledAtMs: number,
): void {
  safelyObserve(() => observer?.observeConversationPlayback({
    ...playbackProvenance(run),
    meetingId: run.prepared.request.meetingId,
    playbackAttemptId: run.attemptId!,
    playbackKind: run.prepared.cue === undefined ? "answer" : "prepared-cue",
    settledAtMs,
    settlement,
    status: "settled",
    turnId: run.prepared.request.turnId,
  }));
}

export function playbackProvenance(run: ActiveConversationRun): {
  readonly preparedAssetSha256?: string;
  readonly speechProvenance?: "literal_tts" | "model_tts";
} {
  if (run.prepared.cue !== undefined) {
    return run.prepared.cue.assetSha256 === undefined
      ? {}
      : { preparedAssetSha256: run.prepared.cue.assetSha256 };
  }
  return {
    speechProvenance: run.prepared.request.literalSpeech === undefined
      ? "model_tts"
      : "literal_tts",
  };
}

function safelyObserve(observe: () => Promise<void> | void | undefined): void {
  try {
    const result = observe();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {
        // Observability must never alter conversation delivery or cancellation.
      });
    }
  } catch {
    // Observability must never alter conversation delivery or cancellation.
  }
}
