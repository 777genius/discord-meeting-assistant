import { createHash } from "node:crypto";

import { z } from "zod";

import {
  currentDeploymentProvenanceSchema,
  deploymentRevisionExpectationSchema,
  sameDeploymentProvenance,
  type CurrentDeploymentProvenance,
  type DeploymentRevisionExpectation,
} from "./e2e-evidence.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";
import { assertV9DeploymentProvenance } from "./recording-ready-receipt.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const sourceRevision = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const exactTargetSchema = z.object(
  Object.fromEntries(Object.entries(HOSTED_CAMPAIGN_TARGET).map(([key, value]) => [key, z.literal(value)])),
).strict();

export const hostedCampaignProvenanceSnapshotV1Schema = z.object({
  campaignId: identifier,
  deployment: currentDeploymentProvenanceSchema,
  digestSha256: sha256,
  expectedRevisions: deploymentRevisionExpectationSchema.extend({
    pipecat: sourceRevision,
    subscriptionRuntime: sourceRevision,
  }),
  runIds: z.tuple([identifier, identifier, identifier]),
  schemaVersion: z.literal(1),
  target: exactTargetSchema,
}).strict();

export const hostedCampaignProvenanceCompletionV1Schema = z.object({
  campaignId: identifier,
  digestSha256: sha256,
  phase: z.enum(["before", "after"]),
  runIds: z.tuple([identifier, identifier, identifier]),
  schemaVersion: z.literal(1),
  target: exactTargetSchema,
}).strict();

export type HostedCampaignProvenanceSnapshotV1 = z.infer<
  typeof hostedCampaignProvenanceSnapshotV1Schema
>;

export interface ProvenanceCollector {
  collectProvenance(): Promise<CurrentDeploymentProvenance>;
}

interface ProvenanceCorrelation {
  readonly campaignId: string;
  readonly expectedRevisions: DeploymentRevisionExpectation;
  readonly runIds: readonly [string, string, string];
}

export async function collectHostedCampaignProvenanceBefore(
  input: ProvenanceCorrelation,
  collector: ProvenanceCollector,
): Promise<HostedCampaignProvenanceSnapshotV1> {
  const deployment = currentDeploymentProvenanceSchema.parse(await collector.collectProvenance());
  assertV9DeploymentProvenance(deployment, input.expectedRevisions);
  return hostedCampaignProvenanceSnapshotV1Schema.parse({
    campaignId: input.campaignId,
    deployment,
    digestSha256: digestDeployment(deployment),
    expectedRevisions: input.expectedRevisions,
    runIds: input.runIds,
    schemaVersion: 1,
    target: HOSTED_CAMPAIGN_TARGET,
  });
}

export async function collectHostedCampaignProvenanceAfter(
  input: ProvenanceCorrelation & { readonly baseline: unknown },
  collector: ProvenanceCollector,
): Promise<z.infer<typeof hostedCampaignProvenanceCompletionV1Schema>> {
  const baseline = hostedCampaignProvenanceSnapshotV1Schema.parse(input.baseline);
  assertSameCorrelation(baseline, input);
  const deployment = currentDeploymentProvenanceSchema.parse(await collector.collectProvenance());
  assertV9DeploymentProvenance(deployment, input.expectedRevisions);
  const digestSha256 = digestDeployment(deployment);
  if (digestSha256 !== baseline.digestSha256 || !sameDeploymentProvenance(baseline.deployment, deployment)) {
    throw new Error("Hosted campaign deployment provenance changed during the campaign");
  }
  return hostedCampaignProvenanceCompletionV1Schema.parse({
    campaignId: input.campaignId,
    digestSha256,
    phase: "after",
    runIds: input.runIds,
    schemaVersion: 1,
    target: HOSTED_CAMPAIGN_TARGET,
  });
}

export function provenanceBeforeCompletion(
  snapshot: HostedCampaignProvenanceSnapshotV1,
): z.infer<typeof hostedCampaignProvenanceCompletionV1Schema> {
  return hostedCampaignProvenanceCompletionV1Schema.parse({
    campaignId: snapshot.campaignId,
    digestSha256: snapshot.digestSha256,
    phase: "before",
    runIds: snapshot.runIds,
    schemaVersion: 1,
    target: snapshot.target,
  });
}

function assertSameCorrelation(
  baseline: HostedCampaignProvenanceSnapshotV1,
  input: ProvenanceCorrelation,
): void {
  if (baseline.campaignId !== input.campaignId
    || JSON.stringify(baseline.runIds) !== JSON.stringify(input.runIds)
    || JSON.stringify(baseline.expectedRevisions) !== JSON.stringify(input.expectedRevisions)
    || JSON.stringify(baseline.target) !== JSON.stringify(HOSTED_CAMPAIGN_TARGET)) {
    throw new Error("Hosted campaign provenance baseline correlation mismatch");
  }
}

function digestDeployment(deployment: CurrentDeploymentProvenance): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(deployment))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}
