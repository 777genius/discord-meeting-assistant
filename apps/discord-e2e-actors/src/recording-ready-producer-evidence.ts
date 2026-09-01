import { createHash } from "node:crypto";

import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const snowflake = z.string().regex(/^\d{17,20}$/u);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const actors = z.array(z.object({
  actorId: snowflake,
  kind: z.enum(["human", "automation", "unknown"]),
}).strict()).min(1).max(1_000).superRefine((roster, context) => {
  const seen = new Set<string>();
  for (const [index, actor] of roster.entries()) {
    if (seen.has(actor.actorId)) {
      context.addIssue({ code: "custom", message: "Producer actor roster contains duplicates",
        path: [index, "actorId"] });
    }
    seen.add(actor.actorId);
  }
});

const producerEvidenceBodyV1Schema = z.object({
  actors,
  authoritativeLifecycleCompletion: z.object({
    eventDigestSha256: sha256,
    eventId: identifier,
    eventType: z.literal("recording.authoritative_ready"),
    lifecycleGeneration: z.literal(3),
    occurredAt: z.iso.datetime(),
    receiptKind: z.literal("meeting-platform-completion-receipt-v4"),
  }).strict(),
  craigDeployment: z.object({
    composeConfigHash: sha256,
    composeProject: identifier,
    composeService: identifier,
    containerId: sha256,
    containerStartedAt: z.iso.datetime(),
    imageId: z.string().regex(/^sha256:[a-f\d]{64}$/u),
    repositoryDigest: z.string().min(1).max(1_000).nullable(),
    sourceRevision: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u),
  }).strict(),
  identityProvenance: z.object({
    actorObservationState: z.literal("consistent"),
    actorSemanticsVersion: z.literal(1),
    producerCapabilityId: z.literal("meeting.lifecycle.sealed-actor-roster.v1"),
    producerRevision: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u),
    rosterState: z.literal("sealed"),
  }).strict(),
  lifecycleGeneration: z.literal(3),
  meetingIdentity: z.object({
    channelId: snowflake,
    guildId: snowflake,
    meetingId: identifier,
    recordingId: identifier,
  }).strict(),
}).strict();

export const recordingReadyProducerEvidenceV1Schema = producerEvidenceBodyV1Schema.extend({
  canonicalSealSha256: sha256,
}).strict().superRefine((evidence, context) => {
  const { canonicalSealSha256, ...body } = evidence;
  if (canonicalDigest(body) !== canonicalSealSha256) {
    context.addIssue({ code: "custom", message: "Recording-ready producer evidence seal is invalid" });
  }
  if (evidence.identityProvenance.producerRevision !== evidence.craigDeployment.sourceRevision) {
    context.addIssue({ code: "custom",
      message: "Producer revision must equal the retained Craig source revision",
      path: ["identityProvenance", "producerRevision"] });
  }
  if (evidence.meetingIdentity.meetingId !== evidence.meetingIdentity.recordingId) {
    context.addIssue({ code: "custom", message: "Producer meeting and recording identity differ" });
  }
});

export function sealRecordingReadyProducerEvidenceV1(
  value: unknown,
): z.infer<typeof recordingReadyProducerEvidenceV1Schema> {
  const body = producerEvidenceBodyV1Schema.parse(value);
  return recordingReadyProducerEvidenceV1Schema.parse({
    ...body, canonicalSealSha256: canonicalDigest(body),
  });
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) =>
      left.localeCompare(right)).map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}
