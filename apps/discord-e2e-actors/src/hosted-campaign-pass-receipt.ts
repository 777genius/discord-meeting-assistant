import { z } from "zod";

import { validateActionEvidence } from "./hosted-campaign-actions.js";
import type {
  HostedCampaignInput,
  HostedCampaignPassReceipt,
} from "./hosted-campaign-coordinator.js";
import { campaignActions } from "./hosted-campaign-execution-graph.js";
import {
  digestCanonical,
  sha256Schema,
} from "./hosted-campaign-local-admission.js";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const revisionsSchema = z.object({
  craig: z.string().min(1),
  meetingPlatform: z.string().min(1),
  pipecat: z.string().min(1),
  subscriptionRuntime: z.string().min(1),
}).strict();
const releaseReferenceSchema = z.object({
  releaseBindingSha256: sha256Schema,
  releaseId: identifierSchema,
  trustRootSha256: sha256Schema,
}).strict();

const hostedCampaignPassReceiptV2Schema = z.object({
  actionEvidence: z.array(z.unknown()).readonly(),
  actionEvidenceSha256: sha256Schema,
  admission: z.object({
    kind: z.literal("hosted-campaign-admission"),
    receiptSha256: sha256Schema,
  }).strict(),
  bindingsSha256: sha256Schema,
  campaignId: identifierSchema,
  definitionSha256: sha256Schema,
  kind: z.literal("hosted-campaign-pass-receipt"),
  planSha256: sha256Schema,
  receiptSha256: sha256Schema,
  release: releaseReferenceSchema,
  revisions: revisionsSchema,
  runIds: z.tuple([identifierSchema, identifierSchema, identifierSchema]).readonly(),
  schemaVersion: z.literal(2),
  teardown: z.object({
    campaignLeaseReleased: z.literal(true),
    childrenStopped: z.literal(true),
  }).strict(),
}).strict();

export type HostedCampaignPassReceiptV2 = Readonly<z.infer<typeof hostedCampaignPassReceiptV2Schema>>;
export type HostedCampaignReleaseReferenceV1 = Readonly<z.infer<typeof releaseReferenceSchema>>;

export interface HostedCampaignPassReceiptExpectation {
  readonly admissionReceiptSha256: string;
  readonly bindingsSha256: string;
  readonly definitionSha256: string;
  readonly plan: HostedCampaignInput;
  readonly release: HostedCampaignReleaseReferenceV1;
  readonly revisions: HostedCampaignPassReceiptV2["revisions"];
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
    bindingsSha256: expectation.bindingsSha256,
    campaignId: execution.campaignId,
    definitionSha256: expectation.definitionSha256,
    kind: "hosted-campaign-pass-receipt" as const,
    planSha256,
    release: expectation.release,
    revisions: expectation.revisions,
    runIds: execution.runIds,
    schemaVersion: 2 as const,
    teardown: {
      campaignLeaseReleased: true as const,
      childrenStopped: true as const,
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
  if (digestCanonical(receipt.actionEvidence) !== receipt.actionEvidenceSha256) {
    throw new Error("Hosted campaign pass action evidence digest is invalid");
  }
  if (new Set(receipt.runIds).size !== 3) {
    throw new Error("Hosted campaign pass run IDs must be unique");
  }
  if (expectation !== undefined) {
    assertMatchesExpectation(receipt, expectation);
  }
  return Object.freeze({
    ...receipt,
    actionEvidence: Object.freeze(receipt.actionEvidence),
    release: Object.freeze(receipt.release),
    revisions: Object.freeze(receipt.revisions),
    runIds: Object.freeze(receipt.runIds),
    teardown: Object.freeze(receipt.teardown),
  });
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
    || receipt.admission.receiptSha256 !== expectation.admissionReceiptSha256
    || receipt.bindingsSha256 !== expectation.bindingsSha256
    || receipt.definitionSha256 !== expectation.definitionSha256
    || JSON.stringify(receipt.revisions) !== JSON.stringify(expectation.revisions)
    || JSON.stringify(receipt.release) !== JSON.stringify(expectation.release)) {
    throw new Error("Hosted campaign pass receipt does not match its exact invocation");
  }
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
