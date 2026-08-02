import { describe, expect, it } from "vitest";

import {
  fixtureManifestV1Schema,
  retainedE2eEvidenceV2Schema,
  verifyE2eCampaign,
  verifyRetainedE2eEvidence,
  type FixtureManifestV1,
  type RetainedE2eEvidenceV2,
} from "../src/e2e-evidence.js";

const speakerAId = "1533227577286852649";
const speakerBId = "1533228054724346087";
const speakerAText = "Спикер A обсуждает Meeting Platform и Craig recording";
const speakerBText = "Спикер B проверит Redis queue и idempotency key";

function manifest(): FixtureManifestV1 {
  return fixtureManifestV1Schema.parse({
    fixtureSetId: "fixture-v1",
    fixtures: [
      {
        actorName: "speaker-a",
        audioPath: "speaker-a.ogg",
        audioSha256: "c".repeat(64),
        durationMs: 7_000,
        fixtureId: "speaker-a",
        requiredTerms: ["Meeting Platform", "Craig recording"],
        sourcePath: "speaker-a.txt",
        sourceSha256: "a".repeat(64),
        sourceText: speakerAText,
        speakerId: speakerAId,
      },
      {
        actorName: "speaker-b",
        audioPath: "speaker-b.ogg",
        audioSha256: "d".repeat(64),
        durationMs: 7_000,
        fixtureId: "speaker-b",
        requiredTerms: ["Redis queue", "idempotency key"],
        sourcePath: "speaker-b.txt",
        sourceSha256: "b".repeat(64),
        sourceText: speakerBText,
        speakerId: speakerBId,
      },
    ],
    locale: "ru-RU",
    summaryExpectations: {
      actionItems: [{
        deadline: null,
        ownerSpeakerId: speakerBId,
        requiredTerms: ["очередь"],
      }],
      decisionTerms: ["Craig"],
      topicTerms: ["Meeting Platform"],
    },
    scenarios: [
      {
        expectOverlap: false,
        kind: "sequential",
        playbackCountByFixture: { "speaker-a": 1, "speaker-b": 1 },
        requireReconnect: false,
        speakerBDelayMs: 1_500,
      },
      {
        expectOverlap: true,
        kind: "overlap",
        playbackCountByFixture: { "speaker-a": 1, "speaker-b": 1 },
        requireReconnect: false,
        speakerBDelayMs: 750,
      },
      {
        expectOverlap: true,
        kind: "reconnect",
        playbackCountByFixture: { "speaker-a": 1, "speaker-b": 1 },
        requireReconnect: true,
        speakerBDelayMs: 500,
      },
    ],
    schemaVersion: 1,
    thresholds: {
      maxCharacterErrorRate: 0.2,
      maxWordErrorRate: 0.35,
      timestampToleranceMs: 500,
    },
  });
}

