import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_WAKE_LATCH_MS,
  ConversationCoordinator,
} from "@discord-meeting/meeting-core/conversation";
import type { ConversationRuntimeEvent } from "@discord-meeting/meeting-core/conversation";
import {
  EventStream,
  RecordingPlayback,
  ScriptedRuntime,
  audioChunk,
  closedStream,
  input,
} from "./conversation-coordinator-fixture.js";

describe("ConversationCoordinator wake latch ordering", () => {
  it("re-arms a same-speaker wake latch with the latest alias-only turn", async () => {
    const runtime = new ScriptedRuntime([
      closedStream([
        { attemptId: "attempt-prompt", type: "accepted" },
        { attemptId: "attempt-prompt", type: "completed" },
      ]),
    ]);
    const playback = new RecordingPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await coordinator.handleFinalizedTurn(
      input("turn-wake-1", 0, "Ботик", {
        speakerId: "speaker-a",
        transcriptEndMs: 100,
        transcriptStartMs: 0,
      }),
    );
    await expect(
      coordinator.handleFinalizedTurn(
        input("turn-wake-2", 1, "Ботик", {
          speakerId: "speaker-a",
          transcriptEndMs: 1_000,
          transcriptStartMs: 800,
        }),
      ),
    ).resolves.toMatchObject({
      latchExpiresAtTranscriptMs: 1_000 + CONVERSATION_WAKE_LATCH_MS,
      status: "awaiting-prompt",
    });
    await expect(
      coordinator.handleFinalizedTurn(
        input("turn-prompt", 2, "Что нового?", {
          speakerId: "speaker-a",
          transcriptEndMs: 8_000,
          transcriptStartMs: 4_500,
        }),
      ),
    ).resolves.toMatchObject({ status: "active", turnId: "turn-prompt" });
    await coordinator.whenIdle("meeting-1");

    expect(runtime.requests.map((request) => request.turnId)).toEqual(["turn-prompt"]);
  });

  it("does not let an out-of-order older wake turn replace a newer latch", async () => {
    const runtime = new ScriptedRuntime([
      closedStream([
        { attemptId: "attempt-prompt", type: "accepted" },
        { attemptId: "attempt-prompt", type: "completed" },
      ]),
    ]);
    const coordinator = new ConversationCoordinator({
      playback: new RecordingPlayback(),
      runtime,
    });

    await coordinator.handleFinalizedTurn(
      input("turn-newer", 0, "Ботик", {
        speakerId: "speaker-a",
        transcriptEndMs: 1_000,
        transcriptStartMs: 900,
      }),
    );
    await coordinator.handleFinalizedTurn(
      input("turn-older", 1, "Ботик", {
        speakerId: "speaker-a",
        transcriptEndMs: 500,
        transcriptStartMs: 400,
      }),
    );
    await expect(
      coordinator.handleFinalizedTurn(
        input("turn-prompt", 2, "Что нового?", {
          speakerId: "speaker-a",
          transcriptEndMs: 6_000,
          transcriptStartMs: 4_800,
        }),
      ),
    ).resolves.toMatchObject({ status: "active", turnId: "turn-prompt" });
    await coordinator.whenIdle("meeting-1");
  });

  it("clears a wake latch when an explicit address arrives or the meeting closes", async () => {
    const runtime = new ScriptedRuntime([
      closedStream([
        { attemptId: "attempt-addressed", type: "accepted" },
        { attemptId: "attempt-addressed", type: "completed" },
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
    await coordinator.handleFinalizedTurn(
      input("turn-addressed", 1, "Ботик, ответь кратко.", {
        speakerId: "speaker-a",
        transcriptEndMs: 1_100,
        transcriptStartMs: 1_000,
      }),
    );
    await expect(
      coordinator.handleFinalizedTurn(
        input("turn-after-address", 2, "Что нового?", {
          speakerId: "speaker-a",
          transcriptEndMs: 1_300,
          transcriptStartMs: 1_200,
        }),
      ),
    ).resolves.toEqual({ status: "ignored" });
    await coordinator.whenIdle("meeting-1");

    await coordinator.handleFinalizedTurn(
      input("turn-wake-after-close", 3, "Ботик", {
        speakerId: "speaker-a",
        transcriptEndMs: 2_000,
        transcriptStartMs: 1_900,
      }),
    );
    await coordinator.closeMeeting("meeting-1", 4);
    await expect(
      coordinator.handleFinalizedTurn(
        input("turn-after-close", 5, "Что нового?", {
          speakerId: "speaker-a",
          transcriptEndMs: 2_200,
          transcriptStartMs: 2_100,
        }),
      ),
    ).resolves.toEqual({ status: "ignored" });

    expect(runtime.requests.map((request) => request.turnId)).toEqual(["turn-addressed"]);
  });
});

describe("ConversationCoordinator cancellation and recovery", () => {
  it("ignores stale runtime attempt events and stale audio chunks", async () => {
    const runtime = new ScriptedRuntime([
      closedStream([
        { attemptId: "attempt-current", type: "accepted" },
        {
          attemptId: "attempt-stale",
          channels: 1,
          format: "pcm_s16le",
          sampleRateHz: 48_000,
          type: "audio-start",
        },
        {
          attemptId: "attempt-current",
          channels: 1,
          format: "pcm_s16le",
          sampleRateHz: 48_000,
          type: "audio-start",
        },
        audioChunk("attempt-stale", "turn-1", 1),
        audioChunk("attempt-current", "turn-1", 2),
        { attemptId: "attempt-current", type: "audio-end" },
        { attemptId: "attempt-current", type: "completed" },
      ]),
    ]);
    const playback = new RecordingPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    await coordinator.whenIdle("meeting-1");

    expect(playback.requests).toHaveLength(1);
    expect(playback.sessions[0]?.chunks).toEqual([
      expect.objectContaining({ attemptId: "attempt-current", sequence: 2 }),
    ]);
  });

  it("isolates playback failure, cancels the active run, and starts the queued turn", async () => {
    const first = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([
      first,
      closedStream([
        { attemptId: "attempt-2", type: "accepted" },
        { attemptId: "attempt-2", type: "completed" },
      ]),
    ]);
    const playback = new RecordingPlayback(new Set(["turn-1"]));
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    await expect(coordinator.handleFinalizedTurn(input("turn-2", 1))).resolves.toMatchObject({
      status: "queued",
      turnId: "turn-2",
    });

    first.push({ attemptId: "attempt-1", type: "accepted" });
    first.push({
      attemptId: "attempt-1",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    first.push(audioChunk("attempt-1", "turn-1", 0));
    first.close();
    await coordinator.whenIdle("meeting-1");

    expect(runtime.cancellations).toContainEqual({
      reason: "playback-failed",
      turnId: "turn-1",
    });
    expect(playback.sessions[0]?.cancelReasons).toEqual(["playback-failed"]);
    expect(runtime.requests.map((request) => request.turnId)).toEqual(["turn-1", "turn-2"]);
    await expect(coordinator.whenTurnPlaybackSettled("meeting-1", "turn-1"))
      .resolves.toBe("partial");
  });

  it("cancels active transports and discards queued work when the meeting ends", async () => {
    const first = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([first]);
    const playback = new RecordingPlayback();
    const coordinator = new ConversationCoordinator({ playback, runtime });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    await coordinator.handleFinalizedTurn(input("turn-2", 1));
    first.push({ attemptId: "attempt-1", type: "accepted" });
    first.push({
      attemptId: "attempt-1",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    await vi.waitFor(() => {
      expect(playback.sessions).toHaveLength(1);
    });
    first.push(audioChunk("attempt-1", "turn-1", 0));
    await vi.waitFor(() => {
      expect(playback.sessions[0]?.chunks).toHaveLength(1);
    });
    const settlement = coordinator.whenTurnPlaybackSettled("meeting-1", "turn-1");
    await coordinator.closeMeeting("meeting-1", 101);

    expect(runtime.cancellations).toEqual([
      { reason: "meeting-ended", turnId: "turn-1" },
    ]);
    expect(playback.sessions[0]?.cancelReasons).toEqual(["meeting-ended"]);
    expect(runtime.requests.map((request) => request.turnId)).toEqual(["turn-1"]);
    await expect(settlement).resolves.toBe("partial");
  });
});
