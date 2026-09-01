import { createHash } from "node:crypto";

import { z } from "zod";

import {
  deploymentRevisionExpectationSchema,
  unboundActorRunEvidenceV1Schema,
} from "./e2e-evidence.js";
import type {
  CurrentDeploymentProvenance,
  DeploymentRevisionExpectation,
} from "./e2e-evidence.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";
import {
  recordingReadyProducerEvidenceV1Schema,
  sealRecordingReadyProducerEvidenceV1,
} from "./recording-ready-producer-evidence.js";
export {
  sealRecordingReadyProducerEvidenceV1,
} from "./recording-ready-producer-evidence.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const snowflake = z.string().regex(/^\d{17,20}$/u);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const storedEventSchema = z.object({
  digest: sha256,
  eventId: identifier,
  occurredAt: z.iso.datetime(),
  type: z.string().min(1),
}).strict();

const actorSchema = z.object({
  actorId: snowflake,
  kind: z.enum(["human", "automation", "unknown"]),
}).strict();
const actorRosterSchema = z.array(actorSchema).superRefine((actors, context) => {
  const kindsByActor = new Map<string, string>();
  for (const [index, actor] of actors.entries()) {
    const existing = kindsByActor.get(actor.actorId);
    if (existing !== undefined) {
      context.addIssue({
        code: "custom",
        message: existing === actor.kind
          ? "Actor roster cannot repeat an actor"
          : "Actor roster contains conflicting actor kinds",
        path: [index, "actorId"],
      });
    }
    kindsByActor.set(actor.actorId, actor.kind);
  }
});

const speakerAudioSchema = z.object({
  audioLocator: z.string().min(1),
  speakerId: snowflake,
  timelineOffsetMs: z.number().int().nonnegative(),
}).strict();

const authoritativeTrackSchema = z.object({
  audioLocator: z.string().min(1),
  checksumSha256: sha256,
  sizeBytes: z.number().int().positive(),
  speakerId: snowflake,
  timelineOffsetMs: z.number().int().nonnegative(),
  trackNumber: z.number().int().positive(),
  uploadId: identifier,
}).strict();

const identityProvenanceSchema = z.object({
  actorObservationState: z.enum(["consistent", "conflicted"]),
  actorSemanticsVersion: z.number().int().positive().max(1_000),
  producerCapabilityId: z.string().min(1).max(128),
  producerRevision: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u),
  rosterState: z.enum(["sealed", "unsealed"]),
}).strict();

const completionReceiptFields = {
  channelId: snowflake,
  events: z.array(storedEventSchema).min(2),
  finalEventDigest: sha256,
  finalEventId: identifier,
  guildId: snowflake,
  recording: z.object({
    manifestLocator: z.string().min(1),
    recordingId: identifier,
    speakerAudio: z.array(speakerAudioSchema).min(1),
  }).strict(),
  recordingId: identifier,
} as const;

const recordingCompletionReceiptV2Schema = z.looseObject({
  ...completionReceiptFields,
  schemaVersion: z.literal(2),
});

const recordingCompletionReceiptV3Schema = z.looseObject({
  ...completionReceiptFields,
  actors: actorRosterSchema.nullable(),
  authoritativeTracks: z.array(authoritativeTrackSchema).min(1),
  lifecycleSchemaVersion: z.union([z.literal(1), z.literal(2)]),
  schemaVersion: z.literal(3),
}).superRefine((receipt, context) => {
  if (receipt.lifecycleSchemaVersion === 1 && receipt.actors !== null) {
    context.addIssue({ code: "custom", message: "V1 lifecycle identity must remain legacy-null", path: ["actors"] });
  }
  if (receipt.lifecycleSchemaVersion === 2 && receipt.actors === null) {
    context.addIssue({ code: "custom", message: "V2 lifecycle receipt requires actors", path: ["actors"] });
    return;
  }
  if (receipt.actors !== null) {
    const actorIds = new Set(receipt.actors.map((actor) => actor.actorId));
    for (const [index, track] of receipt.recording.speakerAudio.entries()) {
      if (!actorIds.has(track.speakerId)) {
        context.addIssue({
          code: "custom",
          message: "Authoritative speaker track requires actor identity",
          path: ["recording", "speakerAudio", index, "speakerId"],
        });
      }
    }
  }
  const tracksBySpeaker = new Map(
    receipt.authoritativeTracks.map((track) => [track.speakerId, track]),
  );
  for (const [index, speaker] of receipt.recording.speakerAudio.entries()) {
    const track = tracksBySpeaker.get(speaker.speakerId);
    if (track === undefined || track.audioLocator !== speaker.audioLocator ||
      track.timelineOffsetMs !== speaker.timelineOffsetMs) {
      context.addIssue({
        code: "custom",
        message: "Authoritative track identity does not match recording snapshot",
        path: ["recording", "speakerAudio", index],
      });
    }
  }
});

