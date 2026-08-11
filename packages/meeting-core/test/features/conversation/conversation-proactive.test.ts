import { expect, it, vi } from "vitest";

import {
  CONVERSATION_QUEUE_TTL_MS,
  ConversationCoordinator,
} from "@discord-meeting/meeting-core/conversation";
import type { ConversationRuntimeEvent } from "@discord-meeting/meeting-core/conversation";
import {
  ControlledDelayPort,
  EventStream,
  FixedThinkingCues,
  RecordingPlayback,
  ScriptedRuntime,
  audioChunk,
  closedStream,
} from "./conversation-coordinator-fixture.js";

const proactiveTurn = (turnId: string, nowMs: number) => ({
  locale: "ru" as const,
  meetingId: "meeting-1",
  nowMs,
  prompt: "Привет!",
  recordingId: "recording-1",
  speakerId: turnId,
  systemPrompt: "Repeat exactly.",
  turnId,
  voiceProfileId: "default",
});

it("streams a proactive greeting without thinking cues", async () => {
  const runtime = new ScriptedRuntime([
    closedStream([
      { attemptId: "attempt-greeting", type: "accepted" },
      {
        attemptId: "attempt-greeting",
        channels: 1,
        format: "pcm_s16le",
        sampleRateHz: 48_000,
        type: "audio-start",
      },
      audioChunk("attempt-greeting", "participant-greeting:42", 0),
      { attemptId: "attempt-greeting", type: "audio-end" },
      { attemptId: "attempt-greeting", type: "completed" },
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

  await expect(coordinator.handleProactiveTurn({
    locale: "ru",
    meetingId: "meeting-1",
    nowMs: 0,
    prompt: "Привет, Саша!",
    recordingId: "recording-1",
    speakerId: "42",
    systemPrompt: "Repeat exactly.",
    turnId: "participant-greeting:42",
    voiceProfileId: "default",
  })).resolves.toMatchObject({
    prompt: "Привет, Саша!",
    status: "active",
    turnId: "participant-greeting:42",
  });
  await coordinator.whenIdle("meeting-1");
  await expect(coordinator.whenTurnPlaybackSettled(
    "meeting-1",
    "participant-greeting:42",
  )).resolves.toBe("played");

  expect(delay.requestedMs).toEqual([]);
  expect(thinkingCues.selections).toEqual([]);
  expect(runtime.requests).toEqual([
    {
      idempotencyKey:
        "25:proactive-conversation:v1|9:meeting-1|11:recording-1|23:participant-greeting:42",
      locale: "ru",
      meetingId: "meeting-1",
      prompt: "Привет, Саша!",
      recordingId: "recording-1",
      speakerId: "42",
      systemPrompt: "Repeat exactly.",
      turnId: "participant-greeting:42",
      voiceProfileId: "default",
    },
  ]);
  expect(playback.requests).toEqual([
    {
      attemptId: "attempt-greeting",
      meetingId: "meeting-1",
      recordingId: "recording-1",
      turnId: "participant-greeting:42",
    },
  ]);
});

it("reports a proactive turn as unplayed when synthesis completes without audio", async () => {
  const runtime = new ScriptedRuntime([
    closedStream([
      { attemptId: "attempt-empty", type: "accepted" },
      { attemptId: "attempt-empty", type: "completed" },
    ]),
  ]);
  const coordinator = new ConversationCoordinator({
    playback: new RecordingPlayback(),
    runtime,
  });

  const outcome = await coordinator.handleProactiveTurn({
    locale: "ru",
    meetingId: "meeting-1",
    nowMs: 0,
    prompt: "Привет, Саша!",
    recordingId: "recording-1",
    speakerId: "42",
    systemPrompt: "Repeat exactly.",
    turnId: "participant-greeting:42",
    voiceProfileId: "default",
  });

  expect(outcome.status).toBe("active");
  await expect(coordinator.whenTurnPlaybackSettled(
    "meeting-1",
    "participant-greeting:42",
  )).resolves.toBe("unplayed");
});

it("does not lose a turn settlement when meeting close races its waiter", async () => {
  const runtime = new ScriptedRuntime([
    closedStream([
      { attemptId: "attempt-empty", type: "accepted" },
      { attemptId: "attempt-empty", type: "completed" },
    ]),
  ]);
  const coordinator = new ConversationCoordinator({
    playback: new RecordingPlayback(),
    runtime,
  });
  await coordinator.handleProactiveTurn({
    locale: "ru",
    meetingId: "meeting-1",
    nowMs: 0,
    prompt: "Привет!",
    recordingId: "recording-1",
    speakerId: "42",
    systemPrompt: "Repeat exactly.",
    turnId: "participant-greeting:42",
    voiceProfileId: "default",
  });

  const settlement = coordinator.whenTurnPlaybackSettled(
    "meeting-1",
    "participant-greeting:42",
  );
  await coordinator.closeMeeting("meeting-1", 1);

  await expect(settlement).resolves.toBe("unplayed");
});

it("settles an expired queued proactive turn as safely unplayed", async () => {
  const first = new EventStream<ConversationRuntimeEvent>();
  const runtime = new ScriptedRuntime([first]);
  const coordinator = new ConversationCoordinator({
    playback: new RecordingPlayback(),
    runtime,
  });
  await expect(coordinator.handleProactiveTurn(proactiveTurn("greeting-1", 0)))
    .resolves.toMatchObject({ status: "active" });
  await expect(coordinator.handleProactiveTurn(proactiveTurn("greeting-2", 1)))
    .resolves.toMatchObject({ status: "queued" });
  coordinator.advanceMeeting("meeting-1", CONVERSATION_QUEUE_TTL_MS + 2);
  const settlement = coordinator.whenTurnPlaybackSettled("meeting-1", "greeting-2");
  first.push({ attemptId: "attempt-1", type: "accepted" });
  first.push({ attemptId: "attempt-1", type: "completed" });
  first.close();

  await expect(settlement).resolves.toBe("unplayed");
  expect(runtime.requests.map(({ turnId }) => turnId)).toEqual(["greeting-1"]);
});

it("settles a queued proactive turn after it is promoted", async () => {
  const first = new EventStream<ConversationRuntimeEvent>();
  const runtime = new ScriptedRuntime([
    first,
    closedStream([
      { attemptId: "attempt-2", type: "accepted" },
      { attemptId: "attempt-2", type: "completed" },
    ]),
  ]);
  const coordinator = new ConversationCoordinator({
    playback: new RecordingPlayback(),
    runtime,
  });
  await coordinator.handleProactiveTurn(proactiveTurn("greeting-1", 0));
  await expect(coordinator.handleProactiveTurn(proactiveTurn("greeting-2", 1)))
    .resolves.toMatchObject({ status: "queued" });
  const settlement = coordinator.whenTurnPlaybackSettled("meeting-1", "greeting-2");
  first.push({ attemptId: "attempt-1", type: "accepted" });
  first.push({ attemptId: "attempt-1", type: "completed" });
  first.close();

  await expect(settlement).resolves.toBe("unplayed");
  expect(runtime.requests.map(({ turnId }) => turnId)).toEqual(["greeting-1", "greeting-2"]);
});

it("settles one turn without waiting for its active successor", async () => {
  const first = new EventStream<ConversationRuntimeEvent>();
  const second = new EventStream<ConversationRuntimeEvent>();
  const runtime = new ScriptedRuntime([first, second]);
  const coordinator = new ConversationCoordinator({
    playback: new RecordingPlayback(),
    runtime,
  });
  await coordinator.handleProactiveTurn(proactiveTurn("greeting-1", 0));
  await coordinator.handleProactiveTurn(proactiveTurn("greeting-2", 1));
  const observed: string[] = [];
  void coordinator.whenTurnPlaybackSettled("meeting-1", "greeting-1")
    .then((settlement) => observed.push(settlement));
  first.push({ attemptId: "attempt-1", type: "accepted" });
  first.push({ attemptId: "attempt-1", type: "completed" });
  first.close();

  await vi.waitFor(() => {
    expect(runtime.requests.map(({ turnId }) => turnId))
      .toEqual(["greeting-1", "greeting-2"]);
    expect(observed).toEqual(["unplayed"]);
  });
  await coordinator.closeMeeting("meeting-1", 2);
});
