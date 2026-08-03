import { describe, expect, it } from "vitest";

import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
  LiveMeeting,
  type GeneratedIncrementalSummary,
  type IncrementalSummaryGenerationPort,
  type IncrementalSummaryGenerationRequest,
  type LiveGenerationTelemetrySnapshot,
  type LiveMeetingProjectionPort,
  type LiveMeetingProjectionRequest,
  type LiveMeetingRepository,
  type LiveMeetingSnapshot,
  type PortResult,
} from "../src/index.js";

class MemoryLiveMeetingRepository implements LiveMeetingRepository {
  public snapshot: LiveMeetingSnapshot | null = null;

  public findById(meetingId: string): Promise<LiveMeetingSnapshot | null> {
    return Promise.resolve(
      this.snapshot?.meetingId === meetingId ? structuredClone(this.snapshot) : null,
    );
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
}

class ConflictingTelemetryRepository extends MemoryLiveMeetingRepository {
  public rejectGenerationWrites = false;

  public override save(snapshot: LiveMeetingSnapshot, expectedRevision: number | null): Promise<void> {
    if (!this.rejectGenerationWrites || expectedRevision === null) {
      return super.save(snapshot, expectedRevision);
    }
    if (this.snapshot !== null) {
      this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1 };
    }
    return Promise.reject(new Error("simulated generation write conflict"));
  }
}

class RecordingSummarizer implements IncrementalSummaryGenerationPort {
  public readonly requests: IncrementalSummaryGenerationRequest[] = [];

  public constructor(
    private readonly responder: (
      request: IncrementalSummaryGenerationRequest,
    ) => PortResult<GeneratedIncrementalSummary>,
  ) {}

  public generate(
    request: IncrementalSummaryGenerationRequest,
  ): Promise<PortResult<GeneratedIncrementalSummary>> {
    this.requests.push(structuredClone(request));
    return Promise.resolve(this.responder(request));
  }
}

class DeferredSummarizer implements IncrementalSummaryGenerationPort {
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

  public resolveNext(result: PortResult<GeneratedIncrementalSummary>): void {
    const resolve = this.resolvers.shift();
    if (resolve === undefined) {
      throw new Error("no pending summary generation");
    }
    resolve(result);
  }
}

class RecordingProjector implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      ok: true,
      value: { externalPublicationId: request.currentExternalPublicationId ?? "thread-1" },
    });
  }
}

class RecoveringProjectionProjector implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];
  public readonly directEditReceipts: string[] = [];

  public readonly recoveredReceipt =
    "discord:v1:thread:22222222222222222:message:33333333333333334";
  public readonly staleReceipt =
    "discord:v1:thread:22222222222222222:message:33333333333333333";

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
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

class FailingCallProjector implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];

  public constructor(private readonly failingCalls: ReadonlySet<number>) {}

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
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

class DeferredFirstProjector implements LiveMeetingProjectionPort {
  public readonly requests: LiveMeetingProjectionRequest[] = [];
  private firstResolver:
    | ((result: PortResult<{ readonly externalPublicationId: string }>) => void)
    | undefined;