function overlapEvidence(): RetainedE2eEvidenceV2 {
  return retainedE2eEvidenceV2Schema.parse({
    actorRun: {
      events: [
        { actorName: "speaker-a", atRecordingMs: 0, type: "ready" },
        { actorName: "speaker-b", atRecordingMs: 0, type: "ready" },
        { actorName: "speaker-a", atRecordingMs: 100, fixtureId: "speaker-a", type: "playback-start" },
        { actorName: "speaker-b", atRecordingMs: 850, fixtureId: "speaker-b", type: "playback-start" },
        { actorName: "speaker-a", atRecordingMs: 7_100, fixtureId: "speaker-a", type: "playback-end" },
        { actorName: "speaker-b", atRecordingMs: 7_850, fixtureId: "speaker-b", type: "playback-end" },
      ],
      fixtureSetId: "fixture-v1",
      fixtures: [
        {
          audioSha256: "c".repeat(64),
          durationMs: 7_000,
          fixtureId: "speaker-a",
          sourceSha256: "a".repeat(64),
        },
        {
          audioSha256: "d".repeat(64),
          durationMs: 7_000,
          fixtureId: "speaker-b",
          sourceSha256: "b".repeat(64),
        },
      ],
      recordingId: "meeting-1",
      runId: "run-overlap-1",
      scenario: "overlap",
      schemaVersion: 1,
      timelineOrigin: "actor-run-start-correlated-to-recording-id",
    },
    deployment: {
      craig: {
        composeConfigHash: "3".repeat(64),
        composeProject: "craig-meeting-e2e",
        composeService: "bot",
        containerId: "4".repeat(64),
        containerStartedAt: "1969-12-31T23:00:00.000Z",
        imageId: `sha256:${"5".repeat(64)}`,
        repositoryDigest: null,
        sourceRevision: "6".repeat(40),
      },
      meetingPlatform: {
        composeConfigHash: "7".repeat(64),
        composeProject: "discord-meeting-assistant",
        composeService: "meeting-platform",
        containerId: "8".repeat(64),
        containerStartedAt: "1969-12-31T23:00:00.000Z",
        imageId: `sha256:${"9".repeat(64)}`,
        repositoryDigest: "registry.example/meeting-platform@sha256:" + "a".repeat(64),
        sourceRevision: "b".repeat(40),
      },
    },
    fixtureManifestVersion: 1,
    fixtureSetId: "fixture-v1",
    database: {
      matchingMeetingCount: 1,
      matchingRecordingCount: 1,
      matchingSummaryCount: 1,
      matchingTranscriptCount: 1,
    },
    fixtures: [
      {
        audioSha256: "c".repeat(64),
        codec: "opus",
        durationMs: 7_000,
        fixtureId: "speaker-a",
        sourceSha256: "a".repeat(64),
      },
      {
        audioSha256: "d".repeat(64),
        codec: "opus",
        durationMs: 7_000,
        fixtureId: "speaker-b",
        sourceSha256: "b".repeat(64),
      },
    ],
    meetingId: "meeting-1",
    publication: {
      embedDescription: [
        "## Задачи",
        `Ответственный: <@${speakerBId}>`,
        `Основание: **00:00-00:07 · <@${speakerAId}>:** «Релиз в пятницу»`,
        `Основание: **00:00-00:07 · <@${speakerBId}>:** «Проверить очередь»`,
      ].join("\n"),
      matchingMessageCount: 1,
      matchingThreadCount: 1,
      messageId: "message-1",
      threadId: "thread-1",
    },
    recording: {
      durationMs: 7_850,
      endedAt: "1970-01-01T00:00:07.850Z",
      recordingId: "meeting-1",
      s3: {
        manifestChecksumSha256: "e".repeat(64),
        manifestLocator: "s3://bucket/meeting-1/manifest.json",
        sourceChecksumSha256: "f".repeat(64),
        tracks: [
          {
            checksumSha256: "1".repeat(64),
            durationMs: 7_000,
            locator: "s3://bucket/meeting-1/a.ogg",
            sizeBytes: 1_000,
            speakerId: speakerAId,
            timelineOffsetMs: 100,
          },
          {
            checksumSha256: "2".repeat(64),
            durationMs: 7_750,
            locator: "s3://bucket/meeting-1/b.ogg",
            sizeBytes: 1_000,
            speakerId: speakerBId,
            timelineOffsetMs: 850,
          },
        ],
      },
      speakerIds: [speakerAId, speakerBId],
      startedAt: "1970-01-01T00:00:00.000Z",
    },
    replay: {
      matchingMeetingCount: 1,
      matchingMessageCount: 1,
      matchingRecordingCount: 1,
      matchingSummaryCount: 1,
      matchingThreadCount: 1,
      matchingTranscriptCount: 1,
      meetingId: "meeting-1",
      messageId: "message-1",
      recordingId: "meeting-1",
      replayJob: {
        afterProcessedOn: 2,
        beforeProcessedOn: 1,
        jobId: "post-call-job-1",
        state: "completed",
      },
      summaryId: "summary-1",
      threadId: "thread-1",
      transcriptId: "transcript-1",
    },
    schemaVersion: 2,
    stages: [
      { attempts: 1, stage: "transcription", status: "succeeded" },
      { attempts: 1, stage: "summary", status: "succeeded" },
      { attempts: 1, stage: "publication", status: "succeeded" },
    ],
    summary: {
      actionItems: [
        {
          actionItemId: "action-1",
          deadline: null,
          evidenceTurnIds: ["turn-b"],
          ownerSpeakerId: speakerBId,
          text: "Проверить очередь",
        },
      ],
      decisions: [{
        decisionId: "decision-1",
        evidenceTurnIds: ["turn-a"],
        text: "Использовать Craig",
      }],
      openQuestions: [{
        evidenceTurnIds: ["turn-b"],
        id: "question-1",
        text: "Нужен ли следующий этап?",
      }],
      overview: "Команда согласовала релиз и проверку очереди.",
      summaryId: "summary-1",
      title: "Итоги встречи",
      topics: [{
        evidenceTurnIds: ["turn-a"],
        points: ["Обсудили Meeting Platform"],
        title: "Архитектура",
      }],
      transcriptId: "transcript-1",
      version: 1,
    },
    transcript: {
      transcriptId: "transcript-1",
      turns: [
        { endMs: 7_100, speakerId: speakerAId, startMs: 100, text: speakerAText, turnId: "turn-a" },
        { endMs: 7_850, speakerId: speakerBId, startMs: 850, text: speakerBText, turnId: "turn-b" },
      ],
    },
  });
}