const recordingCompletionReceiptV4Schema = z.union([
  z.looseObject({
    ...completionReceiptFields,
    actors: z.null(),
    authoritativeTracks: z.array(authoritativeTrackSchema).min(1),
    identityProvenance: z.null(),
    lifecycleSchemaVersion: z.literal(1),
    schemaVersion: z.literal(4),
  }),
  z.looseObject({
    ...completionReceiptFields,
    actors: actorRosterSchema,
    authoritativeTracks: z.array(authoritativeTrackSchema).min(1),
    identityProvenance: z.null(),
    lifecycleSchemaVersion: z.literal(2),
    schemaVersion: z.literal(4),
  }),
  z.looseObject({
    ...completionReceiptFields,
    actors: actorRosterSchema,
    authoritativeTracks: z.array(authoritativeTrackSchema).min(1),
    identityProvenance: identityProvenanceSchema,
    lifecycleSchemaVersion: z.literal(3),
    schemaVersion: z.literal(4),
  }),
]).superRefine((receipt, context) => {
  if (receipt.actors === null) {
    return;
  }
  const actorIds = new Set(receipt.actors.map((actor) => actor.actorId));
  for (const [index, track] of receipt.recording.speakerAudio.entries()) {
    if (!actorIds.has(track.speakerId)) {
      context.addIssue({
        code: "custom",
        message: "Authoritative speaker track requires actor identity",
        path: ["recording", "speakerAudio", index, "speakerId"],
      });
    }
  }
  const tracksBySpeaker = new Map(
    receipt.authoritativeTracks.map((track) => [track.speakerId, track]),
  );
  for (const [index, speaker] of receipt.recording.speakerAudio.entries()) {
    const track = tracksBySpeaker.get(speaker.speakerId);
    if (track === undefined || track.audioLocator !== speaker.audioLocator ||
      track.timelineOffsetMs !== speaker.timelineOffsetMs) {
      context.addIssue({
        code: "custom",
        message: "Authoritative track identity does not match recording snapshot",
        path: ["recording", "speakerAudio", index],
      });
    }
  }
});

const recordingCompletionReceiptSchema = z.union([
  recordingCompletionReceiptV2Schema,
  recordingCompletionReceiptV3Schema,
  recordingCompletionReceiptV4Schema,
]);

export const recordingReadyReceiptV1Schema = z.object({
  authoritativeSource: z.object({
    eventDigestSha256: sha256,
    eventId: identifier,
    kind: z.enum([
      "meeting-platform-completion-receipt-v2",
      "meeting-platform-completion-receipt-v3",
      "meeting-platform-completion-receipt-v4",
    ]),
    occurredAt: z.iso.datetime(),
  }).strict(),
  meetingId: identifier,
  observedAt: z.iso.datetime(),
  pinnedTestTarget: z.object({
    guildId: z.literal(HOSTED_CAMPAIGN_TARGET.guildId),
    provenanceDigestSha256: sha256,
    voiceChannelId: z.literal(HOSTED_CAMPAIGN_TARGET.voiceChannelId),
  }).strict(),
  recordingId: identifier,
  runId: identifier,
  schemaVersion: z.literal(1),
}).strict().refine(({ meetingId, recordingId }) => meetingId === recordingId, {
  message: "meetingId must equal recordingId",
});

