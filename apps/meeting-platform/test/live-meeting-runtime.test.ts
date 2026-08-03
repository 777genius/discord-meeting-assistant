import type { CraigLifecycleEvent, VoicePacketBatch } from "@discord-meeting/craig-gateway-contracts";
import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  LiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
  type GeneratedIncrementalSummary,
  type IncrementalSummaryGenerationPort,
  type IncrementalSummaryGenerationRequest,
  type LiveMeetingProjectionPort,
  type LiveMeetingProjectionRequest,
  type LiveMeetingRepository,
  type LiveMeetingSnapshot,
  type PortResult,
  type StageFailure,
} from "@discord-meeting/meeting-core";
import type { Logger } from "@discord-meeting/observability-adapter";
import type {
  OpenVoicetextLiveSessionRequest,
  VoicetextLivePacket,
  VoicetextLiveSession,
} from "@discord-meeting/voicetext-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlatformLiveMeetingRuntime } from "../src/live-meeting-runtime.js";

class MemoryLiveMeetingRepository implements LiveMeetingRepository {
  public snapshot: LiveMeetingSnapshot | null = null;

  public findById(meetingId: string): Promise<LiveMeetingSnapshot | null> {
    return Promise.resolve(
      this.snapshot?.meetingId === meetingId ? structuredClone(this.snapshot) : null,
    );
  }

  public save(snapshot: LiveMeetingSnapshot, expectedRevision: number | null): Promise<void> {
    if (expectedRevision === null) {
      if (this.snapshot !== null && this.snapshot.meetingId !== snapshot.meetingId) {
        throw new Error("unexpected live meeting");
      }
    } else if (this.snapshot?.revision !== expectedRevision) {
      throw new Error("revision conflict");
    }
    this.snapshot = structuredClone(snapshot);
    return Promise.resolve();
  }
}

class SummaryStub implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];

  public generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<PortResult<GeneratedIncrementalSummary>> {
    this.requests.push(structuredClone(request));
    const evidenceTurnId = request.knownTurnIds[0]!;
    return Promise.resolve({
      ok: true,
      value: {
        summary: {
          actionItems: [],
          decisions: [{
            decisionId: "decision-1",
            evidenceTurnIds: [evidenceTurnId],
            text: "Выпустить версию в пятницу.",
          }],
          openQuestions: [],
          overview: "Команда договорилась о выпуске.",
          revision: request.revision,
          title: "План выпуска",
          topics: [{
            evidenceTurnIds: [evidenceTurnId],
            points: ["Релиз в пятницу"],
            title: "Релиз",
          }],
        },
      },
    });
  }
}

class DeferredSummaryStub implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];
  private readonly resolvers: Array<(result: PortResult<GeneratedIncrementalSummary>) => void> = [];

  public generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<PortResult<GeneratedIncrementalSummary>> {
    this.requests.push(structuredClone(request));
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  public resolveNext(): void {
    const request = this.requests.shift();
    const resolve = this.resolvers.shift();
    if (request === undefined || resolve === undefined) {
      throw new Error("no pending summary generation");
    }
    const evidenceTurnId = request.knownTurnIds[0]!;
    resolve({
      ok: true,
      value: {
        summary: {
          actionItems: [],
          decisions: [{
            decisionId: "decision-1",
            evidenceTurnIds: [evidenceTurnId],
            text: "Выпустить версию в пятницу.",
          }],
          openQuestions: [],
          overview: "Команда договорилась о выпуске.",
          revision: request.revision,
          title: "План выпуска",
          topics: [{
            evidenceTurnIds: [evidenceTurnId],
            points: ["Релиз в пятницу"],
            title: "Релиз",
          }],
        },
      },
    });
  }
}

class FailingSummaryStub implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];

  public generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<PortResult<GeneratedIncrementalSummary>> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      failure: {
        code: "TELEMETRY_UNAVAILABLE",
        message: "generation telemetry is unavailable",
        retryable: true,
      },
      ok: false,
    });
  }
}

class PermanentFailingSummaryStub implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];

  public generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<PortResult<GeneratedIncrementalSummary>> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      failure: {
        code: "INVALID_LIVE_SUMMARY_OUTPUT",
        message: "provider output is permanently invalid for this evidence base",
        retryable: false,
      },
      ok: false,
    });
  }
}

class ProjectionStub implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({ ok: true, value: { externalPublicationId: "thread-1" } });
  }
}

class FailingProjectionStub implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];

  public constructor(private readonly failure: StageFailure) {}

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({ failure: this.failure, ok: false });
  }
}

