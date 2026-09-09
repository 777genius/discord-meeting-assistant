import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  LiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
} from "@discord-meeting/meeting-core/live-meeting";
import { afterEach, expect, it, vi } from "vitest";

import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import { createLiveIncrementalSummaryPort } from
  "../../src/composition/discord-live.js";
import type { PlatformConfig } from "../../src/config.js";
import {
  DeferredSummaryStub,
  FailingProjectionStub,
  FailingSummaryStub,
  LiveTranscriberStub,
  ended,
  logger,
  MemoryLiveMeetingRepository,
  packets,
  PermanentFailingSummaryStub,
  ProjectionStub,
  SilentLiveTranscriberStub,
  started,
  SummaryStub,
  TimedProjectionStub,
} from "./live-runtime-fixtures.js";

afterEach(() => vi.useRealTimers());

it("rehydrates finalized caption history when a persisted live meeting restarts", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const persisted = LiveMeeting.start({
    meetingId: "recording-live-1",
    publicationTargetId: "1533228891827736657",
    startedAtMs: Date.parse("2026-08-02T10:00:00.000Z"),
  });
  const externalPublicationId =
    "discord:v2:channel:1533228891827736657:message:1533228991827736657";
  persisted.completeProjection(externalPublicationId, persisted.revision);
  meetings.snapshot = persisted.toSnapshot();
  await meetings.appendFinalizedTurn("recording-live-1", {
    endMs: 4_000,
    speakerId: "1533228054724346087",
    startMs: 1_000,
    text: "Сохраненная реплика переживает рестарт.",
    turnId: "live-turn:persisted",
  });
  const projector = new ProjectionStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber: new SilentLiveTranscriberStub(),
  });

  await runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(5_000);

  expect(projector.requests).toHaveLength(1);
  expect(projector.requests[0]).toMatchObject({
    captions: [
      {
        isFinal: true,
        text: "Сохраненная реплика переживает рестарт.",
      },
    ],
    currentExternalPublicationId: externalPublicationId,
  });
  await runtime.close();
});

it("does not edit Discord captions when only invisible rendered content changes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const projector = new ProjectionStub();
  const transcriber = new SilentLiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });
  const firstBatch = packets();
  firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };

  await runtime.acceptLifecycle(started());
  void runtime.acceptVoiceBatch(firstBatch);
  await vi.advanceTimersByTimeAsync(0);

  const onTranscript = transcriber.requests[0]?.onTranscript;
  expect(onTranscript).toBeDefined();
  const visiblePrefix = "x".repeat(280);
  for (let index = 0; index < 13; index += 1) {
    onTranscript?.({
      endMs: index + 1,
      isFinal: false,
      meetingId: "recording-live-1",
      speakerId: `speaker-${index}`,
      startMs: index,
      text:
        index === 12
          ? `${visiblePrefix} initial hidden suffix`
          : `Caption ${index}`,
    });
  }

  await vi.advanceTimersByTimeAsync(1_000);
  expect(projector.requests).toHaveLength(1);

  onTranscript?.({
    endMs: 13,
    isFinal: false,
    meetingId: "recording-live-1",
    speakerId: "speaker-12",
    startMs: 12,
    text: `${visiblePrefix} changed hidden suffix`,
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(projector.requests).toHaveLength(1);

  await runtime.close();
});

it("backs off retryable Discord projection failures instead of retrying on every caption cadence", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const projector = new FailingProjectionStub({
    code: "DISCORD_PUBLICATION_REQUEST_FAILED",
    message: "Discord rate limited the live projection",
    retryable: true,
  });
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber: new LiveTranscriberStub(),
  });
  const firstBatch = packets();
  firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };

  await runtime.acceptLifecycle(started());
  void runtime.acceptVoiceBatch(firstBatch);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(projector.requests).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(5_000);
  expect(projector.requests).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(5_000);
  expect(projector.requests).toHaveLength(2);

  await vi.advanceTimersByTimeAsync(10_000);
  expect(projector.requests).toHaveLength(2);
  await runtime.close();
});

