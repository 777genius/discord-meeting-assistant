import { z } from "zod";

import { validateActionEvidence } from "./hosted-campaign-actions.js";
import type {
  HostedCampaignInput,
  HostedCampaignLeaseCleanupProof,
  HostedCampaignLeaseHandle,
  HostedCampaignPassReceipt,
} from "./hosted-campaign-coordinator.js";
import { campaignActions } from "./hosted-campaign-execution-graph.js";
import {
  digestCanonical,
  sha256Schema,
} from "./hosted-campaign-local-admission.js";
import {
  hostedCampaignReleaseReferenceV1Schema,
  type HostedCampaignReleaseReferenceV1,
} from "./hosted-campaign-release-reference.js";
import type { CraigCampaignStackAbsenceProofV1 } from "./craig-campaign-stack-runtime-proof.js";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const revisionsSchema = z.object({
  craig: z.string().min(1),
  meetingPlatform: z.string().min(1),
  pipecat: z.string().min(1),
  subscriptionRuntime: z.string().min(1),
}).strict();
const hostedCampaignPassReceiptV2Schema = z.object({
  actionEvidence: z.array(z.unknown()).readonly(),
  actionEvidenceSha256: sha256Schema,
  admission: z.object({
    kind: z.literal("hosted-campaign-admission"),
    receiptSha256: sha256Schema,
  }).strict(),
  artifacts: z.array(z.object({
    byteLength: z.number().int().nonnegative(),
    path: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).{1,1024}$/u),
    sha256: sha256Schema,
  }).strict()).min(1).max(512).readonly(),
  artifactsSha256: sha256Schema,
  bindingsSha256: sha256Schema,
  campaignId: identifierSchema,
  campaignLease: z.object({
    campaignRoot: z.string().startsWith("/"),
    device: z.number().int().nonnegative(),
    inode: z.number().int().nonnegative(),
    leaseSha256: sha256Schema,
    planSha256: sha256Schema,
    receiptSha256: sha256Schema,
  }).strict(),
  craigStack: z.object({ projectName: identifierSchema, receiptSha256: sha256Schema }).strict(),
  createdAt: z.iso.datetime(),
  definitionSha256: sha256Schema,
  kind: z.literal("hosted-campaign-pass-receipt"),
  planSha256: sha256Schema,
  receiptSha256: sha256Schema,
  release: hostedCampaignReleaseReferenceV1Schema,
  revisions: revisionsSchema,
  runIds: z.tuple([identifierSchema, identifierSchema, identifierSchema]).readonly(),
  schemaVersion: z.literal(2),
  teardown: z.object({
    campaignLeaseHeldAtVerification: z.literal(true),
    childrenStopped: z.literal(true),
    destructiveTeardownAuthorized: z.literal(true),
  }).strict(),
}).strict();

export type HostedCampaignPassReceiptV2 = Readonly<z.infer<typeof hostedCampaignPassReceiptV2Schema>>;
export {
  type HostedCampaignReleaseReferenceV1,
} from "./hosted-campaign-release-reference.js";

export interface HostedCampaignPassReceiptExpectation {
  readonly admissionReceiptSha256: string;
  readonly artifacts: HostedCampaignPassReceiptV2["artifacts"];
  readonly bindingsSha256: string;
  readonly campaignLease: HostedCampaignPassReceiptV2["campaignLease"];
  readonly craigStack: HostedCampaignPassReceiptV2["craigStack"];
  readonly definitionSha256: string;
  readonly plan: HostedCampaignInput;
  readonly release: HostedCampaignReleaseReferenceV1;
  readonly revisions: HostedCampaignPassReceiptV2["revisions"];
}

export function createCampaignLeaseReceipt(lease: HostedCampaignLeaseHandle) {
  const content = { campaignId: lease.campaignId, campaignRoot: lease.campaignRoot,
    device: lease.device, hostedPlanSha256: lease.planSha256, inode: lease.inode,
    kind: "campaign-lease-receipt" as const, leaseSha256: lease.leaseSha256, schemaVersion: 1 as const };
  return Object.freeze({ ...content, receiptSha256: digestCanonical(content) });
}

export function createCraigStackTeardownReceipt(input: Readonly<{
  absenceProof: CraigCampaignStackAbsenceProofV1;
  completedAt: string; leaseReceiptSha256: string; lease: HostedCampaignLeaseHandle;
  passReceiptSha256: string; projectName: string; stackReceiptSha256: string;
}>) {
  if (input.absenceProof.campaignId !== input.lease.campaignId
    || input.absenceProof.planSha256 === "0".repeat(64)
    || input.absenceProof.projectName !== input.projectName) {
    throw new Error("Craig teardown absence proof contradicts campaign custody");
  }
  const content = { campaignLeaseReceiptSha256: input.leaseReceiptSha256,
    absenceProof: input.absenceProof,
    campaignLeaseSha256: input.lease.leaseSha256, completedAt: input.completedAt,
    hostedPlanSha256: input.lease.planSha256, kind: "craig-stack-teardown" as const,
    passReceiptSha256: input.passReceiptSha256, projectName: input.projectName,
    schemaVersion: 1 as const, stackReceiptSha256: input.stackReceiptSha256 };
  return Object.freeze({ ...content, receiptSha256: digestCanonical(content) });
}

