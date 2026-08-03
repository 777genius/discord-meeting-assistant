import type {
  CraigLifecycleEvent,
  VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";
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
      this.snapshot?.meetingId === meetingId
        ? structuredClone(this.snapshot)
        : null,
    );
  }

  public save(
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number | null,
  ): Promise<void> {
    if (expectedRevision === null) {
      if (
        this.snapshot !== null &&
        this.snapshot.meetingId !== snapshot.meetingId
      ) {
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
          decisions: [
            {
              decisionId: "decision-1",
              evidenceTurnIds: [evidenceTurnId],
              text: "Выпустить версию в пятницу.",
            },
          ],
          openQuestions: [],
          overview: "Команда договорилась о выпуске.",
          revision: request.revision,
          title: "План выпуска",
          topics: [
            {
              evidenceTurnIds: [evidenceTurnId],
              points: ["Релиз в пятницу"],
              title: "Релиз",
            },
          ],
        },
      },
    });
  }
}

class DeferredSummaryStub implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];
  private readonly resolvers: Array<
    (result: PortResult<GeneratedIncrementalSummary>) => void
  > = [];

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
          decisions: [
            {
              decisionId: "decision-1",
              evidenceTurnIds: [evidenceTurnId],
              text: "Выпустить версию в пятницу.",
            },
          ],
          openQuestions: [],
          overview: "Команда договорилась о выпуске.",
          revision: request.revision,
          title: "План выпуска",
          topics: [
            {
              evidenceTurnIds: [evidenceTurnId],
              points: ["Релиз в пятницу"],
              title: "Релиз",
            },
          ],
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
        message:
          "provider output is permanently invalid for this evidence base",
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
    return Promise.resolve({
      ok: true,
      value: { externalPublicationId: "thread-1" },
    });
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

class FinalizingFailingProjectionStub implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    if (request.phase === "finalizing") {
      return Promise.resolve({
        failure: {
          code: "DISCORD_UNAVAILABLE",
          message: "finalizing edit failed",
          retryable: true,
        },
        ok: false,
      });
    }
    return Promise.resolve({
      ok: true,
      value: { externalPublicationId: "thread-1" },
    });
  }
}

class TimedProjectionStub implements LiveMeetingProjectionPort {
  public readonly calls: Array<{
    readonly meetingId: string;
    readonly publishedAtMs: number;
  }> = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
    this.calls.push({
      meetingId: request.meetingId,
      publishedAtMs: Date.now(),
    });
    return Promise.resolve({
      ok: true,
      value: { externalPublicationId: `thread-${request.meetingId}` },
    });
  }
}

class LiveTranscriberStub {
  public readonly packets: VoicetextLivePacket[] = [];
  public finalizationCount = 0;
  public readonly requests: OpenVoicetextLiveSessionRequest[] = [];
  public readonly sentAtMs: number[] = [];
  public terminatedSessionCount = 0;

  public openSession(
    request: OpenVoicetextLiveSessionRequest,
  ): Promise<VoicetextLiveSession> {
    this.requests.push(request);
    let terminated = false;
    const session: VoicetextLiveSession = {
      finalize: () => {
        if (terminated) {
          return Promise.reject(new Error("session was terminated before finalize"));
        }
        this.finalizationCount += 1;
        return Promise.resolve();
      },
      sendPacket: (packet) => {
        this.packets.push(packet);
        this.sentAtMs.push(Date.now());
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
      terminate: () => {
        if (terminated) {
          return;
        }
        terminated = true;
        this.terminatedSessionCount += 1;
      },
    };
    request.signal?.addEventListener(
      "abort",
      () => {
        session.terminate();
      },
      { once: true },
    );
    return Promise.resolve(session);
  }
}

class BlockedFinalizeLiveTranscriberStub {
  public finalizationStarted = false;
  public readonly requests: OpenVoicetextLiveSessionRequest[] = [];
  private releaseFinalize: (() => void) | undefined;

  public openSession(
    request: OpenVoicetextLiveSessionRequest,
  ): Promise<VoicetextLiveSession> {
    this.requests.push(request);
    return Promise.resolve({
      finalize: () => {
        this.finalizationStarted = true;
        return new Promise((resolve) => {
          this.releaseFinalize = () => {
            request.onTranscript({
              endMs: 4_000,
              isFinal: true,
              meetingId: request.meetingId,
              speakerId: request.speakerId,
              startMs: 3_000,
              text: "Late provider final turn.",
            });
            resolve();
          };
        });
      },
      sendPacket: () => Promise.resolve("accepted" as const),
      terminate: () => {},
    });
  }