it("gives finalizing one fresh projection attempt during live backoff", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const projector = new FailingProjectionStub({
    code: "DISCORD_PUBLICATION_REQUEST_FAILED",
    message: "Discord rate limited the live projection",
    retryable: true,
  });
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber: new LiveTranscriberStub(),
  });
  const firstBatch = packets();
  firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };

  await runtime.acceptLifecycle(started());
  void runtime.acceptVoiceBatch(firstBatch);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(projector.requests).toHaveLength(1);
  expect(projector.requests[0]).toMatchObject({ phase: "live" });

  await runtime.acceptLifecycle(ended());
  await vi.advanceTimersByTimeAsync(0);

  expect(projector.requests).toHaveLength(3);
  expect(projector.requests.slice(1)).toEqual([
    expect.objectContaining({ phase: "finalizing", status: "active" }),
    expect.objectContaining({ phase: "finalizing", status: "ended" }),
  ]);
  await runtime.close();
});

it("permanently fences non-retryable Discord projection failures until restart or configuration change", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const projector = new FailingProjectionStub({
    code: "DISCORD_PUBLICATION_CONFIGURATION",
    message: "Discord projection target is invalid",
    retryable: false,
  });
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber: new LiveTranscriberStub(),
  });
  const firstBatch = packets();
  firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };

  await runtime.acceptLifecycle(started());
  void runtime.acceptVoiceBatch(firstBatch);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(projector.requests).toHaveLength(1);

  const laterBatch = packets();
  laterBatch.packets[0] = {
    ...laterBatch.packets[0]!,
    relativeTimeMs: 5_000,
    sequenceNumber: 2,
    mediaTimestamp: 1_920,
  };
  void runtime.acceptVoiceBatch(laterBatch);
  await vi.advanceTimersByTimeAsync(60_000);

  expect(projector.requests).toHaveLength(1);
  await runtime.close();
});

it("bounds deterministic first-caption projection jitter to one second", async () => {
  vi.useFakeTimers();
  const startedAtMs = Date.parse("2026-08-02T10:00:00.000Z");
  vi.setSystemTime(startedAtMs);
  const projector = new TimedProjectionStub();
  const meetingsA = new MemoryLiveMeetingRepository();
  const runtimeA = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetingsA),
    finishMeeting: new FinishLiveMeeting(meetingsA),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings: meetingsA,
      projector,
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings: meetingsA }),
    transcriber: new LiveTranscriberStub(),
  });
  const meetingsB = new MemoryLiveMeetingRepository();
  const runtimeB = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetingsB),
    finishMeeting: new FinishLiveMeeting(meetingsB),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings: meetingsB,
      projector,
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings: meetingsB }),
    transcriber: new LiveTranscriberStub(),
  });
  const firstA = packets("recording-spread-a");
  firstA.packets[0] = { ...firstA.packets[0]!, relativeTimeMs: 0 };
  const firstB = packets("recording-spread-b");
  firstB.packets[0] = { ...firstB.packets[0]!, relativeTimeMs: 0 };

  await runtimeA.acceptLifecycle(started("recording-spread-a"));
  await runtimeB.acceptLifecycle(started("recording-spread-b"));
  void runtimeA.acceptVoiceBatch(firstA);
  void runtimeB.acceptVoiceBatch(firstB);
  await vi.advanceTimersByTimeAsync(1_000);

  expect(projector.calls).toHaveLength(2);
  const firstAttemptByMeeting = new Map(
    projector.calls.map(({ meetingId, publishedAtMs }) => [
      meetingId,
      publishedAtMs,
    ]),
  );
  const firstAttemptA = firstAttemptByMeeting.get("recording-spread-a")!;
  const firstAttemptB = firstAttemptByMeeting.get("recording-spread-b")!;
  expect(firstAttemptA).toBeLessThanOrEqual(startedAtMs + 1_000);
  expect(firstAttemptB).toBeLessThanOrEqual(startedAtMs + 1_000);

  await runtimeA.close();
  await runtimeB.close();
});

