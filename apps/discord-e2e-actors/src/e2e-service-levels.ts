import { z } from "zod";

import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";
import {
  serviceLevelClockAttestationId,
  serviceLevelEvidenceDigest,
} from "./service-level-attestation-integrity.js";

export const serviceLevelIds = [
  "join-to-greeting-first-packet",
  "question-end-to-answer-first-packet",
  "recording-end-to-discord-first-seen",
] as const;

const identifierSchema = z.string().trim().min(1);
const safeNonNegativeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a nonnegative safe integer",
);
const timestampSchema = z.number().refine(Number.isSafeInteger, "Expected a safe integer timestamp");
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const httpsOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value;
}, "Expected an exact HTTPS origin");
const sourceIdentitySchema = z.object({
  meetingId: identifierSchema,
  runId: identifierSchema,
}).strict();
const voiceFirstPacketSourceSchema = sourceIdentitySchema.extend({
  attemptId: identifierSchema,
  kind: z.literal("conversation-voice-first-packet"),
  recordingId: identifierSchema,
  turnId: identifierSchema,
}).strict();
const endpointBaseSchema = z.object({
  atEpochMs: timestampSchema,
  clockId: identifierSchema,
}).strict();
const clockSkewAttestationSchema = z.object({
  attestationId: sha256Schema,
  clockSkewBoundMs: safeNonNegativeIntegerSchema,
  endClockId: identifierSchema,
  endEvidenceSha256: sha256Schema,
  method: z.literal("host-clock-skew-preflight-v1"),
  schemaVersion: z.literal(1),
  startClockId: identifierSchema,
  startEvidenceSha256: sha256Schema,
}).strict();
const measurementBaseShape = {
  clockSkewAttestation: clockSkewAttestationSchema,
  measurementId: identifierSchema,
  upperBoundMs: safeNonNegativeIntegerSchema,
};

export const joinMeasurementSchema = z.object({
  ...measurementBaseShape,
  end: endpointBaseSchema.extend({
    source: voiceFirstPacketSourceSchema.extend({ purpose: z.literal("greeting") }).strict(),
  }).strict(),
  serviceLevelId: z.literal("join-to-greeting-first-packet"),
  start: endpointBaseSchema.extend({
    source: sourceIdentitySchema.extend({
      eventType: z.literal("participant.joined"),
      kind: z.literal("participant-joined-receipt"),
      observedAt: z.iso.datetime(),
      occurredAt: z.iso.datetime(),
      participantId: identifierSchema,
    }).strict(),
  }).strict(),
}).strict();

export const answerMeasurementSchema = z.object({
  ...measurementBaseShape,
  end: endpointBaseSchema.extend({
    source: voiceFirstPacketSourceSchema.extend({ purpose: z.literal("addressed-answer") }).strict(),
  }).strict(),
  serviceLevelId: z.literal("question-end-to-answer-first-packet"),
  start: endpointBaseSchema.extend({
    source: sourceIdentitySchema.extend({
      kind: z.literal("authoritative-transcript-turn-end"),
      recordingId: identifierSchema,
      transcriptId: identifierSchema,
      turnId: identifierSchema,
    }).strict(),
  }).strict(),
}).strict();

const publicationContainerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel-message"), parentChannelId: identifierSchema }).strict(),
  z.object({
    kind: z.literal("thread"),
    parentChannelId: identifierSchema,
    threadId: identifierSchema,
  }).strict(),
]);
export const recordingPublicationMeasurementSchema = z.object({
  ...measurementBaseShape,
  end: endpointBaseSchema.extend({
    source: sourceIdentitySchema.extend({
      capabilitySha256: sha256Schema,
      container: publicationContainerSchema,
      kind: z.literal("discord-playback-link-first-seen-proof"),
      messageId: identifierSchema,
      origin: httpsOriginSchema,
      pathname: z.literal("/recordings/playback"),
      projectionMarker: identifierSchema,
      recordingId: identifierSchema,
      resultChannelId: identifierSchema,
      firstSeenPollStartedAt: z.object({
        epochMilliseconds: timestampSchema,
        monotonicMilliseconds: safeNonNegativeIntegerSchema,
      }).strict(),
      firstSeenPollCompletedAt: z.object({
        epochMilliseconds: timestampSchema,
        monotonicMilliseconds: safeNonNegativeIntegerSchema,
      }).strict(),
    }).strict(),
  }).strict(),
  serviceLevelId: z.literal("recording-end-to-discord-first-seen"),
  start: endpointBaseSchema.extend({
    source: sourceIdentitySchema.extend({
      kind: z.literal("authoritative-recording-end"),
      recordingId: identifierSchema,
    }).strict(),
  }).strict(),
}).strict();

