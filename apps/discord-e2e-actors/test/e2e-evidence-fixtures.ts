import {
  fixtureManifestV1Schema,
  retainedE2eEvidenceV2Schema,
  retainedE2eEvidenceV3Schema,
  retainedE2eEvidenceV4Schema,
  retainedE2eEvidenceV5Schema,
  retainedE2eEvidenceV6Schema,
  retainedE2eEvidenceV7Schema,
  verifyE2eCampaign as verifyE2eCampaignAgainstExpectedRevision,
  verifyRetainedE2eEvidence as verifyRetainedE2eEvidenceAgainstExpectedRevision,
  type DeploymentRevisionExpectation,
  type FixtureManifestV1,
  type RetainedE2eEvidenceV2,
  type RetainedE2eEvidenceV3,
  type RetainedE2eEvidenceV4,
  type RetainedE2eEvidenceV5,
  type RetainedE2eEvidenceV6,
  type RetainedE2eEvidenceV7,
} from "../src/e2e-evidence.js";

export const speakerAId = "1533227577286852649";
export const speakerBId = "1533228054724346087";
const speakerAText = "Спикер A обсуждает Meeting Platform и Craig recording";
const speakerBText = "Спикер B проверит Redis queue и idempotency key";
export const expectedRevisions: DeploymentRevisionExpectation =
  { craig: "6".repeat(40), meetingPlatform: "b".repeat(40) };
export const currentExpectedRevisions: DeploymentRevisionExpectation = {
  ...expectedRevisions,
  pipecat: "7".repeat(40),
  subscriptionRuntime: "e".repeat(40),
};

export function verifyRetainedE2eEvidence(
  fixtureManifest: FixtureManifestV1,
  evidence: RetainedE2eEvidenceV2 | RetainedE2eEvidenceV3,
) {
  return verifyRetainedE2eEvidenceAgainstExpectedRevision(
    fixtureManifest,
    evidence,
    expectedRevisions,
  );
}
export function verifyE2eCampaign(
  fixtureManifest: FixtureManifestV1,
  runs: readonly (RetainedE2eEvidenceV2 | RetainedE2eEvidenceV3)[],
) {
  return verifyE2eCampaignAgainstExpectedRevision(fixtureManifest, runs, expectedRevisions);
}

