import { fileURLToPath } from "node:url";

import { loadSync } from "@grpc/proto-loader";
import { describe, expect, it } from "vitest";

import {
  conversationRuntimeProtocolVersion,
  parseConversationRuntimeCancelTurn,
  parseConversationRuntimeEvent,
  parseConversationRuntimeHealth,
  parseConversationRuntimeStartTurn,
} from "../src/index.js";

const baseEvent = {
  protocolVersion: conversationRuntimeProtocolVersion,
  turnId: "turn-1",
  attemptId: "attempt-1",
  eventSequence: 1,
} as const;

describe("conversation runtime contracts", () => {
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
        systemPrompt: "Answer briefly in the participant's language.",
        prompt: "Расскажи короткий факт.",
        locale: "ru",
        voiceProfileId: "deterministic-e2e-ru",
      }),
    ).toMatchObject({ turnId: "turn-1", locale: "ru" });
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