const serviceLevelMeasurementV1Schema = z.discriminatedUnion("serviceLevelId", [
  joinMeasurementSchema,
  answerMeasurementSchema,
  recordingPublicationMeasurementSchema,
]);

export const e2eServiceLevelsV1Schema = z.object({
  measurements: z.array(serviceLevelMeasurementV1Schema).length(serviceLevelIds.length),
  schemaVersion: z.literal(1),
}).strict().superRefine(({ measurements }, context) => {
  requireUnique(measurements.map(({ measurementId }) => measurementId), "measurementId", context);
  requireUnique(measurements.map(({ serviceLevelId }) => serviceLevelId), "serviceLevelId", context);
  for (const serviceLevelId of serviceLevelIds) {
    if (!measurements.some((measurement) => measurement.serviceLevelId === serviceLevelId)) {
      context.addIssue({ code: "custom", message: `Missing service level ${serviceLevelId}` });
    }
  }
});

export const serviceLevelThresholdsSchema = z.object({
  "join-to-greeting-first-packet": safeNonNegativeIntegerSchema,
  "question-end-to-answer-first-packet": safeNonNegativeIntegerSchema,
  "recording-end-to-discord-first-seen": safeNonNegativeIntegerSchema,
}).strict();

export type E2eServiceLevelsV1 = z.infer<typeof e2eServiceLevelsV1Schema>;
export type ServiceLevelThresholds = z.infer<typeof serviceLevelThresholdsSchema>;

export { serviceLevelClockAttestationId, serviceLevelEvidenceDigest };

export const serviceLevelSourcesV1Schema = z.object({
  discordPlaybackLinkProof: z.object({
    capabilitySha256: sha256Schema, container: publicationContainerSchema,
    firstSeenPollCompletedAt: z.object({ epochMilliseconds: timestampSchema, monotonicMilliseconds: safeNonNegativeIntegerSchema }).strict(),
    firstSeenPollStartedAt: z.object({ epochMilliseconds: timestampSchema, monotonicMilliseconds: safeNonNegativeIntegerSchema }).strict(),
    messageId: identifierSchema, origin: httpsOriginSchema, pathname: z.literal("/recordings/playback"),
    projectionMarker: identifierSchema, recordingId: identifierSchema, resultChannelId: identifierSchema,
    runId: identifierSchema, schemaVersion: z.literal(1),
  }).strict(),
  participantLifecycleReceipts: z.array(z.object({
    eventType: z.enum(["participant.joined", "participant.left"]), occurredAt: z.iso.datetime(),
    observedAt: z.iso.datetime(), participantId: identifierSchema, type: z.literal("participant-lifecycle"),
  }).strict()),
  schemaVersion: z.literal(1),
}).strict();
export type ServiceLevelSourcesV1 = z.infer<typeof serviceLevelSourcesV1Schema>;

export interface ServiceLevelEvidenceSources {
  readonly actorRun: { readonly runId: string };
  readonly conversation: {
    readonly lifecycle: {
      readonly events: readonly { readonly turnId?: string; readonly type: string }[];
      readonly playbackReceipts: readonly {
        readonly playbackAttemptId: string;
        readonly playbackKind: string;
        readonly playbackStartedAtEpochMs?: number;
        readonly status: string;
        readonly turnId: string;
      }[];
    };
    readonly voice: readonly {
      readonly capture: { readonly firstPacketAt: { readonly epochMilliseconds: number } };
      readonly correlation: {
        readonly attemptId: string;
        readonly meetingId?: string;
        readonly purpose: string;
        readonly recordingId: string | null;
        readonly turnId: string;
      };
      readonly runId: string;
    }[];
  };
  readonly meetingId: string;
  readonly publication: {
    readonly container: { readonly kind: string; readonly parentChannelId: string; readonly threadId?: string };
    readonly messageId: string;
  };
  readonly recording: { readonly endedAt: string; readonly recordingId: string; readonly startedAt: string };
  readonly recordingPlayback?: {
    readonly capabilitySha256: string;
    readonly link: { readonly origin: string; readonly pathname: string };
  } | undefined;
  readonly serviceLevelSources?: ServiceLevelSourcesV1;
  readonly transcript: {
    readonly transcriptId: string;
    readonly turns: readonly { readonly endMs: number; readonly turnId: string }[];
  };
}

