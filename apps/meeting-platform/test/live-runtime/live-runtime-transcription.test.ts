import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
} from "@discord-meeting/meeting-core/live-meeting";
import { afterEach, expect, it, vi } from "vitest";

import { PlatformLiveMeetingRuntime } from "../../src/live-meeting-runtime.js";
import type { Logger } from "@discord-meeting/observability-adapter";
import type { LiveVoicePacketBatch } from "../../src/live-runtime/contracts.js";
import {
  ConversationCoordinatorProbe,
  ControlledLiveTranscriberStub,
  DeferredProjectionStub,
  emitControlledTranscript,
  FailFirstOpenAndSendLiveTranscriberStub,
  FailFirstSendLiveTranscriberStub,
  LiveTranscriberStub,
  logger,
  MemoryLiveMeetingRepository,
  packets,
  packetsForSpeakers,
  ProjectionStub,
  SlowFirstPacketLiveTranscriberStub,
  started,
  SummaryStub,
} from "./live-runtime-fixtures.js";

afterEach(() => vi.useRealTimers());

it("starts conversation only after durable final-turn append and isolates its failure", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const coordinator = new ConversationCoordinatorProbe(meetings, true);
  const transcriber = new LiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    conversation: {
      coordinator,
      locale: "auto",
      nowMilliseconds: () => Date.now(),
      systemPrompt: "Answer briefly.",
      voiceProfileId: "deterministic-e2e-ru",
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
  const firstBatch = packets();
  firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };

  await runtime.acceptLifecycle(started());
  await vi.advanceTimersByTimeAsync(1_250);
  await runtime.acceptVoiceBatch(firstBatch);
  await vi.waitFor(() => {
    expect(coordinator.calls).toHaveLength(1);
  });

  expect(coordinator.persistedBeforeCall).toEqual([true]);
  expect(coordinator.calls[0]?.locale).toBe("auto");
  expect(coordinator.calls[0]?.thinkingCueLocale).toBe("ru");
  const observedConversation = coordinator.calls[0];
  expect(observedConversation?.turnEndedAtUnixMs).toBe(
    Date.parse("2026-08-02T10:00:01.000Z"),
  );
  expect(observedConversation?.wakeDetectedAtUnixMs).toBeGreaterThanOrEqual(
    observedConversation?.turnEndedAtUnixMs ?? Number.POSITIVE_INFINITY,
  );
  expect(meetings.finalizedTurns).toHaveLength(1);
  expect(coordinator.speechEvents).toEqual(["started", "ended"]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(coordinator.advanceCalls.at(-1)?.meetingId).toBe(
    "recording-live-1",
  );
  await runtime.close();
  expect(coordinator.closeCalls).toEqual(["recording-live-1"]);
});

it("keeps aggregate speech active while another participant is still speaking", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const coordinator = new ConversationCoordinatorProbe(meetings);
  const transcriber = new ControlledLiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    conversation: {
      coordinator,
      locale: "auto",
      nowMilliseconds: () => performance.now(),
      systemPrompt: "Answer briefly.",
      voiceProfileId: "deterministic-e2e-ru",
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
  await runtime.acceptVoiceBatch(packetsForSpeakers(0, 2));
  await vi.waitFor(() => {
    expect(transcriber.requests).toHaveLength(2);
  });
  const [first, second] = transcriber.requests;
  if (first === undefined || second === undefined) {
    throw new Error("controlled conversation sessions did not open");
  }
  emitControlledTranscript(first, false);
  emitControlledTranscript(second, false);
  emitControlledTranscript(first, true);
  await vi.waitFor(() => {
    expect(coordinator.speechEvents.slice(0, 3)).toEqual([
      "started",
      "activity",
      "activity",
    ]);
    expect(coordinator.speechEvents).not.toContain("ended");
  });
  await vi.advanceTimersByTimeAsync(4_100);
  expect(coordinator.speechEvents).not.toContain("ended");

  emitControlledTranscript(second, true);
  await vi.waitFor(() => {
    expect(coordinator.speechEvents.at(-1)).toBe("ended");
  });
  await runtime.close();
});

