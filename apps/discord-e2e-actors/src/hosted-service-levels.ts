import { createHash } from "node:crypto";
import { z } from "zod";
import {
  conversationVoiceEvidenceV3Schema,
  fixtureManifestV1Schema,
  supplementalPlaybackEvidenceV1Schema,
} from "./e2e-evidence.js";
import { parseDiscordPublication, projectionMarker, toEvidenceContainer } from
  "./e2e-discord-projection-inspection.js";
import { turnsContainingAnyTerms } from "./e2e-evidence-farewell-semantics-verification.js";
import { conversationVoiceCampaignLifecycleIssue,
  conversationVoiceCampaignIdentities } from "./conversation-voice-campaign-contract.js";
import { conversationVoiceCampaignProofIssue,
  conversationVoiceCampaignProofV1Schema } from "./conversation-voice-campaign-proof.js";
import { liveDiscordPlaybackLinkProofSchema } from "./live-discord-playback-link-observer.js";
import { recordingReadyReceiptV1Schema } from "./recording-ready-receipt.js";
import { parseConversationLifecycleEvidenceLogs } from "./e2e-processing-log-parser.js";
import { assertExactDatabaseCounts, alignS3TracksToSnapshot, normalizeDatabase } from
  "./e2e-retained-evidence-snapshot.js";
import type { S3RecordingEvidence } from "./e2e-retained-evidence-contracts.js";
import { e2eServiceLevelsV1Schema, type E2eServiceLevelsV1 } from "./e2e-service-levels.js";
import { databaseOutputSchema, s3OutputSchema } from "./ssh-deployment-probe-validation.js";
import {
  clockEvidenceDigest,
  hostedServiceLevelClockAttestationsV1Schema,
  type HostedServiceLevelClockAttestationsV1,
} from "./hosted-service-level-clock-attestation.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";

export const hostedServiceLevelFailureCodeSchema = z.enum([
  "ANSWER_SOURCE_INVALID", "AUTHORITATIVE_SOURCE_INVALID", "CLOCK_ATTESTATION_MISMATCH",
  "CLOCK_ATTESTATION_MISSING", "IMPOSSIBLE_TIMELINE", "JOIN_SOURCE_AMBIGUOUS",
  "PUBLICATION_SOURCE_MISMATCH", "QUESTION_SOURCE_AMBIGUOUS", "SOURCE_IDENTITY_MISMATCH",
  "SOURCE_INPUT_INVALID", "SOURCE_INPUT_MISSING", "VOICE_CAMPAIGN_INVALID",
]);
export type HostedServiceLevelFailureCode = z.infer<typeof hostedServiceLevelFailureCodeSchema>;

