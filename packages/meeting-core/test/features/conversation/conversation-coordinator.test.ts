import { describe, expect, it, vi } from "vitest";

import { ConversationCoordinator } from "@discord-meeting/meeting-core/conversation";
import type {
  ConversationPlaybackObservation,
  ConversationPlaybackReadinessPort,
  ConversationPlaybackReadinessRequest,
  ConversationRuntimeEvent,
} from "@discord-meeting/meeting-core/conversation";
import {
  AbortablePendingRuntime,
  ControlledDelayPort,
  DelayedFirstOpenPlayback,
  EventStream,
  FixedThinkingCues,
  HeldFinishPlaybackSession,
  HeldFirstFinishPlayback,
  RecordingPlayback,
  ScriptedRuntime,
  audioChunk,
  closedStream,
  input,
} from "./conversation-coordinator-fixture.js";

describe("ConversationCoordinator startup", () => {
  it("does not block admission or meeting close on a pending runtime start", async () => {
    const runtime = new AbortablePendingRuntime();
    const coordinator = new ConversationCoordinator({
      playback: new RecordingPlayback(),
      runtime,
    });

    await expect(
      coordinator.handleFinalizedTurn(input("turn-1", 0)),
    ).resolves.toMatchObject({ status: "active" });
    expect(runtime.startCount).toBe(1);

    await expect(coordinator.closeMeeting("meeting-1", 1)).resolves.toBeUndefined();
    expect(runtime.aborted).toBe(true);
  });
});

describe("ConversationCoordinator thinking cues", () => {
  it("plays one delayed thinking cue and lets speech interrupt it immediately", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([stream]);
    const playback = new RecordingPlayback();
    const delay = new ControlledDelayPort();
    const thinkingCues = new FixedThinkingCues();
    const coordinator = new ConversationCoordinator({
      delay,
      playback,
      runtime,
      thinkingCues,
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    stream.push({ attemptId: "attempt-1", type: "accepted" });
    expect(delay.requestedMs).toEqual([1_300]);
    delay.delays[0]?.elapse();
    await vi.waitFor(() => {
      expect(playback.sessions).toHaveLength(1);
      expect(playback.sessions[0]?.chunks).toHaveLength(2);
    });

    await expect(coordinator.speechStarted("meeting-1", 201)).resolves.toEqual({
      status: "cancel-requested",
      turnId: "turn-1",
    });
    stream.close();
    await coordinator.whenIdle("meeting-1");

    expect(thinkingCues.selections).toEqual(["acknowledgement"]);
    expect(runtime.cancellations).toEqual([
      { reason: "barge-in", turnId: "turn-1" },
    ]);
  });

  it("adds a later deliberation cue only for a reasoning prompt", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([stream]);
    const playback = new RecordingPlayback();
    const delay = new ControlledDelayPort();
    const thinkingCues = new FixedThinkingCues();
    const coordinator = new ConversationCoordinator({
      delay,
      playback,
      runtime,
      thinkingCues,
    });

    await coordinator.handleFinalizedTurn(
      input(
        "turn-1",
        0,
        "Ботик, объясни почему порт надёжнее прямого вызова адаптера?",
      ),
    );
    expect(delay.requestedMs).toEqual([1_300, 3_200]);

    delay.delays[0]?.elapse();
    await vi.waitFor(() => {
      expect(playback.sessions).toHaveLength(1);
    });
    delay.delays[1]?.elapse();
    await vi.waitFor(() => {
      expect(playback.sessions).toHaveLength(2);
    });

    expect(thinkingCues.selections).toEqual([
      "acknowledgement",
      "deliberation",
    ]);
    await coordinator.closeMeeting("meeting-1", 4_000);
    stream.close();
    await coordinator.whenIdle("meeting-1");
  });

  it("starts ready deliberation after a long acknowledgement finishes", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([stream]);
    const playback = new HeldFirstFinishPlayback();
    const delay = new ControlledDelayPort();
    const thinkingCues = new FixedThinkingCues();
    const coordinator = new ConversationCoordinator({
      delay,
      playback,
      runtime,
      thinkingCues,
    });

    await coordinator.handleFinalizedTurn(
      input("turn-1", 0, "Ботик, объясни почему этот вариант надёжнее?"),
    );
    delay.delays[0]?.elapse();
    await vi.waitFor(() => {
      expect(playback.requests).toHaveLength(1);
    });
    delay.delays[1]?.elapse();
    await vi.waitFor(() => {
      expect(thinkingCues.selections).toEqual(["acknowledgement"]);
    });

    const acknowledgement = playback.sessions[0];
    if (!(acknowledgement instanceof HeldFinishPlaybackSession)) {
      throw new Error("expected held acknowledgement playback");
    }
    acknowledgement.complete(3_500);
    await vi.waitFor(() => {
      expect(playback.requests).toHaveLength(2);
    });
    expect(thinkingCues.selections).toEqual([
      "acknowledgement",
      "deliberation",
    ]);

    await coordinator.closeMeeting("meeting-1", 4_000);
    stream.close();
  });

  it("keeps deliberation ready while acknowledgement playback is still opening", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([stream]);
    const playback = new DelayedFirstOpenPlayback();
    const delay = new ControlledDelayPort();
    const thinkingCues = new FixedThinkingCues();
    const coordinator = new ConversationCoordinator({
      delay,
      playback,
      runtime,
      thinkingCues,
    });

    await coordinator.handleFinalizedTurn(
      input("turn-1", 0, "Ботик, объясни почему этот вариант надёжнее?"),
    );
    delay.delays[0]?.elapse();
    await vi.waitFor(() => {
      expect(playback.requests).toHaveLength(1);
    });
    delay.delays[1]?.elapse();
    await vi.waitFor(() => {
      expect(thinkingCues.selections).toEqual([
        "acknowledgement",
        "deliberation",
      ]);
    });

    playback.releaseFirstOpen();
    await vi.waitFor(() => {
      expect(playback.sessions).toHaveLength(1);
    });
    const acknowledgement = playback.sessions[0];
    if (acknowledgement === undefined) {
      throw new Error("expected delayed acknowledgement playback");
    }
    acknowledgement.events.push({
      attemptId: acknowledgement.request.attemptId,
      finishedAtMs: 3_500,
      type: "finished",
    });
    await vi.waitFor(() => {
      expect(playback.requests).toHaveLength(2);
    });

    expect(playback.requests[1]?.attemptId).toContain("deliberation");
    await coordinator.closeMeeting("meeting-1", 4_000);
    stream.close();
  });
});

