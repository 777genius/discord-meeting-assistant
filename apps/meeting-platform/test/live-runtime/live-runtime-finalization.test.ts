import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
} from "@discord-meeting/meeting-core/live-meeting";
import { afterEach, expect, it, vi } from "vitest";

import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import {
  BlockedFinalizeLiveTranscriberStub,
  DeferredSummaryStub,
  ended,
  FinalizingFailingProjectionStub,
  LiveTranscriberStub,
  logger,
  MemoryLiveMeetingRepository,
  packets,
  ProjectionStub,
  started,
  SummaryStub,
} from "./live-runtime-fixtures.js";

afterEach(() => vi.useRealTimers());

it("drains an in-flight generation before the terminal projection and performs no post-final writes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const summarizer = new DeferredSummaryStub();
  const projector = new ProjectionStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer,
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber: new LiveTranscriberStub(),
  });
  const firstBatch = packets();
  firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };

  await runtime.acceptLifecycle(started());
  void runtime.acceptVoiceBatch(firstBatch);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(summarizer.requests).toHaveLength(1);

  let settled = false;
  const fence = runtime
    .settleBeforeFinalPublication("recording-live-1")
    .then(() => {
      settled = true;
      return settled;
    });
  await Promise.resolve();
  expect(settled).toBe(false);

  summarizer.resolveNext();
  await fence;

  expect(meetings.snapshot).toMatchObject({
    draftSummary: { revision: 1 },
    status: "ended",
  });
  expect(projector.requests.at(-1)).toMatchObject({
    status: "ended",
    summary: { revision: 1 },
  });
  const projectionCount = projector.requests.length;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(projector.requests).toHaveLength(projectionCount);

  await runtime.close();
});

it("starts live finalization when the authoritative publisher reaches the fence", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:01.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber: new LiveTranscriberStub(),
  });

  await runtime.acceptLifecycle(started());
  await runtime.settleBeforeFinalPublication("recording-live-1");

  expect(meetings.snapshot).toMatchObject({
    endedAtMs: Date.parse("2026-08-02T10:00:01.000Z"),
    status: "ended",
  });
  await runtime.close();
});

it("projects finalizing before a blocked provider finalize and preserves the final fence", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const summarizer = new SummaryStub();
  const projector = new ProjectionStub();
  const startMeeting = new StartLiveMeeting({ meetings });
  const appendTurn = new AppendLiveTranscriptTurn(meetings);
  const startedAtMs = Date.parse("2026-08-02T10:00:00.000Z");

  await startMeeting.execute({
    meetingId: "recording-live-1",
    publicationTargetId: "1533228891827736657",
    startedAtMs,
  });
  await appendTurn.execute("recording-live-1", {
    endMs: 2_000,
    speakerId: "1533228054724346087",
    startMs: 1_000,
    text: "Existing caption before the call ends.",
    turnId: "turn-before-finalizing",
  });
  await new RefreshLiveMeeting({ meetings, projector, summarizer }).execute({
    captions: [{
      endMs: 2_000,
      isFinal: true,
      speakerId: "1533228054724346087",
      startMs: 1_000,
      text: "Existing caption before the call ends.",
    }],
    meetingId: "recording-live-1",
    nowMs: startedAtMs + 300_000,
  });

  const transcriber = new BlockedFinalizeLiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn,
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer }),
    speakerIdleFinalizeMs: 10_000,
    startMeeting,
    transcriber,
  });
  const packetBatch = packets();
  packetBatch.packets[0] = {
    ...packetBatch.packets[0]!,
    relativeTimeMs: 0,
  };

  await runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(0);
  await runtime.acceptVoiceBatch(packetBatch);
  await vi.advanceTimersByTimeAsync(0);
  const terminal = runtime.acceptLifecycle(ended());
  await vi.advanceTimersByTimeAsync(0);

  expect(transcriber.finalizationStarted).toBe(true);
  expect(projector.requests.at(-1)).toMatchObject({
    captions: [expect.objectContaining({ text: "Existing caption before the call ends." })],
    currentExternalPublicationId: "thread-1",
    phase: "finalizing",
    status: "active",
    summary: { revision: 1 },
  });
  expect(meetings.snapshot?.status).toBe("active");

  let fenceReleased = false;
  const fence = runtime.settleBeforeFinalPublication("recording-live-1").then(() => {
    fenceReleased = true;
    return null;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(fenceReleased).toBe(false);

  transcriber.release();
  await Promise.all([terminal, fence]);

  expect(meetings.snapshot).toMatchObject({ status: "ended" });
  expect(meetings.finalizedTurns).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: "Late provider final turn." }),
  ]));
  expect(projector.requests.at(-1)).toMatchObject({
    currentExternalPublicationId: "thread-1",
    phase: "finalizing",
    status: "ended",
  });
  await runtime.close();
});