export function manifest(): FixtureManifestV1 {
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
        requiredTerms: ["Redis queue", "idempotency key"],
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

export function overlapEvidence(): RetainedE2eEvidenceV2 {
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
          text: "Проверить Redis queue и idempotency key",
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

export function directMessageEvidence(source: RetainedE2eEvidenceV2): RetainedE2eEvidenceV3 {
  return retainedE2eEvidenceV3Schema.parse({
    ...source,
    publication: {
      container: {
        kind: "channel-message",
        parentChannelId: "1533228891827736657",
      },
      embedDescription: source.publication.embedDescription.replaceAll("Основание: ", ""),
      matchingMessageCount: source.publication.matchingMessageCount,
      matchingThreadCount: 0,
      messageId: source.publication.messageId,
    },
    replay: {
      container: {
        kind: "channel-message",
        parentChannelId: "1533228891827736657",
      },
      matchingMeetingCount: source.replay.matchingMeetingCount,
      matchingMessageCount: source.replay.matchingMessageCount,
      matchingRecordingCount: source.replay.matchingRecordingCount,
      matchingSummaryCount: source.replay.matchingSummaryCount,
      matchingThreadCount: 0,
      matchingTranscriptCount: source.replay.matchingTranscriptCount,
      meetingId: source.replay.meetingId,
      messageId: source.replay.messageId,
      recordingId: source.replay.recordingId,
      replayJob: source.replay.replayJob,
      summaryId: source.replay.summaryId,
      transcriptId: source.replay.transcriptId,
    },
    schemaVersion: 3,
  });
}

export function sequentialEvidence(): RetainedE2eEvidenceV2 {
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

export function reconnectEvidence(): RetainedE2eEvidenceV2 {
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

export function reidentify(
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

export function retainedV4Evidence(): RetainedE2eEvidenceV4 {
  const source = directMessageEvidence(overlapEvidence());
  return retainedE2eEvidenceV4Schema.parse({
    ...source,
    deployment: {
      ...source.deployment,
      subscriptionRuntime: {
        composeConfigHash: "c".repeat(64),
        composeProject: "discord-meeting-assistant",
        composeService: "subscription-runtime-sidecar",
        containerId: "d".repeat(64),
        containerStartedAt: "1969-12-31T23:00:00.000Z",
        imageId: `sha256:${"e".repeat(64)}`,
        repositoryDigest: null,
        sourceRevision: "e".repeat(40),
      },
    },
    processing: {
      stages: [
        { durationMs: 2_000, observedAt: "1970-01-01T00:00:08.000Z", outcome: "succeeded", stage: "transcription" },
        { durationMs: 5_000, observedAt: "1970-01-01T00:00:13.000Z", outcome: "succeeded", stage: "summary" },
        { durationMs: 500, observedAt: "1970-01-01T00:00:13.500Z", outcome: "succeeded", stage: "publication" },
      ],
      summaryRuntimeExecutions: [{
        durationMs: 4_900,
        model: "gpt-5.6-sol",
        observedAt: "1970-01-01T00:00:12.900Z",
        outputSchemaName: "discord_meeting_summary_v4",
        policyVersion: "meeting-summary.subscription-runtime.v15",
        purpose: "discord_meeting.summary.generate",
        reasoningEffort: "medium",
        runId: "summary-run-v4",
        status: "completed",
      }],
    },
    schemaVersion: 4,
  });
}

export function retainedV5Evidence(): RetainedE2eEvidenceV5 {
  const source = retainedV4Evidence();
  return retainedE2eEvidenceV5Schema.parse({
    ...source,
    deployment: {
      ...source.deployment,
      pipecat: deployedService(
        "discord-meeting-assistant",
        "pipecat-runtime",
        "1",
        "2",
        "7",
      ),
    },
    schemaVersion: 5,
  });
}

export function retainedV6Evidence(): RetainedE2eEvidenceV6 {
  const source = retainedV5Evidence();
  const attachments = [
    { filename: "meeting-summary.md", sizeBytes: 2_048 },
    { filename: "meeting-transcript.md", sizeBytes: 4_096 },
  ];
  return retainedE2eEvidenceV6Schema.parse({
    ...source,
    publication: { ...source.publication, attachments },
    replay: { ...source.replay, attachments },
    schemaVersion: 6,
  });
}

export function retainedV7Evidence(): RetainedE2eEvidenceV7 {
  const source = retainedV6Evidence();
  source.actorRun.scenario = "reconnect";
  source.actorRun.events = [
    { actorName: "speaker-a", atRecordingMs: 0, type: "ready" },
    { actorName: "speaker-b", atRecordingMs: 0, type: "ready" },
    { actorName: "speaker-a", atRecordingMs: 100, fixtureId: "speaker-a", type: "playback-start" },
    { actorName: "speaker-b", atRecordingMs: 750, type: "disconnected" },
    { actorName: "speaker-b", atRecordingMs: 800, type: "ready" },
    { actorName: "speaker-b", atRecordingMs: 850, fixtureId: "speaker-b", type: "playback-start" },
    { actorName: "speaker-a", atRecordingMs: 7_100, fixtureId: "speaker-a", type: "playback-end" },
    { actorName: "speaker-b", atRecordingMs: 7_850, fixtureId: "speaker-b", type: "playback-end" },
  ];
  const botSpeakerId = "1534231284467896512";
  source.recording.speakerIds.push(botSpeakerId);
  source.recording.s3.tracks.push({
    checksumSha256: "4".repeat(64), durationMs: source.recording.durationMs,
    locator: "s3://bucket/meeting-1/botik.ogg", sizeBytes: 2_000,
    speakerId: botSpeakerId, timelineOffsetMs: 0,
  });
  source.transcript.turns.push({
    endMs: 7_200, speakerId: botSpeakerId, startMs: 6_200,
    text: "Synthetic addressed answer", turnId: "botik-answer-1",
  });
  const events = [
    { greetingLocale: "ru", observedAt: "1970-01-01T00:00:01.500Z", participantId: speakerAId, participantNameStatus: "known", turnId: `participant-greeting:${speakerAId}`, type: "greeting" as const },
    { greetingLocale: "en", observedAt: "1970-01-01T00:00:00.700Z", participantId: speakerBId, participantNameStatus: "known", turnId: `participant-greeting:${speakerBId}`, type: "greeting" as const },
    { greetingLocale: "ru", observedAt: "1970-01-01T00:00:03.500Z", participantId: "3533228054724346087", participantNameStatus: "unknown", turnId: "participant-greeting:3533228054724346087", type: "greeting" as const },
    { evidenceTurnIds: ["turn-a"], locale: "ru", observedAt: "1970-01-01T00:00:05.500Z", playbackAttemptId: "farewell-attempt-1", reason: "explicit-group", turnId: "meeting-farewell:v1" as const, type: "farewell" as const },
  ];
  return retainedE2eEvidenceV7Schema.parse({
    ...source,
    conversation: {
      botSpeakerId,
      lifecycle: { events },
      voice: [
        voiceObservation("greeting", `participant-greeting:${speakerAId}`, "greeting-ru", 1_000),
        voiceObservation("greeting", `participant-greeting:${speakerBId}`, "greeting-en", 200),
        voiceObservation("greeting", "participant-greeting:3533228054724346087", "greeting-unknown", 3_000),
        voiceObservation("farewell", "meeting-farewell:v1", "farewell", 5_000),
        voiceObservation("addressed-answer", "human-question-1", "answer", 6_100),
      ],
    },
    schemaVersion: 7,
  });
}

function voiceObservation(
  purpose: "addressed-answer" | "farewell" | "greeting",
  turnId: string,
  attemptId: string,
  startMs: number,
) {
  return {
    capture: {
      acceptedDurationMilliseconds: 500, acceptedPacketCount: 25,
      cancellation: { status: "not-observed" as const }, endedAt: captureTimestamp(startMs + 500),
      expectedDuration: { maximumMilliseconds: 600, minimumMilliseconds: 500 },
      firstPacketAt: captureTimestamp(startMs), ignoredDuplicatePacketCount: 0, ignoredLatePacketCount: 0,
      limits: { captureTimeoutMilliseconds: 2_000, maxCaptureDurationMilliseconds: 60_000, maxPcmBytes: 11_520_000 },
      pcm: {
        byteLength: 96_000, channels: 2 as const, encoding: "s16le" as const,
        nonSilence: { sampleCount: 48_000, sampleCountAboveThreshold: 4_800, sampleRatioAboveThreshold: 0.1, thresholdSample: 256 },
        rms: 512, sampleRateHertz: 48_000 as const, sha256: "a".repeat(64),
      },
      startedAt: captureTimestamp(startMs - 100), termination: "expected-duration-reached" as const,
    },
    correlation: { attemptId, provenance: "operator-supplied" as const, purpose, recordingId: "meeting-1", verification: "not-run" as const, turnId },
    kind: "conversation-voice-observer-evidence" as const,
    observer: { applicationId: "1534222222222222222", authenticatedBotId: "1534222222222222222", guildId: "1533228590643155034", privateTestGuildConfirmed: true as const, voiceChannelId: "1533228823045214398" },
    runId: "run-overlap-1", schemaVersion: 3 as const,
    source: { codec: "opus" as const, craigBotId: "1534231284467896512", decodedPcm: { channels: 2 as const, encoding: "s16le" as const, sampleRateHertz: 48_000 as const }, receiver: "@discordjs/voice" as const },
    transcriptVerification: { status: "not-run" as const },
  };
}

function captureTimestamp(epochMilliseconds: number) {
  return { epochMilliseconds, monotonicMilliseconds: epochMilliseconds };
}

function deployedService(
  composeProject: string,
  composeService: string,
  containerDigit: string,
  imageDigit: string,
  revisionDigit: string,
) {
  return {
    composeConfigHash: "3".repeat(64),
    composeProject,
    composeService,
    containerId: containerDigit.repeat(64),
    containerStartedAt: "1969-12-31T23:00:00.000Z",
    imageId: `sha256:${imageDigit.repeat(64)}`,
    repositoryDigest: null,
    sourceRevision: revisionDigit.repeat(40),
  };
}