function sequentialEvidence(): RetainedE2eEvidenceV2 {
  const evidence = overlapEvidence();
  evidence.actorRun.scenario = "sequential";
  evidence.actorRun.events = [
    { actorName: "speaker-a", atRecordingMs: 0, type: "ready" },
    { actorName: "speaker-b", atRecordingMs: 0, type: "ready" },
    { actorName: "speaker-a", atRecordingMs: 100, fixtureId: "speaker-a", type: "playback-start" },
    { actorName: "speaker-a", atRecordingMs: 7_100, fixtureId: "speaker-a", type: "playback-end" },
    { actorName: "speaker-b", atRecordingMs: 8_600, fixtureId: "speaker-b", type: "playback-start" },
    { actorName: "speaker-b", atRecordingMs: 15_600, fixtureId: "speaker-b", type: "playback-end" },
  ];
  evidence.recording.durationMs = 15_600;
  const speakerAS3Track = evidence.recording.s3.tracks[0];
  const speakerBS3Track = evidence.recording.s3.tracks[1];
  const speakerBTurn = evidence.transcript.turns[1];
  if (speakerAS3Track === undefined || speakerBS3Track === undefined || speakerBTurn === undefined) {
    throw new Error("sequential fixtures are required");
  }
  evidence.recording.s3.tracks[0] = {
    ...speakerAS3Track,
    durationMs: 15_600,
    timelineOffsetMs: 0,
  };
  evidence.recording.s3.tracks[1] = {
    ...speakerBS3Track,
    durationMs: 15_600,
    timelineOffsetMs: 0,
  };
  evidence.transcript.turns[1] = {
    ...speakerBTurn,
    endMs: 15_600,
    startMs: 8_600,
  };
  return evidence;
}

