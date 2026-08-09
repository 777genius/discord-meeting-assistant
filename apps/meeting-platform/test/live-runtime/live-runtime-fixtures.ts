import {
  type CommitLiveMeetingSummaryInput,
  type GeneratedIncrementalSummary,
  type IncrementalSummaryGenerationPort,
  type IncrementalSummaryGenerationRequest,
  type LiveFinalizedTurn,
  type LiveGenerationTelemetrySnapshot,
  type LiveGenerationUsageSnapshot,
  type LiveMeetingProjectionPort,
  type LiveMeetingProjectionRequest,
  type LiveMeetingRepository,
  type LiveMeetingSnapshot,
  type LiveMeetingPortResult,
  type LiveMeetingFailure,
} from "@discord-meeting/meeting-core/live-meeting";
import {
  type FinalizedConversationTurnInput,
  type PreparedConversationCueInput,
  type ProactiveConversationTurnInput,
} from "@discord-meeting/meeting-core/conversation";
import type { Logger } from "@discord-meeting/observability-adapter";
import type {
  OpenVoicetextLiveSessionRequest,
  VoicetextLivePacket,
  VoicetextLiveSession,
} from "@discord-meeting/voicetext-adapter";

import type {
  LiveMeetingLifecycleEvent,
  LiveMeetingStartedEvent,
  LiveVoicePacket,
  LiveVoicePacketBatch,
} from "../../src/live-runtime/contracts.js";

type MutableLiveVoicePacketBatch = Omit<LiveVoicePacketBatch, "packets"> & {
  readonly packets: LiveVoicePacket[];
};

export class MemoryLiveMeetingRepository implements LiveMeetingRepository {
  public snapshot: LiveMeetingSnapshot | null = null;
  private readonly generationTelemetry: LiveGenerationTelemetrySnapshot[] = [];
  private readonly generationUsage: LiveGenerationUsageSnapshot[] = [];
  private readonly timeline: LiveFinalizedTurn[] = [];

  public get finalizedTurns(): readonly LiveFinalizedTurn["turn"][] {
    return this.timeline.map(({ turn }) => structuredClone(turn));
  }

  public findById(meetingId: string): Promise<LiveMeetingSnapshot | null> {
    return Promise.resolve(
      this.snapshot?.meetingId === meetingId
        ? structuredClone(this.snapshot)
        : null,
    );
  }

  public readSnapshotAndTimeline(meetingId: string): Promise<{
    readonly snapshot: LiveMeetingSnapshot;
    readonly timeline: readonly LiveFinalizedTurn[];
  } | null> {
    if (this.snapshot?.meetingId !== meetingId) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      snapshot: structuredClone(this.snapshot),
      timeline: structuredClone(this.timeline),
    });
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

  public appendFinalizedTurn(
    meetingId: string,
    turn: LiveFinalizedTurn["turn"],
  ): Promise<"appended" | "not-found" | "reused"> {
    if (this.snapshot?.meetingId !== meetingId) {
      return Promise.resolve("not-found");
    }
    const existing = this.timeline.find(({ turn: current }) => current.turnId === turn.turnId);
    if (existing !== undefined) {
      if (!sameTranscriptTurn(existing.turn, turn)) {
        return Promise.reject(new Error("conflicting transcript turn replay"));
      }
      return Promise.resolve("reused");
    }
    this.timeline.push({ isSummarized: false, turn: structuredClone(turn) });
    this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1 };
    return Promise.resolve("appended");
  }

  public listFinalizedTurns(
    meetingId: string,
  ): Promise<readonly LiveFinalizedTurn[]> {
    return Promise.resolve(
      this.snapshot?.meetingId === meetingId ? structuredClone(this.timeline) : [],
    );
  }

  public appendGenerationTelemetry(
    meetingId: string,
    telemetry: LiveGenerationTelemetrySnapshot,
  ): Promise<"appended" | "not-found" | "reused"> {
    if (this.snapshot?.meetingId !== meetingId) {
      return Promise.resolve("not-found");
    }
    this.generationTelemetry.push(structuredClone(telemetry));
    return Promise.resolve("appended");
  }

  public appendGenerationUsage(
    meetingId: string,
    usage: LiveGenerationUsageSnapshot,
  ): Promise<"appended" | "not-found" | "reused"> {
    if (this.snapshot?.meetingId !== meetingId) {
      return Promise.resolve("not-found");
    }
    this.generationUsage.push(structuredClone(usage));
    return Promise.resolve("appended");
  }

  public commitSummary(input: CommitLiveMeetingSummaryInput): Promise<void> {
    if (this.snapshot?.revision !== input.expectedRevision) {
      return Promise.reject(new Error("revision conflict"));
    }
    const summarizedTurnIds = new Set(input.newlySummarizedTurnIds);
    for (const [index, entry] of this.timeline.entries()) {
      if (summarizedTurnIds.has(entry.turn.turnId)) {
        this.timeline[index] = { ...entry, isSummarized: true };
      }
    }
    if (input.telemetry !== undefined) {
      this.generationTelemetry.push(structuredClone(input.telemetry));
    }
    if (input.usage !== undefined) {
      this.generationUsage.push(structuredClone(input.usage));
    }
    this.snapshot = structuredClone(input.snapshot);
    return Promise.resolve();
  }
}

