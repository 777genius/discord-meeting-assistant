import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_WAKE_LATCH_MS,
  ConversationCoordinator,
} from "@discord-meeting/meeting-core/conversation";
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

  it("bypasses answer readiness for thinking-cue playback", async () => {
    const stream = new EventStream<ConversationRuntimeEvent>();
    const playback = new RecordingPlayback();
    const delay = new ControlledDelayPort();
    const awaitConversationPlaybackReady = vi.fn(() =>
      Promise.reject(new Error("answer readiness must not gate a thinking cue"))
    );
    const coordinator = new ConversationCoordinator({
      delay,
      playback,
      playbackReadiness: { awaitConversationPlaybackReady },
      runtime: new ScriptedRuntime([stream]),
      thinkingCues: new FixedThinkingCues(),
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 0));
    stream.push({ attemptId: "answer-attempt-1", type: "accepted" });
    delay.delays[0]?.elapse();
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

    expect(awaitConversationPlaybackReady).not.toHaveBeenCalled();
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