  public publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
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

class PerpetualProjectionConflictRepository extends MemoryLiveMeetingRepository {
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

function generatedSummary(
  request: IncrementalSummaryGenerationRequest,
): PortResult<GeneratedIncrementalSummary> {
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

function partialTelemetry(runId = "telemetry-1"): LiveGenerationTelemetrySnapshot {
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

async function startedRepository(): Promise<MemoryLiveMeetingRepository> {
  const repository = new MemoryLiveMeetingRepository();
  await new StartLiveMeeting({ meetings: repository }).execute({
    meetingId: "meeting-1",
    publicationTargetId: "results-channel",
    startedAtMs: 0,
  });
  return repository;
}

describe("live meeting orchestration", () => {
  it("opens the live projection on the first caption and skips an unchanged refresh", async () => {
    const meetings = await startedRepository();
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new RecordingProjector();
    const refresh = new RefreshLiveMeeting({ meetings, projector, summarizer });
    const caption = {
      endMs: 8_000,
      isFinal: false,
      speakerId: "speaker-a",
      startMs: 5_000,
      text: "Начинаем обсуждение релиза.",
    } as const;

    await expect(refresh.execute({
      captions: [caption],
      meetingId: "meeting-1",
      nowMs: 10_000,
      projectionRequested: true,
    })).resolves.toMatchObject({ generated: false, projected: true });
    await expect(refresh.execute({
      captions: [caption],
      meetingId: "meeting-1",
      nowMs: 15_000,
      projectionRequested: false,
    })).resolves.toMatchObject({ generated: false, projected: false });

    expect(projector.requests).toHaveLength(1);
    expect(projector.requests[0]).toMatchObject({
      captions: [caption],
      currentExternalPublicationId: null,
      summary: null,
    });
    expect(summarizer.requests).toHaveLength(0);
  });

  it("rotates a deleted physical projection receipt through the live revision CAS", async () => {
    const meetings = await startedRepository();
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new RecoveringProjectionProjector();
    const refresh = new RefreshLiveMeeting({ meetings, projector, summarizer });
    const caption = {
      endMs: 8_000,
      isFinal: false,
      speakerId: "speaker-a",
      startMs: 5_000,
      text: "Восстанавливаем удалённую проекцию.",
    } as const;

    await expect(refresh.execute({
      captions: [caption],
      meetingId: "meeting-1",
      nowMs: 10_000,
    })).resolves.toMatchObject({ projected: true });
    await expect(refresh.execute({
      captions: [caption],
      meetingId: "meeting-1",
      nowMs: 15_000,
    })).resolves.toMatchObject({ projected: true });

    expect(meetings.snapshot).toMatchObject({
      projectionExternalId: projector.recoveredReceipt,
    });
    expect(meetings.snapshot?.projectedRevision).toBe(meetings.snapshot?.revision);
    expect(projector.requests[1]).toMatchObject({
      currentExternalPublicationId: projector.staleReceipt,
      idempotencyKey: projector.requests[0]?.idempotencyKey,
    });

    await expect(refresh.execute({
      captions: [caption],
      meetingId: "meeting-1",
      nowMs: 20_000,
    })).resolves.toMatchObject({ projected: true });

    expect(meetings.snapshot?.projectedRevision).toBe(meetings.snapshot?.revision);
    expect(projector.requests[2]).toMatchObject({
      currentExternalPublicationId: projector.recoveredReceipt,
      idempotencyKey: projector.requests[0]?.idempotencyKey,
    });
    expect(projector.directEditReceipts).toEqual([projector.recoveredReceipt]);
  });

  it("rejects a stale physical receipt rotation", () => {
    const meeting = LiveMeeting.start({
      meetingId: "meeting-stale-receipt",
      publicationTargetId: "results-channel",
      startedAtMs: 0,
    });
    const firstReceipt = "discord:v1:thread:22222222222222222:message:33333333333333333";
    const recoveredReceipt = "discord:v1:thread:22222222222222222:message:33333333333333334";

    expect(meeting.completeProjection(firstReceipt, 0)).toBe(true);
    expect(meeting.completeProjection(recoveredReceipt, 1)).toBe(true);
    expect(() => meeting.completeProjection(
      "discord:v1:thread:22222222222222222:message:33333333333333335",
      0,
    )).toThrow(/stale revision/);
    expect(meeting.projectionExternalId).toBe(recoveredReceipt);
  });

  it("does not create a live projection for a silent meeting at five minutes or at its end", async () => {
    const meetings = await startedRepository();
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new RecordingProjector();
    const refresh = new RefreshLiveMeeting({ meetings, projector, summarizer });

    await expect(refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 300_000,
    })).resolves.toMatchObject({ generated: false, projected: false });
    await new FinishLiveMeeting(meetings).execute("meeting-1", 301_000);
    await expect(refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 301_000,
    })).resolves.toMatchObject({ generated: false, projected: false });

    expect(projector.requests).toEqual([]);
    expect(summarizer.requests).toEqual([]);
  });

  it("can open the projection from finalized evidence after its live caption aged out", async () => {
    const meetings = await startedRepository();
    await new AppendLiveTranscriptTurn(meetings).execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Финальная реплика сохранена.",
      turnId: "turn-1",
    });
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new RecordingProjector();
    const refresh = new RefreshLiveMeeting({ meetings, projector, summarizer });