it("preserves the observed speech time while conversation work is queued", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const coordinator = new ConversationCoordinatorProbe(
    meetings,
    false,
    true,
  );
  const transcriber = new ControlledLiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    conversation: {
      coordinator,
      locale: "auto",
      nowMilliseconds: () => performance.now(),
      systemPrompt: "Answer briefly.",
      voiceProfileId: "deterministic-e2e-ru",
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
  await runtime.acceptVoiceBatch(packetsForSpeakers(0, 1));
  await vi.waitFor(() => {
    expect(transcriber.requests).toHaveLength(1);
  });
  const request = transcriber.requests[0];
  if (request === undefined) {
    throw new Error("controlled conversation session did not open");
  }
  emitControlledTranscript(request, true);
  await vi.waitFor(() => {
    expect(coordinator.calls).toHaveLength(1);
  });

  const observationCount = coordinator.speechObservations.length;
  const observedAtMs = Math.floor(performance.now());
  emitControlledTranscript(request, false);
  await vi.advanceTimersByTimeAsync(5_000);
  coordinator.releaseBlockedHandle();
  await vi.waitFor(() => {
    expect(coordinator.speechObservations.length).toBeGreaterThan(
      observationCount,
    );
  });

  expect(coordinator.speechObservations[observationCount]).toEqual({
    meetingId: "recording-live-1",
    nowMs: observedAtMs,
    type: "started",
  });
  await runtime.close();
});

it("projects the first live caption within one second and suppresses unchanged edits", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
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
  const firstBatch = packets();
  firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };

  await runtime.acceptLifecycle(started());
  void runtime.acceptVoiceBatch(firstBatch);
  await vi.advanceTimersByTimeAsync(1_000);

  expect(projector.requests).toHaveLength(1);
  expect(projector.requests[0]).toMatchObject({
    status: "active",
    summary: null,
  });
  expect(projector.requests[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(projector.requests[0]?.elapsedMs).toBeLessThanOrEqual(1_000);

  await vi.advanceTimersByTimeAsync(5_000);
  expect(projector.requests).toHaveLength(1);
  expect(summarizer.requests).toHaveLength(0);

  await runtime.close();
});

it("keeps all ten speakers live while a Discord projection is slow", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const meetings = new MemoryLiveMeetingRepository();
  const projector = new DeferredProjectionStub();
  const transcriber = new LiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    packetFlowControl: {
      maximumConcurrentSessions: 10,
      packetBackpressureTimeoutMs: 100,
    },
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });

  await runtime.acceptLifecycle(started());
  await runtime.acceptVoiceBatch(packetsForSpeakers(0));
  await vi.advanceTimersByTimeAsync(0);

  expect(transcriber.requests).toHaveLength(10);
  expect(
    new Set(transcriber.requests.map(({ speakerId }) => speakerId)).size,
  ).toBe(10);
  expect(transcriber.packets).toHaveLength(10);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(projector.requests).not.toHaveLength(0);

  await runtime.acceptVoiceBatch(packetsForSpeakers(20));
  await vi.advanceTimersByTimeAsync(20);

  expect(transcriber.packets).toHaveLength(20);
  for (let speaker = 1; speaker <= 10; speaker += 1) {
    expect(
      transcriber.packets
        .filter(({ packetId }) => packetId.includes(`speaker-${speaker}:`))
        .map(({ relativeTimeMs }) => relativeTimeMs),
    ).toEqual([0, 20]);
  }

  projector.releaseAll();
  await vi.advanceTimersByTimeAsync(0);
  await runtime.close();
});

it("uses bounded post-durability backpressure instead of silently advancing a full queue", async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-02T10:00:00.000Z");
  const warnings: string[] = [];
  const infos: string[] = [];
  const observedLogger: Logger = {
    ...logger,
    info: (message) => {
      infos.push(message);
    },
    warn: (message) => {
      warnings.push(message);
    },
  };
  const meetings = new MemoryLiveMeetingRepository();
  const transcriber = new SlowFirstPacketLiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger: observedLogger,
    packetFlowControl: {
      maximumConcurrentSessions: 10,
      maximumQueuedPacketsPerSpeaker: 2,
      packetBackpressureTimeoutMs: 100,
    },
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });

  await runtime.acceptLifecycle(started());
  await runtime.acceptVoiceBatch(packetsForSpeakers(0));
  await vi.advanceTimersByTimeAsync(0);
  await runtime.acceptVoiceBatch(packetsForSpeakers(20));

  let settled = false;
  const boundedAdmission = runtime
    .acceptVoiceBatch(packetsForSpeakers(40))
    .then(() => {
      settled = true;
      return null;
    });
  await Promise.resolve();
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  await boundedAdmission;

  expect(transcriber.requests).toHaveLength(10);
  expect(warnings).not.toContain("Live transcription packet queue is full");
  expect(
    warnings.filter(
      (message) =>
        message ===
        "Derived live transcription degraded after packet backpressure",
    ),
  ).toHaveLength(10);

  transcriber.releaseFirstPackets();
  await vi.advanceTimersByTimeAsync(0);
  await runtime.acceptVoiceBatch(packetsForSpeakers(60));
  await vi.advanceTimersByTimeAsync(20);

  for (let speaker = 1; speaker <= 10; speaker += 1) {
    expect(
      transcriber.packets
        .filter(({ speakerId }) => speakerId === `speaker-${speaker}`)
        .map(({ relativeTimeMs }) => relativeTimeMs),
    ).toEqual([0, 20, 60]);
  }
  expect(
    infos.filter(
      (message) =>
        message === "Derived live transcription recovered from backpressure",
    ),
  ).toHaveLength(10);

  await runtime.close();
});