it("keeps finalized turn history while mutable partials replace each other", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const projector = new ProjectionStub();
  const transcriber = new SilentLiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });
  const firstBatch = packets();
  firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };
  await runtime.acceptLifecycle(started());
  void runtime.acceptVoiceBatch(firstBatch);
  await vi.advanceTimersByTimeAsync(0);

  const onTranscript = transcriber.requests[0]?.onTranscript;
  expect(onTranscript).toBeDefined();
  onTranscript?.({
    endMs: 500,
    isFinal: false,
    meetingId: "recording-live-1",
    speakerId: "1533228054724346087",
    startMs: 0,
    text: "Первая...",
  });
  onTranscript?.({
    endMs: 750,
    isFinal: false,
    meetingId: "recording-live-1",
    speakerId: "1533228054724346087",
    startMs: 0,
    text: "Первая реплика...",
  });
  onTranscript?.({
    endMs: 1_000,
    isFinal: true,
    meetingId: "recording-live-1",
    speakerId: "1533228054724346087",
    startMs: 0,
    text: "Первая реплика.",
  });
  onTranscript?.({
    endMs: 6_500,
    isFinal: false,
    meetingId: "recording-live-1",
    speakerId: "1533228054724346087",
    startMs: 6_000,
    text: "Вторая реплика...",
  });
  onTranscript?.({
    endMs: 7_000,
    isFinal: true,
    meetingId: "recording-live-1",
    speakerId: "1533228054724346087",
    startMs: 6_000,
    text: "Вторая реплика.",
  });

  await vi.advanceTimersByTimeAsync(5_000);
  expect(projector.requests.at(-1)?.captions).toEqual([
    expect.objectContaining({ isFinal: true, text: "Первая реплика." }),
    expect.objectContaining({ isFinal: true, text: "Вторая реплика." }),
  ]);

  await vi.advanceTimersByTimeAsync(31_000);
  expect(projector.requests.at(-1)?.captions).toEqual([
    expect.objectContaining({ isFinal: true, text: "Первая реплика." }),
    expect.objectContaining({ isFinal: true, text: "Вторая реплика." }),
  ]);

  await runtime.close();
});

it("keeps caption projection live while one incremental summary generation is in flight", async () => {
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

  const laterBatch = packets();
  laterBatch.packets[0] = {
    ...laterBatch.packets[0]!,
    relativeTimeMs: 300_000,
    sequenceNumber: 2,
    mediaTimestamp: 1_920,
  };
  void runtime.acceptVoiceBatch(laterBatch);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(summarizer.requests).toHaveLength(1);
  expect(
    projector.requests.some(({ captions }) =>
      captions.some(({ startMs }) => startMs === 300_000),
    ),
  ).toBe(true);

  summarizer.resolveNext();
  await vi.advanceTimersByTimeAsync(0);
  await runtime.close();
});

it("projects ordinary live captions without a Subscription Runtime and never fabricates a brief", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const projector = new ProjectionStub();
  const summarizer = createLiveIncrementalSummaryPort({
    secrets: {},
    summaryProvider: "transcript-outline",
  } as PlatformConfig);
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber: new LiveTranscriberStub(),
  });
  const firstBatch = packets();
  firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };

  await runtime.acceptLifecycle(started());
  void runtime.acceptVoiceBatch(firstBatch);
  await vi.advanceTimersByTimeAsync(300_000);

  expect(projector.requests.some(({ captions }) => captions.length > 0)).toBe(true);
  expect(meetings.snapshot?.draftSummary).toBeNull();
  await expect(summarizer.generate({} as never)).resolves.toMatchObject({
    failure: { code: "LIVE_SUMMARY_PROVIDER_UNAVAILABLE", retryable: false },
    ok: false,
  });
  await runtime.close();
});

it("backs off retryable incremental generation failures instead of retrying every caption tick", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const summarizer = new FailingSummaryStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
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

  await vi.advanceTimersByTimeAsync(25_000);
  expect(summarizer.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(summarizer.requests).toHaveLength(2);

  await runtime.close();
});

it("fences non-retryable generation failures and backs off a changed evidence base", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const summarizer = new PermanentFailingSummaryStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
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

  await vi.advanceTimersByTimeAsync(5_000);
  expect(summarizer.requests).toHaveLength(1);

  const laterBatch = packets();
  laterBatch.packets[0] = {
    ...laterBatch.packets[0]!,
    relativeTimeMs: 305_000,
    sequenceNumber: 2,
    mediaTimestamp: 1_920,
  };
  void runtime.acceptVoiceBatch(laterBatch);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(summarizer.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(summarizer.requests).toHaveLength(2);
  await runtime.close();
});