  public release(): void {
    this.releaseFinalize?.();
    this.releaseFinalize = undefined;
  }
}

class SilentLiveTranscriberStub {
  public readonly requests: OpenVoicetextLiveSessionRequest[] = [];

  public openSession(
    request: OpenVoicetextLiveSessionRequest,
  ): Promise<VoicetextLiveSession> {
    this.requests.push(request);
    return Promise.resolve({
      finalize: () => Promise.resolve(),
      sendPacket: () => Promise.resolve("accepted" as const),
      terminate: () => {},
    });
  }
}

class SlowFirstPacketLiveTranscriberStub {
  public readonly packets: Array<
    VoicetextLivePacket & { readonly speakerId: string }
  > = [];
  public readonly requests: OpenVoicetextLiveSessionRequest[] = [];
  private readonly firstPacketResolvers: Array<() => void> = [];

  public openSession(
    request: OpenVoicetextLiveSessionRequest,
  ): Promise<VoicetextLiveSession> {
    this.requests.push(request);
    return Promise.resolve({
      finalize: () => Promise.resolve(),
      sendPacket: (packet) => {
        this.packets.push({ ...packet, speakerId: request.speakerId });
        if (packet.relativeTimeMs !== 0) {
          return Promise.resolve("accepted" as const);
        }
        return new Promise((resolve) => {
          this.firstPacketResolvers.push(() => {
            resolve("accepted");
          });
        });
      },
      terminate: () => {
        while (this.firstPacketResolvers.length > 0) {
          this.firstPacketResolvers.shift()?.();
        }
      },
    });
  }

  public releaseFirstPackets(): void {
    while (this.firstPacketResolvers.length > 0) {
      this.firstPacketResolvers.shift()?.();
    }
  }
}

class FailFirstOpenAndSendLiveTranscriberStub {
  public openAttemptCount = 0;
  public readonly packets: VoicetextLivePacket[] = [];
  public readonly sentAtMs: number[] = [];
  public sendAttemptCount = 0;

  public openSession(): Promise<VoicetextLiveSession> {
    this.openAttemptCount += 1;
    if (this.openAttemptCount === 1) {
      return Promise.reject(new Error("provider open failed"));
    }
    return Promise.resolve({
      finalize: () => Promise.resolve(),
      sendPacket: (packet) => {
        this.sendAttemptCount += 1;
        if (this.sendAttemptCount === 1) {
          return Promise.reject(new Error("provider send failed"));
        }
        this.packets.push(packet);
        this.sentAtMs.push(Date.now());
        return Promise.resolve("accepted" as const);
      },
      terminate: () => {},
    });
  }
}

class FailFirstSendLiveTranscriberStub {
  public readonly deliveredPackets: VoicetextLivePacket[] = [];
  public readonly sendAttempts: VoicetextLivePacket[] = [];

  public constructor(private readonly failedSendAttempts = 1) {}

  public openSession(): Promise<VoicetextLiveSession> {
    return Promise.resolve({
      finalize: () => Promise.resolve(),
      sendPacket: (packet) => {
        this.sendAttempts.push(packet);
        if (this.sendAttempts.length <= this.failedSendAttempts) {
          return Promise.reject(new Error("provider send failed"));
        }
        this.deliveredPackets.push(packet);
        return Promise.resolve("accepted" as const);
      },
      terminate: () => {},
    });
  }
}

class DeferredProjectionStub implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];
  private released = false;
  private readonly resolvers: Array<() => void> = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    if (this.released) {
      return Promise.resolve({
        ok: true,
        value: { externalPublicationId: "thread-1" },
      });
    }
    return new Promise((resolve) => {
      this.resolvers.push(() => {
        resolve({ ok: true, value: { externalPublicationId: "thread-1" } });
      });
    });
  }

  public releaseAll(): void {
    this.released = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()?.();
    }
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
    packets: [
      {
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
      },
    ],
    schemaVersion: 1,
  };
}