function reconnectEvidence(): RetainedE2eEvidenceV2 {
  const evidence = overlapEvidence();
  evidence.actorRun.scenario = "reconnect";
  evidence.actorRun.events = [
    { actorName: "speaker-a", atRecordingMs: 0, type: "ready" },
    { actorName: "speaker-b", atRecordingMs: 0, type: "ready" },
    { actorName: "speaker-a", atRecordingMs: 100, fixtureId: "speaker-a", type: "playback-start" },
    { actorName: "speaker-b", atRecordingMs: 600, type: "disconnected" },
    { actorName: "speaker-b", atRecordingMs: 1_100, type: "ready" },
    { actorName: "speaker-b", atRecordingMs: 1_200, fixtureId: "speaker-b", type: "playback-start" },
    { actorName: "speaker-a", atRecordingMs: 7_100, fixtureId: "speaker-a", type: "playback-end" },
    { actorName: "speaker-b", atRecordingMs: 8_200, fixtureId: "speaker-b", type: "playback-end" },
  ];
  evidence.recording.durationMs = 8_200;
  const speakerBS3Track = evidence.recording.s3.tracks[1];
  const turnB = evidence.transcript.turns[1];
  if (speakerBS3Track === undefined || turnB === undefined) {
    throw new Error("speaker-b reconnect fixtures are required");
  }
  evidence.recording.s3.tracks[1] = {
    ...speakerBS3Track,
    durationMs: 8_100,
    timelineOffsetMs: 100,
  };
  evidence.transcript.turns[1] = {
    ...turnB,
    endMs: 8_200,
    startMs: 1_200,
    text: speakerBText,
  };
  return evidence;
}

function reidentify(
  source: RetainedE2eEvidenceV2,
  suffix: string,
): RetainedE2eEvidenceV2 {
  const evidence = structuredClone(source);
  evidence.actorRun.runId = `run-${suffix}`;
  evidence.actorRun.recordingId = `meeting-${suffix}`;
  evidence.meetingId = `meeting-${suffix}`;
  evidence.recording.recordingId = `meeting-${suffix}`;
  evidence.recording.s3.manifestLocator = `s3://bucket/meeting-${suffix}/manifest.json`;
  evidence.transcript.transcriptId = `transcript-${suffix}`;
  evidence.summary.summaryId = `summary-${suffix}`;
  evidence.summary.transcriptId = `transcript-${suffix}`;
  evidence.publication.threadId = `thread-${suffix}`;
  evidence.publication.messageId = `message-${suffix}`;
  evidence.replay.meetingId = `meeting-${suffix}`;
  evidence.replay.recordingId = `meeting-${suffix}`;
  evidence.replay.transcriptId = `transcript-${suffix}`;
  evidence.replay.summaryId = `summary-${suffix}`;
  evidence.replay.threadId = `thread-${suffix}`;
  evidence.replay.messageId = `message-${suffix}`;
  evidence.replay.replayJob.jobId = `job-${suffix}`;
  return evidence;
}