it("paces queued Opus packets at their source duration", async () => {
  vi.useFakeTimers();
  const startedAtMs = Date.parse("2026-08-02T10:00:00.000Z");
  vi.setSystemTime(startedAtMs);
  const meetings = new MemoryLiveMeetingRepository();
  const transcriber = new LiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    packetFlowControl: {
      maximumConcurrentSessions: 10,
      packetBackpressureTimeoutMs: 100,
    },
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });
  const first = packets().packets[0]!;

  await runtime.acceptLifecycle(started());
  await runtime.acceptVoiceBatch({
    format: packets().format,
    packets: [
      { ...first, relativeTimeMs: 0 },
      { ...first, relativeTimeMs: 20, sequenceNumber: 2, mediaTimestamp: 1_920 },
      { ...first, relativeTimeMs: 40, sequenceNumber: 3, mediaTimestamp: 2_880 },
    ],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(transcriber.sentAtMs).toEqual([startedAtMs]);

  await vi.advanceTimersByTimeAsync(20);
  expect(transcriber.sentAtMs).toEqual([startedAtMs, startedAtMs + 20]);
  await vi.advanceTimersByTimeAsync(20);
  expect(transcriber.sentAtMs).toEqual([
    startedAtMs,
    startedAtMs + 20,
    startedAtMs + 40,
  ]);

  await runtime.close();
});

it("keeps a durable packet retryable after bounded provider recovery exhausts", async () => {
  vi.useFakeTimers();
  const startedAtMs = Date.parse("2026-08-02T10:00:00.000Z");
  vi.setSystemTime(startedAtMs);
  const meetings = new MemoryLiveMeetingRepository();
  const transcriber = new FailFirstOpenAndSendLiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    packetFlowControl: {
      maximumConcurrentSessions: 10,
      packetBackpressureTimeoutMs: 100,
    },
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });
  const retry = packets();
  retry.packets[0] = { ...retry.packets[0]!, relativeTimeMs: 0 };

  await runtime.acceptLifecycle(started());

  await runtime.acceptVoiceBatch(retry);
  await vi.advanceTimersByTimeAsync(0);
  expect(transcriber.openAttemptCount).toBe(2);
  expect(transcriber.sendAttemptCount).toBe(1);
  expect(transcriber.packets).toHaveLength(0);

  await runtime.acceptVoiceBatch(retry);
  await vi.advanceTimersByTimeAsync(0);
  expect(transcriber.openAttemptCount).toBe(3);
  expect(transcriber.sendAttemptCount).toBe(2);
  expect(transcriber.packets).toHaveLength(1);
  expect(transcriber.packets[0]).toMatchObject({ relativeTimeMs: 0 });
  // A rejected send must not consume one Opus duration of pacing before the
  // durable retry is successfully delivered.
  expect(transcriber.sentAtMs).toEqual([startedAtMs]);

  await runtime.close();
});

