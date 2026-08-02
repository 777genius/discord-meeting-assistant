import type { CraigLifecycleEvent, VoicePacketBatch } from "@discord-meeting/craig-gateway-contracts";
import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
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

class ProjectionStub implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({ ok: true, value: { externalPublicationId: "thread-1" } });
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

const logger: Logger = {
  child: () => logger,
  debug: () => {},
  error: () => {},
  flush: () => Promise.resolve(),
  info: () => {},
  warn: () => {},
};

function started(): CraigLifecycleEvent {
  return {
    channelId: "1533228891827736657",
    eventId: "start-1",
    guildId: "1533227577286852649",
    occurredAt: "2026-08-02T10:00:00.000Z",
    participantIds: ["1533228054724346087"],
    recordingId: "recording-live-1",
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

function packets(): VoicePacketBatch {
  return {
    packets: [{
      channelId: "1533228891827736657",
      guildId: "1533227577286852649",
      opusBase64: Buffer.from([0xf8, 0xff, 0xfe]).toString("base64"),
      receivedAtMs: 1_000,
      recordingId: "recording-live-1",
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

  it("projects the first live caption within one tick and suppresses unchanged edits", async () => {
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

    runtime.acceptLifecycle(started());
    runtime.acceptVoiceBatch(firstBatch);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(projector.requests).toHaveLength(1);
    expect(projector.requests[0]).toMatchObject({
      elapsedMs: 5_000,
      status: "active",
      summary: null,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(projector.requests).toHaveLength(1);
    expect(summarizer.requests).toHaveLength(0);

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

    runtime.acceptLifecycle(started());
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

    runtime.acceptLifecycle(started());
    runtime.acceptVoiceBatch(packets());
    runtime.acceptLifecycle(ended());
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

    runtime.acceptLifecycle(started());
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
    runtime.acceptLifecycle(ended());
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

  it("splits a relative timeline gap even when both packets arrive in one batch", async () => {
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

    runtime.acceptLifecycle(started());
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
    runtime.acceptLifecycle(ended());
    await runtime.close();

    expect(transcriber.requests).toHaveLength(2);
    expect(transcriber.finalizationCount).toBe(2);
    expect(meetings.snapshot?.turns.map(({ startMs }) => startMs)).toEqual([
      350_000,
      352_000,
    ]);
  });
});
