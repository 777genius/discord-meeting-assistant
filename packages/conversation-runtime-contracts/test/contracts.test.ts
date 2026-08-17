import { fileURLToPath } from "node:url";

import { loadSync } from "@grpc/proto-loader";
import { describe, expect, it } from "vitest";

import {
  conversationThinkingCueObserverReadySchema,
  conversationThinkingCuePlaybackIntentSchema,
  conversationRuntimeProtocolVersion,
  parseConversationRuntimeCancelTurn,
  parseConversationRuntimeEvent,
  parseConversationRuntimeHealth,
  parseConversationRuntimeStartTurn,
  serializeConversationThinkingCuePlaybackReadinessEnvelope,
} from "../src/index.js";

const baseEvent = {
  protocolVersion: conversationRuntimeProtocolVersion,
  turnId: "turn-1",
  attemptId: "attempt-1",
  eventSequence: 1,
} as const;

describe("conversation runtime contracts", () => {
  it("binds a thinking-cue intent and observer readiness to one exact playback", () => {
    const intent = conversationThinkingCuePlaybackIntentSchema.parse({
      capturePlan: "thinking-cue",
      kind: "thinking-cue",
      meetingId: "meeting-1",
      playbackAttemptId: "cue-attempt-turn-1-acknowledgement",
      protocolVersion: 1,
      runId: "campaign-run-1",
      turnId: "turn-1",
      type: "playback-intent",
    });
    const ready = conversationThinkingCueObserverReadySchema.parse({
      ...intent,
      authenticatedObserverBotId: "123456789012345678",
      intentDigestSha256: "a".repeat(64),
      intentObservedAt: "2026-08-17T12:00:00.000Z",
      planDigestSha256: "b".repeat(64),
      readyPublishedAt: "2026-08-17T12:00:00.100Z",
      target: {
        craigBotId: "223456789012345678",
        guildId: "323456789012345678",
        observerApplicationId: "423456789012345678",
        voiceChannelId: "523456789012345678",
      },
      type: "observer-ready",
    });

    expect(serializeConversationThinkingCuePlaybackReadinessEnvelope(intent))
      .toBe(serializeConversationThinkingCuePlaybackReadinessEnvelope(ready));
    expect(JSON.parse(
      serializeConversationThinkingCuePlaybackReadinessEnvelope(intent),
    )).toEqual([
      1,
      "campaign-run-1",
      "meeting-1",
      "turn-1",
      "cue-attempt-turn-1-acknowledgement",
      "thinking-cue",
      "thinking-cue",
    ]);
  });

  it("rejects a thinking-cue readiness receipt for a different playback kind", () => {
    expect(() => conversationThinkingCuePlaybackIntentSchema.parse({
      capturePlan: "thinking-cue",
      kind: "answer",
      meetingId: "meeting-1",
      playbackAttemptId: "cue-attempt-1",
      protocolVersion: 1,
      runId: "campaign-run-1",
      turnId: "turn-1",
      type: "playback-intent",
    })).toThrow();
  });

  it("parses provider-neutral health without provider credentials", () => {
    expect(parseConversationRuntimeHealth({
      status: "serving",
      runtimeName: "pipecat-runtime",
      runtimeVersion: "1.0.0",
      warningCodes: [],
    })).toEqual({
      status: "serving",
      runtimeName: "pipecat-runtime",
      runtimeVersion: "1.0.0",
      warningCodes: [],
    });
  });
  it("publishes a parseable bidirectional v1 gRPC service", () => {
    const definition = loadSync(
      fileURLToPath(new URL("../proto/conversation_runtime.proto", import.meta.url)),
      { defaults: true, enums: String, keepCase: false, longs: String, oneofs: true },
    );

    expect(definition).toHaveProperty(
      "discord_meeting.conversation_runtime.v1.ConversationRuntimeService",
    );
  });

  it("accepts one stateless addressed turn", () => {
    expect(
      parseConversationRuntimeStartTurn({
        protocolVersion: 1,
        meetingId: "meeting-1",
        recordingId: "recording-1",
        turnId: "turn-1",
        speakerId: "speaker-1",
        idempotencyKey: "conversation:meeting-1:turn-1",
        latency: {
          turnEndedAtUnixMs: 1_700_000_000_000,
          wakeDetectedAtUnixMs: 1_700_000_000_125,
        },
        systemPrompt: "Answer briefly in the participant's language.",
        prompt: "Расскажи короткий факт.",
        literalSpeech: "Привет, Саша!",
        locale: "ru",
        voiceProfileId: "deterministic-e2e-ru",
      }),
    ).toMatchObject({
      turnId: "turn-1",
      locale: "ru",
      literalSpeech: "Привет, Саша!",
    });
  });

  it("enforces literal speech omission and text boundaries", () => {
    const valid = {
      protocolVersion: 1,
      meetingId: "meeting-1",
      recordingId: "recording-1",
      turnId: "turn-1",
      speakerId: "speaker-1",
      idempotencyKey: "conversation:meeting-1:turn-1",
      systemPrompt: "Repeat exactly.",
      prompt: "Привет!",
      locale: "ru",
      voiceProfileId: "default",
    };
    expect(parseConversationRuntimeStartTurn(valid).literalSpeech).toBeUndefined();
    expect(() => parseConversationRuntimeStartTurn({
      ...valid,
      literalSpeech: "   ",
    })).toThrow();
    expect(() => parseConversationRuntimeStartTurn({
      ...valid,
      literalSpeech: "a".repeat(2_001),
    })).toThrow();
  });

  it("accepts exact additive first-audio latency telemetry", () => {
    expect(
      parseConversationRuntimeEvent({
        ...baseEvent,
        type: "latency",
        endTurnToWakeMs: 125,
        wakeToFirstLlmTokenMs: 2_400,
        firstLlmTokenToAudioMs: 350,
        totalToFirstAudioMs: 2_875,
      }),
    ).toMatchObject({ type: "latency", totalToFirstAudioMs: 2_875 });
  });

  it("accepts bounded mono 48 kHz PCM", () => {
    expect(
      parseConversationRuntimeEvent({
        ...baseEvent,
        type: "audio-chunk",
        audioSequence: 0,
        format: "pcm_s16le",
        sampleRateHz: 48_000,
        channels: 1,
        pcm: Uint8Array.of(1, 0, 2, 0),
      }),
    ).toMatchObject({ type: "audio-chunk", audioSequence: 0 });
  });

  it("rejects provider details and malformed audio", () => {
    expect(() =>
      parseConversationRuntimeStartTurn({
        protocolVersion: 1,
        meetingId: "meeting-1",
        recordingId: "recording-1",
        turnId: "turn-1",
        speakerId: "speaker-1",
        idempotencyKey: "conversation:meeting-1:turn-1",
        systemPrompt: "Answer briefly.",
        prompt: "Hello",
        locale: "en",
        voiceProfileId: "voice-1",
        elevenLabsApiKey: "must-not-cross-the-boundary",
      }),
    ).toThrow();
    expect(() =>
      parseConversationRuntimeEvent({
        ...baseEvent,
        type: "audio-chunk",
        audioSequence: 0,
        format: "pcm_s16le",
        sampleRateHz: 24_000,
        channels: 1,
        pcm: Uint8Array.of(1),
      }),
    ).toThrow();
  });

  it("accepts an idempotent cancellation command", () => {
    expect(
      parseConversationRuntimeCancelTurn({
        protocolVersion: 1,
        turnId: "turn-1",
        attemptId: "attempt-1",
        reason: "barge-in",
      }),
    ).toEqual({
      protocolVersion: 1,
      turnId: "turn-1",
      attemptId: "attempt-1",
      reason: "barge-in",
    });
  });
});
