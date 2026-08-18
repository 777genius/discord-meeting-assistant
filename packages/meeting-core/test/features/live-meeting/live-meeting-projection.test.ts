import { expect, it } from "vitest";


import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  LiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
} from "@discord-meeting/meeting-core/live-meeting";


import {
  DeferredFirstProjector,
  FailingCallProjector,
  MemoryLiveMeetingRepository,
  PerpetualProjectionConflictRepository,
  RecordingProjector,
  RecordingSummarizer,
  RecoveringProjectionProjector,
  flushMicrotasks,
  generatedSummary,
  startedRepository,
} from "./live-meeting-fixtures.js";

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
    const publisherIdentity = "discord-bot-application:test";

    expect(meeting.completeProjection(firstReceipt, 0, publisherIdentity)).toBe(true);
    expect(meeting.completeProjection(recoveredReceipt, 1, publisherIdentity)).toBe(true);
    expect(() => meeting.completeProjection(
      "discord:v1:thread:22222222222222222:message:33333333333333335",
      0,
      publisherIdentity,
    )).toThrow(/stale revision/);
    expect(meeting.projectionExternalId).toBe(recoveredReceipt);
  });

  it("keeps prior summary coverage immutable while covering newly appended evidence", async () => {
    const meetings = await startedRepository();
    const firstTurn = {
      endMs: 2_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Первая подтвержденная реплика.",
      turnId: "turn-first",
    } as const;
    const secondTurn = {
      endMs: 4_000,
      speakerId: "speaker-b",
      startMs: 3_000,
      text: "Вторая подтвержденная реплика.",
      turnId: "turn-second",
    } as const;
    const append = new AppendLiveTranscriptTurn(meetings);
    const refresh = new RefreshLiveMeeting({
      meetings,
      projector: new RecordingProjector(),
      summarizer: new RecordingSummarizer(generatedSummary),
    });

    await append.execute("meeting-1", firstTurn);
    await refresh.execute({ captions: [], meetingId: "meeting-1", nowMs: 300_000 });
    await append.execute("meeting-1", secondTurn);
    await new FinishLiveMeeting(meetings).execute("meeting-1", 5_000);
    await refresh.execute({ captions: [], meetingId: "meeting-1", nowMs: 5_000 });

    expect(meetings.timeline).toEqual([
      expect.objectContaining({ isSummarized: true, turn: firstTurn }),
      expect.objectContaining({ isSummarized: true, turn: secondTurn }),
    ]);
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
    expect(meetings.snapshot).toMatchObject({ projectionExternalId: "thread-1" });
    expect(meetings.generationUsage).toEqual([
      expect.objectContaining({ model: "gpt-5.6-luna", totalTokens: 32 }),
    ]);
    expect(meetings.timeline.map(({ isSummarized, turn }) => ({
      isSummarized,
      turnId: turn.turnId,
    }))).toEqual([{ isSummarized: true, turnId: "turn-1" }]);
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
      previousSummaryEvidenceTurns: [{ turnId: "turn-1" }],
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
    await flushMicrotasks();
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
    expect(meetings.snapshot).toMatchObject({ projectionExternalId: "thread-1" });
    expect(meetings.timeline.map(({ isSummarized, turn }) => ({
      isSummarized,
      turnId: turn.turnId,
    }))).toEqual([{ isSummarized: true, turnId: "turn-1" }]);
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
    expect(projector.requests[0]).toMatchObject({
      phase: "finalizing",
      status: "ended",
    });
  });

  it("projects a finalizing phase without ending the aggregate", async () => {
    const meetings = await startedRepository();
    const append = new AppendLiveTranscriptTurn(meetings);
    const projector = new RecordingProjector();
    const refresh = new RefreshLiveMeeting({
      meetings,
      projector,
      summarizer: new RecordingSummarizer(generatedSummary),
    });

    await append.execute("meeting-1", {
      endMs: 2_000,
      speakerId: "speaker-a",
      startMs: 1_000,
      text: "Последняя видимая реплика.",
      turnId: "turn-before-finalizing",
    });
    await refresh.execute({
      captions: [{
        endMs: 2_000,
        isFinal: true,
        speakerId: "speaker-a",
        startMs: 1_000,
        text: "Последняя видимая реплика.",
      }],
      meetingId: "meeting-1",
      nowMs: 2_000,
      summaryGeneration: "skip",
    });

    await expect(refresh.execute({
      captions: [],
      meetingId: "meeting-1",
      nowMs: 3_000,
      projectionPhase: "finalizing",
      projectionRequested: false,
      summaryGeneration: "skip",
    })).resolves.toMatchObject({ projected: true });

    expect(projector.requests.at(-1)).toMatchObject({
      currentExternalPublicationId: "thread-1",
      phase: "finalizing",
      status: "active",
    });
    await expect(append.execute("meeting-1", {
      endMs: 4_000,
      speakerId: "speaker-a",
      startMs: 3_000,
      text: "Поздняя final-реплика.",
      turnId: "turn-after-finalizing",
    })).resolves.toBe("appended");
    expect(meetings.snapshot?.status).toBe("active");
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
    expect(projector.requests[0]).toMatchObject({
      elapsedMs: 25_000,
      phase: "finalizing",
      status: "ended",
    });
  });
