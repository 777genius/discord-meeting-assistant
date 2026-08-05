import { expect, it } from "vitest";


import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
  normalizeLiveGenerationTelemetry,
} from "../src/index.js";


import {
  ConflictingTelemetryRepository,
  DeferredSummarizer,
  MemoryLiveMeetingRepository,
  RecordingProjector,
  RecordingSummarizer,
  flushMicrotasks,
  generatedSummary,
  partialTelemetry,
  startedRepository,
} from "./live-meeting-fixtures.js";

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
    expect(meetings.timeline.every(({ isSummarized }) => isSummarized)).toBe(true);
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
    expect(meetings.generationUsage).toHaveLength(1);
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
    expect(meetings.generationUsage).toEqual([]);
    expect(meetings.generationTelemetry).toEqual([
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
    expect(meetings.generationUsage).toEqual([]);
    expect(meetings.generationTelemetry).toEqual([
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

  it("fails explicitly when rejected telemetry cannot be appended", async () => {
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
    })).rejects.toThrow("simulated generation ledger write failure");
  });

  it("persists telemetry idempotently without advancing the business revision", async () => {
    const meetings = new MemoryLiveMeetingRepository();
    await new StartLiveMeeting({ meetings }).execute({
      meetingId: "meeting-telemetry",
      publicationTargetId: "results-channel",
      startedAtMs: 0,
    });
    const telemetry = partialTelemetry("run-replay");
    const revision = meetings.snapshot?.revision;

    await expect(meetings.appendGenerationTelemetry("meeting-telemetry", telemetry)).resolves.toBe(
      "appended",
    );
    await expect(meetings.appendGenerationTelemetry("meeting-telemetry", telemetry)).resolves.toBe(
      "reused",
    );
    await expect(meetings.appendGenerationTelemetry("meeting-telemetry", {
      ...telemetry,
      outputTokens: { availability: "measured", value: 3 },
      totalTokens: {
        availability: "derived",
        derivedFrom: ["inputTokens", "outputTokens"],
        value: 33,
      },
    })).rejects.toThrow(/replayed with different values/);
    expect(meetings.generationTelemetry).toEqual([telemetry]);
    expect(meetings.snapshot?.revision).toBe(revision);
  });

  it("keeps operational telemetry out of compact lifecycle state", async () => {
    const meetings = new MemoryLiveMeetingRepository();
    await new StartLiveMeeting({ meetings }).execute({
      meetingId: "meeting-clean-telemetry",
      publicationTargetId: "results-channel",
      startedAtMs: 0,
    });
    const before = structuredClone(meetings.snapshot);
    await meetings.appendGenerationTelemetry("meeting-clean-telemetry", partialTelemetry("run-clean"));

    expect(meetings.snapshot).toEqual(before);
    expect(meetings.generationTelemetry).toHaveLength(1);
  });

  it("fails closed when unavailable telemetry carries a synthetic zero", () => {
    expect(() => normalizeLiveGenerationTelemetry({
      ...partialTelemetry("run-invalid"),
      cacheWriteInputTokens: { availability: "unavailable", value: 0 } as never,
    })).toThrow(/unavailable token class must not carry a value/);
  });

  it("accepts exact generated evidence when a second speaker inserts a turn into its timeline", async () => {
    const meetings = await startedRepository();
    const append = new AppendLiveTranscriptTurn(meetings);
    await append.execute("meeting-1", {
      endMs: 20_000,
      speakerId: "speaker-a",
      startMs: 10_000,
      text: "Первая финальная реплика от первого участника.",
      turnId: "turn-a-first",
    });
    await append.execute("meeting-1", {
      endMs: 60_000,
      speakerId: "speaker-b",
      startMs: 50_000,
      text: "Поздняя по времени реплика второго участника.",
      turnId: "turn-b-later",
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
    await flushMicrotasks();
    expect(summarizer.requests).toHaveLength(1);
    expect(summarizer.requests[0]?.knownTurnIds).toEqual([
      "turn-a-first",
      "turn-b-later",
    ]);

    await append.execute("meeting-1", {
      endMs: 40_000,
      speakerId: "speaker-b",
      startMs: 30_000,
      text: "Эта реплика пришла после запуска генерации, но раньше на таймлайне.",
      turnId: "turn-b-inserted",
    });
    summarizer.resolveNext(generatedSummary(summarizer.requests[0]!));

    await expect(pending).resolves.toMatchObject({ generated: true, projected: false });
    expect(meetings.snapshot).toMatchObject({ draftSummary: { revision: 1 } });
    expect(meetings.timeline.map(({ isSummarized, turn }) => ({
      isSummarized,
      turnId: turn.turnId,
    }))).toEqual([
      { isSummarized: true, turnId: "turn-a-first" },
      { isSummarized: false, turnId: "turn-b-inserted" },
      { isSummarized: true, turnId: "turn-b-later" },
    ]);
    expect(projector.requests).toHaveLength(0);
  });

  it("rejects evidence that arrived after an incremental generation began", async () => {
    const meetings = await startedRepository();
    const append = new AppendLiveTranscriptTurn(meetings);
    await append.execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Исходная реплика для генерации.",
      turnId: "turn-generated-evidence",
    });
    const summarizer = new DeferredSummarizer();
    const refresh = new RefreshLiveMeeting({
      meetings,
      projector: new RecordingProjector(),
      summarizer,
    });

    const pending = refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 300_000,
      projection: "skip",
    });
    await flushMicrotasks();

    await append.execute("meeting-1", {
      endMs: 9_000,
      speakerId: "speaker-b",
      startMs: 6_000,
      text: "Реплика появилась после снимка доказательств.",
      turnId: "turn-arrived-after-generation",
    });
    const completed = generatedSummary(summarizer.requests[0]!);
    if (!completed.ok) {
      throw new Error("expected a generated incremental summary");
    }
    const postSnapshotTurnId = "turn-arrived-after-generation";
    summarizer.resolveNext({
      ok: true,
      value: {
        ...completed.value,
        summary: {
          ...completed.value.summary,
          decisions: completed.value.summary.decisions.map((decision) => ({
            ...decision,
            evidenceTurnIds: [postSnapshotTurnId],
          })),
          topics: completed.value.summary.topics.map((topic) => ({
            ...topic,
            evidenceTurnIds: [postSnapshotTurnId],
          })),
        },
      },
    });

    await expect(pending).resolves.toMatchObject({
      generated: false,
      generationFailure: { code: "INVALID_LIVE_SUMMARY_OUTPUT", retryable: false },
    });
    expect(meetings.snapshot).toMatchObject({
      draftSummary: null,
    });
  });

  it("fails closed when exact generated evidence is changed before it is applied", async () => {
    const meetings = await startedRepository();
    const append = new AppendLiveTranscriptTurn(meetings);
    await append.execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Первоначальный текст финальной реплики.",
      turnId: "turn-mutated",
    });
    const summarizer = new DeferredSummarizer();
    const refresh = new RefreshLiveMeeting({
      meetings,
      projector: new RecordingProjector(),
      summarizer,
    });

    const pending = refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 300_000,
      projection: "skip",
    });
    await flushMicrotasks();
    meetings.timeline = meetings.timeline.map((entry) => entry.turn.turnId === "turn-mutated"
      ? { ...entry, turn: { ...entry.turn, text: "Изменённый текст той же final-реплики." } }
      : entry);
    summarizer.resolveNext(generatedSummary(summarizer.requests[0]!));

    await expect(pending).resolves.toMatchObject({
      generated: false,
      generationStale: true,
    });
    expect(meetings.snapshot).toMatchObject({
      draftSummary: null,
    });
  });

  it("fails closed when exact generated evidence disappears before it is applied", async () => {
    const meetings = await startedRepository();
    const append = new AppendLiveTranscriptTurn(meetings);
    await append.execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Реплика, которая не должна исчезнуть из доказательств.",
      turnId: "turn-removed",
    });
    const summarizer = new DeferredSummarizer();
    const refresh = new RefreshLiveMeeting({
      meetings,
      projector: new RecordingProjector(),
      summarizer,
    });

    const pending = refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 300_000,
      projection: "skip",
    });
    await flushMicrotasks();
    meetings.timeline = [];
    summarizer.resolveNext(generatedSummary(summarizer.requests[0]!));

    await expect(pending).resolves.toMatchObject({
      generated: false,
      generationStale: true,
    });
    expect(meetings.snapshot).toMatchObject({
      draftSummary: null,
    });
  });

  it("keeps the terminal fence when a meeting ends during incremental generation", async () => {
    const meetings = await startedRepository();
    const append = new AppendLiveTranscriptTurn(meetings);
    await append.execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Реплика перед завершением звонка.",
      turnId: "turn-before-end",
    });
    const summarizer = new DeferredSummarizer();
    const refresh = new RefreshLiveMeeting({
      meetings,
      projector: new RecordingProjector(),
      summarizer,
    });

    const pending = refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 300_000,
      projection: "skip",
    });
    await flushMicrotasks();
    await new FinishLiveMeeting(meetings).execute("meeting-1", 301_000);
    summarizer.resolveNext(generatedSummary(summarizer.requests[0]!));

    await expect(pending).resolves.toMatchObject({
      generated: false,
      generationStale: true,
    });
    expect(meetings.snapshot).toMatchObject({
      draftSummary: null,
      status: "ended",
    });
  });

  it("allows only one replay of the same generated evidence to advance the summary revision", async () => {
    const meetings = await startedRepository();
    await new AppendLiveTranscriptTurn(meetings).execute("meeting-1", {
      endMs: 5_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Единственная реплика для конкурентных генераций.",
      turnId: "turn-replay",
    });
    const summarizer = new DeferredSummarizer();
    const refresh = new RefreshLiveMeeting({
      meetings,
      projector: new RecordingProjector(),
      summarizer,
    });

    const first = refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 300_000,
      projection: "skip",
    });
    const second = refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 300_000,
      projection: "skip",
    });
    await flushMicrotasks();
    expect(summarizer.requests).toHaveLength(2);

    summarizer.resolveNext(generatedSummary(summarizer.requests[0]!));
    await expect(first).resolves.toMatchObject({ generated: true, projected: false });
    summarizer.resolveNext(generatedSummary(summarizer.requests[1]!));
    await expect(second).resolves.toMatchObject({
      generated: false,
      generationStale: true,
      projected: false,
    });
    expect(meetings.snapshot).toMatchObject({
      draftSummary: { revision: 1 },
    });
    expect(meetings.timeline.map(({ isSummarized, turn }) => ({
      isSummarized,
      turnId: turn.turnId,
    }))).toEqual([{ isSummarized: true, turnId: "turn-replay" }]);
  });
