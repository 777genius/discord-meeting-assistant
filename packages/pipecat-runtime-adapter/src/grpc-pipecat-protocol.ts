import {
  conversationRuntimeProtocolVersion,
  parseConversationRuntimeEvent,
  parseConversationRuntimeHealth,
  type ConversationRuntimeEvent as TransportEvent,
  type ConversationRuntimeHealth,
  type ConversationRuntimeStartTurn,
} from "@discord-meeting/conversation-runtime-contracts";
import {
  type ConversationCancellationReason,
  type ConversationRuntimeEvent,
} from "@discord-meeting/meeting-core/conversation";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { RawMessage } from "./grpc-pipecat-types.js";

const cancellationReasons = {
  "barge-in": "CONVERSATION_CANCELLATION_REASON_BARGE_IN",
  disconnected: "CONVERSATION_CANCELLATION_REASON_RUNTIME_SHUTDOWN",
  "meeting-ended": "CONVERSATION_CANCELLATION_REASON_MEETING_ENDED",
  "playback-failed": "CONVERSATION_CANCELLATION_REASON_PLAYBACK_FAILED",
  "runtime-shutdown": "CONVERSATION_CANCELLATION_REASON_RUNTIME_SHUTDOWN",
  superseded: "CONVERSATION_CANCELLATION_REASON_SUPERSEDED",
} satisfies Record<ConversationCancellationReason, string>;

export function createGrpcConversationStartMessage(
  request: ConversationRuntimeStartTurn,
): RawMessage {
  return {
    schemaVersion: conversationRuntimeProtocolVersion,
    startTurn: {
      meetingId: request.meetingId,
      recordingId: request.recordingId,
      turnId: request.turnId,
      speakerId: request.speakerId,
      idempotencyKey: request.idempotencyKey,
      turnEndedAtUnixMs: request.latency?.turnEndedAtUnixMs ?? 0,
      wakeDetectedAtUnixMs: request.latency?.wakeDetectedAtUnixMs ?? 0,
      systemPrompt: request.systemPrompt,
      prompt: request.prompt,
      ...(request.literalSpeech === undefined
        ? {}
        : { literalSpeech: request.literalSpeech }),
      locale: request.locale,
      voiceProfileId: request.voiceProfileId,
    },
  };
}

export function createGrpcConversationCancellationMessage(
  turnId: string,
  attemptId: string,
  reason: ConversationCancellationReason,
): RawMessage {
  return {
    schemaVersion: conversationRuntimeProtocolVersion,
    cancelTurn: {
      turnId,
      attemptId,
      reason: cancellationReasons[reason],
    },
  };
}

export function parseGrpcConversationRuntimeHealth(
  response: RawMessage,
): ConversationRuntimeHealth {
  return parseConversationRuntimeHealth({
    status: healthStatus(response.status),
    runtimeName: requiredString(response.runtimeName, "runtimeName"),
    runtimeVersion: requiredString(response.runtimeVersion, "runtimeVersion"),
    warningCodes: stringArray(response.warningCodes, "warningCodes"),
  });
}

