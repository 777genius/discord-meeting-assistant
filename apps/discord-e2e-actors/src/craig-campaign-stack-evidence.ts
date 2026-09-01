import { z } from "zod";

import { craigCampaignNetworkPolicySchema, deriveCraigCampaignNetworkPolicy } from
  "./craig-campaign-network-plan.js";
import { craigAbsolutePathSchema, craigComposeCoordinateSchema, craigIdentifierSchema,
  craigSha256Schema } from "./craig-campaign-stack-schemas.js";
import { digestCraigCampaignStackCanonical as digestCanonical } from "./craig-campaign-stack-digest.js";
import { hostedCampaignReleaseReferenceV1Schema } from "./hosted-campaign-release-reference.js";

const craigStackMutationStartReceiptV1Schema = z.object({
  campaignId: craigIdentifierSchema, campaignLeaseSha256: craigSha256Schema,
  composeCanonicalSha256: craigSha256Schema,
  composeServiceConfigHashes: z.record(craigComposeCoordinateSchema, craigSha256Schema),
  hostedPlanSha256: craigSha256Schema,
  kind: z.literal("craig-stack-mutation-start"), networkPolicy: craigCampaignNetworkPolicySchema,
  planSha256: craigSha256Schema, projectName: craigComposeCoordinateSchema,
  receiptSha256: craigSha256Schema, release: hostedCampaignReleaseReferenceV1Schema,
  schemaVersion: z.literal(1), startedAt: z.iso.datetime(),
}).strict();
export type CraigStackMutationStartReceiptV1 = Readonly<z.infer<typeof craigStackMutationStartReceiptV1Schema>>;

const craigFailedStackReceiptV1Schema = z.object({
  campaignId: craigIdentifierSchema, campaignLeaseSha256: craigSha256Schema,
  campaignRoot: craigAbsolutePathSchema, failedAt: z.iso.datetime(), failureClass: craigIdentifierSchema,
  failureSha256: craigSha256Schema, hostedPlanSha256: craigSha256Schema,
  kind: z.literal("craig-failed-stack"), mutationReceiptSha256: craigSha256Schema,
  planSha256: craigSha256Schema, projectName: craigComposeCoordinateSchema,
  receiptSha256: craigSha256Schema, release: hostedCampaignReleaseReferenceV1Schema,
  schemaVersion: z.literal(1),
}).strict();
export type CraigFailedStackReceiptV1 = Readonly<z.infer<typeof craigFailedStackReceiptV1Schema>>;

const recoveryAbsenceSchema = z.object({
  absentAnonymousVolumeNames: z.array(craigSha256Schema).max(3),
  absentContainerIds: z.array(craigSha256Schema).max(3), absentNetworkId: craigSha256Schema.nullable(),
  absentNetworkName: craigComposeCoordinateSchema, absentVolumeName: craigComposeCoordinateSchema,
  campaignId: craigIdentifierSchema, kind: z.literal("craig-recovery-absence-proof"),
  planSha256: craigSha256Schema, projectName: craigComposeCoordinateSchema,
  release: hostedCampaignReleaseReferenceV1Schema, schemaVersion: z.literal(1),
}).strict();

const craigFailedStackRecoveryReceiptV1Schema = z.object({
  absenceProof: recoveryAbsenceSchema, campaignId: craigIdentifierSchema, campaignLeaseRemoved: z.literal(true),
  completedAt: z.iso.datetime(), failureReceiptSha256: craigSha256Schema,
  hostedPlanSha256: craigSha256Schema, kind: z.literal("craig-failed-stack-recovery"),
  mutationReceiptSha256: craigSha256Schema, planSha256: craigSha256Schema,
  projectName: craigComposeCoordinateSchema, receiptSha256: craigSha256Schema,
  release: hostedCampaignReleaseReferenceV1Schema, schemaVersion: z.literal(1),
}).strict();
export type CraigFailedStackRecoveryReceiptV1 =
  Readonly<z.infer<typeof craigFailedStackRecoveryReceiptV1Schema>>;

export function verifyCraigMutationStartReceipt(value: unknown): CraigStackMutationStartReceiptV1 {
  return verifyDigest(craigStackMutationStartReceiptV1Schema, value, "Craig mutation-start receipt");
}

export function verifyCraigFailedStackReceipt(value: unknown, mutationValue: unknown): CraigFailedStackReceiptV1 {
  const mutation = verifyCraigMutationStartReceipt(mutationValue);
  const failure = verifyDigest(craigFailedStackReceiptV1Schema, value, "Craig failed-stack receipt");
  if (failure.campaignId !== mutation.campaignId
    || failure.campaignLeaseSha256 !== mutation.campaignLeaseSha256
    || failure.hostedPlanSha256 !== mutation.hostedPlanSha256
    || failure.mutationReceiptSha256 !== mutation.receiptSha256
    || failure.planSha256 !== mutation.planSha256 || failure.projectName !== mutation.projectName
    || JSON.stringify(failure.release) !== JSON.stringify(mutation.release)) {
    throw new Error("Craig failed-stack receipt contradicts mutation-start custody");
  }
  return failure;
}

export function verifyCraigFailedStackRecoveryReceipt(value: unknown,
  failureValue: unknown, mutationValue: unknown): CraigFailedStackRecoveryReceiptV1 {
  const mutation = verifyCraigMutationStartReceipt(mutationValue);
  const failure = verifyCraigFailedStackReceipt(failureValue, mutation);
  const recovery = verifyDigest(craigFailedStackRecoveryReceiptV1Schema, value,
    "Craig failed-stack recovery receipt");
  const expectedNetworkPolicy = deriveCraigCampaignNetworkPolicy(mutation.campaignId, mutation.release,
    mutation.networkPolicy.udpDestinationPorts);
  if (recovery.campaignId !== failure.campaignId || recovery.failureReceiptSha256 !== failure.receiptSha256
    || recovery.hostedPlanSha256 !== failure.hostedPlanSha256
    || recovery.mutationReceiptSha256 !== failure.mutationReceiptSha256
    || recovery.planSha256 !== failure.planSha256 || recovery.projectName !== failure.projectName
    || recovery.absenceProof.campaignId !== failure.campaignId
    || recovery.absenceProof.planSha256 !== failure.planSha256
    || recovery.absenceProof.projectName !== failure.projectName
    || recovery.absenceProof.absentNetworkName !== mutation.networkPolicy.name
    || digestCanonical(mutation.networkPolicy) !== digestCanonical(expectedNetworkPolicy)
    || JSON.stringify(recovery.release) !== JSON.stringify(failure.release)
    || JSON.stringify(recovery.absenceProof.release) !== JSON.stringify(failure.release)) {
    throw new Error("Craig recovery receipt contradicts retained failure custody");
  }
  return recovery;
}

function verifyDigest<T>(schema: z.ZodType<T>, value: unknown, label: string): Readonly<T> {
  const parsed = schema.parse(value) as T & { receiptSha256: string };
  const { receiptSha256, ...content } = parsed;
  if (digestCanonical(content) !== receiptSha256) { throw new Error(`${label} digest is invalid`); }
  return Object.freeze(parsed);
}
