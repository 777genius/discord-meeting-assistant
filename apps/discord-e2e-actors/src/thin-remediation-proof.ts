import { z } from "zod";

import { finalizedLiveMemoryQualificationV1Schema } from "./finalized-live-memory-qualification.js";
import {
  greetingLedgerQualificationV1Schema,
  OFFICIAL_GREETING_TEST_IDENTITIES,
} from "./greeting-ledger-qualification.js";
import { historicalReplyCampaignEvidenceV1Schema } from "./historical-reply-campaign-contract.js";
import { hostedCampaignReleaseReferenceV1Schema } from "./hosted-campaign-release-reference.js";
import { lateGreetingObservationV1Schema } from "./late-greeting-observation.js";
import { privateCampaignCoverageQualificationV1Schema } from
  "./private-campaign-coverage-qualification.js";
import { recordingReadyProducerEvidenceV1Schema } from
  "./recording-ready-producer-evidence.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const snowflake = z.string().regex(/^\d{17,20}$/u);
const retainedRecordingReadyV2Schema = z.object({
  authoritativeSource: z.object({
    eventDigestSha256: sha256, eventId: identifier,
    eventType: z.literal("recording.authoritative_ready"),
    kind: z.literal("meeting-platform-completion-receipt-v4"),
    lifecycleGeneration: z.literal(3), occurredAt: z.iso.datetime(),
  }).strict(),
  meetingId: identifier, observedAt: z.iso.datetime(),
  pinnedTestTarget: z.object({ guildId: snowflake, provenanceDigestSha256: sha256,
    voiceChannelId: snowflake }).strict(),
  producerEvidence: recordingReadyProducerEvidenceV1Schema,
  recordingId: identifier, runId: identifier, schemaVersion: z.literal(2),
}).strict();
const artifact = <Schema extends z.ZodType>(role: string, schema: Schema) => z.object({
  content: schema,
  outputArtifactSha256: sha256,
  role: z.literal(role),
}).strict();

export { OFFICIAL_GREETING_TEST_IDENTITIES };

export const thinRemediationProofV1Schema = z.object({
  artifacts: z.object({
    greetingLedger: artifact("greeting-ledger", greetingLedgerQualificationV1Schema),
    historicalReply: artifact("historical-reply", historicalReplyCampaignEvidenceV1Schema),
    lateGreeting: artifact("late-greeting", lateGreetingObservationV1Schema),
    liveMemory: artifact("live-memory", finalizedLiveMemoryQualificationV1Schema),
    privateCoverage: artifact("private-coverage", privateCampaignCoverageQualificationV1Schema),
    recordingReady: artifact("recording-ready", retainedRecordingReadyV2Schema),
  }).strict(),
  campaignId: identifier,
  kind: z.literal("hosted-campaign-remediation-bundle"),
  release: hostedCampaignReleaseReferenceV1Schema,
  runId: identifier,
  schemaVersion: z.literal(3),
}).strict().superRefine((proof, context) => {
  const contents = Object.values(proof.artifacts).map(({ content }) => content);
  if (contents.some((content) => {
    const record = content as { campaignId?: string; runId?: string };
    if ("campaign" in content) {
      return content.campaign.campaignId !== proof.campaignId ||
        content.campaign.runId !== proof.runId;
    }
    return record.runId !== proof.runId ||
      (record.campaignId !== undefined && record.campaignId !== proof.campaignId);
  })) {
    context.addIssue({ code: "custom", message: "Remediation bundle artifacts must bind one admitted campaign run" });
  }
  if (proof.artifacts.lateGreeting.content.greetingLedgerSha256 !==
    proof.artifacts.greetingLedger.outputArtifactSha256) {
    context.addIssue({ code: "custom", message: "Late greeting interval must hash the exact settled greeting ledger artifact" });
  }
  if (JSON.stringify(proof.artifacts.historicalReply.content.campaign.release) !==
    JSON.stringify(proof.release)) {
    context.addIssue({ code: "custom", message: "Remediation bundle release differs from historical campaign evidence" });
  }
  try {
    assertHistoricalLifecycleMatchesRecordingReady(
      proof.artifacts.historicalReply.content.campaign.producerEvidence,
      proof.artifacts.recordingReady.content,
    );
  } catch {
    context.addIssue({ code: "custom",
      message: "Historical evidence differs from the independent recording-ready lifecycle receipt" });
  }
});

export type ThinRemediationProofV1 = z.infer<typeof thinRemediationProofV1Schema>;

export function assertHistoricalLifecycleMatchesRecordingReady(
  producerValue: unknown,
  readyValue: unknown,
): void {
  const producer = recordingReadyProducerEvidenceV1Schema.parse(producerValue);
  const ready = retainedRecordingReadyV2Schema.parse(readyValue);
  if (JSON.stringify(producer) !== JSON.stringify(ready.producerEvidence) ||
    JSON.stringify(producer.authoritativeLifecycleCompletion) !== JSON.stringify({
      eventDigestSha256: ready.authoritativeSource.eventDigestSha256,
      eventId: ready.authoritativeSource.eventId,
      eventType: ready.authoritativeSource.eventType,
      lifecycleGeneration: ready.authoritativeSource.lifecycleGeneration,
      occurredAt: ready.authoritativeSource.occurredAt,
      receiptKind: ready.authoritativeSource.kind,
    })) {
    throw new Error("Historical lifecycle evidence differs from recording-ready authority");
  }
}

export function assertThinRemediationProofMatchesPlan(
  proofValue: unknown,
  plan: { readonly historicalReplyObservationPolicy?: unknown },
): ThinRemediationProofV1 {
  const proof = thinRemediationProofV1Schema.parse(proofValue);
  assertGovernedObservationPolicyMatchesPlan(
    proof.artifacts.historicalReply.content.campaign.observationScope,
    plan,
  );
  return proof;
}

export function assertGovernedObservationPolicyMatchesPlan(
  observationScope: unknown,
  plan: { readonly historicalReplyObservationPolicy?: unknown },
): void {
  if (plan.historicalReplyObservationPolicy === undefined ||
    JSON.stringify(observationScope) !== JSON.stringify(plan.historicalReplyObservationPolicy)) {
    throw new Error("Retained governed observation scope differs from the compiled campaign plan");
  }
}
