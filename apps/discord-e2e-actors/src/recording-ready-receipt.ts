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

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const snowflake = z.string().regex(/^\d{17,20}$/u);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const storedEventSchema = z.object({
  digest: sha256,
  eventId: identifier,
  occurredAt: z.iso.datetime(),
  type: z.string().min(1),
}).strict();

export const recordingCompletionReceiptSchema = z.object({
  channelId: snowflake,
  events: z.array(storedEventSchema).min(2),
  finalEventDigest: sha256,
  finalEventId: identifier,
  guildId: snowflake,
  recording: z.object({
    manifestLocator: z.string().min(1),
    recordingId: identifier,
    speakerAudio: z.array(z.object({
      audioLocator: z.string().min(1),
      speakerId: snowflake,
      timelineOffsetMs: z.number().int().nonnegative(),
    }).strict()).min(1),
  }).strict(),
  recordingId: identifier,
  schemaVersion: z.literal(2),
}).passthrough();

export const recordingReadyReceiptV1Schema = z.object({
  authoritativeSource: z.object({
    eventDigestSha256: sha256,
    eventId: identifier,
    kind: z.literal("meeting-platform-completion-receipt-v2"),
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

export type RecordingReadyReceiptV1 = z.infer<typeof recordingReadyReceiptV1Schema>;

export function deriveRecordingReadyReceipt(input: {
  readonly actorRun: unknown;
  readonly completionReceipts: readonly unknown[];
  readonly expectedRevisions: DeploymentRevisionExpectation;
  readonly observedAt: string;
  readonly provenance: CurrentDeploymentProvenance;
}): RecordingReadyReceiptV1 {
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
    throw new Error(`Expected exactly one authoritative completion receipt, found ${candidates.length}`);
  }
  const completion = candidates[0]!;
  if (completion.recording.recordingId !== completion.recordingId) {
    throw new Error("Completion receipt recording identity is inconsistent");
  }
  const finalEvent = completion.events.find(({ eventId }) => eventId === completion.finalEventId);
  if (finalEvent?.type !== "recording.authoritative_ready" ||
    finalEvent.digest !== completion.finalEventDigest) {
    throw new Error("Completion receipt does not bind its authoritative-ready event");
  }
  return recordingReadyReceiptV1Schema.parse({
    authoritativeSource: {
      eventDigestSha256: finalEvent.digest,
      eventId: finalEvent.eventId,
      kind: "meeting-platform-completion-receipt-v2",
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
    runId: actorRun.runId,
    schemaVersion: 1,
  });
}

function assertV9DeploymentProvenance(
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
  return createHash("sha256").update(JSON.stringify(canonicalize(provenance))).digest("hex");
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