export const recordingReadyReceiptV2Schema = z.object({
  ...recordingReadyReceiptV1Schema.shape,
  authoritativeSource: z.object({
    eventDigestSha256: sha256,
    eventId: identifier,
    eventType: z.literal("recording.authoritative_ready"),
    kind: z.literal("meeting-platform-completion-receipt-v4"),
    lifecycleGeneration: z.literal(3),
    occurredAt: z.iso.datetime(),
  }).strict(),
  producerEvidence: recordingReadyProducerEvidenceV1Schema,
  schemaVersion: z.literal(2),
}).strict().superRefine((receipt, context) => {
  const identity = receipt.producerEvidence.meetingIdentity;
  if (identity.meetingId !== receipt.meetingId || identity.recordingId !== receipt.recordingId ||
    identity.guildId !== receipt.pinnedTestTarget.guildId ||
    identity.channelId !== receipt.pinnedTestTarget.voiceChannelId) {
    context.addIssue({ code: "custom", message: "Producer evidence is bound to another recording target" });
  }
  if (receipt.meetingId !== receipt.recordingId) {
    context.addIssue({ code: "custom", message: "meetingId must equal recordingId" });
  }
  const completion = receipt.producerEvidence.authoritativeLifecycleCompletion;
  if (JSON.stringify(completion) !== JSON.stringify({
    eventDigestSha256: receipt.authoritativeSource.eventDigestSha256,
    eventId: receipt.authoritativeSource.eventId,
    eventType: receipt.authoritativeSource.eventType,
    lifecycleGeneration: receipt.authoritativeSource.lifecycleGeneration,
    occurredAt: receipt.authoritativeSource.occurredAt,
    receiptKind: receipt.authoritativeSource.kind,
  })) {
    context.addIssue({ code: "custom",
      message: "Producer evidence does not bind the recording-ready authoritative completion event" });
  }
});

export const recordingReadyReceiptSchema = z.union([
  recordingReadyReceiptV1Schema,
  recordingReadyReceiptV2Schema,
]);
export type RecordingReadyReceiptV2 = z.infer<typeof recordingReadyReceiptV2Schema>;

export class RecordingReadyNotObservedError extends Error {
  public constructor() {
    super("Expected exactly one authoritative completion receipt, found 0");
    this.name = "RecordingReadyNotObservedError";
  }
}

