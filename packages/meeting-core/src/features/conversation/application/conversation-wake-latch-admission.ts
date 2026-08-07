import {
  CONVERSATION_WAKE_LATCH_MS,
  createConversationTurn,
  type ConversationAlias,
} from "../domain/conversation.js";
import { DomainInvariantError, requireNonNegativeInteger } from "../domain/errors.js";
import type {
  ConversationCoordinatorResult,
  ConversationWakeTurnReceipt,
  FinalizedConversationTurnInput,
  MeetingConversationState,
  PreparedConversation,
  ProactiveConversationTurnInput,
} from "./conversation-coordinator-types.js";

interface TranscriptTimeline {
  readonly endMs: number;
  readonly startMs: number;
}

export interface ConversationPromptAdmission {
  readonly result: ConversationCoordinatorResult;
  readonly turnToStart: string | null;
}

const maximumRememberedWakeTurns = 1_024;

function identityPart(value: string): string {
  return `${value.length}:${value}`;
}

function conversationIdempotencyKey(input: FinalizedConversationTurnInput): string {
  return [
    "live-conversation:v1",
    input.meetingId,
    input.recordingId,
    input.turnId,
  ].map(identityPart).join("|");
}

function proactiveConversationIdempotencyKey(
  input: ProactiveConversationTurnInput,
): string {
  return [
    "proactive-conversation:v1",
    input.meetingId,
    input.recordingId,
    input.turnId,
  ].map(identityPart).join("|");
}

function normalizedTranscriptPrompt(text: string): string {
  return text.normalize("NFKC").trim();
}

function transcriptTimeline(input: FinalizedConversationTurnInput): TranscriptTimeline {
  const startMs = requireNonNegativeInteger(
    input.transcriptStartMs,
    "conversation.transcriptStartMs",
  );
  const endMs = requireNonNegativeInteger(
    input.transcriptEndMs,
    "conversation.transcriptEndMs",
  );
  if (endMs < startMs) {
    throw new DomainInvariantError(
      "INVALID_NUMBER",
      "conversation.transcriptEndMs must not be before transcriptStartMs",
    );
  }
  return { endMs, startMs };
}

/**
 * Owns only transcript-time wake latches and conversion of an accepted prompt
 * into Meeting Core's deterministic conversation-session admission.
 */
export class ConversationWakeLatchAdmission {
  public arm(
    state: MeetingConversationState,
    input: FinalizedConversationTurnInput,
    alias: ConversationAlias,
  ): ConversationCoordinatorResult {
    const timeline = transcriptTimeline(input);
    const receipt = state.wakeTurnReceipts.get(input.turnId);
    if (receipt !== undefined) {
      if (
        receipt.alias !== alias ||
        receipt.speakerId !== input.speakerId ||
        receipt.armedAtTranscriptMs !== timeline.endMs
      ) {
        throw new DomainInvariantError(
          "CONFLICTING_COMPLETION",
          "conversation wake turn was replayed with different content",
        );
      }
      return Object.freeze({
        alias: receipt.alias,
        latchExpiresAtTranscriptMs: receipt.expiresAtTranscriptMs,
        status: "awaiting-prompt" as const,
        turnId: input.turnId,
      });
    }

    const latchExpiresAtTranscriptMs = timeline.endMs + CONVERSATION_WAKE_LATCH_MS;
    if (!Number.isSafeInteger(latchExpiresAtTranscriptMs)) {
      throw new DomainInvariantError(
        "INVALID_NUMBER",
        "conversation wake latch expiry must be a safe integer",
      );
    }

    const wakeLatch = {
      armedAtTranscriptMs: timeline.endMs,
      expiresAtTranscriptMs: latchExpiresAtTranscriptMs,
      turnId: input.turnId,
    } as const;
    const latestWakeAt = state.latestWakeAtBySpeaker.get(input.speakerId);
    if (latestWakeAt === undefined || timeline.endMs >= latestWakeAt) {
      state.latestWakeAtBySpeaker.set(input.speakerId, timeline.endMs);
      state.wakeLatches.set(input.speakerId, wakeLatch);
    }
    this.remember(state, { ...wakeLatch, alias, speakerId: input.speakerId });
    return Object.freeze({
      alias,
      latchExpiresAtTranscriptMs,
      status: "awaiting-prompt" as const,
      turnId: input.turnId,
    });
  }

  public consumePrompt(
    state: MeetingConversationState,
    input: FinalizedConversationTurnInput,
  ): string | null {
    const latch = state.wakeLatches.get(input.speakerId);
    if (latch === undefined) {
      return null;
    }

    const timeline = transcriptTimeline(input);
    if (timeline.startMs > latch.expiresAtTranscriptMs) {
      state.wakeLatches.delete(input.speakerId);
      return null;
    }
    if (timeline.startMs < latch.armedAtTranscriptMs) {
      return null;
    }

    const prompt = normalizedTranscriptPrompt(input.text);
    return prompt.length === 0 ? null : prompt;
  }

  public clearForSpeaker(state: MeetingConversationState, speakerId: string): void {
    state.wakeLatches.delete(speakerId);
  }

