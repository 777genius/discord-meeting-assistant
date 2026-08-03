import { describe, expect, it } from "vitest";

import {
  collectRetainedE2eEvidence,
  type DatabaseObservation,
  type DeploymentEvidenceProbe,
  type DiscordEvidenceProbe,
  type S3RecordingEvidence,
} from "../src/e2e-collector.js";
import type { DeploymentProvenance } from "../src/e2e-evidence.js";

const speakerA = "1533227577286852649";
const speakerB = "1533228054724346087";

function actorRun() {
  return {
    events: [
      { actorName: "speaker-a", atEpochMs: 1_000_000, type: "ready" },
      { actorName: "speaker-b", atEpochMs: 1_000_000, type: "ready" },
      { actorName: "speaker-a", atEpochMs: 1_000_010, fixtureId: "speaker-a", type: "playback-start" },
      { actorName: "speaker-b", atEpochMs: 1_000_760, fixtureId: "speaker-b", type: "playback-start" },
      { actorName: "speaker-b", atEpochMs: 1_013_127, fixtureId: "speaker-b", type: "playback-end" },
      { actorName: "speaker-a", atEpochMs: 1_016_011, fixtureId: "speaker-a", type: "playback-end" },
    ],
    fixtureSetId: "discord-meeting-ru-en-v1",
    fixtures: [
      {
        audioSha256: "a".repeat(64),
        durationMs: 16_001,
        fixtureId: "speaker-a",
        sourceSha256: "b".repeat(64),
      },
      {
        audioSha256: "c".repeat(64),
        durationMs: 12_367,
        fixtureId: "speaker-b",
        sourceSha256: "d".repeat(64),
      },
    ],
    recordingId: null,
    runId: "run-1",
    scenario: "overlap",
    schemaVersion: 1,
    timelineOrigin: "unix-epoch",
  } as const;
}

function snapshot() {
  return {
    meetingId: "recording-1",
    publication: {
      externalPublicationId: "discord:v1:thread:thread-1:message:message-1",
      idempotencyKey: "meeting-summary-publication:v1|recording-1|summary-1|results",
    },
    publicationStage: { attempts: 1, status: "succeeded" },
    publicationTargetId: "1533228891827736657",
    recording: {
      manifestLocator: "s3://meeting-artifacts/recording-1/manifest.json",
      recordingId: "recording-1",
      speakerAudio: [
        { audioLocator: "s3://meeting-artifacts/recording-1/a.ogg", speakerId: speakerA, timelineOffsetMs: 0 },
        { audioLocator: "s3://meeting-artifacts/recording-1/b.ogg", speakerId: speakerB, timelineOffsetMs: 750 },
      ],
    },
    revision: 6,
    summary: {
      actionItems: [{
        actionItemId: "action-1",
        deadline: "2026-08-07",
        evidenceTurnIds: ["turn-b"],
        ownerSpeakerId: speakerB,
        text: "Проверить Discord thread",
      }],
      decisions: [{
        decisionId: "decision-1",
        evidenceTurnIds: ["turn-a"],
        text: "Выпустить в пятницу",
      }],
      openQuestions: [{
        evidenceTurnIds: ["turn-b"],
        id: "question-1",
        text: "Нужен ли следующий этап?",
      }],
      overview: "Команда согласовала выпуск и владельца проверки.",
      summaryId: "summary-1",
      title: "Итоги встречи",
      topics: [{
        evidenceTurnIds: ["turn-a"],
        points: ["Meeting Platform хранит Craig recording"],
        title: "PostgreSQL pipeline",
      }],
      transcriptId: "transcript-1",
      version: 1,
    },
    summaryStage: { attempts: 1, status: "succeeded" },
    transcript: {
      transcriptId: "transcript-1",
      turns: [
        { endMs: 16_001, speakerId: speakerA, startMs: 0, text: "Спикер A", turnId: "turn-a" },
        { endMs: 13_117, speakerId: speakerB, startMs: 750, text: "Спикер B", turnId: "turn-b" },
      ],
    },
    transcriptionStage: { attempts: 1, status: "succeeded" },
  } as const;
}

