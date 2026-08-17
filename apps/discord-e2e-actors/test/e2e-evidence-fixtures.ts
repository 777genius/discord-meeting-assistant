import {
  fixtureManifestV1Schema,
  retainedE2eEvidenceV2Schema,
  retainedE2eEvidenceV3Schema,
  retainedE2eEvidenceV4Schema,
  retainedE2eEvidenceV5Schema,
  retainedE2eEvidenceV6Schema,
  retainedE2eEvidenceV7Schema,
  retainedReconnectE2eEvidenceV8Schema,
  verifyRetainedE2eEvidence as verifyRetainedE2eEvidenceAgainstExpectedRevision,
  type DeploymentRevisionExpectation,
  type FixtureManifestV1,
  type RetainedE2eEvidence,
  type RetainedE2eEvidenceV2,
  type RetainedE2eEvidenceV3,
  type RetainedE2eEvidenceV4,
  type RetainedE2eEvidenceV5,
  type RetainedE2eEvidenceV6,
  type RetainedE2eEvidenceV7,
  type RetainedReconnectE2eEvidenceV8,
} from "../src/e2e-evidence.js";
import {
  deployedService,
  voiceObservation,
} from "./e2e-evidence-voice-fixture-support.js";

export const speakerAId = "1533227577286852649";
export const speakerBId = "1533228054724346087";
const speakerDId = "1533873978417086474", observerId = "1533867700575670282";
const speakerAText = "Спикер A обсуждает Meeting Platform и Craig recording";
const speakerBText = "Спикер B проверит Redis queue и idempotency key";
export const expectedRevisions: DeploymentRevisionExpectation = { craig: "6".repeat(40), meetingPlatform: "b".repeat(40) };
export const currentExpectedRevisions: DeploymentRevisionExpectation =
  { ...expectedRevisions, pipecat: "7".repeat(40), subscriptionRuntime: "e".repeat(40) };
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