  public clear(state: MeetingConversationState): void {
    state.wakeLatches.clear();
  }

  public admit(
    state: MeetingConversationState,
    input: FinalizedConversationTurnInput,
    prompt: string,
  ): ConversationPromptAdmission {
    const turn = createConversationTurn({
      meetingId: input.meetingId,
      prompt,
      speakerId: input.speakerId,
      turnId: input.turnId,
    });
    return this.admitPrepared(state, {
      request: {
        idempotencyKey: conversationIdempotencyKey(input),
        locale: input.locale,
        meetingId: input.meetingId,
        prompt,
        recordingId: input.recordingId,
        speakerId: input.speakerId,
        systemPrompt: input.systemPrompt,
        turnId: input.turnId,
        voiceProfileId: input.voiceProfileId,
      },
      thinkingCueLocale: input.thinkingCueLocale,
      thinkingCuesEnabled: true,
      turn,
    });
  }

  public admitProactive(
    state: MeetingConversationState,
    input: ProactiveConversationTurnInput,
  ): ConversationPromptAdmission {
    const prompt = input.prompt.normalize("NFKC").trim();
    const turn = createConversationTurn({
      meetingId: input.meetingId,
      prompt,
      speakerId: input.speakerId,
      turnId: input.turnId,
    });
    return this.admitPrepared(state, {
      request: {
        idempotencyKey: proactiveConversationIdempotencyKey(input),
        locale: input.locale,
        meetingId: input.meetingId,
        prompt,
        recordingId: input.recordingId,
        speakerId: input.speakerId,
        systemPrompt: input.systemPrompt,
        turnId: input.turnId,
        voiceProfileId: input.voiceProfileId,
      },
      thinkingCueLocale: input.locale,
      thinkingCuesEnabled: false,
      turn,
    });
  }

  private admitPrepared(
    state: MeetingConversationState,
    prepared: PreparedConversation,
  ): ConversationPromptAdmission {
    const admission = state.session.admit(
      prepared.turn,
      state.lastObservedAtMs,
    );

    if (admission.status === "reused") {
      return {
        result: Object.freeze({
          disposition: admission.disposition,
          status: "reused" as const,
          turnId: admission.turnId,
        }),
        turnToStart: null,
      };
    }
    if (admission.status === "busy") {
      return {
        result: Object.freeze({ status: "busy" as const, turnId: admission.turnId }),
        turnToStart: null,
      };
    }

    state.pending.set(prepared.turn.turnId, prepared);
    if (admission.status === "active") {
      return {
        result: Object.freeze({
          prompt: prepared.turn.prompt,
          status: "active" as const,
          turnId: prepared.turn.turnId,
          usedFallbackPrompt: false,
        }),
        turnToStart: prepared.turn.turnId,
      };
    }
    return {
      result: Object.freeze({
        expiresAtMs: admission.expiresAtMs,
        prompt: prepared.turn.prompt,
        status: "queued" as const,
        turnId: prepared.turn.turnId,
        usedFallbackPrompt: false,
      }),
      turnToStart: null,
    };
  }

  private prepare(
    input: FinalizedConversationTurnInput,
    prompt: string,
    turn: PreparedConversation["turn"],
  ): PreparedConversation {
    const latency = conversationLatencyContext(input);
    return {
      request: {
        idempotencyKey: conversationIdempotencyKey(input),
        ...(latency === undefined ? {} : { latency }),
        locale: input.locale,
        meetingId: input.meetingId,
        prompt,
        recordingId: input.recordingId,
        speakerId: input.speakerId,
        systemPrompt: input.systemPrompt,
        turnId: input.turnId,
        voiceProfileId: input.voiceProfileId,
      },
      thinkingCueLocale: input.thinkingCueLocale,
      turn,
    };
  }

  private remember(
    state: MeetingConversationState,
    receipt: ConversationWakeTurnReceipt,
  ): void {
    if (state.wakeTurnReceipts.size >= maximumRememberedWakeTurns) {
      const oldestTurnId = state.wakeTurnReceipts.keys().next().value;
      if (oldestTurnId !== undefined) {
        state.wakeTurnReceipts.delete(oldestTurnId);
      }
    }
    state.wakeTurnReceipts.set(receipt.turnId, receipt);
  }
}

function conversationLatencyContext(
  input: FinalizedConversationTurnInput,
): PreparedConversation["request"]["latency"] {
  const turnEndedAtUnixMs = input.turnEndedAtUnixMs;
  const wakeDetectedAtUnixMs = input.wakeDetectedAtUnixMs;
  if (turnEndedAtUnixMs === undefined || wakeDetectedAtUnixMs === undefined) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(turnEndedAtUnixMs) ||
    !Number.isSafeInteger(wakeDetectedAtUnixMs) ||
    turnEndedAtUnixMs < 0 ||
    wakeDetectedAtUnixMs < turnEndedAtUnixMs
  ) {
    return undefined;
  }
  return Object.freeze({ turnEndedAtUnixMs, wakeDetectedAtUnixMs });
}
