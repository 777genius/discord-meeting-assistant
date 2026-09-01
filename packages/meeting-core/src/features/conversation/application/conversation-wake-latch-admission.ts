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
  PreparedConversationCueInput,
  ProactiveConversationTurnInput,
} from "./conversation-coordinator-types.js";
import {
  normalizedLiteralSpeech,
  preparedConversationFingerprint,
} from "./conversation-admission-fingerprint.js";

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
    input.playbackAttemptId ?? input.turnId,
  ].map(identityPart).join("|");
}

function preparedCueIdempotencyKey(
  input: PreparedConversationCueInput,
): string {
  return [
    "prepared-conversation-cue:v1",
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
    const latency = conversationLatencyContext(input);
    return this.admitPrepared(state, {
      groundedKnowledgeRequest: {
        locale: input.locale,
        meetingId: input.meetingId,
        participantId: input.speakerId,
        question: prompt,
        roomId: input.roomId,
      },
      interruptible: true,
      preemptive: false,
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
      interruptible: input.interruptible ?? true,
      preemptive: input.preemptive ?? false,
      ...(input.playbackNotAfterMs === undefined ? {}
        : { playbackNotAfterMs: input.playbackNotAfterMs }),
      request: {
        idempotencyKey: proactiveConversationIdempotencyKey(input),
        locale: input.locale,
        ...(input.literalSpeech === undefined
          ? {}
          : { literalSpeech: normalizedLiteralSpeech(input.literalSpeech) }),
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

  public admitPreparedCue(
    state: MeetingConversationState,
    input: PreparedConversationCueInput,
  ): ConversationPromptAdmission {
    const turn = createConversationTurn({
      meetingId: input.meetingId,
      prompt: input.cueId,
      speakerId: input.speakerId,
      turnId: input.turnId,
    });
    if (input.pcmChunks.length === 0) {
      throw new DomainInvariantError(
        "INVALID_LIFECYCLE_STATE",
        "prepared conversation cue must contain PCM",
      );
    }
    if (input.assetSha256 !== undefined && !/^[a-f\d]{64}$/u.test(input.assetSha256)) {
      throw new DomainInvariantError(
        "INVALID_LIFECYCLE_STATE",
        "prepared conversation cue asset digest must be lowercase SHA-256",
      );
    }
    const pcmChunks = input.pcmChunks.map((chunk) => {
      if (chunk.byteLength === 0 || chunk.byteLength % 2 !== 0) {
        throw new DomainInvariantError(
          "INVALID_LIFECYCLE_STATE",
          "prepared conversation cue must contain sample-aligned PCM",
        );
      }
      return chunk.slice();
    });
    return this.admitPrepared(state, {
      cue: {
        ...(input.assetSha256 === undefined ? {} : { assetSha256: input.assetSha256 }),
        cueId: input.cueId,
        pcmChunks: Object.freeze(pcmChunks),
        playbackAttemptId: input.playbackAttemptId,
      },
      interruptible: input.interruptible ?? true,
      preemptive: input.preemptive ?? true,
      ...(input.playbackNotAfterMs === undefined ? {}
        : { playbackNotAfterMs: input.playbackNotAfterMs }),
      request: {
        idempotencyKey: preparedCueIdempotencyKey(input),
        locale: input.locale,
        meetingId: input.meetingId,
        prompt: input.cueId,
        recordingId: input.recordingId,
        speakerId: input.speakerId,
        systemPrompt: "Play the pre-generated audio cue.",
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
    const fingerprint = preparedConversationFingerprint(prepared);
    const priorFingerprint = state.admissionFingerprints.get(prepared.turn.turnId);
    if (priorFingerprint !== undefined && priorFingerprint !== fingerprint) {
      throw new DomainInvariantError(
        "DUPLICATE_IDENTIFIER",
        "conversation turn replay conflicts with its original request",
      );
    }
    const admission = state.session.admit(
      prepared.turn,
      state.lastObservedAtMs,
    );
    state.admissionFingerprints.set(prepared.turn.turnId, fingerprint);

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
      interruptible: true,
      preemptive: false,
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
      thinkingCuesEnabled: true,
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