    await expect(refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 300_000,
    })).resolves.toMatchObject({ generated: true, projected: true });

    expect(projector.requests[0]).toMatchObject({
      captions: [],
      currentExternalPublicationId: null,
      summary: null,
    });
    expect(projector.requests[1]).toMatchObject({
      currentExternalPublicationId: "thread-1",
      summary: { revision: 1 },
    });
  });

  it("waits five minutes, then creates one mutable projection with captions", async () => {
    const meetings = await startedRepository();
    await new AppendLiveTranscriptTurn(meetings).execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Выпускаем первую версию в пятницу.",
      turnId: "turn-1",
    });
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new RecordingProjector();
    const refresh = new RefreshLiveMeeting({ meetings, projector, summarizer });

    expect(
      await refresh.execute({ captions: [], meetingId: "meeting-1", nowMs: 299_999 }),
    ).toMatchObject({ generated: false, projected: false });

    const caption = {
      endMs: 301_000,
      isFinal: false,
      speakerId: "speaker-b",
      startMs: 300_000,
      text: "Я подготовлю чеклист...",
    } as const;
    expect(
      await refresh.execute({ captions: [caption], meetingId: "meeting-1", nowMs: 300_000 }),
    ).toMatchObject({ generated: true, projected: true });

    expect(summarizer.requests).toHaveLength(1);
    expect(summarizer.requests[0]?.newTurns.map(({ turnId }) => turnId)).toEqual(["turn-1"]);
    expect(JSON.stringify(summarizer.requests[0])).not.toContain(caption.text);
    expect(projector.requests).toHaveLength(2);
    expect(projector.requests[0]).toMatchObject({
      captions: [caption],
      currentExternalPublicationId: null,
      meetingId: "meeting-1",
      publicationTargetId: "results-channel",
      summary: null,
    });
    expect(projector.requests[1]).toMatchObject({
      currentExternalPublicationId: "thread-1",
      summary: { revision: 1 },
    });
    expect(meetings.snapshot).toMatchObject({
      generationUsage: [{ model: "gpt-5.6-luna", totalTokens: 32 }],
      projectionExternalId: "thread-1",
      summarizedTurnIds: ["turn-1"],
    });
    const persistedRevisionAfterFirstProjection = meetings.snapshot?.revision;

    await refresh.execute({ captions: [], meetingId: "meeting-1", nowMs: 305_000 });
    expect(projector.requests).toHaveLength(3);
    expect(projector.requests[2]?.currentExternalPublicationId).toBe("thread-1");
    expect(summarizer.requests).toHaveLength(1);
    expect(meetings.snapshot?.revision).toBe(persistedRevisionAfterFirstProjection);
  });

  it("uses a 90 second debounce and a three minute forced incremental refresh", async () => {
    const meetings = await startedRepository();
    const append = new AppendLiveTranscriptTurn(meetings);
    await append.execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Первая тема.",
      turnId: "turn-1",
    });
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new RecordingProjector();
    const refresh = new RefreshLiveMeeting({ meetings, projector, summarizer });
    await refresh.execute({ captions: [], meetingId: "meeting-1", nowMs: 300_000 });

    await append.execute("meeting-1", {
      endMs: 320_000,
      speakerId: "speaker-b",
      startMs: 310_000,
      text: "Короткое уточнение.",
      turnId: "turn-2",
    });
    await refresh.execute({ captions: [], meetingId: "meeting-1", nowMs: 390_000 });
    await refresh.execute({ captions: [], meetingId: "meeting-1", nowMs: 479_999 });
    expect(summarizer.requests).toHaveLength(1);

    await refresh.execute({ captions: [], meetingId: "meeting-1", nowMs: 480_000 });
    expect(summarizer.requests).toHaveLength(2);
    expect(summarizer.requests[1]).toMatchObject({
      newTurns: [{ turnId: "turn-2" }],
      previousSummary: { revision: 1 },
      revision: 2,
      throughTurnCount: 2,
    });
    expect(summarizer.requests[1]?.recentContextTurns).toEqual([]);
  });

  it("retries a failed summary projection without requiring another caption change", async () => {
    const meetings = await startedRepository();
    const append = new AppendLiveTranscriptTurn(meetings);
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new FailingCallProjector(new Set([3]));
    const refresh = new RefreshLiveMeeting({ meetings, projector, summarizer });
    const caption = {
      endMs: 8_000,
      isFinal: true,
      speakerId: "speaker-a",
      startMs: 5_000,
      text: "Выпускаем версию в пятницу.",
    } as const;

    await refresh.execute({
      captions: [caption],
      meetingId: "meeting-1",
      nowMs: 10_000,
      projectionRequested: true,
    });
    await append.execute("meeting-1", { ...caption, turnId: "turn-1" });

    const generated = await refresh.execute({
      captions: [caption],
      meetingId: "meeting-1",
      nowMs: 300_000,
      projectionRequested: false,
    });
    expect(generated).toMatchObject({ generated: true, projected: true });
    expect(generated.status).toBe("refreshed");
    if (generated.status !== "refreshed") {
      throw new Error("expected refreshed live meeting");
    }
    expect(generated.projectionFailure).toMatchObject({ code: "DISCORD_UNAVAILABLE" });

    await expect(refresh.execute({
      captions: [caption],
      meetingId: "meeting-1",
      nowMs: 305_000,
      projectionRequested: false,
    })).resolves.toMatchObject({ generated: false, projected: true });
    expect(projector.requests).toHaveLength(4);
    expect(meetings.snapshot?.projectedRevision).toBe(meetings.snapshot?.revision);
  });

  it("republishes the latest summary when a remote projection receipt loses a CAS race", async () => {
    const meetings = await startedRepository();
    await new AppendLiveTranscriptTurn(meetings).execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Выпускаем первую версию в пятницу.",
      turnId: "turn-1",
    });
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new DeferredFirstProjector();
    const refresh = new RefreshLiveMeeting({ meetings, projector, summarizer });
    const caption = {
      endMs: 8_000,
      isFinal: false,
      speakerId: "speaker-a",
      startMs: 5_000,
      text: "Обсуждаем релиз...",
    } as const;

    const pendingProjection = refresh.execute({
      captions: [caption],
      meetingId: "meeting-1",
      nowMs: 300_000,
      summaryGeneration: "skip",
    });
    await Promise.resolve();
    expect(projector.requests).toHaveLength(1);

    await expect(refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 300_000,
      projection: "skip",
    })).resolves.toMatchObject({ generated: true, projected: false });
    projector.resolveFirst();

    await expect(pendingProjection).resolves.toMatchObject({ projected: true });
    expect(projector.requests).toHaveLength(2);
    expect(projector.requests[0]).toMatchObject({ revision: 1, summary: null });
    expect(projector.requests[1]).toMatchObject({ revision: 2, summary: { revision: 1 } });
    expect(projector.requests[1]?.idempotencyKey).toBe(projector.requests[0]?.idempotencyKey);
    expect(meetings.snapshot).toMatchObject({
      projectionExternalId: "thread-1",
      summarizedTurnIds: ["turn-1"],
    });
    expect(meetings.snapshot?.projectedRevision).toBe(meetings.snapshot?.revision);
  });

  it("returns an explicit retryable failure after repeated projection receipt conflicts", async () => {
    const meetings = new PerpetualProjectionConflictRepository();
    await new StartLiveMeeting({ meetings }).execute({
      meetingId: "meeting-conflict",
      publicationTargetId: "results-channel",
      startedAtMs: 0,
    });
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new RecordingProjector();
    const refresh = new RefreshLiveMeeting({ meetings, projector, summarizer });

    await expect(refresh.execute({
      captions: [{
        endMs: 2_000,
        isFinal: false,
        speakerId: "speaker-a",
        startMs: 1_000,
        text: "Начинаем.",
      }],
      meetingId: "meeting-conflict",
      nowMs: 2_000,
      summaryGeneration: "skip",
    })).resolves.toMatchObject({
      projected: false,
      projectionFailure: { code: "LIVE_PROJECTION_CONFLICT", retryable: true },
    });
    expect(projector.requests).toHaveLength(3);
  });

  it("projects an ended meeting without generating when terminal generation is skipped", async () => {
    const repository = new MemoryLiveMeetingRepository();
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new RecordingProjector();
    const start = new StartLiveMeeting({ meetings: repository });
    const append = new AppendLiveTranscriptTurn(repository);
    const finish = new FinishLiveMeeting(repository);
    const refresh = new RefreshLiveMeeting({
      meetings: repository,
      projector,
      summarizer,
    });

    await start.execute({
      meetingId: "meeting-terminal-skip",
      publicationTargetId: "channel-1",
      startedAtMs: 1_000,
    });
    await append.execute("meeting-terminal-skip", {
      endMs: 2_000,
      speakerId: "speaker-1",
      startMs: 1_000,
      text: "Последняя реплика встречи.",
      turnId: "turn-terminal-1",
    });
    await finish.execute("meeting-terminal-skip", 4_000);

    const result = await refresh.execute({
      captions: [],
      meetingId: "meeting-terminal-skip",
      nowMs: 4_000,
      summaryGeneration: "skip",
    });

    expect(result).toMatchObject({ generated: false, projected: true });
    expect(summarizer.requests).toHaveLength(0);
    expect(projector.requests).toHaveLength(1);
    expect(projector.requests[0]).toMatchObject({ status: "ended" });
  });

  it("publishes and summarizes a short meeting as soon as it ends", async () => {
    const meetings = await startedRepository();
    await new AppendLiveTranscriptTurn(meetings).execute("meeting-1", {
      endMs: 20_000,
      speakerId: "speaker-a",
      startMs: 5_000,
      text: "Короткий созвон тоже должен получить итог.",
      turnId: "turn-1",
    });
    await new FinishLiveMeeting(meetings).execute("meeting-1", 25_000);
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new RecordingProjector();

    const result = await new RefreshLiveMeeting({ meetings, projector, summarizer }).execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 25_000,
    });

    expect(result).toMatchObject({ generated: true, projected: true });
    expect(projector.requests[0]).toMatchObject({ elapsedMs: 25_000, status: "ended" });
  });

  it("summarizes a late finalized turn inserted before the prior timeline", async () => {
    const meetings = await startedRepository();
    const append = new AppendLiveTranscriptTurn(meetings);
    await append.execute("meeting-1", {
      endMs: 20_000,
      speakerId: "speaker-a",
      startMs: 10_000,
      text: "Поздняя по времени первая полученная реплика.",
      turnId: "turn-later",
    });
    const summarizer = new RecordingSummarizer(generatedSummary);
    const projector = new RecordingProjector();
    const refresh = new RefreshLiveMeeting({ meetings, projector, summarizer });
    await refresh.execute({ captions: [], meetingId: "meeting-1", nowMs: 300_000 });

    await append.execute("meeting-1", {
      endMs: 8_000,
      speakerId: "speaker-b",
      startMs: 2_000,
      text: "Эта final-реплика пришла позже, но была раньше на таймлайне.",
      turnId: "turn-earlier",
    });
    await new FinishLiveMeeting(meetings).execute("meeting-1", 301_000);
    await refresh.execute({ captions: [], meetingId: "meeting-1", nowMs: 301_000 });

    expect(summarizer.requests[1]?.newTurns.map(({ turnId }) => turnId)).toEqual([
      "turn-earlier",
    ]);
    expect(meetings.snapshot?.summarizedTurnIds).toEqual([
      "turn-earlier",
      "turn-later",
    ]);
  });

  it("rejects hallucinated evidence and keeps the prior projection usable", async () => {
    const meetings = await startedRepository();
    await new AppendLiveTranscriptTurn(meetings).execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Обсуждаем релиз.",
      turnId: "turn-1",
    });
    const summarizer = new RecordingSummarizer((request) => {
      const valid = generatedSummary(request);
      if (!valid.ok) {
        return valid;
      }
      return {
        ok: true,
        value: {
          ...valid.value,
          summary: {
            ...valid.value.summary,
            topics: [{ ...valid.value.summary.topics[0]!, evidenceTurnIds: ["hallucinated"] }],
          },
        },
      };
    });
    const projector = new RecordingProjector();

    const result = await new RefreshLiveMeeting({ meetings, projector, summarizer }).execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 300_000,
    });

    expect(result).toMatchObject({
      generated: false,
      generationFailure: { code: "INVALID_LIVE_SUMMARY_OUTPUT", retryable: false },
      projected: true,
    });
    expect(projector.requests[0]?.summary).toBeNull();
    expect(meetings.snapshot?.draftSummary).toBeNull();
    expect(meetings.snapshot?.generationUsage).toHaveLength(1);
  });

  it("accepts a partial telemetry summary without fabricating legacy usage", async () => {
    const meetings = await startedRepository();
    await new AppendLiveTranscriptTurn(meetings).execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Обсудили важную договоренность.",
      turnId: "turn-1",
    });
    const summarizer = new RecordingSummarizer((request) => {
      const complete = generatedSummary(request);
      if (!complete.ok) {
        return complete;
      }
      return {
        ok: true,
        value: {
          summary: complete.value.summary,
          telemetry: partialTelemetry(`run-${request.revision}`),
        },
      };
    });
    const result = await new RefreshLiveMeeting({
      meetings,
      projector: new RecordingProjector(),
      summarizer,
    }).execute({ captions: [], meetingId: "meeting-1", nowMs: 300_000 });

    expect(result).toMatchObject({
      generated: true,
      generationTelemetry: {
        cacheWriteInputTokens: { availability: "unavailable" },
        totalTokens: { availability: "derived", value: 32 },
      },
    });
    expect(meetings.snapshot?.generationUsage).toEqual([]);
    expect(meetings.snapshot?.generationTelemetry).toEqual([
      expect.objectContaining({
        cacheWriteInputTokens: { availability: "unavailable" },
        totalTokens: {
          availability: "derived",
          derivedFrom: ["inputTokens", "outputTokens"],
          value: 32,
        },
      }),
    ]);
  });

  it("persists rejected partial telemetry without inventing legacy usage", async () => {
    const meetings = await startedRepository();
    await new AppendLiveTranscriptTurn(meetings).execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Провайдер успел начать генерацию.",
      turnId: "turn-1",
    });
    const summarizer = new RecordingSummarizer(() => ({
      failure: {
        code: "SUBSCRIPTION_RUNTIME_SUMMARY_TASK_TIMEOUT",
        message: "timed out after generating partial telemetry",
        retryable: true,
      },
      ok: false,
      telemetry: partialTelemetry("run-rejected"),
    }));
    const projector = new RecordingProjector();
    const refresh = new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer,
    });
    const result = await refresh.execute({ captions: [], meetingId: "meeting-1", nowMs: 300_000 });

    expect(result).toMatchObject({
      generated: false,
      generationFailure: { code: "SUBSCRIPTION_RUNTIME_SUMMARY_TASK_TIMEOUT" },
      generationTelemetry: { runId: "run-rejected" },
    });
    expect(meetings.snapshot?.generationUsage).toEqual([]);
    expect(meetings.snapshot?.generationTelemetry).toEqual([
      expect.objectContaining({ runId: "run-rejected" }),
    ]);
    expect(meetings.snapshot?.projectedRevision).toBe(meetings.snapshot?.revision);

    await expect(refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 305_000,
      projectionRequested: false,
      summaryGeneration: "skip",
    })).resolves.toMatchObject({ generated: false, projected: false });
    expect(projector.requests).toHaveLength(1);
  });

  it("fails explicitly when rejected telemetry cannot be persisted after CAS retries", async () => {
    const meetings = new ConflictingTelemetryRepository();
    await new StartLiveMeeting({ meetings }).execute({
      meetingId: "meeting-cas-conflict",
      publicationTargetId: "results-channel",
      startedAtMs: 0,
    });
    await new AppendLiveTranscriptTurn(meetings).execute("meeting-cas-conflict", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Провайдер вернул ошибку после использования токенов.",
      turnId: "turn-1",
    });
    meetings.rejectGenerationWrites = true;
    const refresh = new RefreshLiveMeeting({
      meetings,
      projector: new RecordingProjector(),
      summarizer: new RecordingSummarizer(() => ({
        failure: {
          code: "SUBSCRIPTION_RUNTIME_SUMMARY_TASK_TIMEOUT",
          message: "retryable generation failure",
          retryable: true,
        },
        ok: false,
        telemetry: partialTelemetry("run-cas-conflict"),
      })),
    });

    await expect(refresh.execute({
      captions: [],
      meetingId: "meeting-cas-conflict",
      nowMs: 300_000,
      projection: "skip",
    })).rejects.toThrow("Unable to persist rejected generation telemetry after concurrent updates");
  });

  it("persists telemetry idempotently across snapshot replay and rejects changed runs", () => {
    const meeting = LiveMeeting.start({
      meetingId: "meeting-telemetry",
      publicationTargetId: "results-channel",
      startedAtMs: 0,
    });
    const telemetry = partialTelemetry("run-replay");

    expect(meeting.recordGenerationTelemetry(telemetry)).toBe(true);
    const restored = LiveMeeting.restore(meeting.toSnapshot());
    expect(restored.recordGenerationTelemetry(telemetry)).toBe(false);
    expect(restored.toSnapshot().generationTelemetry).toEqual([telemetry]);
    expect(() => restored.recordGenerationTelemetry({
      ...telemetry,
      outputTokens: { availability: "measured", value: 3 },
      totalTokens: {
        availability: "derived",
        derivedFrom: ["inputTokens", "outputTokens"],
        value: 33,
      },
    })).toThrow(/replayed with different values/);
  });

  it("keeps projection dirtiness stable for invisible generation telemetry", () => {
    const clean = LiveMeeting.start({
      meetingId: "meeting-clean-telemetry",
      publicationTargetId: "results-channel",
      startedAtMs: 0,
    });
    expect(clean.appendFinalTurn({
      endMs: 2_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Видимая реплика.",
      turnId: "turn-clean",
    })).toBe(true);
    expect(clean.completeProjection("thread-clean", clean.revision)).toBe(true);
    expect(clean.projectedRevision).toBe(clean.revision);

    expect(clean.recordGenerationTelemetry(partialTelemetry("run-clean"))).toBe(true);
    expect(clean.projectedRevision).toBe(clean.revision);

    const dirty = LiveMeeting.start({
      meetingId: "meeting-dirty-telemetry",
      publicationTargetId: "results-channel",
      startedAtMs: 0,
    });
    expect(dirty.appendFinalTurn({
      endMs: 2_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Непроецированная реплика.",
      turnId: "turn-dirty",
    })).toBe(true);
    expect(dirty.recordGenerationTelemetry(partialTelemetry("run-dirty"))).toBe(true);
    expect(dirty.projectedRevision).toBe(0);
    expect(dirty.projectedRevision).toBeLessThan(dirty.revision);
  });

  it("fails closed when unavailable telemetry carries a synthetic zero", () => {
    const snapshot = LiveMeeting.start({
      meetingId: "meeting-invalid-telemetry",
      publicationTargetId: "results-channel",
      startedAtMs: 0,
    }).toSnapshot();

    expect(() => LiveMeeting.restore({
      ...snapshot,
      generationTelemetry: [{
        ...partialTelemetry("run-invalid"),
        cacheWriteInputTokens: { availability: "unavailable", value: 0 } as never,
      }],
    })).toThrow(/unavailable token class must not carry a value/);
  });

  it("applies a generation result while newer finalized turns remain unsummarized", async () => {
    const meetings = await startedRepository();
    const append = new AppendLiveTranscriptTurn(meetings);
    await append.execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Первая финальная реплика.",
      turnId: "turn-1",
    });
    const summarizer = new DeferredSummarizer();
    const projector = new RecordingProjector();
    const refresh = new RefreshLiveMeeting({ meetings, projector, summarizer });

    const pending = refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 300_000,
      projection: "skip",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(summarizer.requests).toHaveLength(1);

    await append.execute("meeting-1", {
      endMs: 9_000,
      speakerId: "speaker-b",
      startMs: 6_000,
      text: "Новая реплика пришла во время генерации.",
      turnId: "turn-2",
    });
    summarizer.resolveNext(generatedSummary(summarizer.requests[0]!));

    await expect(pending).resolves.toMatchObject({ generated: true, projected: false });
    expect(meetings.snapshot).toMatchObject({
      draftSummary: { revision: 1 },
      summarizedTurnIds: ["turn-1"],
      turns: [{ turnId: "turn-1" }, { turnId: "turn-2" }],
    });
    expect(projector.requests).toHaveLength(0);
  });
});
