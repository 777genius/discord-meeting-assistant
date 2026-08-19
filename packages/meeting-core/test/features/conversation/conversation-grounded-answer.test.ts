import type {
  ConversationPortResult,
  ConversationRuntimeEvent,
  GroundedKnowledgeAnswerOptions,
  GroundedKnowledgeAnswerObservation,
  GroundedKnowledgeAnswerPort,
  GroundedKnowledgePlaybackAuthorityRequest,
  GroundedKnowledgeAnswerRequest,
} from "@discord-meeting/meeting-core/conversation";
import { ConversationCoordinator } from "@discord-meeting/meeting-core/conversation";
import { describe, expect, it } from "vitest";

import {
  ControlledDelayPort,
  EventStream,
  FixedThinkingCues,
  RecordingPlayback,
  ScriptedRuntime,
  audioChunk,
  closedStream,
  input,
} from "./conversation-coordinator-fixture.js";

class ControlledGroundedAnswers implements GroundedKnowledgeAnswerPort {
  public readonly calls: Array<{
    readonly options: GroundedKnowledgeAnswerOptions;
    readonly request: GroundedKnowledgeAnswerRequest;
  }> = [];
  public readonly playbackAuthorityCalls: GroundedKnowledgePlaybackAuthorityRequest[] = [];
  public playbackAuthorityCurrent = true;
  private readonly pending: Array<(
    value: ConversationPortResult<unknown>,
  ) => void> = [];

  public answer(
    request: GroundedKnowledgeAnswerRequest,
    options: GroundedKnowledgeAnswerOptions,
  ): Promise<ConversationPortResult<unknown>> {
    this.calls.push({ options, request: structuredClone(request) });
    return new Promise((resolve) => {
      this.pending.push(resolve);
    });
  }

  public resolve(value: ConversationPortResult<unknown>): void {
    const resolve = this.pending.shift();
    if (resolve === undefined) {
      throw new Error("no grounded answer is pending");
    }
    resolve(value);
  }

  public recheckPlaybackAuthority(
    request: GroundedKnowledgePlaybackAuthorityRequest,
    options: GroundedKnowledgeAnswerOptions,
  ): Promise<ConversationPortResult<"current">> {
    this.playbackAuthorityCalls.push(structuredClone(request));
    return Promise.resolve(
      this.playbackAuthorityCurrent && !options.signal.aborted
        ? { ok: true, value: "current" }
        : {
            failure: {
              code: "STALE_PLAYBACK_AUTHORITY",
              message: "stale",
              retryable: false,
            },
            ok: false,
          },
    );
  }
}

function answer(plainText = "Решили выпустить в пятницу."): ConversationPortResult<unknown> {
  return {
    ok: true,
    value: {
      citations: [{ turnId: "evidence-turn-1" }],
      evidenceEpoch: "evidence-7",
      knowledgeEpoch: "knowledge-9",
      plainText,
      schemaVersion: 1,
      status: "answered",
    },
  };
}

function ttsAttestation(): ConversationRuntimeEvent {
  return {
    attemptId: "attempt-1",
    attestation: {
      attemptId: "attempt-1",
      deployment: "pipecat-runtime",
      keyId: "a".repeat(64),
      model: "fixture-tts-v1",
      provider: "fixture",
      schemaVersion: 1,
      signature: "b".repeat(64),
      sourceRevision: "c".repeat(40),
      turnId: "turn-1",
      voice: "fixture",
      voiceProfileId: "default",
    },
    type: "tts-attestation",
  };
}

type InvalidTtsAttestationScenario =
  | "missing"
  | "mismatched-attempt"
  | "mismatched-turn"
  | "mismatched-voice-profile";

async function expectGroundedPcmRejectedForAttestation(
  scenario: InvalidTtsAttestationScenario,
): Promise<void> {
  const groundedAnswers = new ControlledGroundedAnswers();
  const events = new EventStream<ConversationRuntimeEvent>();
  const runtime = new ScriptedRuntime([events]);
  const playback = new RecordingPlayback();
  const coordinator = new ConversationCoordinator({ groundedAnswers, playback, runtime });

  await coordinator.handleFinalizedTurn(input("turn-1", 1));
  groundedAnswers.resolve(answer());
  await waitUntil(() => runtime.requests.length === 1);
  events.push({ attemptId: "attempt-1", type: "accepted" });
  if (scenario !== "missing") {
    const attestation = ttsAttestation();
    if (attestation.type !== "tts-attestation") {
      throw new Error("fixture did not create a TTS attestation");
    }
    events.push({
      ...attestation,
      ...(scenario === "mismatched-attempt" ? { attemptId: "other-attempt" } : {}),
      attestation: {
        ...attestation.attestation,
        ...(scenario === "mismatched-turn"
          ? { turnId: "other-turn" }
          : scenario === "mismatched-voice-profile"
            ? { voiceProfileId: "other-profile" }
            : {}),
      },
    });
  }
  events.push({
    attemptId: "attempt-1",
    channels: 1,
    format: "pcm_s16le",
    sampleRateHz: 48_000,
    type: "audio-start",
  });
  await coordinator.whenIdle("meeting-1");

  expect(playback.requests).toEqual([]);
  expect(groundedAnswers.playbackAuthorityCalls).toEqual([]);
  expect(runtime.cancellations).toContainEqual({
    reason: "runtime-shutdown",
    turnId: "turn-1",
  });
}