export function verifyE2eServiceLevels(
  serviceLevels: E2eServiceLevelsV1,
  thresholdsInput: ServiceLevelThresholds,
  evidence: ServiceLevelEvidenceSources,
  fail: VerificationFailureReporter,
): void {
  const thresholds = serviceLevelThresholdsSchema.parse(thresholdsInput);
  for (const measurement of serviceLevels.measurements) {
    const { clockSkewAttestation, end, serviceLevelId, start } = measurement;
    if (!sourceIsBound(measurement, evidence)) {
      fail("SLA_SOURCE_MISMATCH", `${serviceLevelId} is not bound to its retained authoritative receipts`);
      continue;
    }
    const expectedStartEvidenceSha256 = serviceLevelEvidenceDigest(start.source);
    const expectedEndEvidenceSha256 = serviceLevelEvidenceDigest(end.source);
    if (
      clockSkewAttestation.startEvidenceSha256 !== expectedStartEvidenceSha256 ||
      clockSkewAttestation.endEvidenceSha256 !== expectedEndEvidenceSha256
    ) {
      fail("SLA_CLOCK_ATTESTATION_MISMATCH", `${serviceLevelId} source digests do not match retained evidence`);
      continue;
    }
    const expectedAttestationId = serviceLevelClockAttestationId({
      clockSkewBoundMs: clockSkewAttestation.clockSkewBoundMs,
      endClockId: clockSkewAttestation.endClockId,
      endEvidenceSha256: clockSkewAttestation.endEvidenceSha256,
      method: clockSkewAttestation.method,
      serviceLevelId,
      startClockId: clockSkewAttestation.startClockId,
      startEvidenceSha256: clockSkewAttestation.startEvidenceSha256,
    });
    if (clockSkewAttestation.attestationId !== expectedAttestationId) {
      fail("SLA_CLOCK_ATTESTATION_MISMATCH", `${serviceLevelId} attestation ID does not match its content`);
      continue;
    }
    if (
      clockSkewAttestation.startClockId !== start.clockId ||
      clockSkewAttestation.endClockId !== end.clockId
    ) {
      fail("SLA_CLOCK_ATTESTATION_MISMATCH", `${serviceLevelId} clock IDs do not match their attestation`);
      continue;
    }
    const measuredDeltaMs = end.atEpochMs - start.atEpochMs;
    if (measuredDeltaMs + clockSkewAttestation.clockSkewBoundMs < 0) {
      fail("SLA_IMPOSSIBLE_TIMELINE", `${serviceLevelId} end precedes start beyond the attested clock skew`);
      continue;
    }
    const recomputedUpperBoundMs = measuredDeltaMs + clockSkewAttestation.clockSkewBoundMs;
    if (measurement.upperBoundMs !== recomputedUpperBoundMs) {
      fail("SLA_UPPER_BOUND_TAMPERED", `${serviceLevelId} upper bound does not match its timestamps and clock skew`);
      continue;
    }
    if (recomputedUpperBoundMs > thresholds[serviceLevelId]) {
      fail("SLA_THRESHOLD_EXCEEDED", `${serviceLevelId} upper bound exceeds its supplied threshold`);
    }
  }
}

function sourceIsBound(
  measurement: E2eServiceLevelsV1["measurements"][number],
  evidence: ServiceLevelEvidenceSources,
): boolean {
  const identityMatches = (source: { meetingId: string; runId: string; recordingId?: string }) =>
    source.runId === evidence.actorRun.runId && source.meetingId === evidence.meetingId &&
    (source.recordingId === undefined || source.recordingId === evidence.recording.recordingId);
  if (!identityMatches(measurement.start.source) || !identityMatches(measurement.end.source)) {
    return false;
  }

  if (measurement.serviceLevelId === "join-to-greeting-first-packet") {
    return joinSourceIsBound(measurement, evidence);
  }
  if (measurement.serviceLevelId === "question-end-to-answer-first-packet") {
    return answerSourceIsBound(measurement, evidence);
  }
  return recordingPublicationSourceIsBound(measurement, evidence);
}

function joinSourceIsBound(
  measurement: Extract<E2eServiceLevelsV1["measurements"][number], { serviceLevelId: "join-to-greeting-first-packet" }>,
  evidence: ServiceLevelEvidenceSources,
): boolean {
  const voice = matchingVoice(measurement.end.source, evidence);
  const receipt = measurement.start.source;
  const collectedReceiptMatches = evidence.serviceLevelSources?.participantLifecycleReceipts.some((candidate) =>
      candidate.eventType === receipt.eventType && candidate.participantId === receipt.participantId &&
      candidate.occurredAt === receipt.occurredAt && candidate.observedAt === receipt.observedAt
    ) === true;
  return Date.parse(receipt.occurredAt) === measurement.start.atEpochMs &&
    Date.parse(receipt.observedAt) >= Date.parse(receipt.occurredAt) && collectedReceiptMatches &&
    voice?.capture.firstPacketAt.epochMilliseconds === measurement.end.atEpochMs &&
    measurement.start.source.participantId === participantForGreetingTurn(measurement.end.source.turnId);
}