export class HostedServiceLevelDerivationError extends Error {
  public constructor(
    public readonly code: HostedServiceLevelFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type Voice = z.infer<typeof conversationVoiceEvidenceV3Schema>;
type Lifecycle = ReturnType<typeof parseConversationLifecycleEvidenceLogs>;
type Manifest = z.infer<typeof fixtureManifestV1Schema>;
type Snapshot = ReturnType<typeof normalizeDatabase>["snapshot"];
type S3 = S3RecordingEvidence;

export interface HostedServiceLevelSourceInput {
  readonly campaignProof: unknown;
  readonly clockAttestations?: unknown;
  readonly database: unknown;
  readonly fixtureManifest: unknown;
  readonly meetingPlatformLogs: string;
  readonly playbackLinkProof: unknown;
  readonly readyReceipt: unknown;
  readonly runId: string;
  readonly s3: unknown;
  readonly supplementalPlayback: unknown;
  readonly voice: readonly unknown[];
}

export interface HostedServiceLevelClockBindingRequest {
  readonly measurements: readonly Omit<PreparedMeasurement, "endSource" | "startSource">[];
  readonly meetingId: string;
  readonly recordingId: string;
  readonly runId: string;
}

interface PreparedMeasurement {
  readonly endAtEpochMs: number;
  readonly endEvidenceSha256: string;
  readonly endSource: Record<string, unknown>;
  readonly serviceLevelId: E2eServiceLevelsV1["measurements"][number]["serviceLevelId"];
  readonly startAtEpochMs: number;
  readonly startEvidenceSha256: string;
  readonly startSource: Record<string, unknown>;
}

interface PreparedSources {
  readonly measurements: readonly PreparedMeasurement[];
  readonly meetingId: string;
  readonly recordingId: string;
  readonly runId: string;
}

export async function deriveHostedServiceLevels(
  raw: HostedServiceLevelSourceInput,
): Promise<E2eServiceLevelsV1> {
  const sources = await prepareSources(raw);
  if (raw.clockAttestations === undefined) {
    fail("CLOCK_ATTESTATION_MISSING", "Run-bound hosted clock attestations are required");
  }
  let attestations: HostedServiceLevelClockAttestationsV1;
  try {
    attestations = hostedServiceLevelClockAttestationsV1Schema.parse(raw.clockAttestations);
  } catch (error) {
    fail("CLOCK_ATTESTATION_MISMATCH", "Hosted clock attestation artifact is invalid", error);
  }
  if (attestations.runId !== sources.runId || attestations.meetingId !== sources.meetingId ||
    attestations.recordingId !== sources.recordingId) {
    fail("CLOCK_ATTESTATION_MISMATCH", "Hosted clock attestations do not match the run and recording");
  }
  const measurements = sources.measurements.map((source) => {
    const attestation = attestations.measurements.find(
      ({ serviceLevelId }) => serviceLevelId === source.serviceLevelId,
    );
    if (attestation === undefined ||
      attestation.startEvidenceSha256 !== source.startEvidenceSha256 ||
      attestation.endEvidenceSha256 !== source.endEvidenceSha256) {
      fail("CLOCK_ATTESTATION_MISMATCH", `${source.serviceLevelId} clocks are not bound to its exact source artifacts`);
    }
    const upperBoundMs = source.endAtEpochMs - source.startAtEpochMs + attestation.clockSkewBoundMs;
    if (!Number.isSafeInteger(upperBoundMs) || upperBoundMs < 0) {
      fail("IMPOSSIBLE_TIMELINE", `${source.serviceLevelId} has an impossible attested timeline`);
    }
    return {
      clockSkewAttestation: {
        attestationId: attestation.attestationId,
        clockSkewBoundMs: attestation.clockSkewBoundMs,
        endClockId: attestation.endClockId,
        schemaVersion: 1 as const,
        startClockId: attestation.startClockId,
      },
      end: { atEpochMs: source.endAtEpochMs, clockId: attestation.endClockId, source: source.endSource },
      measurementId: measurementId(source),
      serviceLevelId: source.serviceLevelId,
      start: { atEpochMs: source.startAtEpochMs, clockId: attestation.startClockId, source: source.startSource },
      upperBoundMs,
    };
  });
  return e2eServiceLevelsV1Schema.parse({ measurements, schemaVersion: 1 });
}

export async function hostedServiceLevelClockBindingRequest(
  raw: Omit<HostedServiceLevelSourceInput, "clockAttestations">,
): Promise<HostedServiceLevelClockBindingRequest> {
  const sources = await prepareSources(raw);
  return {
    measurements: sources.measurements.map((measurement) => ({
      endAtEpochMs: measurement.endAtEpochMs,
      endEvidenceSha256: measurement.endEvidenceSha256,
      serviceLevelId: measurement.serviceLevelId,
      startAtEpochMs: measurement.startAtEpochMs,
      startEvidenceSha256: measurement.startEvidenceSha256,
    })),
    meetingId: sources.meetingId,
    recordingId: sources.recordingId,
    runId: sources.runId,
  };
}

async function prepareSources(raw: HostedServiceLevelSourceInput): Promise<PreparedSources> {
  try {
    const ready = recordingReadyReceiptV1Schema.parse(raw.readyReceipt);
    if (ready.runId !== raw.runId || ready.meetingId !== ready.recordingId) {
      fail("SOURCE_IDENTITY_MISMATCH", "Recording-ready receipt does not match the requested run");
    }
    const manifest = fixtureManifestV1Schema.parse(raw.fixtureManifest);
    const database = normalizeDatabase(databaseOutputSchema.parse(raw.database));
    assertExactDatabaseCounts(database, "for service-level composition");
    const snapshot = database.snapshot;
    const s3 = alignS3TracksToSnapshot(s3OutputSchema.parse(raw.s3), snapshot);
    if (snapshot.meetingId !== ready.meetingId || snapshot.recording.recordingId !== ready.recordingId ||
      s3.recordingId !== ready.recordingId) {
      fail("SOURCE_IDENTITY_MISMATCH", "Postgres, S3, and recording-ready identities differ");
    }
    const voices = bindVoice(raw.voice, ready.recordingId, ready.runId, manifest);
    const campaignProof = conversationVoiceCampaignProofV1Schema.parse(raw.campaignProof);
    const campaignIssue = conversationVoiceCampaignProofIssue(campaignProof, ready.runId, voices);
    if (campaignIssue !== undefined || campaignProof.observerReadyReceipt.meetingId !== ready.meetingId) {
      fail("VOICE_CAMPAIGN_INVALID", campaignIssue ?? "Campaign proof meeting identity differs");
    }
    const lifecycle = parseConversationLifecycleEvidenceLogs(raw.meetingPlatformLogs, ready.meetingId);
    const lifecycleIssue = conversationVoiceCampaignLifecycleIssue(
      voices, lifecycle.events, manifest.thresholds.timestampToleranceMs,
    );
    if (lifecycleIssue !== undefined) {
      fail("VOICE_CAMPAIGN_INVALID", lifecycleIssue);
    }
    const supplemental = supplementalPlaybackEvidenceV1Schema.parse(raw.supplementalPlayback);
    assertSupplemental(supplemental, manifest, ready.runId, s3);
    const playbackProof = liveDiscordPlaybackLinkProofSchema.parse(raw.playbackLinkProof);
    return {
      measurements: [
        prepareJoin(ready.runId, ready.meetingId, voices, lifecycle, manifest),
        prepareAnswer({ lifecycle, manifest, meetingId: ready.meetingId, runId: ready.runId,
          s3, snapshot, supplemental, voices }),
        await preparePublication(ready.runId, ready.meetingId, playbackProof, snapshot, s3),
      ],
      meetingId: ready.meetingId,
      recordingId: ready.recordingId,
      runId: ready.runId,
    };
  } catch (error) {
    if (error instanceof HostedServiceLevelDerivationError) {
      throw error;
    }
    throw new HostedServiceLevelDerivationError(
      "AUTHORITATIVE_SOURCE_INVALID", "Saved hosted source artifacts are invalid", { cause: error },
    );
  }
}

function bindVoice(raw: readonly unknown[], recordingId: string, runId: string, manifest: Manifest): Voice[] {
  const expectation = manifest.conversationVoiceExpectation;
  if (expectation === undefined || raw.length !== 6) {
    fail("VOICE_CAMPAIGN_INVALID", "Manifest and campaign must define exactly six voice captures");
  }
  return raw.map((value) => {
    const parsed = conversationVoiceEvidenceV3Schema.parse(value);
    if (parsed.runId !== runId || parsed.correlation.recordingId !== null &&
      parsed.correlation.recordingId !== recordingId ||
      parsed.observer.applicationId !== expectation.observerApplicationId ||
      parsed.observer.authenticatedBotId !== expectation.observerApplicationId ||
      parsed.observer.guildId !== expectation.guildId ||
      parsed.observer.voiceChannelId !== expectation.voiceChannelId ||
      parsed.source.craigBotId !== conversationVoiceCampaignIdentities.botik) {
      fail("SOURCE_IDENTITY_MISMATCH", "Conversation voice capture target or correlation differs");
    }
    return conversationVoiceEvidenceV3Schema.parse({
      ...parsed, correlation: { ...parsed.correlation, recordingId },
    });
  });
}

function prepareJoin(
  runId: string, meetingId: string, voices: readonly Voice[], lifecycle: Lifecycle, manifest: Manifest,
): PreparedMeasurement {
  const participantId = manifest.fixtures.find(({ actorName }) => actorName === "speaker-b")?.speakerId;
  if (participantId === undefined) {
    fail("JOIN_SOURCE_AMBIGUOUS", "Manifest has no unique speaker-b participant");
  }
  const turnId = `participant-greeting:${participantId}`;
  const capture = exact(voices.filter(({ correlation }) =>
    correlation.purpose === "greeting" && correlation.turnId === turnId
  ), "JOIN_SOURCE_AMBIGUOUS", "speaker-b greeting capture");
  const greeting = exact(lifecycle.events.filter((event) =>
    event.type === "greeting" && event.participantId === participantId
  ), "JOIN_SOURCE_AMBIGUOUS", "speaker-b greeting lifecycle event");
  const greetingObservedAt = Date.parse(greeting.observedAt);
  const receipts = lifecycle.participantLifecycleReceipts.filter((receipt) =>
    receipt.eventType === "participant.joined" && receipt.participantId === participantId &&
    Date.parse(receipt.occurredAt) <= Date.parse(receipt.observedAt) &&
    Date.parse(receipt.observedAt) <= greetingObservedAt
  );
  const receipt = exact(receipts, "JOIN_SOURCE_AMBIGUOUS", "pre-greeting participant join receipt");
  const startSource = {
    eventType: "participant.joined", kind: "participant-joined-receipt", meetingId,
    observedAt: receipt.observedAt, occurredAt: receipt.occurredAt, participantId, runId,
  } as const;
  const endSource = voiceSource(runId, meetingId, capture, "greeting");
  return prepareMeasurement({
    endAtEpochMs: capture.capture.firstPacketAt.epochMilliseconds, endEvidence: capture,
    endSource, serviceLevelId: "join-to-greeting-first-packet",
    startAtEpochMs: Date.parse(receipt.occurredAt), startEvidence: receipt, startSource,
  });
}

function prepareAnswer(input: {
  readonly lifecycle: Lifecycle; readonly manifest: Manifest; readonly meetingId: string;
  readonly runId: string; readonly s3: S3; readonly snapshot: Snapshot;
  readonly supplemental: z.infer<typeof supplementalPlaybackEvidenceV1Schema>;
  readonly voices: readonly Voice[];
}): PreparedMeasurement {
  const { lifecycle, manifest, meetingId, runId, s3, snapshot, supplemental, voices } = input;
  const expectation = manifest.supplementalVoiceExpectation!;
  const recordingStart = Date.parse(s3.startedAt);
  const windowStart = supplemental.playback.startedAtEpochMs - recordingStart;
  const windowEnd = supplemental.playback.endedAtEpochMs - recordingStart;
  const question = exact(turnsContainingAnyTerms(snapshot.transcript.turns.filter((turn) =>
    turn.speakerId === expectation.applicationId && turn.startMs >= windowStart && turn.endMs <= windowEnd
  ), [expectation.answerNonce]), "QUESTION_SOURCE_AMBIGUOUS", "authoritative nonce-bearing question turn");
  const capture = exact(voices.filter(({ correlation }) =>
    correlation.purpose === "addressed-answer"
  ), "ANSWER_SOURCE_INVALID", "addressed-answer voice capture");
  if (capture.correlation.provenance !== "playback-readiness-handshake" ||
    capture.correlation.meetingId !== meetingId) {
    fail("ANSWER_SOURCE_INVALID", "Addressed answer is not bound by the meeting playback handshake");
  }
  exact(lifecycle.events.filter((event) => event.type === "addressed-answer" &&
    event.outcome === "active" && event.participantId === expectation.applicationId &&
    event.turnId === capture.correlation.turnId), "ANSWER_SOURCE_INVALID", "active addressed-answer admission");
  exact(lifecycle.playbackReceipts.filter((receipt) => receipt.status === "started" &&
    receipt.playbackKind === "answer" && receipt.playbackAttemptId === capture.correlation.attemptId &&
    receipt.turnId === capture.correlation.turnId), "ANSWER_SOURCE_INVALID", "addressed-answer playback start");
  const startAt = recordingStart + question.endMs;
  const startSource = {
    kind: "authoritative-transcript-turn-end", meetingId, recordingId: s3.recordingId, runId,
    transcriptId: snapshot.transcript.transcriptId, turnId: question.turnId,
  } as const;
  const endSource = voiceSource(runId, meetingId, capture, "addressed-answer");
  return prepareMeasurement({
    endAtEpochMs: capture.capture.firstPacketAt.epochMilliseconds, endEvidence: capture, endSource,
    serviceLevelId: "question-end-to-answer-first-packet", startAtEpochMs: startAt,
    startEvidence: { recordingId: s3.recordingId, startedAt: s3.startedAt,
      transcriptId: snapshot.transcript.transcriptId, turn: question }, startSource,
  });
}

async function preparePublication(
  runId: string, meetingId: string,
  proof: z.infer<typeof liveDiscordPlaybackLinkProofSchema>, snapshot: Snapshot, s3: S3,
): Promise<PreparedMeasurement> {
  const publication = parseDiscordPublication(
    snapshot.publication.externalPublicationId, snapshot.publicationTargetId,
  );
  const expectedContainer = toEvidenceContainer(publication);
  const proofContainer = proof.container.kind === "channel-message" ? proof.container : {
    kind: "thread" as const, parentChannelId: proof.container.parentId, threadId: proof.container.id,
  };
  if (proof.runId !== runId || proof.recordingId !== s3.recordingId ||
    proof.sutApplicationId !== HOSTED_CAMPAIGN_TARGET.sutApplicationId ||
    proof.resultChannelId !== snapshot.publicationTargetId || proof.messageId !== publication.messageId ||
    JSON.stringify(proofContainer) !== JSON.stringify(expectedContainer) ||
    proof.projectionMarker !== await projectionMarker(snapshot.publication.idempotencyKey)) {
    fail("PUBLICATION_SOURCE_MISMATCH", "Playback-link proof does not match the authoritative publication receipt");
  }
  const startSource = { kind: "authoritative-recording-end", meetingId,
    recordingId: s3.recordingId, runId } as const;
  const endSource = {
    capabilitySha256: proof.link.capabilitySha256, container: proofContainer,
    firstSeenPollCompletedAt: proof.firstSeenPollCompletedAt,
    firstSeenPollStartedAt: proof.firstSeenPollStartedAt,
    kind: "discord-playback-link-first-seen-proof", meetingId, messageId: proof.messageId,
    origin: proof.link.origin, pathname: proof.link.pathname, projectionMarker: proof.projectionMarker,
    recordingId: proof.recordingId, resultChannelId: proof.resultChannelId, runId,
  } as const;
  return prepareMeasurement({
    endAtEpochMs: proof.firstSeenPollCompletedAt.epochMilliseconds, endEvidence: proof, endSource,
    serviceLevelId: "recording-end-to-discord-first-seen", startAtEpochMs: Date.parse(s3.endedAt),
    startEvidence: { endedAt: s3.endedAt, manifestChecksumSha256: s3.manifestChecksumSha256,
      recordingId: s3.recordingId }, startSource,
  });
}

function assertSupplemental(
  supplemental: z.infer<typeof supplementalPlaybackEvidenceV1Schema>, manifest: Manifest,
  runId: string, s3: S3,
): void {
  const expected = manifest.supplementalVoiceExpectation;
  const voice = manifest.conversationVoiceExpectation;
  if (expected === undefined || voice === undefined || supplemental.runId !== runId ||
    supplemental.actor.applicationId !== expected.applicationId ||
    supplemental.actor.authenticatedApplicationId !== expected.applicationId ||
    supplemental.fixture.sha256 !== expected.fixtureSha256 ||
    supplemental.fixture.durationMs !== expected.durationMs ||
    supplemental.target.guildId !== voice.guildId || supplemental.target.voiceChannelId !== voice.voiceChannelId ||
    supplemental.playback.startedAtEpochMs < Date.parse(s3.startedAt) ||
    supplemental.playback.endedAtEpochMs > Date.parse(s3.endedAt)) {
    fail("ANSWER_SOURCE_INVALID", "Supplemental question source is not bound to the run and recording window");
  }
}

function voiceSource(runId: string, meetingId: string, capture: Voice, purpose: "addressed-answer" | "greeting") {
  return {
    attemptId: capture.correlation.attemptId, kind: "conversation-voice-first-packet" as const,
    meetingId, purpose, recordingId: capture.correlation.recordingId!, runId,
    turnId: capture.correlation.turnId,
  };
}

function prepareMeasurement(input: {
  readonly endAtEpochMs: number; readonly endEvidence: unknown;
  readonly endSource: Record<string, unknown>;
  readonly serviceLevelId: PreparedMeasurement["serviceLevelId"];
  readonly startAtEpochMs: number; readonly startEvidence: unknown;
  readonly startSource: Record<string, unknown>;
}): PreparedMeasurement {
  const { endAtEpochMs, endEvidence, endSource, serviceLevelId,
    startAtEpochMs, startEvidence, startSource } = input;
  if (!Number.isSafeInteger(startAtEpochMs) || !Number.isSafeInteger(endAtEpochMs)) {
    fail("AUTHORITATIVE_SOURCE_INVALID", `${serviceLevelId} has an invalid source timestamp`);
  }
  return { endAtEpochMs, endEvidenceSha256: clockEvidenceDigest(endEvidence), endSource,
    serviceLevelId, startAtEpochMs, startEvidenceSha256: clockEvidenceDigest(startEvidence), startSource };
}

function measurementId(source: PreparedMeasurement): string {
  const digest = createHash("sha256").update(JSON.stringify([
    source.serviceLevelId, source.startSource, source.endSource,
  ])).digest("hex").slice(0, 32);
  return `hosted-sla:${source.serviceLevelId}:${digest}`;
}

function exact<T>(values: readonly T[], code: HostedServiceLevelFailureCode, label: string): T {
  if (values.length !== 1) {
    fail(code, `Expected exactly one ${label}, found ${values.length}`);
  }
  return values[0]!;
}

function fail(code: HostedServiceLevelFailureCode, message: string, cause?: unknown): never {
  throw new HostedServiceLevelDerivationError(code, message, cause === undefined ? undefined : { cause });
}