describe("verifyRetainedE2eEvidence", () => {
  it("accepts accurate speaker, timing, overlap, evidence and replay proof", () => {
    const verification = verifyRetainedE2eEvidence(manifest(), overlapEvidence());

    expect(verification).toEqual({
      failures: [],
      metrics: [
        { characterErrorRate: 0, speakerId: speakerAId, wordErrorRate: 0 },
        { characterErrorRate: 0, speakerId: speakerBId, wordErrorRate: 0 },
      ],
      passed: true,
    });
  });

  it("uses the shared Craig media origin once for cooked track durations", () => {
    const evidence = overlapEvidence();

    expect(evidence.recording.s3.tracks).toMatchObject([
      { durationMs: 7_000, timelineOffsetMs: 100 },
      { durationMs: 7_750, timelineOffsetMs: 850 },
    ]);
    expect(evidence.recording.durationMs).toBe(7_850);
    expect(verifyRetainedE2eEvidence(manifest(), evidence).passed).toBe(true);
  });

  it("rejects inaccurate transcription and missing required terminology", () => {
    const evidence = overlapEvidence();
    const turnB = evidence.transcript.turns[1];
    if (turnB === undefined) {
      throw new Error("speaker-b fixture turn is required");
    }
    evidence.transcript.turns[1] = {
      ...turnB,
      text: "Неразборчивая короткая фраза",
    };

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining(["WER_EXCEEDED", "CER_EXCEEDED", "TERM_MISSING"]));
  });

  it("treats the fixed spoken Russian date and its numeric STT form as equivalent", () => {
    const dateManifest = manifest();
    const speakerAFixture = dateManifest.fixtures[0];
    if (speakerAFixture === undefined) {
      throw new Error("speaker-a manifest fixture is required");
    }
    speakerAFixture.sourceText =
      "Проверить Discord thread до седьмого августа две тысячи двадцать шестого года";
    speakerAFixture.requiredTerms = ["Discord thread", "августа", "2026"];

    const evidence = overlapEvidence();
    const speakerATurn = evidence.transcript.turns[0];
    if (speakerATurn === undefined) {
      throw new Error("speaker-a transcript turn is required");
    }
    evidence.transcript.turns[0] = {
      ...speakerATurn,
      text: "Проверить Discord thread до 7 августа 2026 года",
    };

    const verification = verifyRetainedE2eEvidence(dateManifest, evidence);
    const speakerAMetrics = verification.metrics.find(({ speakerId }) => speakerId === speakerAId);

    expect(speakerAMetrics).toEqual({
      characterErrorRate: 0,
      speakerId: speakerAId,
      wordErrorRate: 0,
    });
    expect(verification.failures.map(({ code }) => code)).not.toContain("TERM_MISSING");
  });

  it("accepts mixed numeric and spoken dates in transcripts and summary deadlines", () => {
    const dateManifest = manifest();
    const speakerAFixture = dateManifest.fixtures[0];
    if (speakerAFixture === undefined) {
      throw new Error("speaker-a manifest fixture is required");
    }
    speakerAFixture.sourceText =
      "Проверить Discord thread до седьмого августа две тысячи двадцать шестого года";
    speakerAFixture.requiredTerms = ["Discord thread", "августа", "2026"];
    dateManifest.summaryExpectations.actionItems = [{
      deadline: "до 7 августа 2026 года",
      ownerSpeakerId: speakerBId,
      requiredTerms: ["очередь"],
    }];

    const evidence = overlapEvidence();
    const speakerATurn = evidence.transcript.turns[0];
    const actionItem = evidence.summary.actionItems[0];
    if (speakerATurn === undefined || actionItem === undefined) {
      throw new Error("speaker-a turn and action item are required");
    }
    evidence.transcript.turns[0] = {
      ...speakerATurn,
      text: "Проверить Discord thread до 7 августа две тысячи двадцать шестого года",
    };
    evidence.summary.actionItems[0] = {
      ...actionItem,
      deadline: "до 7 августа две тысячи двадцать шестого года",
    };

    const verification = verifyRetainedE2eEvidence(dateManifest, evidence);

    expect(verification.failures.map(({ code }) => code)).not.toEqual(
      expect.arrayContaining(["TERM_MISSING", "ACTION_SEMANTICS_MISSING"]),
    );
  });

  it("still fails required year evidence when STT loses 2026", () => {
    const dateManifest = manifest();
    const speakerAFixture = dateManifest.fixtures[0];
    if (speakerAFixture === undefined) {
      throw new Error("speaker-a manifest fixture is required");
    }
    speakerAFixture.sourceText =
      "Проверить Discord thread до седьмого августа две тысячи двадцать шестого года";
    speakerAFixture.requiredTerms = ["Discord thread", "августа", "2026"];

    const evidence = overlapEvidence();
    const speakerATurn = evidence.transcript.turns[0];
    if (speakerATurn === undefined) {
      throw new Error("speaker-a transcript turn is required");
    }
    evidence.transcript.turns[0] = {
      ...speakerATurn,
      text: "Проверить Discord thread до 7 августа года",
    };

    const codes = verifyRetainedE2eEvidence(dateManifest, evidence).failures.map(({ code }) => code);

    expect(codes).toContain("TERM_MISSING");
  });

  it("rejects missing evidence turns and duplicate replay effects", () => {
    const evidence = overlapEvidence();
    const decision = evidence.summary.decisions[0];
    if (decision === undefined) {
      throw new Error("summary decision fixture is required");
    }
    evidence.summary.decisions[0] = {
      ...decision,
      evidenceTurnIds: ["invented-turn"],
    };
    evidence.replay.matchingMessageCount = 2;
    evidence.replay.threadId = "duplicate-thread";

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining([
      "UNKNOWN_EVIDENCE_TURN",
      "DUPLICATE_BUSINESS_EFFECT",
      "REPLAY_IDENTITY_CHANGED",
    ]));
  });

  it("requires the complete summary contract and validates open-question evidence", () => {
    const evidence = overlapEvidence();
    const question = evidence.summary.openQuestions[0];
    if (question === undefined) {
      throw new Error("summary open-question fixture is required");
    }
    evidence.summary.openQuestions[0] = {
      ...question,
      evidenceTurnIds: ["invented-question-turn"],
    };
    evidence.summary.transcriptId = "different-transcript";

    const failures = verifyRetainedE2eEvidence(manifest(), evidence).failures;

    expect(failures).toContainEqual({
      code: "UNKNOWN_EVIDENCE_TURN",
      message: "open question references missing turn invented-question-turn",
    });
    expect(failures.map(({ code }) => code)).toContain("SUMMARY_TRANSCRIPT_MISMATCH");

    const incomplete = structuredClone(evidence) as unknown as {
      summary: { overview?: string };
    };
    delete incomplete.summary.overview;
    expect(retainedE2eEvidenceV2Schema.safeParse(incomplete).success).toBe(false);
  });

  it("requires initial ready, reconnect during speaker A, then one playback", () => {
    const evidence = reconnectEvidence();

    expect(verifyRetainedE2eEvidence(manifest(), evidence).passed).toBe(true);

    const initialReadyIndex = evidence.actorRun.events.findIndex(
      (event) => event.actorName === "speaker-b" && event.type === "ready",
    );
    if (initialReadyIndex < 0) {
      throw new Error("speaker-b initial ready event is required");
    }
    evidence.actorRun.events.splice(initialReadyIndex, 1);
    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);
    expect(codes).toContain("RECONNECT_SEQUENCE_INVALID");
  });

  it("rejects reconnect evidence bound to a different recording", () => {
    const evidence = reconnectEvidence();
    evidence.actorRun.recordingId = "different-recording";

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("ACTOR_RECORDING_CORRELATION_MISMATCH");
  });

  it("rejects speaker B playback beginning before reconnect ready", () => {
    const evidence = reconnectEvidence();
    const reconnectReadyIndex = evidence.actorRun.events.findIndex(
      (event, index) => index > 1 && event.actorName === "speaker-b" && event.type === "ready",
    );
    const reconnectReady = evidence.actorRun.events[reconnectReadyIndex];
    if (reconnectReady === undefined) {
      throw new Error("speaker-b reconnect ready event is required");
    }
    evidence.actorRun.events[reconnectReadyIndex] = {
      ...reconnectReady,
      atRecordingMs: 1_300,
    };

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("RECONNECT_SEQUENCE_INVALID");
  });

  it("rejects reconnect completion outside the continuing speaker A playback", () => {
    const evidence = reconnectEvidence();
    const readyIndex = evidence.actorRun.events.findIndex(
      (event, index) => index > 1 && event.actorName === "speaker-b" && event.type === "ready",
    );
    const ready = evidence.actorRun.events[readyIndex];
    if (ready === undefined) {
      throw new Error("speaker-b reconnect ready event is required");
    }
    evidence.actorRun.events[readyIndex] = { ...ready, atRecordingMs: 7_200 };

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("RECONNECT_NOT_DURING_SPEAKER_A");
  });

  it("accepts sequential Craig tracks with offset zero and retained initial silence", () => {
    expect(verifyRetainedE2eEvidence(manifest(), sequentialEvidence()).passed).toBe(true);
  });

  it("compares sequential transcript speech to actor playback instead of silent S3 origin", () => {
    const evidence = sequentialEvidence();
    const speakerBTurn = evidence.transcript.turns[1];
    if (speakerBTurn === undefined) {
      throw new Error("speaker-b sequential turn is required");
    }
    evidence.transcript.turns[1] = {
      ...speakerBTurn,
      startMs: 0,
    };

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("START_TIMESTAMP_MISMATCH");
  });

  it("rejects an actor playback window extending beyond its silent S3 track", () => {
    const evidence = sequentialEvidence();
    const speakerBTrack = evidence.recording.s3.tracks[1];
    if (speakerBTrack === undefined) {
      throw new Error("speaker-b sequential track is required");
    }
    evidence.recording.s3.tracks[1] = {
      ...speakerBTrack,
      durationMs: 8_000,
    };

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("ACTOR_S3_TIMELINE_MISMATCH");
  });

  it("uses the single post-reconnect playback window as transcript bounds", () => {
    const lateStart = reconnectEvidence();
    const lateStartTurn = lateStart.transcript.turns[1];
    if (lateStartTurn === undefined) {
      throw new Error("speaker-b reconnect turn is required");
    }
    lateStart.transcript.turns[1] = { ...lateStartTurn, startMs: 2_500 };
    expect(
      verifyRetainedE2eEvidence(manifest(), lateStart).failures.map(({ code }) => code),
    ).toContain("START_TIMESTAMP_MISMATCH");

    const earlyEnd = reconnectEvidence();
    const earlyEndTurn = earlyEnd.transcript.turns[1];
    if (earlyEndTurn === undefined) {
      throw new Error("speaker-b reconnect turn is required");
    }
    earlyEnd.transcript.turns[1] = { ...earlyEndTurn, endMs: 7_600 };
    expect(
      verifyRetainedE2eEvidence(manifest(), earlyEnd).failures.map(({ code }) => code),
    ).toContain("END_TIMESTAMP_MISMATCH");
  });

  it("rejects internal Discord identifiers and missing human-readable UX evidence", () => {
    const evidence = overlapEvidence();
    evidence.publication.embedDescription =
      `turn:v1:hidden meeting-projection:raw ${evidence.summary.summaryId}`;

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toEqual(expect.arrayContaining([
      "DISCORD_ACTION_OWNER_MENTION_MISSING",
      "DISCORD_EVIDENCE_INTERVAL_MISSING",
      "DISCORD_EVIDENCE_LABEL_MISSING",
      "DISCORD_INTERNAL_ID_VISIBLE",
      "DISCORD_SPEAKER_MENTION_MISSING",
    ]));
  });

  it("rejects provenance captured from containers deployed after the recording began", () => {
    const evidence = overlapEvidence();
    evidence.deployment.craig.containerStartedAt = "1970-01-01T00:00:01.000Z";

    const codes = verifyRetainedE2eEvidence(manifest(), evidence).failures.map(({ code }) => code);

    expect(codes).toContain("DEPLOYMENT_STARTED_AFTER_RECORDING");
  });

  it("requires all scenarios and isolated identities across the campaign", () => {
    const runs = [
      reidentify(sequentialEvidence(), "sequential"),
      reidentify(overlapEvidence(), "overlap"),
      reidentify(reconnectEvidence(), "reconnect"),
    ];

    expect(verifyE2eCampaign(manifest(), runs).passed).toBe(true);

    runs[2]!.publication.threadId = runs[1]!.publication.threadId;
    runs[2]!.replay.threadId = runs[1]!.replay.threadId;
    const failed = verifyE2eCampaign(manifest(), runs);
    expect(failed.failures.map(({ code }) => code)).toContain("CAMPAIGN_STATE_LEAK");
  });

  it("requires identical immutable deployment provenance across campaign runs", () => {
    const runs = [
      reidentify(sequentialEvidence(), "sequential"),
      reidentify(overlapEvidence(), "overlap"),
      reidentify(reconnectEvidence(), "reconnect"),
    ];
    runs[2]!.deployment.meetingPlatform.imageId = `sha256:${"c".repeat(64)}`;

    const codes = verifyE2eCampaign(manifest(), runs).failures.map(({ code }) => code);

    expect(codes).toContain("CAMPAIGN_DEPLOYMENT_CHANGED");
  });
});