export function decodeGrpcConversationRuntimeEvent(
  message: RawMessage,
  attestationKey?: string,
): TransportEvent {
  const base = {
    protocolVersion: integerValue(message.schemaVersion, "schemaVersion"),
    turnId: requiredString(message.turnId, "turnId"),
    attemptId: requiredString(message.attemptId, "attemptId"),
    eventSequence: integerValue(message.eventSequence, "eventSequence"),
  };
  const payload = requiredString(message.payload, "payload");
  if (payload === "accepted") {
    return parseConversationRuntimeEvent({ ...base, type: "accepted" });
  }
  if (payload === "ttsAttestation") {
    const value = recordValue(message.ttsAttestation, "ttsAttestation");
    const event = parseConversationRuntimeEvent({
      ...base,
      type: "tts-attestation",
      deployment: requiredString(value.deployment, "ttsAttestation.deployment"),
      keyId: requiredString(value.keyId, "ttsAttestation.keyId"),
      model: requiredString(value.model, "ttsAttestation.model"),
      provider: requiredString(value.provider, "ttsAttestation.provider"),
      signature: requiredString(value.signature, "ttsAttestation.signature"),
      sourceRevision: requiredString(value.sourceRevision, "ttsAttestation.sourceRevision"),
      voice: requiredString(value.voice, "ttsAttestation.voice"),
      voiceProfileId: requiredString(value.voiceProfileId, "ttsAttestation.voiceProfileId"),
    });
    if (event.type !== "tts-attestation") {
      throw new Error("Conversation runtime TTS attestation payload is invalid");
    }
    if (attestationKey === undefined || !verifyTtsAttestation(event, attestationKey)) {
      throw new Error("Conversation runtime TTS attestation signature is invalid");
    }
    return event;
  }
  if (payload === "textDelta") {
    const value = recordValue(message.textDelta, "textDelta");
    return parseConversationRuntimeEvent({
      ...base,
      type: "text-delta",
      text: requiredString(value.text, "textDelta.text"),
    });
  }
  if (payload === "audioStart") {
    const value = recordValue(message.audioStart, "audioStart");
    return parseConversationRuntimeEvent({
      ...base,
      type: "audio-start",
      format: audioFormat(value.format),
      sampleRateHz: integerValue(value.sampleRateHz, "audioStart.sampleRateHz"),
      channels: integerValue(value.channels, "audioStart.channels"),
    });
  }
  if (payload === "audioChunk") {
    const value = recordValue(message.audioChunk, "audioChunk");
    return parseConversationRuntimeEvent({
      ...base,
      type: "audio-chunk",
      audioSequence: integerValue(value.audioSequence, "audioChunk.audioSequence"),
      format: audioFormat(value.format),
      sampleRateHz: integerValue(value.sampleRateHz, "audioChunk.sampleRateHz"),
      channels: integerValue(value.channels, "audioChunk.channels"),
      pcm: bytesValue(value.pcm, "audioChunk.pcm"),
    });
  }
  if (payload === "audioEnd") {
    return parseConversationRuntimeEvent({ ...base, type: "audio-end" });
  }
  if (payload === "usage") {
    const value = recordValue(message.usage, "usage");
    return parseConversationRuntimeEvent({
      ...base,
      type: "usage",
      inputTokens: integerValue(value.inputTokens, "usage.inputTokens"),
      outputTokens: integerValue(value.outputTokens, "usage.outputTokens"),
      totalTokens: integerValue(value.totalTokens, "usage.totalTokens"),
    });
  }
  if (payload === "latency") {
    const value = recordValue(message.latency, "latency");
    return parseConversationRuntimeEvent({
      ...base,
      type: "latency",
      endTurnToWakeMs: integerValue(value.endTurnToWakeMs, "latency.endTurnToWakeMs"),
      wakeToFirstLlmTokenMs: integerValue(
        value.wakeToFirstLlmTokenMs,
        "latency.wakeToFirstLlmTokenMs",
      ),
      firstLlmTokenToAudioMs: integerValue(
        value.firstLlmTokenToAudioMs,
        "latency.firstLlmTokenToAudioMs",
      ),
      totalToFirstAudioMs: integerValue(
        value.totalToFirstAudioMs,
        "latency.totalToFirstAudioMs",
      ),
    });
  }
  if (payload === "completed") {
    return parseConversationRuntimeEvent({ ...base, type: "completed" });
  }
  if (payload === "cancelled") {
    const value = recordValue(message.cancelled, "cancelled");
    return parseConversationRuntimeEvent({
      ...base,
      type: "cancelled",
      reason: cancellationReason(value.reason),
    });
  }
  if (payload === "failed") {
    const value = recordValue(message.failed, "failed");
    return parseConversationRuntimeEvent({
      ...base,
      type: "failed",
      code: requiredString(value.code, "failed.code"),
      safeMessage: requiredString(value.safeMessage, "failed.safeMessage"),
      retryable: value.retryable === true,
    });
  }
  throw new Error(`Conversation runtime payload is unsupported: ${payload}`);
}

