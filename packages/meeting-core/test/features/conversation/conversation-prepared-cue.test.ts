import { expect, it } from "vitest";

import {
  ConversationCoordinator,
  type ConversationRuntimeEvent,
} from "@discord-meeting/meeting-core/conversation";
import {
  EventStream,
  RecordingPlayback,
  ScriptedRuntime,
  input,
} from "./conversation-coordinator-fixture.js";

it("preempts an active answer and plays pre-generated PCM without another runtime call", async () => {
  const answerStream = new EventStream<ConversationRuntimeEvent>();
  const runtime = new ScriptedRuntime([answerStream]);
  const playback = new RecordingPlayback();
  const coordinator = new ConversationCoordinator({ playback, runtime });

  await coordinator.handleFinalizedTurn(input("turn-1", 0));
  await expect(coordinator.playPreparedCue({
    cueId: "farewell-ru-v1",
    locale: "ru",
    meetingId: "meeting-1",
    nowMs: 10,
    pcmChunks: [Uint8Array.of(1, 2), Uint8Array.of(3, 4)],
    playbackAttemptId: "farewell-attempt-1",
    recordingId: "recording-1",
    speakerId: "system-farewell",
    turnId: "meeting-farewell",
    voiceProfileId: "default",
  })).resolves.toMatchObject({
    prompt: "farewell-ru-v1",
    status: "queued",
    turnId: "meeting-farewell",
  });
  await coordinator.whenIdle("meeting-1");
  await expect(coordinator.whenTurnPlaybackSettled(
    "meeting-1",
    "meeting-farewell",
  )).resolves.toBe("played");

  expect(runtime.requests).toHaveLength(1);
  expect(runtime.cancellations).toEqual([
    { reason: "superseded", turnId: "turn-1" },
  ]);
  expect(playback.requests).toEqual([
    {
      attemptId: "farewell-attempt-1",
      meetingId: "meeting-1",
      recordingId: "recording-1",
      turnId: "meeting-farewell",
    },
  ]);
  expect(playback.sessions[0]?.chunks).toEqual([
    {
      attemptId: "farewell-attempt-1",
      bytes: Uint8Array.of(1, 2),
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      sequence: 0,
      turnId: "meeting-farewell",
    },
    {
      attemptId: "farewell-attempt-1",
      bytes: Uint8Array.of(3, 4),
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
      sequence: 1,
      turnId: "meeting-farewell",
    },
  ]);
});

it("queues a non-preemptive prepared greeting behind an answer race", async () => {
  const answerStream = new EventStream<ConversationRuntimeEvent>();
  const runtime = new ScriptedRuntime([answerStream]);
  const playback = new RecordingPlayback();
  const coordinator = new ConversationCoordinator({ playback, runtime });

  await coordinator.handleFinalizedTurn(input("turn-1", 0));
  await expect(coordinator.playPreparedCue({
    cueId: "greeting-ru-v1",
    interruptible: false,
    locale: "ru",
    meetingId: "meeting-1",
    nowMs: 10,
    pcmChunks: [Uint8Array.of(1, 2)],
    playbackAttemptId: "greeting-attempt-1",
    preemptive: false,
    recordingId: "recording-1",
    speakerId: "participant-1",
    turnId: "participant-greeting:1",
    voiceProfileId: "default",
  })).resolves.toMatchObject({ status: "queued" });
  expect(runtime.cancellations).toEqual([]);

  answerStream.push({ attemptId: "answer-attempt", type: "accepted" });
  answerStream.push({ attemptId: "answer-attempt", type: "completed" });
  answerStream.close();
  await expect(coordinator.whenTurnPlaybackSettled(
    "meeting-1",
    "participant-greeting:1",
  )).resolves.toBe("played");

  expect(runtime.cancellations).toEqual([]);
  expect(playback.requests).toEqual([{
    attemptId: "greeting-attempt-1",
    meetingId: "meeting-1",
    recordingId: "recording-1",
    turnId: "participant-greeting:1",
  }]);
});

it("rejects malformed prepared PCM before opening playback", async () => {
  const coordinator = new ConversationCoordinator({
    playback: new RecordingPlayback(),
    runtime: new ScriptedRuntime([]),
  });

  await expect(coordinator.playPreparedCue({
    cueId: "farewell-en-v1",
    locale: "en",
    meetingId: "meeting-1",
    nowMs: 0,
    pcmChunks: [Uint8Array.of(1)],
    playbackAttemptId: "farewell-attempt-1",
    recordingId: "recording-1",
    speakerId: "system-farewell",
    turnId: "meeting-farewell",
    voiceProfileId: "default",
  })).rejects.toThrow("sample-aligned PCM");
});

it("does not let participant speech cancel a non-interruptible prepared greeting", async () => {
  const coordinator = new ConversationCoordinator({
    playback: new RecordingPlayback(),
    runtime: new ScriptedRuntime([]),
  });

  await coordinator.playPreparedCue({
    cueId: "greeting-ru-v1",
    interruptible: false,
    locale: "ru",
    meetingId: "meeting-1",
    nowMs: 0,
    pcmChunks: [Uint8Array.of(1, 2)],
    playbackAttemptId: "greeting-attempt-1",
    recordingId: "recording-1",
    speakerId: "participant-1",
    turnId: "participant-greeting:1",
    voiceProfileId: "default",
  });

  await expect(coordinator.speechStarted("meeting-1", 1)).resolves.toEqual({
    status: "ignored",
  });
  await expect(coordinator.whenTurnPlaybackSettled(
    "meeting-1",
    "participant-greeting:1",
  )).resolves.toBe("played");
});