export function createCampaignLeaseCleanupReceipt(input: Readonly<{
  cleanup: HostedCampaignLeaseCleanupProof; lease: HostedCampaignLeaseHandle;
  leaseReceiptSha256: string; passReceiptSha256: string; projectName: string;
  stackReceiptSha256: string; teardownReceiptSha256: string;
}>) {
  const { cleanup, lease } = input;
  const leasePath = `${lease.campaignRoot}/barriers/campaign.lease`;
  if (cleanup.leasePath !== leasePath || cleanup.campaignId !== lease.campaignId
    || cleanup.campaignRoot !== lease.campaignRoot || cleanup.device !== lease.device
    || cleanup.inode !== lease.inode || cleanup.leaseSha256 !== lease.leaseSha256
    || cleanup.planSha256 !== lease.planSha256) {
    throw new Error("Hosted campaign lease cleanup proof contradicts the exact held lease");
  }
  const content = { campaignId: lease.campaignId, campaignRoot: lease.campaignRoot, deleted: true as const,
    device: lease.device, hostedPlanSha256: lease.planSha256, inode: lease.inode,
    kind: "campaign-lease-cleanup" as const, leasePath,
    leaseReceiptSha256: input.leaseReceiptSha256, leaseSha256: lease.leaseSha256,
    passReceiptSha256: input.passReceiptSha256, projectName: input.projectName, schemaVersion: 1 as const,
    stackReceiptSha256: input.stackReceiptSha256, teardownReceiptSha256: input.teardownReceiptSha256 };
  return Object.freeze({ ...content, receiptSha256: digestCanonical(content) });
}

export function createHostedCampaignPassReceiptV2(
  execution: HostedCampaignPassReceipt,
  expectation: HostedCampaignPassReceiptExpectation,
): HostedCampaignPassReceiptV2 {
  const planSha256 = digestCanonical(expectation.plan);
  const actionEvidence = Object.freeze([...execution.actionEvidence]);
  const content = {
    actionEvidence,
    actionEvidenceSha256: digestCanonical(actionEvidence),
    admission: {
      kind: "hosted-campaign-admission" as const,
      receiptSha256: expectation.admissionReceiptSha256,
    },
    artifacts: expectation.artifacts,
    artifactsSha256: digestCanonical(expectation.artifacts),
    bindingsSha256: expectation.bindingsSha256,
    campaignId: execution.campaignId,
    campaignLease: expectation.campaignLease,
    craigStack: expectation.craigStack,
    createdAt: new Date().toISOString(),
    definitionSha256: expectation.definitionSha256,
    kind: "hosted-campaign-pass-receipt" as const,
    planSha256,
    release: expectation.release,
    revisions: expectation.revisions,
    runIds: execution.runIds,
    schemaVersion: 2 as const,
    teardown: {
      campaignLeaseHeldAtVerification: true as const,
      childrenStopped: true as const,
      destructiveTeardownAuthorized: true as const,
    },
  };
  return verifyHostedCampaignPassReceiptV2({
    ...content,
    receiptSha256: digestCanonical(content),
  }, expectation);
}

export function verifyHostedCampaignPassReceiptV2(
  value: unknown,
  expectation?: HostedCampaignPassReceiptExpectation,
): HostedCampaignPassReceiptV2 {
  const receipt = hostedCampaignPassReceiptV2Schema.parse(value);
  const { receiptSha256, ...content } = receipt;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Hosted campaign pass receipt digest is invalid");
  }
  const createdAt = Date.parse(receipt.createdAt);
  if (!Number.isSafeInteger(createdAt) || createdAt > Date.now() || Date.now() - createdAt > 15 * 60_000) {
    throw new Error("Hosted campaign pass receipt is stale or from the future");
  }
  if (digestCanonical(receipt.actionEvidence) !== receipt.actionEvidenceSha256) {
    throw new Error("Hosted campaign pass action evidence digest is invalid");
  }
  if (digestCanonical(receipt.artifacts) !== receipt.artifactsSha256 ||
    new Set(receipt.artifacts.map(({ path }) => path)).size !== receipt.artifacts.length) {
    throw new Error("Hosted campaign finite artifact manifest is invalid");
  }
  if (new Set(receipt.runIds).size !== 3) {
    throw new Error("Hosted campaign pass run IDs must be unique");
  }
  if (receipt.campaignLease.planSha256 !== receipt.planSha256) {
    throw new Error("Hosted campaign pass lease does not match its exact plan");
  }
  if (expectation !== undefined) {
    assertMatchesExpectation(receipt, expectation);
  }
  return Object.freeze({
    ...receipt,
    actionEvidence: Object.freeze(receipt.actionEvidence),
    artifacts: Object.freeze(receipt.artifacts),
    campaignLease: Object.freeze(receipt.campaignLease),
    release: Object.freeze(receipt.release),
    revisions: Object.freeze(receipt.revisions),
    runIds: Object.freeze(receipt.runIds),
    teardown: Object.freeze(receipt.teardown),
  });
}

