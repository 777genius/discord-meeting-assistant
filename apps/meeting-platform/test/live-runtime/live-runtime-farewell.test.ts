import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
} from "@discord-meeting/meeting-core/live-meeting";
import { afterEach, expect, it, vi } from "vitest";

import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import {
  ConversationCoordinatorProbe,
  ControlledLiveTranscriberStub,
  logger,
  MemoryLiveMeetingRepository,
  packets,
  ProjectionStub,
  started,
  SummaryStub,
} from "./live-runtime-fixtures.js";

afterEach(() => vi.useRealTimers());

it("plays one prepared farewell only after its final turn is durable", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const coordinator = new ConversationCoordinatorProbe(meetings);
  const transcriber = new ControlledLiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    conversation: {
      coordinator,
      farewells: {
        cues: {
          select: ({ locale, meetingId }) => ({
            cueId: `farewell-${locale}-v1`,
            pcmChunks: [Uint8Array.of(1, 2)],
            playbackAttemptId: `farewell-${meetingId}-${locale}`,
          }),
        },
        participantNames: {},
      },
      locale: "auto",
      nowMilliseconds: () => performance.now(),
      systemPrompt: "Answer briefly.",
      voiceProfileId: "voice-profile",
    },
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });

  await runtime.acceptLifecycle(started());
  const firstBatch = packets();
  firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };
  await runtime.acceptVoiceBatch(firstBatch);
  await vi.waitFor(() => {
    expect(transcriber.requests).toHaveLength(1);
  });
  const request = transcriber.requests[0];
  if (request === undefined) {
    throw new Error("controlled transcription session did not open");
  }
  request.onTranscript({
    endMs: 1_000,
    isFinal: true,
    meetingId: request.meetingId,
    speakerId: request.speakerId,
    startMs: 0,
    text: "Всем пока!",
  });
  expect(coordinator.preparedCueCalls).toEqual([]);
  await vi.waitFor(() => {
    expect(meetings.finalizedTurns).toHaveLength(1);
  });
  await vi.advanceTimersByTimeAsync(200);
  await vi.waitFor(() => {
    expect(coordinator.preparedCueCalls).toHaveLength(1);
  });

  expect(coordinator.preparedCueCalls[0]).toMatchObject({
    cueId: "farewell-ru-v1",
    locale: "ru",
    turnId: "meeting-farewell:v1",
  });
  await runtime.close();
});

it("retains quoted finalized farewells without producing synthetic playback", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const coordinator = new ConversationCoordinatorProbe(meetings);
  const transcriber = new ControlledLiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    conversation: {
      coordinator,
      farewells: {
        cues: {
          select: ({ locale, meetingId }) => ({
            cueId: `farewell-${locale}-v1`,
            pcmChunks: [Uint8Array.of(1, 2)],
            playbackAttemptId: `farewell-${meetingId}-${locale}`,
          }),
        },
        participantNames: {},
      },
      locale: "auto",
      nowMilliseconds: () => performance.now(),
      systemPrompt: "Answer briefly.",
      voiceProfileId: "voice-profile",
    },
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });

  await runtime.acceptLifecycle(started());
  const firstBatch = packets();
  firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };
  await runtime.acceptVoiceBatch(firstBatch);
  await vi.waitFor(() => expect(transcriber.requests).toHaveLength(1));
  const request = transcriber.requests[0];
  if (request === undefined) {
    throw new Error("controlled transcription session did not open");
  }
  const quotedTurns = [
    '"Bye everyone"',
    '“Bye everyone!”',
    '«Всем пока!»',
    'The slide says "Bye everyone" and then continues',
    'Please repeat “Bye, Alice” slowly',
    'Повтори «Пока, Саша» медленно',
  ];
  for (const [index, text] of quotedTurns.entries()) {
    request.onTranscript({
      endMs: 1_000 + index * 100,
      isFinal: true,
      meetingId: request.meetingId,
      speakerId: request.speakerId,
      startMs: index * 100,
      text,
    });
  }
  await vi.waitFor(() => expect(meetings.finalizedTurns).toHaveLength(quotedTurns.length));
  await vi.advanceTimersByTimeAsync(1_000);

  expect(meetings.finalizedTurns.map(({ text }) => text)).toEqual(quotedTurns);
  expect(coordinator.preparedCueCalls).toEqual([]);
  await runtime.close();
});
