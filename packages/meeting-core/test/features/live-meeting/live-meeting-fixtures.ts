import {
  LiveMeetingInvariantError,
  StartLiveMeeting,
  type CommitLiveMeetingSummaryInput,
  type GeneratedIncrementalSummary,
  type IncrementalSummaryGenerationPort,
  type IncrementalSummaryGenerationRequest,
  type LiveGenerationTelemetrySnapshot,
  type LiveGenerationUsageSnapshot,
  type LiveAppendResult,
  type LiveFinalizedTurn,
  type LiveMeetingProjectionPort,
  type LiveMeetingProjectionRequest,
  type LiveMeetingRepository,
  type LiveMeetingSnapshot,
  type LiveMeetingPortResult,
} from "@discord-meeting/meeting-core/live-meeting";
import type { TranscriptTurnSnapshot } from "@discord-meeting/meeting-core/transcription";

function sameTurn(left: TranscriptTurnSnapshot, right: TranscriptTurnSnapshot): boolean {
  return left.turnId === right.turnId &&
    left.speakerId === right.speakerId &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.text === right.text;
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

export class MemoryLiveMeetingRepository implements LiveMeetingRepository {
  public snapshot: LiveMeetingSnapshot | null = null;
  public timeline: LiveFinalizedTurn[] = [];
  public generationTelemetry: LiveGenerationTelemetrySnapshot[] = [];
  public generationUsage: LiveGenerationUsageSnapshot[] = [];

  public findById(meetingId: string): Promise<LiveMeetingSnapshot | null> {
    return Promise.resolve(
      this.snapshot?.meetingId === meetingId ? structuredClone(this.snapshot) : null,
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

  public save(snapshot: LiveMeetingSnapshot, expectedRevision: number | null): Promise<void> {
    if (expectedRevision === null) {
      if (this.snapshot !== null) {
        throw new Error("live meeting already exists");
      }
    } else if (this.snapshot?.revision !== expectedRevision) {
      throw new Error(
        `revision conflict: expected ${expectedRevision}, actual ${this.snapshot?.revision}`,
      );
    }
    this.snapshot = structuredClone(snapshot);
    return Promise.resolve();
  }

  public appendFinalizedTurn(
    meetingId: string,
    turn: TranscriptTurnSnapshot,
  ): Promise<LiveAppendResult> {
    if (this.snapshot?.meetingId !== meetingId) {
      return Promise.resolve("not-found");
    }
    const existing = this.timeline.find(({ turn: candidate }) => candidate.turnId === turn.turnId);
    if (existing !== undefined) {
      if (sameTurn(existing.turn, turn)) {
        return Promise.resolve("reused");
      }
      return Promise.reject(new LiveMeetingInvariantError(
        "CONFLICTING_COMPLETION",
        "live turn identity was reused with different content",
      ));
    }
    if (this.snapshot.status !== "active") {
      return Promise.reject(new LiveMeetingInvariantError(
        "INVALID_LIFECYCLE_STATE",
        "cannot append a live turn after the meeting ended",
      ));
    }
    this.timeline.push({ isSummarized: false, turn: structuredClone(turn) });
    this.timeline.sort((left, right) =>
      left.turn.startMs - right.turn.startMs ||
      left.turn.endMs - right.turn.endMs ||
      left.turn.speakerId.localeCompare(right.turn.speakerId) ||
      left.turn.turnId.localeCompare(right.turn.turnId)
    );
    this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1 };
    return Promise.resolve("appended");
  }

  public listFinalizedTurns(meetingId: string): Promise<readonly LiveFinalizedTurn[]> {
    return Promise.resolve(
      this.snapshot?.meetingId === meetingId ? structuredClone(this.timeline) : [],
    );
  }

  public appendGenerationTelemetry(
    meetingId: string,
    telemetry: LiveGenerationTelemetrySnapshot,
  ): Promise<LiveAppendResult> {
    return this.appendGenerationRecord(meetingId, telemetry, this.generationTelemetry);
  }

  public appendGenerationUsage(
    meetingId: string,
    usage: LiveGenerationUsageSnapshot,
  ): Promise<LiveAppendResult> {
    return this.appendGenerationRecord(meetingId, usage, this.generationUsage);
  }

  public async commitSummary(input: CommitLiveMeetingSummaryInput): Promise<void> {
    if (new Set(input.newlySummarizedTurnIds).size !== input.newlySummarizedTurnIds.length) {
      throw new LiveMeetingInvariantError("DUPLICATE_IDENTIFIER", "summary coverage turn IDs must be unique");
    }
    if (input.newlySummarizedTurnIds.some((turnId) =>
      !this.timeline.some(({ turn }) => turn.turnId === turnId)
    )) {
      throw new LiveMeetingInvariantError("INVALID_EVIDENCE_REFERENCE", "summary coverage turn is missing");
    }
    await this.save(input.snapshot, input.expectedRevision);
    this.timeline = this.timeline.map((entry) =>
      input.newlySummarizedTurnIds.includes(entry.turn.turnId)
        ? { ...entry, isSummarized: true }
        : entry
    );
    if (input.usage !== undefined) {
      await this.appendGenerationUsage(input.snapshot.meetingId, input.usage);
    }
    if (input.telemetry !== undefined) {
      await this.appendGenerationTelemetry(input.snapshot.meetingId, input.telemetry);
    }
  }

  private appendGenerationRecord<Value extends { readonly runId: string }>(
    meetingId: string,
    record: Value,
    records: Value[],
  ): Promise<LiveAppendResult> {
    if (this.snapshot?.meetingId !== meetingId) {
      return Promise.resolve("not-found");
    }
    const existing = records.find(({ runId }) => runId === record.runId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(record)) {
        return Promise.resolve("reused");
      }
      return Promise.reject(new LiveMeetingInvariantError(
        "CONFLICTING_COMPLETION",
        "generation run was replayed with different values",
      ));
    }
    records.push(structuredClone(record));
    return Promise.resolve("appended");
  }
}

export class ConflictingTelemetryRepository extends MemoryLiveMeetingRepository {
  public rejectGenerationWrites = false;

  public override appendGenerationTelemetry(
    meetingId: string,
    telemetry: LiveGenerationTelemetrySnapshot,
  ): Promise<LiveAppendResult> {
    if (this.rejectGenerationWrites) {
      return Promise.reject(new Error("simulated generation ledger write failure"));
    }
    return super.appendGenerationTelemetry(meetingId, telemetry);
  }
}

export class PerpetualSummaryConflictRepository extends MemoryLiveMeetingRepository {
  public override commitSummary(_input: CommitLiveMeetingSummaryInput): Promise<void> {
    if (this.snapshot === null) {
      return Promise.reject(new Error("missing live meeting"));
    }
    this.snapshot = {
      ...structuredClone(this.snapshot),
      revision: this.snapshot.revision + 1,
    };
    return Promise.reject(new Error("injected summary revision conflict"));
  }
}

export class RecordingSummarizer implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];

  public constructor(
    private readonly responder: (
      request: IncrementalSummaryGenerationRequest,
    ) => LiveMeetingPortResult<GeneratedIncrementalSummary>,
  ) {}

  public generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<LiveMeetingPortResult<GeneratedIncrementalSummary>> {
    this.requests.push(structuredClone(request));
    return Promise.resolve(this.responder(request));
  }
}