export function manifest(): FixtureManifestV1 {
  return fixtureManifestV1Schema.parse({
    allowedBotSpeakerIds: ["1533877611258708230", speakerDId],
    conversationVoiceExpectation: {
      botSpeakerId: "1533877611258708230",
      guildId: "1533228590643155034",
      observerApplicationId: observerId,
      observerGreetingLocale: "ru",
      voiceChannelId: "1533228823045214398",
    },
    greetingLocaleTerms: { en: ["hi", "hello", "хай"], ru: ["привет", "здравствуй"] },
    farewellCapturePcmSha256: { en: "e".repeat(64), ru: "a".repeat(64) },
    farewellExactPhrases: { en: ["Goodbye!"], ru: ["Пока!"] },
    farewellLocaleTerms: { en: ["bye", "goodbye"], ru: ["пока", "до встречи"] },
    supplementalVoiceExpectation: {
      answerNonce: "кобальт",
      applicationId: speakerDId,
      durationMs: 4_000,
      farewellLocale: "ru",
      fixtureSha256: "9".repeat(64),
      greetingLocale: "ru",
      requiredFarewellTerms: ["всем", "пока"],
      requiredQuestionTerms: ["ботик", "кобальт"],
    },
    fixtureSetId: "fixture-v1",
    fixtures: [
      {
        actorName: "speaker-a",
        audioPath: "speaker-a.ogg",
        audioSha256: "c".repeat(64),
        durationMs: 7_000,
        fixtureId: "speaker-a",
        greetingLocale: "ru",
        greetingNameStatus: "known",
        greetingSpokenToken: "Тест А",
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
        greetingLocale: "en",
        greetingNameStatus: "known",
        greetingSpokenToken: "Test B",
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

export function reidentify<T extends RetainedE2eEvidence>(source: T, suffix: string): T {
  const evidence = structuredClone(source);
  evidence.actorRun.runId = `run-${suffix}`;
  evidence.actorRun.recordingId = `meeting-${suffix}`;
  evidence.meetingId = `meeting-${suffix}`;
  evidence.recording.recordingId = `meeting-${suffix}`;
  if ("recordingPlayback" in evidence && evidence.recordingPlayback !== undefined) {
    evidence.recordingPlayback.manifest.recordingId = `meeting-${suffix}`;
    evidence.recordingPlayback.resume.recordingId = `meeting-${suffix}`;
  }
  evidence.recording.s3.manifestLocator = `s3://bucket/meeting-${suffix}/manifest.json`;
  evidence.transcript.transcriptId = `transcript-${suffix}`;
  evidence.summary.summaryId = `summary-${suffix}`;
  evidence.summary.transcriptId = `transcript-${suffix}`;
  evidence.publication.messageId = `message-${suffix}`;
  if ("threadId" in evidence.publication) {
    evidence.publication.threadId = `thread-${suffix}`;
  } else if (evidence.publication.container.kind === "thread") {
    evidence.publication.container.threadId = `thread-${suffix}`;
  }
  evidence.replay.meetingId = `meeting-${suffix}`;
  evidence.replay.recordingId = `meeting-${suffix}`;
  evidence.replay.transcriptId = `transcript-${suffix}`;
  evidence.replay.summaryId = `summary-${suffix}`;
  evidence.replay.messageId = `message-${suffix}`;
  evidence.replay.replayJob.jobId = `job-${suffix}`;
  if ("threadId" in evidence.replay) {
    evidence.replay.threadId = `thread-${suffix}`;
  } else if (evidence.replay.container.kind === "thread") {
    evidence.replay.container.threadId = `thread-${suffix}`;
  }
  if ("conversation" in evidence) {
    evidence.conversation.voice = evidence.conversation.voice.map((observation) => ({
      ...observation,
      correlation: {
        ...observation.correlation,
        ...(observation.correlation.provenance === "playback-readiness-handshake"
          ? { meetingId: `meeting-${suffix}` }
          : {}),
        recordingId: `meeting-${suffix}`,
      },
      runId: `run-${suffix}`,
    }));
    if ("supplementalPlayback" in evidence.conversation) {
      evidence.conversation.supplementalPlayback = {
        ...evidence.conversation.supplementalPlayback,
        runId: `run-${suffix}`,
      };
    }
  }
  return evidence;
}

export function retainedV4Evidence(
  baseEvidence: RetainedE2eEvidenceV2 = overlapEvidence(),
): RetainedE2eEvidenceV4 {
  const source = directMessageEvidence(baseEvidence);
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

export function retainedV5Evidence(
  baseEvidence: RetainedE2eEvidenceV2 = overlapEvidence(),
): RetainedE2eEvidenceV5 {
  const source = retainedV4Evidence(baseEvidence);
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

export function retainedV6Evidence(
  baseEvidence: RetainedE2eEvidenceV2 = overlapEvidence(),
): RetainedE2eEvidenceV6 {
  const source = retainedV5Evidence(baseEvidence);
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

export function retainedV8Evidence(): RetainedReconnectE2eEvidenceV8 {
  const source = retainedV6Evidence();
  source.recordingPlayback = {
    capabilitySha256: "6".repeat(64),
    link: {
      origin: "https://recordings.example.test",
      pathname: "/recordings/playback",
    },
    manifest: {
      readinessExpectation: "transition",
      recordingId: source.recording.recordingId,
      statuses: ["processing", "ready"],
    },
    resume: {
      manifestStatus: "ready",
      recordingId: source.recording.recordingId,
      statusCode: 200,
    },
    tracks: source.recording.s3.tracks.map((track, index) => ({
      checksumSha256: track.checksumSha256,
      contentLength: track.sizeBytes,
      contentRange: `bytes 0-${track.sizeBytes - 1}/${track.sizeBytes}`,
      index,
      statusCode: 206,
    })),
  };
  source.actorRun.scenario = "reconnect";
  source.actorRun.events = [
    { actorName: "speaker-a", atRecordingMs: 0, type: "ready" },
    { actorName: "speaker-b", atRecordingMs: 0, type: "ready" },
    { actorName: "speaker-a", atRecordingMs: 1_600, fixtureId: "speaker-a", type: "playback-start" },
    { actorName: "speaker-b", atRecordingMs: 2_100, type: "disconnected" },
    { actorName: "speaker-b", atRecordingMs: 2_200, type: "ready" },
    { actorName: "speaker-b", atRecordingMs: 2_300, fixtureId: "speaker-b", type: "playback-start" },
    { actorName: "speaker-a", atRecordingMs: 8_600, fixtureId: "speaker-a", type: "playback-end" },
    { actorName: "speaker-b", atRecordingMs: 9_300, fixtureId: "speaker-b", type: "playback-end" },
  ];
  source.recording.durationMs = 9_300;
  source.recording.endedAt = "1970-01-01T00:00:09.300Z";
  const speakerATrack = source.recording.s3.tracks.find(
    ({ speakerId }) => speakerId === speakerAId,
  );
  const speakerBTrack = source.recording.s3.tracks.find(
    ({ speakerId }) => speakerId === speakerBId,
  );
  const speakerATurn = source.transcript.turns.find(({ turnId }) => turnId === "turn-a");
  const speakerBTurn = source.transcript.turns.find(({ turnId }) => turnId === "turn-b");
  if (
    speakerATrack === undefined || speakerBTrack === undefined ||
    speakerATurn === undefined || speakerBTurn === undefined
  ) {
    throw new Error("reconnect speaker fixtures are required");
  }
  speakerATrack.durationMs = 9_300;
  speakerATrack.timelineOffsetMs = 1_600;
  speakerBTrack.durationMs = 9_300;
  speakerBTrack.timelineOffsetMs = 2_300;
  speakerATurn.startMs = 1_600;
  speakerATurn.endMs = 8_600;
  speakerBTurn.startMs = 2_300;
  speakerBTurn.endMs = 9_300;
  const botSpeakerId = "1533877611258708230";
  source.recording.speakerIds.push(botSpeakerId, speakerDId);
  source.recording.s3.tracks.push({
    checksumSha256: "4".repeat(64), durationMs: source.recording.durationMs,
    locator: "s3://bucket/meeting-1/botik.ogg", sizeBytes: 2_000,
    speakerId: botSpeakerId, timelineOffsetMs: 0,
  }, {
    checksumSha256: "5".repeat(64), durationMs: 4_000,
    locator: "s3://bucket/meeting-1/speaker-d.ogg", sizeBytes: 3_000,
    speakerId: speakerDId, timelineOffsetMs: 3_200,
  });
  source.recordingPlayback.tracks = source.recording.s3.tracks.map((track, index) => ({
    checksumSha256: track.checksumSha256,
    contentLength: track.sizeBytes,
    contentRange: `bytes 0-${track.sizeBytes - 1}/${track.sizeBytes}`,
    index,
    statusCode: 206,
  }));
  source.transcript.turns.push(
    {
      endMs: 2_050, speakerId: botSpeakerId, startMs: 1_700,
      text: "Hi, Test B!", turnId: "botik-greeting-en",
    },
    {
      endMs: 1_450, speakerId: botSpeakerId, startMs: 1_050,
      text: "Привет, Тест А!", turnId: "botik-greeting-ru",
    },
    {
      endMs: 3_600, speakerId: speakerDId, startMs: 3_300,
      text: "Ботик, ответь одним словом: кобальт.", turnId: "speaker-d-question",
    },
    {
      endMs: 650, speakerId: botSpeakerId, startMs: 250,
      text: "Привет!", turnId: "botik-greeting-unknown",
    },
    {
      endMs: 3_150, speakerId: botSpeakerId, startMs: 2_750,
      text: "Привет!", turnId: "botik-greeting-speaker-d",
    },
    {
      endMs: 4_500, speakerId: botSpeakerId, startMs: 4_200,
      text: "Кобальт.", turnId: "botik-answer-1",
    },
    {
      endMs: 6_500, speakerId: speakerDId, startMs: 6_200,
      text: "Всем пока.", turnId: "speaker-d-farewell",
    },
    {
      endMs: 7_100, speakerId: botSpeakerId, startMs: 6_700,
      text: "Пока!", turnId: "botik-farewell-ru",
    },
  );
  const events = [
    { greetingLocale: "ru", observedAt: "1970-01-01T00:00:00.250Z", participantId: observerId, participantNameStatus: "unknown", turnId: `participant-greeting:${observerId}`, type: "greeting" as const },
    { greetingLocale: "ru", observedAt: "1970-01-01T00:00:00.950Z", participantId: speakerAId, participantNameStatus: "known", turnId: `participant-greeting:${speakerAId}`, type: "greeting" as const },
    { greetingLocale: "en", observedAt: "1970-01-01T00:00:01.650Z", participantId: speakerBId, participantNameStatus: "known", turnId: `participant-greeting:${speakerBId}`, type: "greeting" as const },
    { greetingLocale: "ru", observedAt: "1970-01-01T00:00:02.750Z", participantId: speakerDId, participantNameStatus: "unknown", turnId: `participant-greeting:${speakerDId}`, type: "greeting" as const },
    { observedAt: "1970-01-01T00:00:03.800Z", outcome: "active", participantId: speakerDId, turnId: "human-question-1", type: "addressed-answer" as const },
    { evidenceTurnIds: ["speaker-d-farewell"], locale: "ru", observedAt: "1970-01-01T00:00:07.000Z", playbackAttemptId: "farewell", reason: "explicit-group", turnId: "meeting-farewell:v1" as const, type: "farewell" as const },
  ];
  return retainedReconnectE2eEvidenceV8Schema.parse({
    ...source,
    conversation: {
      botSpeakerId,
      lifecycle: {
        events,
        groundedAnswers: [{ citationTurnIds: ["speaker-d-question"],
          evidenceEpoch: "evidence-7", knowledgeEpoch: "knowledge-9",
          observedAt: "1970-01-01T00:00:03.900Z", participantId: speakerDId,
          playbackProvenance: "literal_tts" as const, status: "validated" as const, turnId: "human-question-1" }],
        playbackReceipts: [
          { observedAt: "1970-01-01T00:00:04.000Z", playbackAttemptId: "answer", playbackKind: "answer" as const, playbackStartedAtEpochMs: 4_000, playbackStartedAtMonotonicMs: 4_000, speechProvenance: "literal_tts" as const, status: "started" as const, turnId: "human-question-1" },
          { observedAt: "1970-01-01T00:00:04.600Z", playbackAttemptId: "answer", playbackFinishedAtEpochMs: 4_600, playbackFinishedAtMonotonicMs: 4_600, playbackKind: "answer" as const, speechProvenance: "literal_tts" as const, status: "finished" as const, turnId: "human-question-1" },
          { observedAt: "1970-01-01T00:00:04.700Z", playbackAttemptId: "answer", playbackKind: "answer" as const, playbackSettledAtEpochMs: 4_700, playbackSettledAtMonotonicMs: 4_700, settlement: "played" as const, speechProvenance: "literal_tts" as const, status: "settled" as const, turnId: "human-question-1" },
          { observedAt: "1970-01-01T00:00:06.500Z", playbackAttemptId: "farewell", playbackKind: "prepared-cue" as const, playbackStartedAtEpochMs: 6_500, playbackStartedAtMonotonicMs: 6_500, preparedAssetSha256: "f".repeat(64), status: "started" as const, turnId: "meeting-farewell:v1" },
          { observedAt: "1970-01-01T00:00:06.900Z", playbackAttemptId: "farewell", playbackFinishedAtEpochMs: 6_900, playbackFinishedAtMonotonicMs: 6_900, playbackKind: "prepared-cue" as const, preparedAssetSha256: "f".repeat(64), status: "finished" as const, turnId: "meeting-farewell:v1" },
          { observedAt: "1970-01-01T00:00:07.000Z", playbackAttemptId: "farewell", playbackKind: "prepared-cue" as const, playbackSettledAtEpochMs: 7_000, playbackSettledAtMonotonicMs: 7_000, preparedAssetSha256: "f".repeat(64), settlement: "played" as const, status: "settled" as const, turnId: "meeting-farewell:v1" },
        ],
      },
      reconnectNoRepeat: {
        lifecycleReceipts: [
          { eventType: "participant.left", observedAt: "1970-01-01T00:00:02.100Z", occurredAt: "1970-01-01T00:00:02.100Z", participantId: speakerBId, type: "participant-lifecycle" },
          { eventType: "participant.joined", observedAt: "1970-01-01T00:00:02.200Z", occurredAt: "1970-01-01T00:00:02.200Z", participantId: speakerBId, type: "participant-lifecycle" },
        ],
        negativeWindow: { endedAt: source.recording.endedAt,
          source: "sut-rejoin-to-authoritative-recording-end", startedAt: "1970-01-01T00:00:02.200Z" },
        participantId: speakerBId,
      },
      supplementalPlayback: {
        actor: { applicationId: speakerDId, authenticatedApplicationId: speakerDId, name: "speaker-d" },
        fixture: {
          durationMs: 4_000,
          path: "/fixtures/supplemental-question-farewell.ru.ogg",
          purpose: "speaker-d-botik-question-and-later-group-farewell",
          sha256: "9".repeat(64),
        },
        playback: {
          endedAtEpochMs: 7_200,
          postHoldMilliseconds: 1_000,
          preHoldMilliseconds: 500,
          startedAtEpochMs: 3_200,
        },
        privateTestGuildConfirmed: true,
        runId: source.actorRun.runId,
        schemaVersion: 1,
        target: {
          guildId: "1533228590643155034",
          voiceChannelId: "1533228823045214398",
        },
      },
      voice: [
        voiceObservation("greeting", `participant-greeting:${observerId}`, "greeting-unknown", 200),
        voiceObservation("greeting", `participant-greeting:${speakerAId}`, "greeting-ru", 900),
        voiceObservation("greeting", `participant-greeting:${speakerBId}`, "greeting-en", 1_600),
        voiceObservation("greeting", `participant-greeting:${speakerDId}`, "greeting-speaker-d", 2_700),
        voiceObservation("addressed-answer", "human-question-1", "answer", 4_100),
        voiceObservation("farewell", "meeting-farewell:v1", "farewell", 6_600),
      ],
    },
    schemaVersion: 8,
  });
}

export function retainedV7Evidence(): RetainedE2eEvidenceV7 {
  const source = retainedV8Evidence();
  const { recordingPlayback: _recordingPlayback, ...historicalSource } = source;
  return retainedE2eEvidenceV7Schema.parse({
    ...historicalSource,
    conversation: {
      botSpeakerId: source.conversation.botSpeakerId,
      lifecycle: source.conversation.lifecycle,
      voice: source.conversation.voice,
    },
    schemaVersion: 7,
  });
}
