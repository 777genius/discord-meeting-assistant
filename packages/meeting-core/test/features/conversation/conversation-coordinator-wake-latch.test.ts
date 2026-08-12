import { describe, expect, it } from "vitest";

import {
  CONVERSATION_WAKE_LATCH_MS,
  ConversationCoordinator,
} from "@discord-meeting/meeting-core/conversation";
import {
  RecordingPlayback,
  ScriptedRuntime,
  audioChunk,
  closedStream,
  input,
} from "./conversation-coordinator-fixture.js";

describe("ConversationCoordinator runtime boundary", () => {
  it("streams a provider-neutral addressed request through playback", async () => {
    const runtime = new ScriptedRuntime([
      closedStream([
        { attemptId: "attempt-1", type: "accepted" },
        {
          attemptId: "attempt-1",
          channels: 1,
          format: "pcm_s16le",
          sampleRateHz: 48_000,
          type: "audio-start",
        },
        audioChunk("attempt-1", "turn-1", 0),
        { attemptId: "attempt-1", type: "audio-end" },
        { attemptId: "attempt-1", type: "completed" },
      ]),
    ]);
    const playback = new RecordingPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await expect(coordinator.handleFinalizedTurn(input("turn-1", 0))).resolves.toEqual({
      prompt: "ответь кратко.",
      status: "active",
      turnId: "turn-1",
      usedFallbackPrompt: false,
    });
    await coordinator.whenIdle("meeting-1");

    expect(runtime.requests).toEqual([
      {
        idempotencyKey: "20:live-conversation:v1|9:meeting-1|11:recording-1|6:turn-1",
        locale: "ru-RU",
        meetingId: "meeting-1",
        prompt: "ответь кратко.",
        recordingId: "recording-1",
        speakerId: "speaker-turn-1",
        systemPrompt: "Отвечай кратко и дружелюбно.",
        turnId: "turn-1",
        voiceProfileId: "default",
      },
    ]);
    expect(JSON.stringify(runtime.requests[0])).not.toMatch(/deepgram|elevenlabs|pipecat/i);
    expect(playback.requests).toEqual([
      {
        attemptId: "attempt-1",
        meetingId: "meeting-1",
        recordingId: "recording-1",
        turnId: "turn-1",
      },
    ]);
    expect(playback.sessions[0]?.chunks).toEqual([
      expect.objectContaining({ attemptId: "attempt-1", sequence: 0, turnId: "turn-1" }),
    ]);
    expect(playback.sessions[0]?.finishCalls).toBe(1);
  });
});