export function deriveRecordingReadyReceipt(input: {
  readonly actorRun: unknown;
  readonly completionReceipts: readonly unknown[];
  readonly expectedRevisions: DeploymentRevisionExpectation;
  readonly observedAt: string;
  readonly provenance: CurrentDeploymentProvenance;
}): RecordingReadyReceiptV2 {
  const actorRun = unboundActorRunEvidenceV1Schema.parse(input.actorRun);
  assertV9DeploymentProvenance(input.provenance, input.expectedRevisions);
  const candidates = input.completionReceipts
    .map((value) => recordingCompletionReceiptSchema.parse(value))
    .filter(({ guildId, channelId }) =>
      guildId === HOSTED_CAMPAIGN_TARGET.guildId &&
      channelId === HOSTED_CAMPAIGN_TARGET.voiceChannelId
    )
    .filter((receipt) => actorRunFitsWindow(actorRun.events, receipt));
  if (candidates.length !== 1) {
    if (candidates.length === 0) {
      throw new RecordingReadyNotObservedError();
    }
    throw new Error(`Expected exactly one authoritative completion receipt, found ${candidates.length}`);
  }
  const completion = candidates[0]!;
  if (completion.schemaVersion !== 4 || completion.lifecycleSchemaVersion !== 3) {
    throw new Error("Recording-ready trusted-human evidence requires an authoritative Craig V4 lifecycle-v3 receipt");
  }
  if (completion.recording.recordingId !== completion.recordingId) {
    throw new Error("Completion receipt recording identity is inconsistent");
  }
  const finalEvent = completion.events.find(({ eventId }) => eventId === completion.finalEventId);
  if (finalEvent?.type !== "recording.authoritative_ready" ||
    finalEvent.digest !== completion.finalEventDigest) {
    throw new Error("Completion receipt does not bind its authoritative-ready event");
  }
  const producerEvidence = sealRecordingReadyProducerEvidenceV1({
    actors: [...completion.actors].toSorted((left, right) =>
      left.actorId.localeCompare(right.actorId) || left.kind.localeCompare(right.kind)),
    authoritativeLifecycleCompletion: {
      eventDigestSha256: finalEvent.digest,
      eventId: finalEvent.eventId,
      eventType: finalEvent.type,
      lifecycleGeneration: completion.lifecycleSchemaVersion,
      occurredAt: finalEvent.occurredAt,
      receiptKind: "meeting-platform-completion-receipt-v4",
    },
    craigDeployment: input.provenance.craig,
    identityProvenance: completion.identityProvenance,
    lifecycleGeneration: completion.lifecycleSchemaVersion,
    meetingIdentity: {
      channelId: completion.channelId,
      guildId: completion.guildId,
      meetingId: completion.recordingId,
      recordingId: completion.recordingId,
    },
  });
  return recordingReadyReceiptV2Schema.parse({
    authoritativeSource: {
      eventDigestSha256: finalEvent.digest,
      eventId: finalEvent.eventId,
      eventType: finalEvent.type,
      kind: "meeting-platform-completion-receipt-v4",
      lifecycleGeneration: completion.lifecycleSchemaVersion,
      occurredAt: finalEvent.occurredAt,
    },
    meetingId: completion.recordingId,
    observedAt: input.observedAt,
    pinnedTestTarget: {
      guildId: HOSTED_CAMPAIGN_TARGET.guildId,
      provenanceDigestSha256: deploymentProvenanceDigest(input.provenance),
      voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
    },
    recordingId: completion.recordingId,
    producerEvidence,
    runId: actorRun.runId,
    schemaVersion: 2,
  });
}

export function assertV9DeploymentProvenance(
  provenance: CurrentDeploymentProvenance,
  expectedRevisions: DeploymentRevisionExpectation,
): void {
  const revisions = deploymentRevisionExpectationSchema.parse(expectedRevisions);
  if (revisions.pipecat === undefined || revisions.subscriptionRuntime === undefined) {
    throw new Error("Recording-ready V9 provenance requires all four release-candidate revisions");
  }
  if (provenance.pipecat === undefined) {
    throw new Error("Recording-ready V9 provenance requires the Pipecat component");
  }
  const components = [
    ["craig", provenance.craig, revisions.craig],
    ["meetingPlatform", provenance.meetingPlatform, revisions.meetingPlatform],
    ["pipecat", provenance.pipecat, revisions.pipecat],
    ["subscriptionRuntime", provenance.subscriptionRuntime, revisions.subscriptionRuntime],
  ] as const;
  for (const [component, observed, expected] of components) {
    if (observed.sourceRevision !== expected) {
      throw new Error(`Recording-ready ${component} provenance does not match the release candidate`);
    }
  }
}

function actorRunFitsWindow(
  actorEvents: readonly { readonly atEpochMs: number }[],
  completion: z.infer<typeof recordingCompletionReceiptSchema>,
): boolean {
  const starts = completion.events.filter(({ type }) => type === "meeting.started");
  const finalEvent = completion.events.find(({ eventId }) => eventId === completion.finalEventId);
  if (starts.length !== 1 || finalEvent?.type !== "recording.authoritative_ready") {
    return false;
  }
  const startedAt = Date.parse(starts[0]!.occurredAt);
  const endedAt = Date.parse(finalEvent.occurredAt);
  return endedAt > startedAt && actorEvents.every(
    ({ atEpochMs }) => atEpochMs >= startedAt && atEpochMs <= endedAt,
  );
}

export function deploymentProvenanceDigest(provenance: CurrentDeploymentProvenance): string {
  return canonicalDigest(provenance);
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}
