import { readFileSync } from "node:fs";

import { SemanticQualityV4QualificationWorkflow,
  type SemanticQualityV4VerifiedAdjudicationBinding } from
  "./semantic-quality-v4-workflow.js";
import { canonicalSha256 } from "./semantic-quality-v4-manifest.js";
import { evaluateSemanticQualityV4CampaignAdmission,
  type SemanticQualityV4SealedRunManifest } from "./semantic-quality-v4-qualification.js";
import type { SemanticQualityV4ScoringAuthority } from
  "./semantic-quality-v4-evaluation.js";
import { requireIndependentSemanticQualityV4Receipts,
  requireSemanticQualityV4AdjudicationReceipts,
  type SemanticQualityV4PinnedReviewerKey } from "./semantic-quality-v4-trusted-receipts.js";

/** Provider-free phase command. It verifies each exact custodian binding locally. */
export async function runSemanticQualityV4WorkflowResumeCommand(input: {
  readonly command: "adjudicate" | "cleanup" | "retention" | "status";
  readonly phaseInputPath?: string;
  readonly pinnedKeys: readonly SemanticQualityV4PinnedReviewerKey[];
  readonly workflowRoot: string;
}) {
  const workflow = new SemanticQualityV4QualificationWorkflow(requireAbsolute(input.workflowRoot));
  if (input.command === "status") {
    const current = await workflow.current();
    return Object.freeze({ stage: current?.stage ?? "absent",
      status: current?.stage === "cleaned_qualified" ? "qualified" :
        current?.stage === "terminal_unqualified" ? "unqualified" : "paused" });
  }
  const value = exactRecord(readJson(requireAbsolute(input.phaseInputPath ?? "")));
  const rootBindingSha256 = stringField(value, "rootBindingSha256");
  if (input.command === "adjudicate") {
    if (!Array.isArray(value.perOutcome)) {
      throw new Error("semantic quality V4 adjudication phase input is invalid");
    }
    const perOutcome = value.perOutcome.map((item) => {
      const record = exactRecord(item);
      const outcomeBindingSha256 = stringField(record, "outcomeBindingSha256");
      const binding = { adjudicatedOutcomeSha256: stringField(record,
        "adjudicatedOutcomeSha256"), outcomeBindingSha256, rootBindingSha256 };
      if (!Array.isArray(record.receipts)) {
        throw new Error("semantic quality V4 per-outcome receipts are invalid");
      }
      const verified = requireSemanticQualityV4AdjudicationReceipts({ binding,
        ...(record.conflictReceipt === undefined ? {} : { conflictReceipt: record.conflictReceipt }),
        pinnedKeys: input.pinnedKeys, receipts: record.receipts });
      const reviews = verified.filter(({ receipt }) =>
        receipt.role === "claim_citation_adjudication");
      const resolution = verified.find(({ receipt }) =>
        receipt.role === "claim_citation_conflict_resolution");
      if (reviews.length !== 2) {throw new Error("semantic quality V4 answer reviews are invalid");}
      return Object.freeze({ conflictResolution: resolution === undefined ? null : {
        decisionDigestSha256: resolution.receipt.decisionDigestSha256,
        receiptId: resolution.receipt.receiptId,
        reviewerKeyId: resolution.receipt.reviewerKeyId }, outcomeBindingSha256,
      receipts: reviews.map(({ receipt }) => ({ decisionDigestSha256:
        receipt.decisionDigestSha256, receiptId: receipt.receiptId,
      reviewerKeyId: receipt.reviewerKeyId })) as unknown as
        SemanticQualityV4VerifiedAdjudicationBinding["receipts"] });
    });
    const campaignBinding = { adjudicatedRunSetSha256: stringField(value,
      "adjudicatedRunSetSha256"), rootBindingSha256 };
    if (!Array.isArray(value.campaignReceipts)) {
      throw new Error("semantic quality V4 campaign receipts are invalid");
    }
    const campaign = requireSemanticQualityV4AdjudicationReceipts({ binding: campaignBinding,
      ...(value.campaignConflictReceipt === undefined ? {} :
        { conflictReceipt: value.campaignConflictReceipt }), pinnedKeys: input.pinnedKeys,
      receipts: value.campaignReceipts });
    await workflow.adjudicate({
      adjudicatedRunSetSha256: campaignBinding.adjudicatedRunSetSha256,
      campaignReceiptSetSha256: canonicalSha256(campaign.map(({ digestSha256 }) => digestSha256)),
      perOutcome,
      rootBindingSha256,
    });
    const transition = await workflow.awaitRetention({
      artifactCount: numberField(value, "artifactCount"),
      retainedArtifactInventorySha256: stringField(value,
        "retainedArtifactInventorySha256"), rootBindingSha256,
      runManifestSetSha256: stringField(value, "runManifestSetSha256"),
    });
    return Object.freeze({ blockers: ["retention_receipt_pending"], stage: transition.stage,
      status: "paused" });
  }
  if (input.command === "retention") {
    const retentionBinding = { cleanupAuthorizationSha256: stringField(value,
      "cleanupAuthorizationSha256"), cleanupManifestSha256: stringField(value,
      "cleanupManifestSha256"), retentionReceiptBindingSha256: stringField(value,
      "retentionReceiptBindingSha256"), rootBindingSha256 };
    if (!Array.isArray(value.receipts)) {
      throw new Error("semantic quality V4 retention receipts are invalid");
    }
    const receipts = requireIndependentSemanticQualityV4Receipts({ binding: retentionBinding,
      minimum: 1, pinnedKeys: input.pinnedKeys, receipts: value.receipts,
      role: "artifact_retention" });
    const transition = await workflow.retainAndRequestCleanup({
      cleanupAuthorizationSha256: retentionBinding.cleanupAuthorizationSha256,
      cleanupManifestSha256: retentionBinding.cleanupManifestSha256,
      retentionReceiptSha256: canonicalSha256(receipts.map(({ digestSha256 }) => digestSha256)),
      rootBindingSha256,
    });
    return Object.freeze({ blockers: ["cleanup_receipt_pending"], stage: transition.stage,
      status: "paused" });
  }
  const admissionInput = exactRecord(value.admission);
  const admission = evaluateSemanticQualityV4CampaignAdmission({
    adjudicationReceiptsByRepetition: admissionInput.adjudicationReceiptsByRepetition as
      Readonly<Record<1 | 2 | 3, { readonly conflictReceipt?: unknown;
        readonly receipts: readonly unknown[] }>>,
    authorities: admissionInput.authorities as Readonly<Record<"automated" | "overall" | "real",
      SemanticQualityV4ScoringAuthority>>,
    cleanupManifest: admissionInput.cleanupManifest,
    cleanupReceipts: admissionInput.cleanupReceipts as readonly unknown[],
    pinnedKeys: input.pinnedKeys,
    questionReviewBinding: admissionInput.questionReviewBinding as
      Readonly<Record<string, string | number>>,
    questionReviewReceipts: admissionInput.questionReviewReceipts as readonly unknown[],
    retentionBinding: admissionInput.retentionBinding as Readonly<Record<string, string | number>>,
    retentionReceipts: admissionInput.retentionReceipts as readonly unknown[],
    runs: admissionInput.runs as readonly SemanticQualityV4SealedRunManifest[],
  });
  const firstRun = (admissionInput.runs as readonly SemanticQualityV4SealedRunManifest[] | undefined)
    ?.[0];
  if (firstRun?.rootBindingSha256 !== rootBindingSha256) {
    throw new Error("semantic quality V4 final admission root is stale");
  }
  const cleanupManifest = exactRecord(admissionInput.cleanupManifest);
  const transition = await workflow.finish({
    canonicalAbsenceProofSha256: stringField(cleanupManifest,
      "canonicalAuthorityAbsenceProofSha256"),
    cleanupReceiptSha256: canonicalSha256(admissionInput.cleanupReceipts),
    finalResultSha256: canonicalSha256(admission),
    qualified: admission.status === "admitted", rootBindingSha256,
  });
  return Object.freeze({ blockers: admission.blockers, stage: transition.stage,
  status: transition.stage === "cleaned_qualified" ? "qualified" : "unqualified" });
}

function readJson(path: string): unknown {
  try {return JSON.parse(readFileSync(path, "utf8")) as unknown;}
  catch {throw new Error("semantic quality V4 phase input JSON is invalid");}
}
function exactRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("semantic quality V4 phase input is invalid");
  }
  return value as Record<string, unknown>;
}
function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {throw new Error(`semantic quality V4 ${key} is invalid`);}
  return value;
}
function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) {throw new Error(`semantic quality V4 ${key} is invalid`);}
  return value as number;
}
function requireAbsolute(path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error("semantic quality V4 workflow path must be absolute");
  }
  return path;
}