describe("ConversationCoordinator cue and answer playback", () => {
  it("observes a thinking cue and played answer separately for the same turn", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([stream]);
    const playback = new RecordingPlayback();
    const delay = new ControlledDelayPort();
    const observations: ConversationPlaybackObservation[] = [];
    const coordinator = new ConversationCoordinator({
      delay,
      playback,
      playbackObserver: {
        observeConversationPlayback: (observation) => {
          observations.push(structuredClone(observation));
        },
      },
      runtime,
      thinkingCues: new FixedThinkingCues(),
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    stream.push({ attemptId: "answer-attempt-1", type: "accepted" });
    delay.delays[0]?.elapse();
    await vi.waitFor(() => {
      expect(observations).toEqual([
        expect.objectContaining({
          playbackAttemptId: "cue-attempt-turn-1-acknowledgement",
          playbackKind: "thinking-cue",
          status: "started",
          turnId: "turn-1",
        }),
        expect.objectContaining({
          playbackAttemptId: "cue-attempt-turn-1-acknowledgement",
          playbackKind: "thinking-cue",
          status: "finished",
          turnId: "turn-1",
        }),
      ]);
    });

    stream.push({
      attemptId: "answer-attempt-1",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    stream.push(audioChunk("answer-attempt-1", "turn-1", 0));
    stream.push({ attemptId: "answer-attempt-1", type: "audio-end" });
    stream.push({ attemptId: "answer-attempt-1", type: "completed" });
    stream.close();
    await coordinator.whenIdle("meeting-1");

    expect(observations).toEqual([
      expect.objectContaining({
        playbackAttemptId: "cue-attempt-turn-1-acknowledgement",
        playbackKind: "thinking-cue",
        status: "started",
        turnId: "turn-1",
      }),
      expect.objectContaining({
        playbackAttemptId: "cue-attempt-turn-1-acknowledgement",
        playbackKind: "thinking-cue",
        status: "finished",
        turnId: "turn-1",
      }),
      expect.objectContaining({
        playbackAttemptId: "answer-attempt-1",
        playbackKind: "answer",
        status: "started",
        turnId: "turn-1",
      }),
      expect.objectContaining({
        playbackAttemptId: "answer-attempt-1",
        playbackKind: "answer",
        status: "finished",
        turnId: "turn-1",
      }),
      expect.objectContaining({
        playbackAttemptId: "answer-attempt-1",
        playbackKind: "answer",
        settlement: "played",
        status: "settled",
        turnId: "turn-1",
      }),
    ]);
  });

  it("cancels the delayed cue when real answer audio starts first", async () => {
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
    const delay = new ControlledDelayPort();
    const thinkingCues = new FixedThinkingCues();
    const coordinator = new ConversationCoordinator({
      delay,
      playback,
      runtime,
      thinkingCues,
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    await coordinator.whenIdle("meeting-1");

    expect(thinkingCues.selections).toEqual([]);
    expect(playback.requests).toHaveLength(1);
    expect(playback.requests[0]?.attemptId).toBe("attempt-1");
  });

  it("gives real answer playback priority over an in-flight cue open", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([stream]);
    const playback = new DelayedFirstOpenPlayback();
    const delay = new ControlledDelayPort();
    const coordinator = new ConversationCoordinator({
      delay,
      playback,
      runtime,
      thinkingCues: new FixedThinkingCues(),
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    stream.push({ attemptId: "attempt-1", type: "accepted" });
    delay.delays[0]?.elapse();
    await vi.waitFor(() => {
      expect(playback.requests).toHaveLength(1);
    });

    stream.push({
      attemptId: "attempt-1",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    await vi.waitFor(() => {
      expect(playback.requests).toHaveLength(2);
    });

    expect(playback.sessions).toHaveLength(1);
    expect(playback.requests[1]?.attemptId).toBe("attempt-1");
    stream.push({ attemptId: "attempt-1", type: "audio-end" });
    stream.push({ attemptId: "attempt-1", type: "completed" });
    stream.close();
    await coordinator.whenIdle("meeting-1");
    expect(runtime.cancellations).toEqual([]);
  });

  it("holds successor playback until a cancelled run's cue open settles", async () => {
    const first = new EventStream<ConversationRuntimeEvent>();
    const second = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([first, second]);
    const playback = new DelayedFirstOpenPlayback();
    const delay = new ControlledDelayPort();
    const coordinator = new ConversationCoordinator({
      delay,
      playback,
      runtime,
      thinkingCues: new FixedThinkingCues(),
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    first.push({ attemptId: "attempt-1", type: "accepted" });
    delay.delays[0]?.elapse();
    await vi.waitFor(() => {
      expect(playback.requests).toHaveLength(1);
    });
    await expect(
      coordinator.handleFinalizedTurn(input("turn-2", 10)),
    ).resolves.toMatchObject({ status: "queued" });

    first.push({
      attemptId: "attempt-1",
      reason: "superseded",
      type: "cancelled",
    });
    await vi.waitFor(() => {
      expect(runtime.requests).toHaveLength(2);
    });
    second.push({ attemptId: "attempt-2", type: "accepted" });
    second.push({
      attemptId: "attempt-2",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    await Promise.resolve();
    expect(playback.requests).toHaveLength(1);

    await vi.waitFor(() => {
      expect(playback.requests).toHaveLength(2);
    });
    expect(playback.sessions).toHaveLength(1);
    expect(playback.requests[1]).toMatchObject({
      attemptId: "attempt-2",
      turnId: "turn-2",
    });

    second.push({ attemptId: "attempt-2", type: "audio-end" });
    second.push({ attemptId: "attempt-2", type: "completed" });
    first.close();
    second.close();
    await coordinator.whenIdle("meeting-1");
  });
});

describe("ConversationCoordinator playback readiness", () => {
  it("waits for exact answer readiness before opening playback", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const playback = new RecordingPlayback();
    const readinessRequests: ConversationPlaybackReadinessRequest[] = [];
    let readinessSignal: AbortSignal | undefined;
    let resolveReadiness!: (
      result: Awaited<ReturnType<ConversationPlaybackReadinessPort["awaitConversationPlaybackReady"]>>,
    ) => void;
    const readiness = new Promise<
      Awaited<ReturnType<ConversationPlaybackReadinessPort["awaitConversationPlaybackReady"]>>
    >((resolve) => {
      resolveReadiness = resolve;
    });
    const playbackReadiness: ConversationPlaybackReadinessPort = {
      awaitConversationPlaybackReady: (request, options) => {
        readinessRequests.push(structuredClone(request));
        readinessSignal = options?.signal;
        return readiness;
      },
    };
    const coordinator = new ConversationCoordinator({
      playback,
      playbackReadiness,
      runtime: new ScriptedRuntime([stream]),
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    stream.push({ attemptId: "answer-attempt-1", type: "accepted" });
    stream.push({
      attemptId: "answer-attempt-1",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    await vi.waitFor(() => {
      expect(readinessRequests).toEqual([{
        meetingId: "meeting-1",
        participantId: "speaker-turn-1",
        playbackAttemptId: "answer-attempt-1",
        playbackKind: "answer",
        turnId: "turn-1",
      }]);
    });
    expect(readinessSignal).toBeInstanceOf(AbortSignal);
    expect(readinessSignal?.aborted).toBe(false);
    expect(playback.requests).toEqual([]);

    stream.push(audioChunk("answer-attempt-1", "turn-1", 0));
    stream.push({ attemptId: "answer-attempt-1", type: "audio-end" });
    stream.push({ attemptId: "answer-attempt-1", type: "completed" });
    stream.close();
    await Promise.resolve();
    expect(playback.requests).toEqual([]);

    resolveReadiness({ ok: true, value: "ready" });
    await coordinator.whenIdle("meeting-1");

    expect(playback.requests).toEqual([{
      attemptId: "answer-attempt-1",
      meetingId: "meeting-1",
      recordingId: "recording-1",
      turnId: "turn-1",
    }]);
    await expect(
      coordinator.whenTurnPlaybackSettled("meeting-1", "turn-1"),
    ).resolves.toBe("played");
  });

  it("aborts a pending answer readiness wait when the meeting closes", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const playback = new RecordingPlayback();
    let readinessSignal: AbortSignal | undefined;
    const playbackReadiness: ConversationPlaybackReadinessPort = {
      awaitConversationPlaybackReady: (_request, options) => new Promise((resolve) => {
        readinessSignal = options?.signal;
        options?.signal?.addEventListener("abort", () => {
          resolve({
            failure: { code: "PLAYBACK_READINESS_CANCELLED", message: "cancelled", retryable: false },
            ok: false,
          });
        }, { once: true });
      }),
    };
    const coordinator = new ConversationCoordinator({
      playback,
      playbackReadiness,
      runtime: new ScriptedRuntime([stream]),
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    stream.push({ attemptId: "answer-attempt-1", type: "accepted" });
    stream.push({
      attemptId: "answer-attempt-1",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    await vi.waitFor(() => {
      expect(readinessSignal).toBeInstanceOf(AbortSignal);
    });

    await coordinator.closeMeeting("meeting-1", 1);
    await coordinator.whenIdle("meeting-1");

    expect(readinessSignal?.aborted).toBe(true);
    expect(playback.requests).toEqual([]);
  });

  type ReadinessResult = Awaited<
    ReturnType<ConversationPlaybackReadinessPort["awaitConversationPlaybackReady"]>
  >;
  const blockedReadinessCases: Array<{
    readonly name: string;
    readonly wait: () => Promise<ReadinessResult>;
  }> = [
    {
      name: "an unexpected success value",
      wait: () => Promise.resolve(
        { ok: true, value: "not-ready" } as unknown as ReadinessResult,
      ),
    },
    {
      name: "a failure result",
      wait: () => Promise.resolve({
        failure: {
          code: "PLAYBACK_OBSERVER_NOT_READY",
          message: "observer rejected the playback attempt",
          retryable: true,
        },
        ok: false,
      }),
    },
    {
      name: "a timeout-like rejection",
      wait: () => Promise.reject(new Error("playback readiness timed out")),
    },
  ];

  it.each(blockedReadinessCases)(
    "prevents playback and settles unplayed for $name",
    async ({ wait }) => {
      const playback = new RecordingPlayback();
      const runtime = new ScriptedRuntime([
        closedStream([
          { attemptId: "answer-attempt-1", type: "accepted" },
          {
            attemptId: "answer-attempt-1",
            channels: 1,
            format: "pcm_s16le",
            sampleRateHz: 48_000,
            type: "audio-start",
          },
          audioChunk("answer-attempt-1", "turn-1", 0),
          { attemptId: "answer-attempt-1", type: "audio-end" },
          { attemptId: "answer-attempt-1", type: "completed" },
        ]),
      ]);
      const coordinator = new ConversationCoordinator({
        playback,
        playbackReadiness: { awaitConversationPlaybackReady: wait },
        runtime,
      });

      await coordinator.handleFinalizedTurn(input("turn-1", 0));
      await coordinator.whenIdle("meeting-1");

      expect(playback.requests).toEqual([]);
      expect(runtime.cancellations).toEqual([{
        reason: "playback-failed",
        turnId: "turn-1",
      }]);
      await expect(
        coordinator.whenTurnPlaybackSettled("meeting-1", "turn-1"),
      ).resolves.toBe("unplayed");
    },
  );
});

describe("ConversationCoordinator cue playback readiness", () => {
  it("waits for exact thinking-cue readiness before opening cue playback", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const playback = new RecordingPlayback();
    const delay = new ControlledDelayPort();
    const readinessRequests: ConversationPlaybackReadinessRequest[] = [];
    let readinessSignal: AbortSignal | undefined;
    let resolveReadiness!: (
      result: Awaited<ReturnType<ConversationPlaybackReadinessPort[
        "awaitConversationPlaybackReady"
      ]>>,
    ) => void;
    const readiness = new Promise<Awaited<ReturnType<
      ConversationPlaybackReadinessPort["awaitConversationPlaybackReady"]
    >>>((resolve) => {
      resolveReadiness = resolve;
    });
    const coordinator = new ConversationCoordinator({
      delay,
      playback,
      playbackReadiness: {
        awaitConversationPlaybackReady: (request, options) => {
          readinessRequests.push(structuredClone(request));
          readinessSignal = options?.signal;
          return readiness;
        },
      },
      runtime: new ScriptedRuntime([stream]),
      thinkingCues: new FixedThinkingCues(),
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    stream.push({ attemptId: "answer-attempt-1", type: "accepted" });
    delay.delays[0]?.elapse();
    await vi.waitFor(() => {
      expect(readinessRequests).toEqual([{
        meetingId: "meeting-1",
        participantId: "speaker-turn-1",
        playbackAttemptId: "cue-attempt-turn-1-acknowledgement",
        playbackKind: "thinking-cue",
        turnId: "turn-1",
      }]);
    });
    expect(readinessSignal).toBeInstanceOf(AbortSignal);
    expect(readinessSignal?.aborted).toBe(false);
    expect(playback.requests).toEqual([]);

    resolveReadiness({ ok: true, value: "ready" });
    await vi.waitFor(() => {
      expect(playback.requests).toEqual([{
        attemptId: "cue-attempt-turn-1-acknowledgement",
        meetingId: "meeting-1",
        recordingId: "recording-1",
        turnId: "turn-1",
      }]);
    });
    stream.push({ attemptId: "answer-attempt-1", type: "completed" });
    stream.close();
    await coordinator.whenIdle("meeting-1");
  });

  it("aborts pending thinking-cue readiness when the turn is interrupted", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const playback = new RecordingPlayback();
    const delay = new ControlledDelayPort();
    let readinessSignal: AbortSignal | undefined;
    const coordinator = new ConversationCoordinator({
      delay,
      playback,
      playbackReadiness: {
        awaitConversationPlaybackReady: (_request, options) => new Promise((resolve) => {
          readinessSignal = options?.signal;
          options?.signal?.addEventListener("abort", () => {
            resolve({
              failure: {
                code: "PLAYBACK_READINESS_CANCELLED",
                message: "cancelled",
                retryable: false,
              },
              ok: false,
            });
          }, { once: true });
        }),
      },
      runtime: new ScriptedRuntime([stream]),
      thinkingCues: new FixedThinkingCues(),
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    stream.push({ attemptId: "answer-attempt-1", type: "accepted" });
    delay.delays[0]?.elapse();
    await vi.waitFor(() => {
      expect(readinessSignal).toBeInstanceOf(AbortSignal);
    });

    await coordinator.speechStarted("meeting-1", 1_400);
    stream.close();
    await coordinator.whenIdle("meeting-1");

    expect(readinessSignal?.aborted).toBe(true);
    expect(playback.requests).toEqual([]);
  });

  it("bypasses answer readiness for prepared-cue playback", async () => {
    const playback = new RecordingPlayback();
    const awaitConversationPlaybackReady = vi.fn(() =>
      Promise.reject(new Error("answer readiness must not gate a prepared cue"))
    );
    const coordinator = new ConversationCoordinator({
      playback,
      playbackReadiness: { awaitConversationPlaybackReady },
      runtime: new ScriptedRuntime([]),
    });

    await coordinator.playPreparedCue({
      cueId: "farewell-ru-v1",
      locale: "ru",
      meetingId: "meeting-1",
      nowMs: 0,
      pcmChunks: [Uint8Array.of(1, 2)],
      playbackAttemptId: "farewell-attempt-1",
      recordingId: "recording-1",
      speakerId: "system-farewell",
      turnId: "meeting-farewell",
      voiceProfileId: "default",
    });
    await expect(
      coordinator.whenTurnPlaybackSettled("meeting-1", "meeting-farewell"),
    ).resolves.toBe("played");

    expect(awaitConversationPlaybackReady).not.toHaveBeenCalled();
    expect(playback.requests).toEqual([{
      attemptId: "farewell-attempt-1",
      meetingId: "meeting-1",
      recordingId: "recording-1",
      turnId: "meeting-farewell",
    }]);
  });
});