export class DeferredSummarizer implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];
  private readonly resolvers: Array<(result: LiveMeetingPortResult<GeneratedIncrementalSummary>) => void> = [];

  public generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<LiveMeetingPortResult<GeneratedIncrementalSummary>> {
    this.requests.push(structuredClone(request));
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  public resolveNext(result: LiveMeetingPortResult<GeneratedIncrementalSummary>): void {
    const resolve = this.resolvers.shift();
    if (resolve === undefined) {
      throw new Error("no pending summary generation");
    }
    resolve(result);
  }
}

export class RecordingProjector implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<LiveMeetingPortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      ok: true,
      value: { externalPublicationId: request.currentExternalPublicationId ?? "thread-1" },
    });
  }
}

export class RecoveringProjectionProjector implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];
  public readonly directEditReceipts: string[] = [];

  public readonly recoveredReceipt =
    "discord:v1:thread:22222222222222222:message:33333333333333334";
  public readonly staleReceipt =
    "discord:v1:thread:22222222222222222:message:33333333333333333";

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<LiveMeetingPortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    if (request.currentExternalPublicationId === null) {
      return Promise.resolve({ ok: true, value: { externalPublicationId: this.staleReceipt } });
    }
    if (request.currentExternalPublicationId === this.staleReceipt) {
      return Promise.resolve({ ok: true, value: { externalPublicationId: this.recoveredReceipt } });
    }
    this.directEditReceipts.push(request.currentExternalPublicationId);
    return Promise.resolve({
      ok: true,
      value: { externalPublicationId: request.currentExternalPublicationId },
    });
  }
}