it("does not let a finalizing projection failure hold the final fence", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const projector = new FinalizingFailingProjectionStub();
  const startMeeting = new StartLiveMeeting({ meetings });
  const appendTurn = new AppendLiveTranscriptTurn(meetings);
  const startedAtMs = Date.parse("2026-08-02T10:00:00.000Z");

  await startMeeting.execute({
    meetingId: "recording-live-1",
    publicationTargetId: "1533228891827736657",
    startedAtMs,
  });
  await appendTurn.execute("recording-live-1", {
    endMs: 2_000,
    speakerId: "1533228054724346087",
    startMs: 1_000,
    text: "Existing caption before projection failure.",
    turnId: "turn-before-projection-failure",
  });
  await new RefreshLiveMeeting({
    meetings,
    projector,
    summarizer: new SummaryStub(),
  }).execute({
    captions: [{
      endMs: 2_000,
      isFinal: true,
      speakerId: "1533228054724346087",
      startMs: 1_000,
      text: "Existing caption before projection failure.",
    }],
    meetingId: "recording-live-1",
    nowMs: startedAtMs + 2_000,
    summaryGeneration: "skip",
  });

  const transcriber = new BlockedFinalizeLiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn,
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer: new SummaryStub(),
    }),
    speakerIdleFinalizeMs: 10_000,
    startMeeting,
    transcriber,
  });
  const packetBatch = packets();
  packetBatch.packets[0] = {
    ...packetBatch.packets[0]!,
    relativeTimeMs: 0,
  };

  await runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(0);
  await runtime.acceptVoiceBatch(packetBatch);
  await vi.advanceTimersByTimeAsync(0);
  const terminal = runtime.acceptLifecycle(ended());
  await vi.advanceTimersByTimeAsync(0);
  expect(projector.requests.at(-1)).toMatchObject({ phase: "finalizing" });

  const fence = runtime.settleBeforeFinalPublication("recording-live-1");
  transcriber.release();
  await Promise.all([terminal, fence]);
  expect(meetings.snapshot?.status).toBe("ended");
  await runtime.close();
});

it("keeps Opus and derived state off the authoritative request path", async () => {
  const meetings = new MemoryLiveMeetingRepository();
  const summarizer = new SummaryStub();
  const projector = new ProjectionStub();
  const transcriber = new LiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer,
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });

  await runtime.acceptLifecycle(started());
  await runtime.acceptVoiceBatch(packets());
  await Promise.resolve();
  await runtime.acceptLifecycle(ended());
  await runtime.close();

  expect(transcriber.packets).toHaveLength(1);
  expect(transcriber.finalizationCount).toBe(1);
  expect(transcriber.terminatedSessionCount).toBe(0);
  expect(summarizer.requests).toHaveLength(0);
  expect(projector.requests).toHaveLength(2);
  expect(projector.requests[0]).toMatchObject({
    captions: [{ isFinal: true, speakerId: "1533228054724346087" }],
    elapsedMs: 360_000,
    phase: "finalizing",
    status: "active",
    summary: null,
  });
  expect(projector.requests[1]).toMatchObject({
    currentExternalPublicationId: "thread-1",
    phase: "finalizing",
    status: "ended",
  });
  expect(meetings.snapshot).toMatchObject({
    draftSummary: null,
    endedAtMs: Date.parse("2026-08-02T10:06:00.000Z"),
    status: "ended",
  });
  expect(meetings.finalizedTurns).toEqual([
    expect.objectContaining({ text: "Выпускаем версию в пятницу." }),
  ]);
});

it("finalizes an idle speaker and reopens with a new absolute timeline segment", async () => {
  vi.useFakeTimers();
  const meetings = new MemoryLiveMeetingRepository();
  const summarizer = new SummaryStub();
  const projector = new ProjectionStub();
  const transcriber = new LiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer,
    }),
    speakerIdleFinalizeMs: 100,
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });

  await runtime.acceptLifecycle(started());
  void runtime.acceptVoiceBatch(packets());
  await vi.advanceTimersByTimeAsync(101);
  expect(transcriber.finalizationCount).toBe(1);

  void runtime.acceptVoiceBatch(packets());
  await vi.advanceTimersByTimeAsync(1);
  expect(transcriber.requests).toHaveLength(1);

  const laterBatch = packets();
  laterBatch.packets[0] = {
    ...laterBatch.packets[0]!,
    relativeTimeMs: 355_000,
    sequenceNumber: 2,
    mediaTimestamp: 1_920,
  };
  void runtime.acceptVoiceBatch(laterBatch);
  await vi.advanceTimersByTimeAsync(1);
  await runtime.acceptLifecycle(ended());
  await runtime.close();

  expect(
    transcriber.requests.map(({ idempotencyKey }) => idempotencyKey),
  ).toEqual([
    "live-transcription:v2|recording-live-1|1533228054724346087|1",
    "live-transcription:v2|recording-live-1|1533228054724346087|2",
  ]);
  expect(transcriber.finalizationCount).toBe(2);
  expect(meetings.finalizedTurns.map(({ startMs }) => startMs)).toEqual([
    350_000, 355_000,
  ]);
});

it("keeps one provider session across a relative timeline gap in one batch", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:06:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const summarizer = new SummaryStub();
  const projector = new ProjectionStub();
  const transcriber = new LiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer,
    }),
    speakerIdleFinalizeMs: 100,
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });
  const first = packets().packets[0]!;

  await runtime.acceptLifecycle(started());
  await runtime.acceptVoiceBatch({
    format: packets().format,
    packets: [
      { ...first, relativeTimeMs: 350_000 },
      {
        ...first,
        relativeTimeMs: 352_000,
        sequenceNumber: 2,
        mediaTimestamp: 1_920,
      },
    ],
  });
  await vi.advanceTimersByTimeAsync(20);
  await runtime.acceptLifecycle(ended());
  await runtime.close();

  expect(transcriber.requests).toHaveLength(1);
  expect(transcriber.finalizationCount).toBe(1);
  expect(
    transcriber.packets.map(
      ({ durationSamples48Khz }) => durationSamples48Khz,
    ),
  ).toEqual([960, 960]);
  expect(meetings.finalizedTurns.map(({ startMs }) => startMs)).toEqual([
    350_000, 352_000,
  ]);
});
