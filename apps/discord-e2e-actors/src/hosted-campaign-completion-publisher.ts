import { z } from "zod";

import type { HostedCampaignArtifactStore } from "./hosted-campaign-artifact-store.js";
import type { HostedCampaignExecutableSpec } from "./hosted-campaign-coordinator.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";
import type { HostedFiniteProcessCompletion } from "./hosted-finite-process-contract.js";
import { verifyHostedFiniteProcessCompletion } from "./hosted-finite-process-completion.js";
import { hostedCampaignProvenanceCompletionV1Schema } from "./hosted-campaign-provenance.js";
import { recordingReadyReceiptV1Schema } from "./recording-ready-receipt.js";
import { verifyHostedServiceLevelCompletion } from "./hosted-service-level-completion.js";
import {
  hostedServiceLevelSourceReportV1Schema,
  readPrivateHostedServiceLevelArtifact,
} from "./hosted-service-level-source-artifact.js";

const evidenceVerificationOutputSchema = z.object({
  failures: z.array(z.unknown()), metrics: z.array(z.unknown()), passed: z.literal(true),
}).strict();
const campaignVerificationOutputSchema = z.object({
  failures: z.array(z.unknown()), passed: z.literal(true),
  runResults: z.record(z.string(), z.object({
    failures: z.array(z.unknown()), metrics: z.array(z.unknown()), passed: z.literal(true),
  }).strict()),
}).strict();
const collectorOutputSchema = z.object({
  evidencePath: z.string(), metrics: z.array(z.unknown()), recordingId: z.string(),
  runId: z.string(), status: z.literal("passed"),
}).strict();

type Completion = NonNullable<HostedCampaignExecutableSpec["completion"]>;

export async function publishHostedCampaignCompletion(input: {
  readonly artifactStore: HostedCampaignArtifactStore;
  readonly completion: Completion;
  readonly childId: string;
  readonly stdoutChunks: readonly Buffer[];
}): Promise<void> {
  const { artifactStore, childId, completion, stdoutChunks } = input;
  if (completion.kind === "service-level-sources") {
    await publishServiceLevelSourceCompletion(stdoutChunks, completion, artifactStore);
    return;
  }
  if (isFiniteCompletion(completion)) {
    await publishFiniteCompletion(stdoutChunks, completion, artifactStore);
    return;
  }
  const output = parseJsonOutput(stdoutChunks, childId);
  if (completion.kind === "provenance-probe") {
    const parsed = hostedCampaignProvenanceCompletionV1Schema.parse(output);
    if (parsed.campaignId !== completion.campaignId || parsed.phase !== completion.phase
      || JSON.stringify(parsed.runIds) !== JSON.stringify(completion.runIds)
      || JSON.stringify(parsed.target) !== JSON.stringify(HOSTED_CAMPAIGN_TARGET)) {
      throw new Error(`Hosted campaign provenance ${childId} output correlation mismatch`);
    }
    await artifactStore.publishAction(completion.action, { digestSha256: parsed.digestSha256 });
    return;
  }
  if (completion.kind === "collector") {
    const parsed = collectorOutputSchema.parse(output);
    if (parsed.evidencePath !== completion.evidencePath || parsed.runId !== completion.runId) {
      throw new Error(`Hosted campaign collector ${childId} output correlation mismatch`);
    }
    await artifactStore.publishAction(completion.action, {
      ordinal: completion.action.ordinal, runId: completion.action.runId, verified: true,
    });
    return;
  }
  if (completion.kind === "service-levels") {
    const identity = await verifyHostedServiceLevelCompletion(output, completion);
    await artifactStore.publishAction(completion.action, {
      measurementCount: 3, outputPath: completion.outputPath,
      recordingId: identity.recordingId, runId: completion.runId,
    });
    return;
  }
  if (completion.kind === "evidence-verifier") {
    evidenceVerificationOutputSchema.parse(output);
    await artifactStore.publishAction(completion.action, {
      ordinal: completion.action.ordinal, runId: completion.action.runId, verified: true,
    });
    return;
  }
  const parsed = campaignVerificationOutputSchema.parse(output);
  if (JSON.stringify(Object.keys(parsed.runResults).toSorted())
    !== JSON.stringify(completion.runIds.toSorted())) {
    throw new Error(`Hosted campaign verifier ${childId} run results mismatch`);
  }
  await artifactStore.publishAction(completion.action, { campaignId: completion.campaignId });
}