function sameTranscriptTurn(
  left: LiveFinalizedTurn["turn"],
  right: LiveFinalizedTurn["turn"],
): boolean {
  return (
    left.turnId === right.turnId &&
    left.speakerId === right.speakerId &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.text === right.text
  );
}

export class SummaryStub implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];

  public generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<LiveMeetingPortResult<GeneratedIncrementalSummary>> {
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

export class DeferredSummaryStub implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];
  private readonly resolvers: Array<
    (result: LiveMeetingPortResult<GeneratedIncrementalSummary>) => void
  > = [];

  public generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<LiveMeetingPortResult<GeneratedIncrementalSummary>> {
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

export class FailingSummaryStub implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];

  public generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<LiveMeetingPortResult<GeneratedIncrementalSummary>> {
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

export class PermanentFailingSummaryStub implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];

  public generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<LiveMeetingPortResult<GeneratedIncrementalSummary>> {
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

export class ProjectionStub implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<LiveMeetingPortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      ok: true,
      value: { externalPublicationId: "thread-1" },
    });
  }
}

export class FailingProjectionStub implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];

  public constructor(private readonly failure: LiveMeetingFailure) {}

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<LiveMeetingPortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({ failure: this.failure, ok: false });
  }
}

export class FinalizingFailingProjectionStub implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<LiveMeetingPortResult<{ readonly externalPublicationId: string }>> {
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

export class TimedProjectionStub implements LiveMeetingProjectionPort {
  public readonly calls: Array<{
    readonly meetingId: string;
    readonly publishedAtMs: number;
  }> = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<LiveMeetingPortResult<{ readonly externalPublicationId: string }>> {
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

export class LiveTranscriberStub {
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

export class ControlledLiveTranscriberStub {
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

export class ConversationCoordinatorProbe {
  public readonly advanceCalls: Array<{ meetingId: string; nowMs: number }> = [];
  public readonly calls: FinalizedConversationTurnInput[] = [];
  public readonly closeCalls: string[] = [];
  public readonly persistedBeforeCall: boolean[] = [];
  public readonly preparedCueCalls: PreparedConversationCueInput[] = [];
  public readonly proactiveCalls: ProactiveConversationTurnInput[] = [];
  public readonly speechEvents: string[] = [];
  public readonly speechObservations: Array<{
    meetingId: string;
    nowMs: number;
    type: "activity" | "ended" | "started";
  }> = [];
  private releaseHandle: (() => void) | undefined;

  public constructor(
    private readonly meetings: MemoryLiveMeetingRepository,
    private readonly failHandle = false,
    private readonly blockHandle = false,
  ) {}

  public advanceMeeting(meetingId: string, nowMs: number): void {
    this.advanceCalls.push({ meetingId, nowMs });
  }

  public closeMeeting(meetingId: string): Promise<void> {
    this.closeCalls.push(meetingId);
    return Promise.resolve();
  }

  public handleFinalizedTurn(input: FinalizedConversationTurnInput) {
    this.calls.push(structuredClone(input));
    this.persistedBeforeCall.push(
      this.meetings.finalizedTurns.some(
        (turn) => turn.turnId === input.turnId,
      ),
    );
    if (this.failHandle) {
      return Promise.reject(new Error("injected conversation failure"));
    }
    if (this.blockHandle) {
      return new Promise<{ readonly status: "ignored" }>((resolve) => {
        this.releaseHandle = () => {
          resolve({ status: "ignored" });
        };
      });
    }
    return Promise.resolve({ status: "ignored" as const });
  }

  public handleProactiveTurn(input: ProactiveConversationTurnInput) {
    this.proactiveCalls.push(structuredClone(input));
    return Promise.resolve({ status: "ignored" as const });
  }

  public playPreparedCue(input: PreparedConversationCueInput) {
    this.preparedCueCalls.push(structuredClone(input));
    return Promise.resolve({ status: "active" as const });
  }

  public releaseBlockedHandle(): void {
    this.releaseHandle?.();
    this.releaseHandle = undefined;
  }

  public speechActivity(
    meetingId: string,
    nowMs: number,
  ): Promise<{ readonly status: "ignored" }> {
    this.speechEvents.push("activity");
    this.speechObservations.push({ meetingId, nowMs, type: "activity" });
    return Promise.resolve({ status: "ignored" });
  }

  public speechEnded(
    meetingId: string,
    nowMs: number,
  ): Promise<{ readonly status: "ignored" }> {
    this.speechEvents.push("ended");
    this.speechObservations.push({ meetingId, nowMs, type: "ended" });
    return Promise.resolve({ status: "ignored" });
  }

  public speechStarted(
    meetingId: string,
    nowMs: number,
  ): Promise<{ readonly status: "ignored" }> {
    this.speechEvents.push("started");
    this.speechObservations.push({ meetingId, nowMs, type: "started" });
    return Promise.resolve({ status: "ignored" });
  }

  public whenIdle(): Promise<void> {
    return Promise.resolve();
  }
}

export class BlockedFinalizeLiveTranscriberStub {
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

export class SilentLiveTranscriberStub {
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

export class SlowFirstPacketLiveTranscriberStub {
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

export class FailFirstOpenAndSendLiveTranscriberStub {
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

export class FailFirstSendLiveTranscriberStub {
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

export class DeferredProjectionStub implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];
  private released = false;
  private readonly resolvers: Array<() => void> = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<LiveMeetingPortResult<{ readonly externalPublicationId: string }>> {
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

export const logger: Logger = {
  child: () => logger,
  debug: () => {},
  error: () => {},
  flush: () => Promise.resolve(),
  info: () => {},
  warn: () => {},
};

export function started(
  recordingId = "recording-live-1",
  participantIds: readonly string[] = [],
): LiveMeetingStartedEvent {
  return {
    occurredAt: "2026-08-02T10:00:00.000Z",
    participantIds,
    publicationTarget: {
      resolve: async () => "1533228891827736657",
    },
    recordingId,
    type: "meeting.started",
  };
}

export function ended(): LiveMeetingLifecycleEvent {
  return {
    occurredAt: "2026-08-02T10:06:00.000Z",
    recordingId: "recording-live-1",
    type: "meeting.ended",
  };
}

export function packets(recordingId = "recording-live-1"): MutableLiveVoicePacketBatch {
  return {
    format: { channelCount: 1, codec: "opus", sampleRateHz: 48_000 },
    packets: [
      {
        mediaTimestamp: 960,
        payloadBase64: Buffer.from([0xf8, 0xff, 0xfe]).toString("base64"),
        receivedAtMs: 1_000,
        recordingId,
        relativeTimeMs: 350_000,
        sequenceNumber: 1,
        speakerId: "1533228054724346087",
      },
    ],
  };
}

export function packetsForSpeakers(
  relativeTimeMs: number,
  speakerCount = 10,
): MutableLiveVoicePacketBatch {
  const packet = packets().packets[0]!;
  return {
    packets: Array.from({ length: speakerCount }, (_, index) => ({
      ...packet,
      relativeTimeMs,
      sequenceNumber: index + Math.floor(relativeTimeMs / 20) * speakerCount + 1,
      mediaTimestamp: 960 + index * 960 + relativeTimeMs * 48,
      speakerId: `speaker-${index + 1}`,
    })),
    format: { channelCount: 1, codec: "opus", sampleRateHz: 48_000 },
  };
}


export function emitControlledTranscript(
  request: OpenVoicetextLiveSessionRequest,
  isFinal: boolean,
): void {
  request.onTranscript({
    endMs: 1_000,
    isFinal,
    meetingId: request.meetingId,
    speakerId: request.speakerId,
    startMs: 0,
    text: isFinal ? "Готово." : "Говорю...",
  });
}