function answerSourceIsBound(
  measurement: Extract<E2eServiceLevelsV1["measurements"][number], { serviceLevelId: "question-end-to-answer-first-packet" }>,
  evidence: ServiceLevelEvidenceSources,
): boolean {
  const turn = evidence.transcript.turns.find(({ turnId }) => turnId === measurement.start.source.turnId);
  const voice = matchingVoice(measurement.end.source, evidence);
  const receipt = evidence.conversation.lifecycle.playbackReceipts.find((candidate) =>
    candidate.status === "started" && candidate.playbackKind === "answer" &&
    candidate.playbackAttemptId === measurement.end.source.attemptId &&
    candidate.turnId === measurement.end.source.turnId
  );
  const addressedEventExists = evidence.conversation.lifecycle.events.some(({ turnId, type }) =>
    type === "addressed-answer" && turnId === measurement.end.source.turnId
  );
  return measurement.start.source.transcriptId === evidence.transcript.transcriptId && turn !== undefined &&
    Date.parse(evidence.recording.startedAt) + turn.endMs === measurement.start.atEpochMs &&
    voice?.capture.firstPacketAt.epochMilliseconds === measurement.end.atEpochMs && receipt !== undefined &&
    addressedEventExists;
}

function recordingPublicationSourceIsBound(
  measurement: Extract<E2eServiceLevelsV1["measurements"][number], { serviceLevelId: "recording-end-to-discord-first-seen" }>,
  evidence: ServiceLevelEvidenceSources,
): boolean {
  const source = measurement.end.source;
  const recordingPlayback = evidence.recordingPlayback;
  const proof = evidence.serviceLevelSources?.discordPlaybackLinkProof;
  if (recordingPlayback === undefined || proof === undefined) {
    return false;
  }
  const timingMatches = sameTiming(proof.firstSeenPollStartedAt, source.firstSeenPollStartedAt) &&
    sameTiming(proof.firstSeenPollCompletedAt, source.firstSeenPollCompletedAt);
  const publicationMatches = sameValues(
    [proof.messageId, proof.projectionMarker, proof.resultChannelId],
    [source.messageId, source.projectionMarker, source.resultChannelId],
  ) && sameContainer(proof.container, source.container);
  const linkMatches = sameValues(
    [proof.capabilitySha256, proof.origin, proof.pathname],
    [source.capabilitySha256, source.origin, source.pathname],
  );
  const retainedPlaybackMatches = sameValues(
    [source.capabilitySha256, source.origin, source.pathname],
    [recordingPlayback.capabilitySha256, recordingPlayback.link.origin, recordingPlayback.link.pathname],
  );
  const proofIdentityMatches = proof.runId === source.runId && proof.recordingId === source.recordingId;
  const measurementMatches = measurement.start.atEpochMs === Date.parse(evidence.recording.endedAt) &&
    source.firstSeenPollCompletedAt.epochMilliseconds === measurement.end.atEpochMs &&
    source.firstSeenPollStartedAt.epochMilliseconds <= source.firstSeenPollCompletedAt.epochMilliseconds &&
    source.firstSeenPollStartedAt.monotonicMilliseconds <= source.firstSeenPollCompletedAt.monotonicMilliseconds;
  return measurementMatches &&
    source.messageId === evidence.publication.messageId &&
    sameContainer(source.container, evidence.publication.container) &&
    retainedPlaybackMatches && proofIdentityMatches && publicationMatches && linkMatches && timingMatches;
}

function sameValues(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function sameTiming(
  first: { readonly epochMilliseconds: number; readonly monotonicMilliseconds: number },
  second: { readonly epochMilliseconds: number; readonly monotonicMilliseconds: number },
): boolean {
  return first.epochMilliseconds === second.epochMilliseconds &&
    first.monotonicMilliseconds === second.monotonicMilliseconds;
}

function matchingVoice(
  source: { attemptId: string; recordingId: string; turnId: string; purpose: string },
  evidence: ServiceLevelEvidenceSources,
) {
  return evidence.conversation.voice.find(({ correlation, runId }) =>
    runId === evidence.actorRun.runId && correlation.attemptId === source.attemptId &&
    correlation.recordingId === source.recordingId && correlation.turnId === source.turnId &&
    correlation.purpose === source.purpose &&
    (correlation.meetingId === undefined || correlation.meetingId === evidence.meetingId)
  );
}

function participantForGreetingTurn(turnId: string): string | undefined {
  const prefix = "participant-greeting:";
  return turnId.startsWith(prefix) ? turnId.slice(prefix.length) : undefined;
}

function sameContainer(
  source: { kind: string; parentChannelId: string; threadId?: string },
  retained: { kind: string; parentChannelId: string; threadId?: string },
): boolean {
  return source.kind === retained.kind && source.parentChannelId === retained.parentChannelId &&
    source.threadId === retained.threadId;
}

function requireUnique(values: readonly string[], field: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `Duplicate ${field}` });
  }
}