class TimedProjectionStub implements LiveMeetingProjectionPort {
  public readonly calls: Array<{ readonly meetingId: string; readonly publishedAtMs: number }> = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
    this.calls.push({ meetingId: request.meetingId, publishedAtMs: Date.now() });
    return Promise.resolve({ ok: true, value: { externalPublicationId: `thread-${request.meetingId}` } });
  }
}

class LiveTranscriberStub {
  public readonly packets: VoicetextLivePacket[] = [];
  public finalizationCount = 0;
  public readonly requests: OpenVoicetextLiveSessionRequest[] = [];

  public openSession(request: OpenVoicetextLiveSessionRequest): Promise<VoicetextLiveSession> {
    this.requests.push(request);
    return Promise.resolve({
      finalize: () => {
        this.finalizationCount += 1;
        return Promise.resolve();
      },
      sendPacket: (packet) => {
        this.packets.push(packet);
        request.onTranscript({
          endMs: packet.relativeTimeMs + 500,
          isFinal: false,
          meetingId: request.meetingId,
          speakerId: request.speakerId,
          startMs: packet.relativeTimeMs,
          text: "Выпускаем...",
        });
        request.onTranscript({
          endMs: packet.relativeTimeMs + 1_000,
          isFinal: true,
          meetingId: request.meetingId,
          speakerId: request.speakerId,
          startMs: packet.relativeTimeMs,
          text: "Выпускаем версию в пятницу.",
        });
        return Promise.resolve("accepted" as const);
      },
      terminate: () => {},
    });
  }
}

class SilentLiveTranscriberStub {
  public readonly requests: OpenVoicetextLiveSessionRequest[] = [];

  public openSession(request: OpenVoicetextLiveSessionRequest): Promise<VoicetextLiveSession> {
    this.requests.push(request);
    return Promise.resolve({
      finalize: () => Promise.resolve(),
      sendPacket: () => Promise.resolve("accepted" as const),
      terminate: () => {},
    });
  }
}

const logger: Logger = {
  child: () => logger,
  debug: () => {},
  error: () => {},
  flush: () => Promise.resolve(),
  info: () => {},
  warn: () => {},
};

function started(recordingId = "recording-live-1"): CraigLifecycleEvent {
  return {
    channelId: "1533228891827736657",
    eventId: "start-1",
    guildId: "1533227577286852649",
    occurredAt: "2026-08-02T10:00:00.000Z",
    participantIds: ["1533228054724346087"],
    recordingId,
    schemaVersion: 1,
    type: "meeting.started",
  };
}

function ended(): CraigLifecycleEvent {
  return {
    channelId: "1533228891827736657",
    eventId: "end-1",
    guildId: "1533227577286852649",
    occurredAt: "2026-08-02T10:06:00.000Z",
    reason: null,
    recordingId: "recording-live-1",
    schemaVersion: 1,
    type: "meeting.ended",
  };
}

function packets(recordingId = "recording-live-1"): VoicePacketBatch {
  return {
    packets: [{
      channelId: "1533228891827736657",
      guildId: "1533227577286852649",
      opusBase64: Buffer.from([0xf8, 0xff, 0xfe]).toString("base64"),
      receivedAtMs: 1_000,
      recordingId,
      relativeTimeMs: 350_000,
      rtpSequence: 1,
      rtpTimestamp: 960,
      schemaVersion: 1,
      speakerId: "1533228054724346087",
    }],
    schemaVersion: 1,
  };
}