describe("ConversationCoordinator wake latch admission", () => {
  it("arms an alias-only wake latch without starting the runtime", async () => {
    const runtime = new ScriptedRuntime([]);
    const playback = new RecordingPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await expect(
      coordinator.handleFinalizedTurn(
        input("turn-wake", 0, "Ботик?!", {
          speakerId: "speaker-a",
          transcriptEndMs: 500,
          transcriptStartMs: 100,
        }),
      ),
    ).resolves.toEqual({
      alias: "Ботик",
      latchExpiresAtTranscriptMs: 500 + CONVERSATION_WAKE_LATCH_MS,
      status: "awaiting-prompt",
      turnId: "turn-wake",
    });

    expect(runtime.requests).toEqual([]);
  });

  it("accepts a same-speaker split prompt by transcript start and forwards the full trim", async () => {
    const runtime = new ScriptedRuntime([
      closedStream([
        { attemptId: "attempt-prompt", type: "accepted" },
        { attemptId: "attempt-prompt", type: "completed" },
      ]),
    ]);
    const playback = new RecordingPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await coordinator.handleFinalizedTurn(
      input("turn-wake", 0, "Ботик", {
        speakerId: "speaker-a",
        transcriptEndMs: 500,
        transcriptStartMs: 100,
      }),
    );
    await expect(
      coordinator.handleFinalizedTurn(
        input("turn-prompt", 1, "  Расскажи, что нового?  ", {
          speakerId: "speaker-a",
          transcriptEndMs: 9_000,
          transcriptStartMs: 500 + CONVERSATION_WAKE_LATCH_MS - 1,
        }),
      ),
    ).resolves.toEqual({
      prompt: "Расскажи, что нового?",
      status: "active",
      turnId: "turn-prompt",
      usedFallbackPrompt: false,
    });
    await coordinator.whenIdle("meeting-1");

    expect(runtime.requests).toMatchObject([
      {
        prompt: "Расскажи, что нового?",
        speakerId: "speaker-a",
        turnId: "turn-prompt",
      },
    ]);
  });

  it("does not re-arm a consumed latch when its wake turn is replayed", async () => {
    const runtime = new ScriptedRuntime([
      closedStream([
        { attemptId: "attempt-prompt", type: "accepted" },
        { attemptId: "attempt-prompt", type: "completed" },
      ]),
    ]);
    const playback = new RecordingPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });
    const wake = input("turn-wake", 0, "Ботик", {
      speakerId: "speaker-a",
      transcriptEndMs: 500,
      transcriptStartMs: 100,
    });

    await coordinator.handleFinalizedTurn(wake);
    await coordinator.handleFinalizedTurn(
      input("turn-prompt", 1, "Что нового?", {
        speakerId: "speaker-a",
        transcriptEndMs: 1_500,
        transcriptStartMs: 800,
      }),
    );
    await coordinator.whenIdle("meeting-1");

    await expect(
      coordinator.handleFinalizedTurn({ ...wake, nowMs: 2 }),
    ).resolves.toMatchObject({
      status: "awaiting-prompt",
      turnId: "turn-wake",
    });
    await expect(
      coordinator.handleFinalizedTurn(
        input("turn-unrelated", 2, "А теперь о другом.", {
          speakerId: "speaker-a",
          transcriptEndMs: 2_500,
          transcriptStartMs: 2_000,
        }),
      ),
    ).resolves.toEqual({ status: "ignored" });
    expect(runtime.requests.map((request) => request.turnId)).toEqual(["turn-prompt"]);
  });

  it("does not let another speaker consume a wake latch", async () => {
    const runtime = new ScriptedRuntime([
      closedStream([
        { attemptId: "attempt-a", type: "accepted" },
        { attemptId: "attempt-a", type: "completed" },
      ]),
    ]);
    const playback = new RecordingPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await coordinator.handleFinalizedTurn(
      input("turn-wake", 0, "Ботик", {
        speakerId: "speaker-a",
        transcriptEndMs: 500,
        transcriptStartMs: 100,
      }),
    );
    await expect(
      coordinator.handleFinalizedTurn(
        input("turn-other", 1, "Что нового?", {
          speakerId: "speaker-b",
          transcriptEndMs: 900,
          transcriptStartMs: 800,
        }),
      ),
    ).resolves.toEqual({ status: "ignored" });
    await expect(
      coordinator.handleFinalizedTurn(
        input("turn-prompt", 2, "Что нового?", {
          speakerId: "speaker-a",
          transcriptEndMs: 5_000,
          transcriptStartMs: 500 + CONVERSATION_WAKE_LATCH_MS,
        }),
      ),
    ).resolves.toMatchObject({ status: "active", turnId: "turn-prompt" });
    await coordinator.whenIdle("meeting-1");

    expect(runtime.requests.map((request) => request.turnId)).toEqual(["turn-prompt"]);
  });

  it("does not accept a split prompt whose transcript start is after latch expiry", async () => {
    const runtime = new ScriptedRuntime([]);
    const playback = new RecordingPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await coordinator.handleFinalizedTurn(
      input("turn-wake", 0, "Ботик", {
        speakerId: "speaker-a",
        transcriptEndMs: 500,
        transcriptStartMs: 100,
      }),
    );
    await expect(
      coordinator.handleFinalizedTurn(
        input("turn-late", 1, "Что нового?", {
          speakerId: "speaker-a",
          transcriptEndMs: 12_000,
          transcriptStartMs: 500 + CONVERSATION_WAKE_LATCH_MS + 1,
        }),
      ),
    ).resolves.toEqual({ status: "ignored" });

    expect(runtime.requests).toEqual([]);
  });
});