function database(): DatabaseObservation {
  return {
    matchingMeetingCount: 1,
    matchingRecordingCount: 1,
    matchingSummaryCount: 1,
    matchingTranscriptCount: 1,
    snapshot: snapshot(),
  };
}

function directMessageDatabase(): DatabaseObservation {
  const source = snapshot();
  const directSnapshot = {
    ...source,
    publication: {
      ...source.publication,
      externalPublicationId: "discord:v2:channel:1533228891827736657:message:message-1",
    },
  };
  return { ...database(), snapshot: directSnapshot };
}

function s3(): S3RecordingEvidence {
  return {
    endedAt: "1970-01-01T00:17:00.000Z",
    manifestChecksumSha256: "e".repeat(64),
    manifestLocator: "s3://meeting-artifacts/recording-1/manifest.json",
    recordingId: "recording-1",
    sourceChecksumSha256: "f".repeat(64),
    startedAt: "1970-01-01T00:16:40.000Z",
    tracks: [
      {
        checksumSha256: "1".repeat(64),
        durationMs: 16_001,
        locator: "s3://meeting-artifacts/recording-1/a.ogg",
        sizeBytes: 10_000,
        speakerId: speakerA,
        timelineOffsetMs: 0,
      },
      {
        checksumSha256: "2".repeat(64),
        durationMs: 12_367,
        locator: "s3://meeting-artifacts/recording-1/b.ogg",
        sizeBytes: 10_000,
        speakerId: speakerB,
        timelineOffsetMs: 750,
      },
    ],
  };
}

function provenance(): DeploymentProvenance {
  return {
    craig: {
      composeConfigHash: "3".repeat(64),
      composeProject: "craig-meeting-e2e",
      composeService: "bot",
      containerId: "4".repeat(64),
      containerStartedAt: "1970-01-01T00:15:00.000Z",
      imageId: `sha256:${"5".repeat(64)}`,
      repositoryDigest: null,
      sourceRevision: "6".repeat(40),
    },
    meetingPlatform: {
      composeConfigHash: "7".repeat(64),
      composeProject: "discord-meeting-assistant",
      composeService: "meeting-platform",
      containerId: "8".repeat(64),
      containerStartedAt: "1970-01-01T00:15:00.000Z",
      imageId: `sha256:${"9".repeat(64)}`,
      repositoryDigest: null,
      sourceRevision: "a".repeat(40),
    },
  };
}