describe("Conversation grounded knowledge execution", () => {
  it("buffers and validates the complete answer before existing literal speech", async () => {
    const groundedAnswers = new ControlledGroundedAnswers();
    const runtime = new ScriptedRuntime([closedStream([
      { attemptId: "attempt-1", type: "accepted" },
      ttsAttestation(),
      { attemptId: "attempt-1", channels: 1, format: "pcm_s16le", sampleRateHz: 48_000, type: "audio-start" },
      audioChunk("attempt-1", "turn-1", 1),
      { attemptId: "attempt-1", type: "audio-end" },
      { attemptId: "attempt-1", type: "completed" },
    ])]);
    const playback = new RecordingPlayback();
    const observations: GroundedKnowledgeAnswerObservation[] = [];
    const coordinator = new ConversationCoordinator({
      groundedAnswerObserver: {
        observeGroundedKnowledgeAnswer: (observation) => {
          observations.push(observation);
        },
      },
      groundedAnswers,
      playback,
      runtime,
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 1));
    expect(runtime.requests).toEqual([]);
    expect(playback.requests).toEqual([]);
    expect(groundedAnswers.calls[0]).toMatchObject({
      request: {
        locale: "ru-RU",
        meetingId: "meeting-1",
        participantId: "speaker-turn-1",
        question: "ответь кратко.",
        roomId: "private-room-1",
      },
    });

    groundedAnswers.resolve(answer());
    await coordinator.whenIdle("meeting-1");

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]).toMatchObject({
      literalSpeech: "Решили выпустить в пятницу.",
      prompt: "ответь кратко.",
    });
    expect(playback.sessions[0]?.chunks).toHaveLength(1);
    expect(groundedAnswers.playbackAuthorityCalls).toEqual([{
      citationTurnIds: ["evidence-turn-1"],
      evidenceEpoch: "evidence-7",
      knowledgeEpoch: "knowledge-9",
      request: {
        locale: "ru-RU",
        meetingId: "meeting-1",
        participantId: "speaker-turn-1",
        question: "ответь кратко.",
        roomId: "private-room-1",
      },
    }]);
    expect(observations).toEqual([{
      citationTurnIds: ["evidence-turn-1"],
      evidenceEpoch: "evidence-7",
      knowledgeEpoch: "knowledge-9",
      meetingId: "meeting-1",
      participantId: "speaker-turn-1",
      playbackProvenance: "literal_tts",
      status: "validated",
      turnId: "turn-1",
    }]);
  });

  it("rechecks authority at the PCM edge and writes zero bytes after watermark drift", async () => {
    const groundedAnswers = new ControlledGroundedAnswers();
    const events = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([events]);
    const playback = new RecordingPlayback();
    const coordinator = new ConversationCoordinator({ groundedAnswers, playback, runtime });

    await coordinator.handleFinalizedTurn(input("turn-1", 1));
    groundedAnswers.resolve(answer());
    await waitUntil(() => runtime.requests.length === 1);
    events.push({ attemptId: "attempt-1", type: "accepted" });
    events.push(ttsAttestation());
    events.push({
      attemptId: "attempt-1",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    await waitUntil(() => playback.sessions.length === 1);
    groundedAnswers.playbackAuthorityCurrent = false;
    events.push(audioChunk("attempt-1", "turn-1", 0));
    await coordinator.whenIdle("meeting-1");

    expect(groundedAnswers.playbackAuthorityCalls).toHaveLength(1);
    expect(playback.sessions.flatMap(({ chunks }) => chunks)).toEqual([]);
    expect(runtime.cancellations).toContainEqual({
      reason: "disconnected",
      turnId: "turn-1",
    });
    await expect(coordinator.whenTurnPlaybackSettled("meeting-1", "turn-1"))
      .resolves.toBe("unplayed");
  });

  it.each([
    "missing",
    "mismatched-attempt",
    "mismatched-turn",
    "mismatched-voice-profile",
  ] as const)(
    "fails closed before grounded PCM for %s TTS attestation",
    expectGroundedPcmRejectedForAttestation,
  );

  it("fails closed before runtime for incomplete, ungrounded or unsafe answers", async () => {
    for (const value of [
      { ...answer(), value: { plainText: "partial", schemaVersion: 1, status: "answered" } },
      answer("unsafe\u202Etext"),
      { ok: false, failure: { code: "NOT_FOUND", message: "none", retryable: false } } as const,
    ]) {
      const groundedAnswers = new ControlledGroundedAnswers();
      const runtime = new ScriptedRuntime([]);
      const playback = new RecordingPlayback();
      const coordinator = new ConversationCoordinator({ groundedAnswers, playback, runtime });
      await coordinator.handleFinalizedTurn(input("turn-1", 1));
      groundedAnswers.resolve(value);
      await coordinator.whenIdle("meeting-1");
      expect(runtime.requests).toEqual([]);
      expect(playback.requests).toEqual([]);
    }
  });

  it.each([
    ["disconnect", async (coordinator: ConversationCoordinator) => coordinator.disconnectMeeting("meeting-1", 2)],
    ["participant departure", async (coordinator: ConversationCoordinator) =>
      coordinator.participantLeft("meeting-1", "speaker-turn-1", 2)],
    ["meeting end", async (coordinator: ConversationCoordinator) => {
      const closing = coordinator.closeMeeting("meeting-1", 2);
      await Promise.resolve();
      return closing;
    }],
    ["supersession", async (coordinator: ConversationCoordinator) => {
      await coordinator.playPreparedCue({
        cueId: "farewell-ru-v1",
        interruptible: false,
        locale: "ru",
        meetingId: "meeting-1",
        nowMs: 2,
        pcmChunks: [Uint8Array.of(1, 2)],
        playbackAttemptId: "farewell-attempt-1",
        recordingId: "recording-1",
        speakerId: "system",
        turnId: "farewell-1",
        voiceProfileId: "default",
      });
    }],
  ])("aborts the active signal and emits no factual PCM after %s", async (_label, cancel) => {
    const groundedAnswers = new ControlledGroundedAnswers();
    const runtime = new ScriptedRuntime([new EventStream()]);
    const playback = new RecordingPlayback();
    const observations: GroundedKnowledgeAnswerObservation[] = [];
    const coordinator = new ConversationCoordinator({
      groundedAnswerObserver: {
        observeGroundedKnowledgeAnswer: (observation) => {
          observations.push(observation);
        },
      },
      groundedAnswers,
      playback,
      runtime,
    });
    await coordinator.handleFinalizedTurn(input("turn-1", 1));
    const operation = cancel(coordinator);
    expect(groundedAnswers.calls[0]?.options.signal.aborted).toBe(true);
    groundedAnswers.resolve(answer());
    await operation;
    await coordinator.whenIdle("meeting-1");
    expect(runtime.requests).toEqual([]);
    expect(playback.sessions.flatMap(({ chunks }) => chunks)).toEqual([]);
    expect(observations).toContainEqual({
      cancellationObservedAtMs: 2,
      meetingId: "meeting-1",
      reason: _label === "disconnect" || _label === "participant departure"
        ? "disconnected" :
        _label === "meeting end" ? "meeting-ended" : "superseded",
      status: "cancelled",
      turnId: "turn-1",
    });
  });

  it("uses the same active signal for retrieval and barge-in cancellation", async () => {
    const groundedAnswers = new ControlledGroundedAnswers();
    const runtime = new ScriptedRuntime([new EventStream()]);
    const playback = new RecordingPlayback();
    const delay = new ControlledDelayPort();
    const coordinator = new ConversationCoordinator({
      delay,
      groundedAnswers,
      playback,
      runtime,
      thinkingCues: new FixedThinkingCues(),
    });
    await coordinator.handleFinalizedTurn(input("turn-1", 1));
    delay.delays[0]?.elapse();
    await waitUntil(() => playback.sessions.length === 1);
    await coordinator.speechStarted("meeting-1", 1_301);
    await coordinator.speechActivity("meeting-1", 1_302);
    expect(groundedAnswers.calls[0]?.options.signal.aborted).toBe(true);
    groundedAnswers.resolve(answer());
    await coordinator.whenIdle("meeting-1");
    expect(runtime.requests).toEqual([]);
    // Acknowledgement cue PCM is allowed; the factual runtime never started.
    expect(playback.requests.map(({ turnId }) => turnId)).toEqual(["turn-1"]);
  });

  it("sends one canonical cancellation observation to grounding and playback", async () => {
    const groundedAnswers = new ControlledGroundedAnswers();
    const events = new EventStream<ConversationRuntimeEvent>();
    const runtime = new ScriptedRuntime([events]);
    const playback = new RecordingPlayback();
    const observations: GroundedKnowledgeAnswerObservation[] = [];
    const coordinator = new ConversationCoordinator({
      groundedAnswerObserver: {
        observeGroundedKnowledgeAnswer: (observation) => {
          observations.push(observation);
        },
      },
      groundedAnswers,
      playback,
      runtime,
    });

    await coordinator.handleFinalizedTurn(input("turn-1", 1));
    groundedAnswers.resolve(answer());
    await waitUntil(() => runtime.requests.length === 1);
    events.push({ attemptId: "attempt-1", type: "accepted" });
    events.push(ttsAttestation());
    events.push({
      attemptId: "attempt-1",
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      type: "audio-start",
    });
    await waitUntil(() => playback.sessions.length === 1);

    await coordinator.disconnectMeeting("meeting-1", 177);
    await coordinator.whenIdle("meeting-1");

    expect(observations).toContainEqual(expect.objectContaining({
      cancellationObservedAtMs: 177,
      meetingId: "meeting-1",
      status: "cancelled",
      turnId: "turn-1",
    }));
    expect(playback.sessions[0]?.cancellationRequests).toEqual([{
      cancellationObservedAtMs: 177,
      reason: "disconnected",
    }]);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error("condition was not reached");
}