async function publishServiceLevelSourceCompletion(
  chunks: readonly Buffer[], completion: Extract<Completion, { readonly kind: "service-level-sources" }>,
  artifactStore: HostedCampaignArtifactStore,
): Promise<void> {
  const stdout = Buffer.concat(chunks).toString("utf8");
  await verifyServiceLevelSourceCompletion(stdout, completion);
  await artifactStore.publishAction(completion.action, {
    outputPath: completion.reportPath, runId: completion.runId, sourcesReady: true,
  });
}

async function publishFiniteCompletion(
  chunks: readonly Buffer[], completion: HostedFiniteProcessCompletion,
  artifactStore: HostedCampaignArtifactStore,
): Promise<void> {
  const verifiedArtifact = await verifyHostedFiniteProcessCompletion(
    Buffer.concat(chunks).toString("utf8"), completion,
  );
  const coordinates = completion.kind === "recording-ready"
    ? recordingIdentityCoordinates(verifiedArtifact) : {};
  await artifactStore.publishAction(completion.action, {
    completed: true, ordinal: completion.action.ordinal, runId: completion.action.runId, ...coordinates,
  });
}

async function verifyServiceLevelSourceCompletion(
  stdout: string, expected: Extract<Completion, { readonly kind: "service-level-sources" }>,
): Promise<void> {
  const line = stdout.trimEnd().split("\n").at(-1);
  if (line === undefined) {throw new Error("Hosted service-level sources produced no completion output");}
  const parsed = z.object({
    campaignId: z.literal(expected.campaignId), clockAttestationsPath: z.literal(expected.clockAttestationsPath),
    databasePath: z.literal(expected.databasePath), kind: z.literal("hosted-service-level-sources-completion"),
    meetingId: z.string(), meetingPlatformLogsPath: z.literal(expected.meetingPlatformLogsPath),
    recordingId: z.string(), reportPath: z.literal(expected.reportPath), runId: z.literal(expected.runId),
    s3Path: z.literal(expected.s3Path), status: z.literal("ready"),
  }).strict().parse(JSON.parse(line) as unknown);
  if ((expected.meetingId !== undefined && parsed.meetingId !== expected.meetingId)
    || (expected.recordingId !== undefined && parsed.recordingId !== expected.recordingId)) {
    throw new Error("Hosted service-level source completion identity mismatch");
  }
  const report = hostedServiceLevelSourceReportV1Schema.parse(JSON.parse(
    await readPrivateHostedServiceLevelArtifact(expected.reportPath),
  ) as unknown);
  if (report.status !== "ready" || report.campaignId !== expected.campaignId
    || report.runId !== expected.runId || report.meetingId !== parsed.meetingId
    || report.recordingId !== parsed.recordingId || report.reportPath !== expected.reportPath
    || report.outputs.database !== expected.databasePath || report.outputs.s3 !== expected.s3Path
    || report.outputs.meetingPlatformLogs !== expected.meetingPlatformLogsPath
    || report.outputs.clockAttestations !== expected.clockAttestationsPath) {
    throw new Error("Hosted service-level source report is not ready for this run");
  }
  await Promise.all([
    expected.databasePath, expected.s3Path, expected.meetingPlatformLogsPath, expected.clockAttestationsPath,
  ].map(readPrivateHostedServiceLevelArtifact));
}

function recordingIdentityCoordinates(value: unknown): { readonly meetingId: string; readonly recordingId: string } {
  const { meetingId, recordingId } = recordingReadyReceiptV1Schema.parse(value);
  return { meetingId, recordingId };
}

function isFiniteCompletion(completion: Completion): completion is HostedFiniteProcessCompletion {
  return new Set(["actor", "conversation-observer", "playback-link-observer", "recording-ready",
    "replay-attestation-publisher", "supplemental-player"]).has(completion.kind);
}

function parseJsonOutput(chunks: readonly Buffer[], childId: string): unknown {
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error(`Hosted campaign child ${childId} produced malformed completion output`); }
}