it("retries a failed head packet before queued later audio and deduplicates its durable retry", async () => {
  vi.useFakeTimers();
  const startedAtMs = Date.parse("2026-08-02T10:00:00.000Z");
  vi.setSystemTime(startedAtMs);
  const meetings = new MemoryLiveMeetingRepository();
  const transcriber = new FailFirstSendLiveTranscriberStub();
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger,
    packetFlowControl: {
      maximumConcurrentSessions: 10,
      packetBackpressureTimeoutMs: 100,
    },
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });
  const first = packets().packets[0]!;
  const firstAndSecond: LiveVoicePacketBatch = {
    format: packets().format,
    packets: [
      { ...first, relativeTimeMs: 0 },
      {
        ...first,
        relativeTimeMs: 20,
        sequenceNumber: 2,
        mediaTimestamp: 1_920,
      },
    ],
  };

  await runtime.acceptLifecycle(started());
  await runtime.acceptVoiceBatch(firstAndSecond);
  await vi.advanceTimersByTimeAsync(0);

  // A's first provider send fails, but its bounded inline retry succeeds
  // before the already-queued B begins.
  expect(transcriber.sendAttempts.map(({ relativeTimeMs }) => relativeTimeMs)).toEqual([
    0, 0,
  ]);
  expect(transcriber.deliveredPackets.map(({ relativeTimeMs }) => relativeTimeMs)).toEqual([
    0,
  ]);

  await vi.advanceTimersByTimeAsync(20);
  expect(transcriber.deliveredPackets.map(({ relativeTimeMs }) => relativeTimeMs)).toEqual([
    0, 20,
  ]);

  // Craig may redeliver A after B was already accepted. It is now a true
  // duplicate rather than an out-of-order packet silently omitted live.
  await runtime.acceptVoiceBatch({
    format: packets().format,
    packets: [firstAndSecond.packets[0]!],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(transcriber.sendAttempts.map(({ relativeTimeMs }) => relativeTimeMs)).toEqual([
    0, 0, 20,
  ]);
  expect(transcriber.deliveredPackets.map(({ relativeTimeMs }) => relativeTimeMs)).toEqual([
    0, 20,
  ]);

  await runtime.close();
});

it("replays a failed head after later audio without permanently omitting either durable packet", async () => {
  vi.useFakeTimers();
  const startedAtMs = Date.parse("2026-08-02T10:00:00.000Z");
  vi.setSystemTime(startedAtMs);
  const warnings: string[] = [];
  const infos: string[] = [];
  const observedLogger: Logger = {
    ...logger,
    info: (message) => {
      infos.push(message);
    },
    warn: (message) => {
      warnings.push(message);
    },
  };
  const meetings = new MemoryLiveMeetingRepository();
  const transcriber = new FailFirstSendLiveTranscriberStub(2);
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings),
    finishMeeting: new FinishLiveMeeting(meetings),
    logger: observedLogger,
    packetFlowControl: {
      maximumConcurrentSessions: 10,
      packetBackpressureTimeoutMs: 100,
    },
    refreshMeeting: new RefreshLiveMeeting({
      meetings,
      projector: new ProjectionStub(),
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings }),
    transcriber,
  });
  const first = packets().packets[0]!;
  const firstAndSecond: LiveVoicePacketBatch = {
    format: packets().format,
    packets: [
      { ...first, relativeTimeMs: 0 },
      {
        ...first,
        relativeTimeMs: 20,
        sequenceNumber: 2,
        mediaTimestamp: 1_920,
      },
    ],
  };

  await runtime.acceptLifecycle(started());
  await runtime.acceptVoiceBatch(firstAndSecond);
  await vi.advanceTimersByTimeAsync(0);

  // A exhausted its two bounded attempts, but B was still delivered rather
  // than being blocked behind a dead head packet.
  expect(transcriber.sendAttempts.map(({ relativeTimeMs }) => relativeTimeMs)).toEqual([
    0, 0, 20,
  ]);
  expect(transcriber.deliveredPackets.map(({ relativeTimeMs }) => relativeTimeMs)).toEqual([
    20,
  ]);
  expect(warnings).toContain(
    "Derived live transcription packet exhausted bounded delivery retries",
  );

  // The durable replay of A remains eligible despite B's committed source
  // timeline. Its paced fallback lands after B, then the stream continues.
  await runtime.acceptVoiceBatch({
    format: packets().format,
    packets: [firstAndSecond.packets[0]!],
  });
  await vi.advanceTimersByTimeAsync(20);
  const third = {
    ...first,
    relativeTimeMs: 40,
    sequenceNumber: 3,
    mediaTimestamp: 2_880,
  };
  await runtime.acceptVoiceBatch({ format: packets().format, packets: [third] });
  await vi.advanceTimersByTimeAsync(20);

  expect(transcriber.deliveredPackets.map(({ relativeTimeMs }) => relativeTimeMs)).toEqual([
    20, 0, 40,
  ]);
  expect(infos).toContain(
    "Derived live transcription packet recovered after delivery failure",
  );

  await runtime.close();
});