export function toCoreConversationRuntimeEvent(
  event: TransportEvent,
): ConversationRuntimeEvent {
  if (event.type === "audio-chunk") {
    return {
      type: "audio-chunk",
      attemptId: event.attemptId,
      turnId: event.turnId,
      sequence: event.audioSequence,
      format: event.format,
      sampleRateHz: event.sampleRateHz,
      channels: event.channels,
      bytes: event.pcm,
    };
  }
  if (event.type === "tts-attestation") {
    return {
      type: "tts-attestation",
      attemptId: event.attemptId,
      attestation: {
        attemptId: event.attemptId,
        deployment: event.deployment,
        keyId: event.keyId,
        model: event.model,
        provider: event.provider,
        schemaVersion: 1,
        signature: event.signature,
        sourceRevision: event.sourceRevision,
        turnId: event.turnId,
        voice: event.voice,
        voiceProfileId: event.voiceProfileId,
      },
    };
  }
  if (event.type === "failed") {
    return {
      type: "failed",
      attemptId: event.attemptId,
      failure: {
        code: event.code,
        message: event.safeMessage,
        retryable: event.retryable,
      },
    };
  }
  if (event.type === "text-delta") {
    return { type: "text-delta", attemptId: event.attemptId, text: event.text };
  }
  if (event.type === "audio-start") {
    return {
      type: "audio-start",
      attemptId: event.attemptId,
      format: event.format,
      sampleRateHz: event.sampleRateHz,
      channels: event.channels,
    };
  }
  if (event.type === "usage") {
    return {
      type: "usage",
      attemptId: event.attemptId,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      totalTokens: event.totalTokens,
    };
  }
  if (event.type === "latency") {
    return {
      type: "latency",
      attemptId: event.attemptId,
      endTurnToWakeMs: event.endTurnToWakeMs,
      wakeToFirstLlmTokenMs: event.wakeToFirstLlmTokenMs,
      firstLlmTokenToAudioMs: event.firstLlmTokenToAudioMs,
      totalToFirstAudioMs: event.totalToFirstAudioMs,
    };
  }
  if (event.type === "cancelled") {
    return {
      type: "cancelled",
      attemptId: event.attemptId,
      reason: event.reason,
    };
  }
  return { type: event.type, attemptId: event.attemptId };
}

function verifyTtsAttestation(
  event: Extract<TransportEvent, { readonly type: "tts-attestation" }>,
  key: string,
): boolean {
  const expectedKeyId = createHash("sha256").update(key, "utf8").digest("hex");
  if (event.keyId !== expectedKeyId) {
    return false;
  }
  const canonical = [
    "schemaVersion=1",
    `turnId=${event.turnId}`,
    `attemptId=${event.attemptId}`,
    `voiceProfileId=${event.voiceProfileId}`,
    `deployment=${event.deployment}`,
    `sourceRevision=${event.sourceRevision}`,
    `provider=${event.provider}`,
    `model=${event.model}`,
    `voice=${event.voice}`,
  ].join("\n");
  const expected = createHmac("sha256", key).update(canonical, "utf8").digest();
  const actual = Buffer.from(event.signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isGrpcConversationTerminalEvent(event: TransportEvent): boolean {
  return event.type === "completed" || event.type === "cancelled" || event.type === "failed";
}

function cancellationReason(value: unknown): ConversationCancellationReason {
  const normalized = requiredString(value, "cancellation reason");
  if (normalized === cancellationReasons["barge-in"]) {
    return "barge-in";
  }
  if (normalized === cancellationReasons["meeting-ended"]) {
    return "meeting-ended";
  }
  if (normalized === cancellationReasons["playback-failed"]) {
    return "playback-failed";
  }
  if (normalized === cancellationReasons["runtime-shutdown"]) {
    return "runtime-shutdown";
  }
  if (normalized === cancellationReasons.superseded) {
    return "superseded";
  }
  throw new Error("Conversation cancellation reason is unsupported");
}

function audioFormat(value: unknown): "pcm_s16le" {
  if (value !== "CONVERSATION_AUDIO_FORMAT_PCM_S16LE" && value !== "1") {
    throw new Error("Conversation audio format is unsupported");
  }
  return "pcm_s16le";
}

function recordValue(value: unknown, field: string): RawMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const record: RawMessage = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function integerValue(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a safe non-negative integer`);
  }
  return parsed;
}

function bytesValue(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${field} must be bytes`);
  }
  return new Uint8Array(value);
}

function healthStatus(value: unknown): ConversationRuntimeHealth["status"] {
  if (value === "STATUS_SERVING" || value === "1" || value === 1) {
    return "serving";
  }
  if (value === "STATUS_DEGRADED" || value === "2" || value === 2) {
    return "degraded";
  }
  if (value === "STATUS_NOT_SERVING" || value === "3" || value === 3) {
    return "not-serving";
  }
  throw new Error("Conversation runtime returned an unknown health status");
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...value];
}