function packetsForSpeakers(
  relativeTimeMs: number,
  speakerCount = 10,
): VoicePacketBatch {
  const packet = packets().packets[0]!;
  return {
    packets: Array.from({ length: speakerCount }, (_, index) => ({
      ...packet,
      relativeTimeMs,
      rtpSequence: index + Math.floor(relativeTimeMs / 20) * speakerCount + 1,
      rtpTimestamp: 960 + index * 960 + relativeTimeMs * 48,
      speakerId: `speaker-${index + 1}`,
    })),
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
      publicationTargetId: "1533228891827736657",
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
      publicationTargetId: "1533228891827736657",
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
      publicationTargetId: "1533228891827736657",
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
      packets: [
        { ...first, relativeTimeMs: 0 },
        { ...first, relativeTimeMs: 20, rtpSequence: 2, rtpTimestamp: 1_920 },
        { ...first, relativeTimeMs: 40, rtpSequence: 3, rtpTimestamp: 2_880 },
      ],
      schemaVersion: 1,
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
      publicationTargetId: "1533228891827736657",
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
      publicationTargetId: "1533228891827736657",
      refreshMeeting: new RefreshLiveMeeting({
        meetings,
        projector: new ProjectionStub(),
        summarizer: new SummaryStub(),
      }),
      startMeeting: new StartLiveMeeting({ meetings }),
      transcriber,
    });
    const first = packets().packets[0]!;
    const firstAndSecond: VoicePacketBatch = {
      packets: [
        { ...first, relativeTimeMs: 0 },
        {
          ...first,
          relativeTimeMs: 20,
          rtpSequence: 2,
          rtpTimestamp: 1_920,
        },
      ],
      schemaVersion: 1,
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
      packets: [firstAndSecond.packets[0]!],
      schemaVersion: 1,
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
      publicationTargetId: "1533228891827736657",
      refreshMeeting: new RefreshLiveMeeting({
        meetings,
        projector: new ProjectionStub(),
        summarizer: new SummaryStub(),
      }),
      startMeeting: new StartLiveMeeting({ meetings }),
      transcriber,
    });
    const first = packets().packets[0]!;
    const firstAndSecond: VoicePacketBatch = {
      packets: [
        { ...first, relativeTimeMs: 0 },
        {
          ...first,
          relativeTimeMs: 20,
          rtpSequence: 2,
          rtpTimestamp: 1_920,
        },
      ],
      schemaVersion: 1,
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
      packets: [firstAndSecond.packets[0]!],
      schemaVersion: 1,
    });
    await vi.advanceTimersByTimeAsync(20);
    const third = {
      ...first,
      relativeTimeMs: 40,
      rtpSequence: 3,
      rtpTimestamp: 2_880,
    };
    await runtime.acceptVoiceBatch({ packets: [third], schemaVersion: 1 });
    await vi.advanceTimersByTimeAsync(20);

    expect(transcriber.deliveredPackets.map(({ relativeTimeMs }) => relativeTimeMs)).toEqual([
      20, 0, 40,
    ]);
    expect(infos).toContain(
      "Derived live transcription packet recovered after delivery failure",
    );

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
    void runtime.acceptVoiceBatch(firstBatch);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(projector.requests).toHaveLength(1);

    const laterBatch = packets();
    laterBatch.packets[0] = {
      ...laterBatch.packets[0]!,
      relativeTimeMs: 5_000,
      rtpSequence: 2,
      rtpTimestamp: 1_920,
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
      publicationTargetId: "1533228891827736657",
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
      rtpSequence: 2,
      rtpTimestamp: 1_920,
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
    void runtime.acceptVoiceBatch(firstBatch);
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
    void runtime.acceptVoiceBatch(firstBatch);
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
    void runtime.acceptVoiceBatch(laterBatch);
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
      publicationTargetId: "1533228891827736657",
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
    await runtime.acceptLifecycle(ended());
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
    await fence;

    expect(meetings.snapshot).toMatchObject({ status: "ended" });
    expect(meetings.snapshot?.turns).toEqual(expect.arrayContaining([
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
      publicationTargetId: "1533228891827736657",
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
    await runtime.acceptLifecycle(ended());
    await vi.advanceTimersByTimeAsync(0);
    expect(projector.requests.at(-1)).toMatchObject({ phase: "finalizing" });

    const fence = runtime.settleBeforeFinalPublication("recording-live-1");
    transcriber.release();
    await expect(fence).resolves.toBeUndefined();
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
      publicationTargetId: "1533228891827736657",
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
      rtpSequence: 2,
      rtpTimestamp: 1_920,
    };
    void runtime.acceptVoiceBatch(laterBatch);
    await vi.advanceTimersByTimeAsync(1);
    await runtime.acceptLifecycle(ended());
    await runtime.close();

    expect(
      transcriber.requests.map(({ idempotencyKey }) => idempotencyKey),
    ).toEqual([
      "voicetext-live:v2|recording-live-1|1533228054724346087|1",
      "voicetext-live:v2|recording-live-1|1533228054724346087|2",
    ]);
    expect(transcriber.finalizationCount).toBe(2);
    expect(meetings.snapshot?.turns.map(({ startMs }) => startMs)).toEqual([
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
      publicationTargetId: "1533228891827736657",
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
    expect(meetings.snapshot?.turns.map(({ startMs }) => startMs)).toEqual([
      350_000, 352_000,
    ]);
  });
});