export class FailingCallProjector implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];

  public constructor(private readonly failingCalls: ReadonlySet<number>) {}

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<LiveMeetingPortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    if (this.failingCalls.has(this.requests.length)) {
      return Promise.resolve({
        failure: { code: "DISCORD_UNAVAILABLE", message: "retry", retryable: true },
        ok: false,
      });
    }
    return Promise.resolve({
      ok: true,
      value: { externalPublicationId: "thread-1" },
    });
  }
}

export class DeferredFirstProjector implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];
  private firstResolver:
    | ((result: LiveMeetingPortResult<{ readonly externalPublicationId: string }>) => void)
    | undefined;

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<LiveMeetingPortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    if (this.requests.length > 1) {
      return Promise.resolve({
        ok: true,
        value: { externalPublicationId: "thread-1" },
      });
    }
    return new Promise((resolve) => {
      this.firstResolver = resolve;
    });
  }

  public resolveFirst(): void {
    if (this.firstResolver === undefined) {
      throw new Error("no deferred projection");
    }
    this.firstResolver({ ok: true, value: { externalPublicationId: "thread-1" } });
    this.firstResolver = undefined;
  }
}

export class PerpetualProjectionConflictRepository extends MemoryLiveMeetingRepository {
  public override save(
    snapshot: LiveMeetingSnapshot,
    expectedRevision: number | null,
  ): Promise<void> {
    if (expectedRevision !== null && snapshot.projectionExternalId !== null) {
      if (this.snapshot === null) {
        throw new Error("missing live meeting");
      }
      this.snapshot = {
        ...structuredClone(this.snapshot),
        revision: this.snapshot.revision + 1,
      };
      return Promise.reject(new Error("injected projection revision conflict"));
    }
    return super.save(snapshot, expectedRevision);
  }
}

export function generatedSummary(
  request: IncrementalSummaryGenerationRequest,
): LiveMeetingPortResult<GeneratedIncrementalSummary> {
  const evidenceTurnId = request.knownTurnIds.at(-1) ?? "missing";
  return {
    ok: true,
    value: {
      summary: {
        actionItems: [],
        decisions: [
          {
            decisionId: `decision-${request.revision}`,
            evidenceTurnIds: [evidenceTurnId],
            text: "Выпустить версию в пятницу.",
          },
        ],
        openQuestions: [],
        overview: "Команда обсудила выпуск версии.",
        revision: request.revision,
        title: "План выпуска",
        topics: [
          {
            evidenceTurnIds: [evidenceTurnId],
            points: ["Версия запланирована на пятницу"],
            title: "Релиз",
          },
        ],
      },
      usage: {
        apiEquivalentCostUsd: 0.000_042,
        cacheWriteInputTokens: 0,
        cachedInputTokens: 0,
        inputTokens: 30,
        model: "gpt-5.6-luna",
        outputTokens: 2,
        priceCard: "openai-standard-2026-08-02",
        reasoningOutputTokens: 0,
        runId: `run-${request.revision}`,
        totalTokens: 32,
      },
    },
  };
}

export function partialTelemetry(runId = "telemetry-1"): LiveGenerationTelemetrySnapshot {
  return {
    cacheWriteInputTokens: { availability: "unavailable" },
    cachedInputTokens: { availability: "measured", value: 4 },
    cost: {
      maximumUsd: 0.000_021,
      minimumUsd: 0.000_018,
      priceCardId: "luna-2026-08-02-standard",
      priceCardSource: "OpenAI API pricing 2026-08-02",
    },
    inputTokens: { availability: "measured", value: 30 },
    model: "gpt-5.6-luna",
    outputTokens: { availability: "measured", value: 2 },
    reasoningOutputTokens: { availability: "measured", value: 0 },
    runId,
    source: "codex_exec_jsonl",
    totalTokens: {
      availability: "derived",
      derivedFrom: ["inputTokens", "outputTokens"],
      value: 32,
    },
  };
}

export async function startedRepository(): Promise<MemoryLiveMeetingRepository> {
  const repository = new MemoryLiveMeetingRepository();
  await new StartLiveMeeting({ meetings: repository }).execute({
    meetingId: "meeting-1",
    publicationTargetId: "results-channel",
    startedAtMs: 0,
  });
  return repository;
}
