import { describe, expect, it } from "vitest";

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
});