export function verifyHostedCampaignPassReceiptPlan(
  receiptValue: unknown,
  plan: HostedCampaignInput,
): HostedCampaignPassReceiptV2 {
  const receipt = verifyHostedCampaignPassReceiptV2(receiptValue);
  if (receipt.planSha256 !== digestCanonical(plan) ||
    receipt.campaignId !== plan.runs[0]?.campaignId ||
    JSON.stringify(receipt.runIds) !== JSON.stringify(plan.runs.map(({ runId }) => runId))) {
    throw new Error("Hosted campaign pass receipt does not match its retained execution plan");
  }
  assertMandatoryQualificationArtifacts(receipt);
  const expectedActions = campaignActions(plan);
  if (receipt.actionEvidence.length !== expectedActions.length) {
    throw new Error("Hosted campaign pass receipt does not contain every planned action");
  }
  for (const [index, reference] of expectedActions.entries()) {
    const retained = receipt.actionEvidence[index];
    if (typeof retained !== "object" || retained === null ||
      JSON.stringify((retained as { action?: unknown }).action) !== JSON.stringify(reference.action)) {
      throw new Error(`Hosted campaign pass action ${index + 1} does not match its retained plan`);
    }
    validateActionEvidence(
      reference.action,
      (retained as { evidence?: unknown }).evidence,
      plan.thresholds,
    );
  }
  return receipt;
}

function assertMandatoryQualificationArtifacts(receipt: HostedCampaignPassReceiptV2): void {
  const retained = new Set(receipt.artifacts.map(({ path }) => path));
  const mandatory = [
    "campaign-proof.json",
    "control/campaign-lease-receipt.json",
    "control/craig-stack-mutation-start.json",
    "control/craig-stack-receipt.json",
    "control/craig-stack-input.json",
    "greeting-ledger.json",
    "late-greeting.json",
    "historical-reply.json",
    "historical-reply-input.json",
    "live-memory.json",
    "private-coverage.json",
    "thin-remediation.json",
    "run-3/recording-ready.json",
    "run-1/evidence.json",
    "run-2/evidence.json",
    "run-3/evidence.json",
    "run-3/public-reply-effect.arm.json",
    "run-3/public-reply-effect.triggered.json",
    ...Array.from({ length: 6 }, (_, index) => `run-3/capture-${String(index + 1)}.json`),
  ];
  const missing = mandatory.filter((path) => !retained.has(path));
  if (missing.length > 0) {
    throw new Error(`Hosted campaign pass is missing mandatory qualification artifacts: ${missing.join(", ")}`);
  }
}

function assertMatchesExpectation(
  receipt: HostedCampaignPassReceiptV2,
  expectation: HostedCampaignPassReceiptExpectation,
): void {
  const plan = expectation.plan;
  const campaignId = plan.runs[0]?.campaignId;
  const runIds = plan.runs.map(({ runId }) => runId);
  if (campaignId === undefined || receipt.campaignId !== campaignId
    || JSON.stringify(receipt.runIds) !== JSON.stringify(runIds)
    || receipt.planSha256 !== digestCanonical(plan)
    || receipt.artifactsSha256 !== digestCanonical(expectation.artifacts)
    || JSON.stringify(receipt.artifacts) !== JSON.stringify(expectation.artifacts)
    || receipt.admission.receiptSha256 !== expectation.admissionReceiptSha256
    || receipt.bindingsSha256 !== expectation.bindingsSha256
    || JSON.stringify(receipt.campaignLease) !== JSON.stringify(expectation.campaignLease)
    || JSON.stringify(receipt.craigStack) !== JSON.stringify(expectation.craigStack)
    || receipt.definitionSha256 !== expectation.definitionSha256
    || JSON.stringify(receipt.revisions) !== JSON.stringify(expectation.revisions)
    || JSON.stringify(receipt.release) !== JSON.stringify(expectation.release)) {
    throw new Error("Hosted campaign pass receipt does not match its exact invocation");
  }
  assertMandatoryQualificationArtifacts(receipt);
  const expectedActions = campaignActions(plan);
  if (receipt.actionEvidence.length !== expectedActions.length) {
    throw new Error("Hosted campaign pass receipt does not contain every expected action");
  }
  for (const [index, reference] of expectedActions.entries()) {
    const retained = receipt.actionEvidence[index];
    if (typeof retained !== "object" || retained === null
      || JSON.stringify((retained as { action?: unknown }).action) !== JSON.stringify(reference.action)) {
      throw new Error(`Hosted campaign pass action ${index + 1} does not match the execution graph`);
    }
    validateActionEvidence(
      reference.action,
      (retained as { evidence?: unknown }).evidence,
      plan.thresholds,
    );
  }
}