describe("PlatformLiveMeetingRuntime", () => {
  afterEach(() => vi.useRealTimers());

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
      publicationTargetId: "1533228891827736657",
      refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer }),
      startMeeting: new StartLiveMeeting({ meetings }),
      transcriber,
    });
    const firstBatch = packets();
    firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };

    await runtime.acceptLifecycle(started());
    runtime.acceptVoiceBatch(firstBatch);
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

  it("rehydrates finalized caption history when a persisted live meeting restarts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-02T10:00:00.000Z");
    const meetings = new MemoryLiveMeetingRepository();
    const persisted = LiveMeeting.start({
      meetingId: "recording-live-1",
      publicationTargetId: "1533228891827736657",
      startedAtMs: Date.parse("2026-08-02T10:00:00.000Z"),
    });
    persisted.appendFinalTurn({
      endMs: 4_000,
      speakerId: "1533228054724346087",
      startMs: 1_000,
      text: "Сохраненная реплика переживает рестарт.",
      turnId: "live-turn:persisted",
    });
    const externalPublicationId =
      "discord:v2:channel:1533228891827736657:message:1533228991827736657";
    persisted.completeProjection(externalPublicationId, persisted.revision);
    meetings.snapshot = persisted.toSnapshot();
    const projector = new ProjectionStub();
    const runtime = new PlatformLiveMeetingRuntime({
      appendTurn: new AppendLiveTranscriptTurn(meetings),
      finishMeeting: new FinishLiveMeeting(meetings),
      logger,
      publicationTargetId: "1533228891827736657",
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
      captions: [{
        isFinal: true,
        text: "Сохраненная реплика переживает рестарт.",
      }],
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
      publicationTargetId: "1533228891827736657",
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
    runtime.acceptVoiceBatch(firstBatch);
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
        text: index === 12 ? `${visiblePrefix} initial hidden suffix` : `Caption ${index}`,
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
      publicationTargetId: "1533228891827736657",
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
    runtime.acceptVoiceBatch(firstBatch);
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
      publicationTargetId: "1533228891827736657",
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
    runtime.acceptVoiceBatch(firstBatch);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(projector.requests).toHaveLength(1);

    const laterBatch = packets();
    laterBatch.packets[0] = {
      ...laterBatch.packets[0]!,
      relativeTimeMs: 5_000,
      rtpSequence: 2,
      rtpTimestamp: 1_920,
    };
    runtime.acceptVoiceBatch(laterBatch);
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
      publicationTargetId: "1533228891827736657",
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
      publicationTargetId: "1533228891827736657",
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
    runtimeA.acceptVoiceBatch(firstA);
    runtimeB.acceptVoiceBatch(firstB);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(projector.calls).toHaveLength(2);
    const firstAttemptByMeeting = new Map(
      projector.calls.map(({ meetingId, publishedAtMs }) => [meetingId, publishedAtMs]),
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
      publicationTargetId: "1533228891827736657",
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
    runtime.acceptVoiceBatch(firstBatch);
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
      publicationTargetId: "1533228891827736657",
      refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer }),
      startMeeting: new StartLiveMeeting({ meetings }),
      transcriber: new LiveTranscriberStub(),
    });
    const firstBatch = packets();
    firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };

    await runtime.acceptLifecycle(started());
    runtime.acceptVoiceBatch(firstBatch);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(summarizer.requests).toHaveLength(1);

    const laterBatch = packets();
    laterBatch.packets[0] = {
      ...laterBatch.packets[0]!,
      relativeTimeMs: 300_000,
      rtpSequence: 2,
      rtpTimestamp: 1_920,
    };
    runtime.acceptVoiceBatch(laterBatch);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(summarizer.requests).toHaveLength(1);
    expect(
      projector.requests.some(({ captions }) =>
        captions.some(({ startMs }) => startMs === 300_000)
      ),
    ).toBe(true);

    summarizer.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
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
      publicationTargetId: "1533228891827736657",
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
    runtime.acceptVoiceBatch(firstBatch);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(summarizer.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(summarizer.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(summarizer.requests).toHaveLength(2);

    await runtime.close();
  });

  it("permanently fences a non-retryable generation failure until its evidence base changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-02T10:00:00.000Z");
    const meetings = new MemoryLiveMeetingRepository();
    const summarizer = new PermanentFailingSummaryStub();
    const runtime = new PlatformLiveMeetingRuntime({
      appendTurn: new AppendLiveTranscriptTurn(meetings),
      finishMeeting: new FinishLiveMeeting(meetings),
      logger,
      publicationTargetId: "1533228891827736657",
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
    runtime.acceptVoiceBatch(firstBatch);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(summarizer.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(summarizer.requests).toHaveLength(1);

    const laterBatch = packets();
    laterBatch.packets[0] = {
      ...laterBatch.packets[0]!,
      relativeTimeMs: 360_000,
      rtpSequence: 2,
      rtpTimestamp: 1_920,
    };
    runtime.acceptVoiceBatch(laterBatch);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(summarizer.requests).toHaveLength(2);
    await runtime.close();
  });

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
      publicationTargetId: "1533228891827736657",
      refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer }),
      startMeeting: new StartLiveMeeting({ meetings }),
      transcriber: new LiveTranscriberStub(),
    });
    const firstBatch = packets();
    firstBatch.packets[0] = { ...firstBatch.packets[0]!, relativeTimeMs: 0 };

    await runtime.acceptLifecycle(started());
    runtime.acceptVoiceBatch(firstBatch);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(summarizer.requests).toHaveLength(1);

    let settled = false;
    const fence = runtime.settleBeforeFinalPublication("recording-live-1").then(() => {
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
      publicationTargetId: "1533228891827736657",
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

  it("keeps Opus and derived state off the authoritative request path", async () => {
    const meetings = new MemoryLiveMeetingRepository();
    const summarizer = new SummaryStub();
    const projector = new ProjectionStub();
    const transcriber = new LiveTranscriberStub();
    const runtime = new PlatformLiveMeetingRuntime({
      appendTurn: new AppendLiveTranscriptTurn(meetings),
      finishMeeting: new FinishLiveMeeting(meetings),
      logger,
      publicationTargetId: "1533228891827736657",
      refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer }),
      startMeeting: new StartLiveMeeting({ meetings }),
      transcriber,
    });

    await runtime.acceptLifecycle(started());
    runtime.acceptVoiceBatch(packets());
    await runtime.acceptLifecycle(ended());
    await runtime.close();

    expect(transcriber.packets).toHaveLength(1);
    expect(transcriber.finalizationCount).toBe(1);
    expect(summarizer.requests).toHaveLength(0);
    expect(projector.requests).toHaveLength(1);
    expect(projector.requests[0]).toMatchObject({
      captions: [{ isFinal: true, speakerId: "1533228054724346087" }],
      elapsedMs: 360_000,
      status: "ended",
      summary: null,
    });
    expect(meetings.snapshot).toMatchObject({
      draftSummary: null,
      endedAtMs: Date.parse("2026-08-02T10:06:00.000Z"),
      status: "ended",
      summarizedTurnIds: [],
      turns: [{ text: "Выпускаем версию в пятницу." }],
    });
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
      publicationTargetId: "1533228891827736657",
      refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer }),
      speakerIdleFinalizeMs: 100,
      startMeeting: new StartLiveMeeting({ meetings }),
      transcriber,
    });

    await runtime.acceptLifecycle(started());
    runtime.acceptVoiceBatch(packets());
    await vi.advanceTimersByTimeAsync(101);
    expect(transcriber.finalizationCount).toBe(1);

    runtime.acceptVoiceBatch(packets());
    await vi.advanceTimersByTimeAsync(1);
    expect(transcriber.requests).toHaveLength(1);

    const laterBatch = packets();
    laterBatch.packets[0] = {
      ...laterBatch.packets[0]!,
      relativeTimeMs: 355_000,
      rtpSequence: 2,
      rtpTimestamp: 1_920,
    };
    runtime.acceptVoiceBatch(laterBatch);
    await vi.advanceTimersByTimeAsync(1);
    await runtime.acceptLifecycle(ended());
    await runtime.close();

    expect(transcriber.requests.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      "voicetext-live:v2|recording-live-1|1533228054724346087|1",
      "voicetext-live:v2|recording-live-1|1533228054724346087|2",
    ]);
    expect(transcriber.finalizationCount).toBe(2);
    expect(meetings.snapshot?.turns.map(({ startMs }) => startMs)).toEqual([
      350_000,
      355_000,
    ]);
  });

  it("keeps one provider session across a relative timeline gap in one batch", async () => {
    const meetings = new MemoryLiveMeetingRepository();
    const summarizer = new SummaryStub();
    const projector = new ProjectionStub();
    const transcriber = new LiveTranscriberStub();
    const runtime = new PlatformLiveMeetingRuntime({
      appendTurn: new AppendLiveTranscriptTurn(meetings),
      finishMeeting: new FinishLiveMeeting(meetings),
      logger,
      publicationTargetId: "1533228891827736657",
      refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer }),
      speakerIdleFinalizeMs: 100,
      startMeeting: new StartLiveMeeting({ meetings }),
      transcriber,
    });
    const first = packets().packets[0]!;

    await runtime.acceptLifecycle(started());
    runtime.acceptVoiceBatch({
      packets: [
        { ...first, relativeTimeMs: 350_000 },
        {
          ...first,
          relativeTimeMs: 352_000,
          rtpSequence: 2,
          rtpTimestamp: 1_920,
        },
      ],
      schemaVersion: 1,
    });
    await runtime.acceptLifecycle(ended());
    await runtime.close();

    expect(transcriber.requests).toHaveLength(1);
    expect(transcriber.finalizationCount).toBe(1);
    expect(transcriber.packets.map(({ durationSamples48Khz }) => durationSamples48Khz)).toEqual([
      960,
      960,
    ]);
    expect(meetings.snapshot?.turns.map(({ startMs }) => startMs)).toEqual([
      350_000,
      352_000,
    ]);
  });
});
