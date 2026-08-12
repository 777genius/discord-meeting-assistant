import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectHostedServiceLevelClockBindingRequest,
  collectHostedServiceLevels,
  HostedServiceLevelsBlockedError,
  type CollectHostedServiceLevelsConfig,
} from "../src/collect-hosted-service-levels.js";
import {
  conversationVoiceCampaignObserverReadyReceipt,
  conversationVoiceCampaignPlanDigest,
} from "../src/conversation-voice-campaign-proof.js";
import { projectionMarker } from "../src/e2e-discord-projection-inspection.js";
import { retainedV8Evidence } from "./e2e-evidence-fixtures.js";
import {
  clockAttestationId,
  hostedServiceLevelClockAttestationsV1Schema,
  type HostedServiceLevelClockAttestationsV1,
} from "../src/hosted-service-level-clock-attestation.js";
import { e2eServiceLevelsV1Schema } from "../src/e2e-service-levels.js";
import { fixtureManifestV1Schema } from "../src/e2e-evidence.js";

describe("hosted service-level producer", () => {
  it("derives all three measurements only after exact clock binding and writes private create-only output", async () => {
    const fixture = await materializeInputs();
    const request = await collectHostedServiceLevelClockBindingRequest(fixture.config);
    await writePrivate(fixture.paths.clock, clockAttestations(request));

    await collectHostedServiceLevels(fixture.config);

    const output = e2eServiceLevelsV1Schema.parse(
      JSON.parse(await readFile(fixture.paths.output, "utf8")) as unknown,
    );
    expect(output.measurements.map(({ serviceLevelId }) => serviceLevelId)).toEqual([
      "join-to-greeting-first-packet",
      "question-end-to-answer-first-packet",
      "recording-end-to-discord-first-seen",
    ]);
    const answer = output.measurements.find(({ serviceLevelId }) =>
      serviceLevelId === "question-end-to-answer-first-packet"
    );
    expect(answer?.serviceLevelId === "question-end-to-answer-first-packet"
      ? answer.start.source.turnId : undefined).toBe("speaker-d-question");
    expect(output.measurements[2]?.start.source).toMatchObject({
      kind: "authoritative-recording-end", recordingId: "meeting-1",
    });
    expect((await lstat(fixture.paths.output)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(fixture.paths.report, "utf8"))).toMatchObject({
      measurementCount: 3, outputCreated: true, status: "ready",
    });
    await expect(collectHostedServiceLevels(fixture.config)).rejects.toThrow("already exists");
  });

  it("fails closed with a retained report when clock provenance is absent", async () => {
    const fixture = await materializeInputs({ clockPath: false });

    await expect(collectHostedServiceLevels(fixture.config))
      .rejects.toBeInstanceOf(HostedServiceLevelsBlockedError);

    await expect(lstat(fixture.paths.output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(fixture.paths.report, "utf8"))).toMatchObject({
      code: "CLOCK_ATTESTATION_MISSING", outputCreated: false, status: "blocked",
    });
  });

  it("rejects an ambiguous authoritative nonce turn and leaves no SLA output", async () => {
    const fixture = await materializeInputs({ duplicateQuestion: true });
    const request = await collectHostedServiceLevelClockBindingRequest(fixture.config)
      .catch((error: unknown) => error);
    expect(request).toMatchObject({ code: "QUESTION_SOURCE_AMBIGUOUS" });
    await writePrivate(fixture.paths.clock, emptyClockAttestations());

    await expect(collectHostedServiceLevels(fixture.config))
      .rejects.toThrow("QUESTION_SOURCE_AMBIGUOUS");

    await expect(lstat(fixture.paths.output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(fixture.paths.report, "utf8"))).toMatchObject({
      code: "QUESTION_SOURCE_AMBIGUOUS", outputCreated: false,
    });
  });

  it("rejects a mismatched run before clock composition", async () => {
    const fixture = await materializeInputs();
    await writePrivate(fixture.paths.clock, emptyClockAttestations());
    const config = { ...fixture.config, runId: "other-run" };
    await expect(collectHostedServiceLevels(config)).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
    await expect(lstat(fixture.paths.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface MaterializeOptions {
  readonly clockPath?: boolean;
  readonly duplicateQuestion?: boolean;
}

async function materializeInputs(options: MaterializeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "hosted-sla-"));
  await chmod(root, 0o700);
  const evidence = retainedV8Evidence();
  const manifestSource = JSON.parse(await readFile(
    join(import.meta.dirname, "fixtures/manifest.v1.json"), "utf8",
  )) as unknown;
  const manifest = fixtureManifestV1Schema.parse(manifestSource);
  manifest.supplementalVoiceExpectation = {
    answerNonce: "кобальт", applicationId: speakerD, durationMs: 4_000,
    farewellLocale: "ru", fixtureSha256: "9".repeat(64), greetingLocale: "ru",
    requiredFarewellTerms: ["всем", "пока"], requiredQuestionTerms: ["ботик", "кобальт"],
  };
  const snapshot = databaseSnapshot(evidence, options.duplicateQuestion === true);
  const publicationMarker = await projectionMarker(snapshot.publication.idempotencyKey);
  const values = {
    campaign: campaignProof(evidence.conversation.voice),
    database: {
      matchingMeetingCount: 1, matchingRecordingCount: 1,
      matchingSummaryCount: 1, matchingTranscriptCount: 1, snapshot,
    },
    manifest,
    playback: playbackProof(evidence.actorRun.runId, publicationMarker),
    ready: readyReceipt(evidence.actorRun.runId),
    s3: s3Observation(evidence),
    supplemental: evidence.conversation.supplementalPlayback,
  };
  const paths = {
    campaign: join(root, "campaign.json"), clock: join(root, "clocks.json"),
    database: join(root, "database.json"), logs: join(root, "meeting-platform.log"),
    manifest: join(root, "manifest.json"), output: join(root, "service-levels.json"),
    playback: join(root, "playback.json"), ready: join(root, "ready.json"),
    report: join(root, "report.json"), s3: join(root, "s3.json"),
    supplemental: join(root, "supplemental.json"),
    voice: evidence.conversation.voice.map((_, index) => join(root, `voice-${index + 1}.json`)),
  };
  await Promise.all([
    writePrivate(paths.campaign, values.campaign), writePrivate(paths.database, values.database),
    writePrivate(paths.logs, meetingPlatformLogs(evidence)), writePrivate(paths.manifest, values.manifest),
    writePrivate(paths.playback, values.playback), writePrivate(paths.ready, values.ready),
    writePrivate(paths.s3, values.s3), writePrivate(paths.supplemental, values.supplemental),
    ...paths.voice.map((path, index) => writePrivate(path, evidence.conversation.voice[index])),
  ]);
  const config: CollectHostedServiceLevelsConfig = {
    outputPath: paths.output, reportPath: paths.report, runId: evidence.actorRun.runId,
    sources: {
      campaignProof: paths.campaign,
      ...(options.clockPath === false ? {} : { clockAttestations: paths.clock }),
      database: paths.database, fixtureManifest: paths.manifest,
      meetingPlatformLogs: paths.logs, playbackLinkProof: paths.playback,
      readyReceipt: paths.ready, s3: paths.s3, supplementalPlayback: paths.supplemental,
      voice: paths.voice,
    },
  };
  return { config, paths };
}

function databaseSnapshot(evidence: ReturnType<typeof retainedV8Evidence>, duplicateQuestion: boolean) {
  const transcriptTurns = [...evidence.transcript.turns];
  if (duplicateQuestion) {
    transcriptTurns.push({
      endMs: 3_700, speakerId: speakerD, startMs: 3_650,
      text: "Еще раз кобальт", turnId: "speaker-d-question-duplicate",
    });
  }
  return {
    meetingId: evidence.meetingId,
    publication: {
      externalPublicationId: `discord:v2:channel:${publicationChannel}:message:message-1`,
      idempotencyKey: "fixture-final-publication",
    },
    publicationStage: evidence.stages.find(({ stage }) => stage === "publication")!,
    publicationTargetId: publicationChannel,
    recording: {
      manifestLocator: evidence.recording.s3.manifestLocator,
      recordingId: evidence.recording.recordingId,
      speakerAudio: evidence.recording.s3.tracks.map((track) => ({
        audioLocator: track.locator, speakerId: track.speakerId,
        timelineOffsetMs: track.timelineOffsetMs,
      })),
    },
    revision: 1, summary: evidence.summary,
    summaryStage: evidence.stages.find(({ stage }) => stage === "summary")!,
    transcript: { transcriptId: evidence.transcript.transcriptId, turns: transcriptTurns },
    transcriptionStage: evidence.stages.find(({ stage }) => stage === "transcription")!,
  };
}

function s3Observation(evidence: ReturnType<typeof retainedV8Evidence>) {
  return {
    endedAt: evidence.recording.endedAt,
    manifestChecksumSha256: evidence.recording.s3.manifestChecksumSha256,
    manifestLocator: evidence.recording.s3.manifestLocator,
    recordingId: evidence.recording.recordingId,
    sourceChecksumSha256: evidence.recording.s3.sourceChecksumSha256,
    startedAt: evidence.recording.startedAt,
    tracks: evidence.recording.s3.tracks,
  };
}

function campaignProof(voice: ReturnType<typeof retainedV8Evidence>["conversation"]["voice"]) {
  const plan = {
    captures: voice.map((capture, index) => ({
      expectedDuration: capture.capture.expectedDuration, ordinal: index + 1,
      outputPath: `/evidence/voice-${index + 1}.json`, purpose: capture.correlation.purpose,
      resolvedAttemptId: capture.correlation.attemptId,
      resolvedTurnId: capture.correlation.turnId,
      role: ["observer-unknown", "speaker-ru-known", "speaker-en-known", "speaker-d-unknown",
        "speaker-d-addressed-answer", "explicit-group-farewell"][index]!,
    })),
    kind: "conversation-voice-campaign-preflight" as const, status: "validated" as const,
  };
  const ready = conversationVoiceCampaignObserverReadyReceipt({
    authenticatedObserverBotId: observer, meetingId: "meeting-1", plan,
    readyPublishedAt: "1970-01-01T00:00:04.000Z", runId: "run-overlap-1",
    target: { craigBotId: botik, guildId, observerApplicationId: observer, voiceChannelId },
  });
  return { observerReadyReceipt: ready, plan, planDigestSha256: conversationVoiceCampaignPlanDigest(plan), schemaVersion: 1 };
}

function meetingPlatformLogs(evidence: ReturnType<typeof retainedV8Evidence>): string {
  const events = evidence.conversation.lifecycle.events.map((event) => event.type === "greeting"
    ? { ...event, meetingId: "meeting-1", message: "Participant greeting playback settled", time: event.observedAt }
    : event.type === "addressed-answer"
      ? { ...event, meetingId: "meeting-1", message: "Live conversation turn observed", speakerId: event.participantId, time: event.observedAt }
      : { ...event, meetingId: "meeting-1", message: "Meeting farewell playback settled", time: event.observedAt });
  const receipts = evidence.conversation.lifecycle.playbackReceipts.map((receipt) => ({
    ...receipt, meetingId: "meeting-1", message: receipt.status === "started"
      ? "Conversation playback started" : receipt.status === "finished"
        ? "Conversation playback finished" : "Conversation playback settled", time: receipt.observedAt,
  }));
  const participant = {
    eventType: "participant.joined", meetingId: "meeting-1",
    message: "Live participant lifecycle accepted", occurredAt: "1970-01-01T00:00:01.500Z",
    participantId: speakerB, time: "1970-01-01T00:00:01.500Z",
  };
  return [...events, ...receipts, participant].map((value) => JSON.stringify(value)).join("\n");
}

function readyReceipt(runId: string) {
  return {
    authoritativeSource: { eventDigestSha256: "e".repeat(64), eventId: "ready-1",
      kind: "meeting-platform-completion-receipt-v2", occurredAt: "1970-01-01T00:00:09.400Z" },
    meetingId: "meeting-1", observedAt: "1970-01-01T00:00:09.500Z",
    pinnedTestTarget: { guildId, provenanceDigestSha256: "f".repeat(64), voiceChannelId },
    recordingId: "meeting-1", runId, schemaVersion: 1,
  };
}

function playbackProof(runId: string, marker: string) {
  return {
    container: { kind: "channel-message", parentChannelId: publicationChannel },
    firstSeenPollCompletedAt: { epochMilliseconds: 9_500, monotonicMilliseconds: 19_500 },
    firstSeenPollStartedAt: { epochMilliseconds: 9_490, monotonicMilliseconds: 19_490 },
    link: { capabilitySha256: "6".repeat(64), origin: "https://recordings.example.test", pathname: "/recordings/playback" },
    messageId: "message-1", observerArmedAt: { epochMilliseconds: 9_350, monotonicMilliseconds: 19_350 },
    pollIntervalMs: 25, projectionMarker: marker, recordingId: "meeting-1",
    resultChannelId: publicationChannel, runId, schemaVersion: 1, sutApplicationId: "1533224474609057793",
  };
}

function clockAttestations(request: Awaited<ReturnType<typeof collectHostedServiceLevelClockBindingRequest>>): HostedServiceLevelClockAttestationsV1 {
  return hostedServiceLevelClockAttestationsV1Schema.parse({
    host: "codex-workers-eu-01", kind: "hosted-service-level-clock-attestations",
    measurements: request.measurements.map((measurement) => {
      const content = { clockSkewBoundMs: 5, endClockId: "hosted-observer-clock",
        endEvidenceSha256: measurement.endEvidenceSha256, method: "host-clock-skew-preflight-v1" as const,
        serviceLevelId: measurement.serviceLevelId, startClockId: "hosted-source-clock",
        startEvidenceSha256: measurement.startEvidenceSha256 };
      return { ...content, attestationId: clockAttestationId(content) };
    }),
    meetingId: request.meetingId, recordingId: request.recordingId,
    runId: request.runId, schemaVersion: 1,
  });
}

function emptyClockAttestations(): unknown {
  return { host: "codex-workers-eu-01", kind: "hosted-service-level-clock-attestations",
    measurements: [], meetingId: "meeting-1", recordingId: "meeting-1",
    runId: "run-overlap-1", schemaVersion: 1 };
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  const encoded = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
  await writeFile(path, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

const guildId = "1533228590643155034";
const voiceChannelId = "1533228823045214398";
const publicationChannel = "1533228891827736657";
const observer = "1533867700575670282";
const speakerB = "1533228054724346087";
const speakerD = "1533873978417086474";
const botik = "1534231284467896512";
