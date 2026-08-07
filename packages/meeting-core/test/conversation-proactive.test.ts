import { expect, it } from "vitest";

import { ConversationCoordinator } from "../src/application/conversation.js";
import {
  ControlledDelayPort,
  FixedThinkingCues,
  RecordingPlayback,
  ScriptedRuntime,
  audioChunk,
  closedStream,
} from "./conversation-coordinator-fixture.js";

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