describe("collectRetainedE2eEvidence", () => {
  it("collects before state, verifies S3/Discord, performs replay, then collects after state", async () => {
    const calls: string[] = [];
    let databaseCall = 0;
    let provenanceCall = 0;
    const deployment: DeploymentEvidenceProbe = {
      collectDatabase: async () => {
        databaseCall += 1;
        calls.push(`database-${databaseCall}`);
        return database();
      },
      collectProvenance: async () => {
        provenanceCall += 1;
        calls.push(`provenance-${provenanceCall}`);
        return provenance();
      },
      collectS3: async () => {
        calls.push("s3");
        return s3();
      },
      replayPostCall: async () => {
        calls.push("replay");
        return {
          afterProcessedOn: 2_000,
          beforeProcessedOn: 1_000,
          jobId: "post-call-v1-job",
          state: "completed",
        };
      },
    };
    const discord: DiscordEvidenceProbe = {
      inspect: async () => ({
        matchingMessages: [{
          container: {
            kind: "thread",
            parentChannelId: "1533228891827736657",
            threadId: "thread-1",
          },
          embedDescription: [
            "Ответственный: <@1533228054724346087>",
            "Основание: **00:00-00:16 · <@1533227577286852649>:** «Meeting Platform»",
            "Основание: **00:00-00:13 · <@1533228054724346087>:** «Discord thread»",
          ].join("\n"),
          messageId: "message-1",
        }],
        matchingThreadIds: ["thread-1"],
      }),
    };

    const evidence = await collectRetainedE2eEvidence(
      { actorRun: actorRun(), recordingId: "recording-1", runId: "run-1" },
      deployment,
      discord,
    );

    expect(calls).toEqual([
      "provenance-1",
      "database-1",
      "s3",
      "replay",
      "database-2",
      "provenance-2",
    ]);
    expect(evidence.database).toEqual({
      matchingMeetingCount: 1,
      matchingRecordingCount: 1,
      matchingSummaryCount: 1,
      matchingTranscriptCount: 1,
    });
    expect(evidence.replay.replayJob.afterProcessedOn).toBe(2_000);
    expect(evidence.publication.matchingThreadCount).toBe(1);
    expect(evidence.recording.s3.sourceChecksumSha256).toBe("f".repeat(64));
    expect(evidence.deployment).toEqual(provenance());
    expect(evidence.publication.embedDescription).toContain("Основание:");
  });

  it("collects a direct parent-channel publication without inventing a thread", async () => {
    const deployment: DeploymentEvidenceProbe = {
      collectDatabase: async () => directMessageDatabase(),
      collectProvenance: async () => provenance(),
      collectS3: async () => s3(),
      replayPostCall: async () => ({
        afterProcessedOn: 2_000,
        beforeProcessedOn: 1_000,
        jobId: "post-call-v1-job",
        state: "completed",
      }),
    };
    const discord: DiscordEvidenceProbe = {
      inspect: async () => ({
        matchingMessages: [{
          container: {
            kind: "channel-message",
            parentChannelId: "1533228891827736657",
          },
          embedDescription: "**00:00-00:16 · <@1533227577286852649>:** «Meeting Platform»",
          messageId: "message-1",
        }],
        matchingThreadIds: [],
      }),
    };

    const evidence = await collectRetainedE2eEvidence(
      { actorRun: actorRun(), recordingId: "recording-1", runId: "run-1" },
      deployment,
      discord,
    );

    expect(evidence.schemaVersion).toBe(3);
    expect(evidence.publication).toMatchObject({
      container: {
        kind: "channel-message",
        parentChannelId: "1533228891827736657",
      },
      matchingMessageCount: 1,
      matchingThreadCount: 0,
    });
    expect(evidence.replay.container).toEqual(evidence.publication.container);
  });

  it("rejects a deployment change while evidence is collected", async () => {
    let provenanceCall = 0;
    const deployment: DeploymentEvidenceProbe = {
      collectDatabase: async () => database(),
      collectProvenance: async () => {
        provenanceCall += 1;
        const observed = provenance();
        return provenanceCall === 2
          ? {
            ...observed,
            meetingPlatform: {
              ...observed.meetingPlatform,
              imageId: `sha256:${"b".repeat(64)}`,
            },
          }
          : observed;
      },
      collectS3: async () => s3(),
      replayPostCall: async () => ({
        afterProcessedOn: 2_000,
        beforeProcessedOn: 1_000,
        jobId: "post-call-v1-job",
        state: "completed",
      }),
    };
    const discord: DiscordEvidenceProbe = {
      inspect: async () => ({
        matchingMessages: [{
          container: {
            kind: "thread",
            parentChannelId: "1533228891827736657",
            threadId: "thread-1",
          },
          embedDescription: "Основание: 00:00-00:01",
          messageId: "message-1",
        }],
        matchingThreadIds: ["thread-1"],
      }),
    };

    await expect(collectRetainedE2eEvidence(
      { actorRun: actorRun(), recordingId: "recording-1", runId: "run-1" },
      deployment,
      discord,
    )).rejects.toThrow("provenance changed");
  });

  it("rejects an actor file from another explicit run before external reads", async () => {
    const deployment = {} as DeploymentEvidenceProbe;
    const discord = {} as DiscordEvidenceProbe;

    await expect(collectRetainedE2eEvidence(
      { actorRun: actorRun(), recordingId: "recording-2", runId: "run-2" },
      deployment,
      discord,
    )).rejects.toThrow("correlation");
  });
});
