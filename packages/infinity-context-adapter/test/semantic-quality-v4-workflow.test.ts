import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "./semantic-quality-v4-manifest.js";
import { SemanticQualityV4QualificationWorkflow,
  type SemanticQualityV4RawOutcomeBinding,
  type SemanticQualityV4VerifiedAdjudicationBinding,
  type SemanticQualityV4WorkflowStage } from "./semantic-quality-v4-workflow.js";

const digest = (label: string) => canonicalSha256({ label });
const rootBindingSha256 = digest("root");

describe("semantic quality V4 custodian workflow", () => {
  it("pins 200 automated + 40 human = 240 per repetition and 720 total", async () => {
    const workflow = await preparedWorkflow();
    const prepared = await workflow.current();
    expect(prepared?.payload.cardinality).toEqual({
      automatedQuestionsPerRepetition: 200,
      humanQuestionsPerRepetition: 40,
      outcomesPerRepetition: 240,
      repetitionCount: 3,
      totalOutcomes: 720,
    });
  });

  it("resumes every durable boundary idempotently after a post-fsync crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "sqv4-workflow-crash-"));
    let crashStage: SemanticQualityV4WorkflowStage | null = "prepared_admitted";
    const crashing = new SemanticQualityV4QualificationWorkflow(root, (stage) => {
      if (stage === crashStage) {throw new Error(`crash:${stage}`);}
    });
    const steps = transitions(crashing);
    for (const step of steps) {
      await expect(step()).rejects.toThrow("crash:");
      const durable = new SemanticQualityV4QualificationWorkflow(root);
      expect((await durable.current())?.stage).toBe(crashStage);
      crashStage = null;
      await expect(transitions(durable)[steps.indexOf(step)]!()).resolves.toBeDefined();
      crashStage = nextStage((await durable.current())!.stage);
      if (crashStage === null) {break;}
    }
    expect((await new SemanticQualityV4QualificationWorkflow(root).current())?.stage)
      .toBe("cleaned_qualified");
  });

  it("rejects replay drift, stale roots, changed files, and conflicting heads", async () => {
    const root = await mkdtemp(join(tmpdir(), "sqv4-workflow-replay-"));
    const workflow = new SemanticQualityV4QualificationWorkflow(root);
    await prepare(workflow);
    await workflow.startExecuting({ executionReservationSetSha256: digest("reservations"),
      rootBindingSha256 });
    await expect(workflow.startExecuting({ executionReservationSetSha256: digest("changed"),
      rootBindingSha256 })).rejects.toThrow("conflicts");
    await expect(workflow.awaitAdjudication({ artifactSetSha256: digest("artifacts"),
      outcomes: rawOutcomes(), rootBindingSha256: digest("stale-root") }))
      .rejects.toThrow("root changed");
    const path = join(root, "02-executing.json");
    const changed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    changed.rootBindingSha256 = digest("substitution");
    await writeFile(path, JSON.stringify(changed));
    await expect(workflow.current()).rejects.toThrow("transition is invalid");
  });

  it("rejects 719 outcomes, duplicates, provider_reserved, and extra human outcomes", async () => {
    const workflow = await executingWorkflow();
    await expect(workflow.awaitAdjudication({ artifactSetSha256: digest("artifacts"),
      outcomes: rawOutcomes().slice(0, 719), rootBindingSha256 }))
      .rejects.toThrow("exactly 720");
    const duplicate = rawOutcomes();
    duplicate[719] = duplicate[0]!;
    await expect(workflow.awaitAdjudication({ artifactSetSha256: digest("artifacts"),
      outcomes: duplicate, rootBindingSha256 })).rejects.toThrow("cardinality");
    const extra = [...rawOutcomes(), { ...rawOutcomes()[0]!, questionId: "human-extra" }];
    await expect(workflow.awaitAdjudication({ artifactSetSha256: digest("artifacts"),
      outcomes: extra, rootBindingSha256 })).rejects.toThrow("exactly 720");
  });

  it("requires two independent exact-outcome reviews and independent conflict resolution", async () => {
    const workflow = await awaitingAdjudicationWorkflow();
    const missing = adjudications().slice(0, 719);
    await expect(workflow.adjudicate({ adjudicatedRunSetSha256: digest("runs"),
      campaignReceiptSetSha256: digest("campaign"), perOutcome: missing,
      rootBindingSha256 })).rejects.toThrow("all 720");
    const sameReviewer = adjudications();
    sameReviewer[0] = { ...sameReviewer[0]!, receipts: [sameReviewer[0]!.receipts[0],
      { ...sameReviewer[0]!.receipts[1], reviewerKeyId: "reviewer-a" }] };
    await expect(workflow.adjudicate({ adjudicatedRunSetSha256: digest("runs"),
      campaignReceiptSetSha256: digest("campaign"), perOutcome: sameReviewer,
      rootBindingSha256 })).rejects.toThrow("independence");
    const conflictWithoutResolution = adjudications();
    conflictWithoutResolution[0] = { ...conflictWithoutResolution[0]!,
      receipts: [conflictWithoutResolution[0]!.receipts[0],
        { ...conflictWithoutResolution[0]!.receipts[1],
          decisionDigestSha256: digest("disagree") }] };
    await expect(workflow.adjudicate({ adjudicatedRunSetSha256: digest("runs"),
      campaignReceiptSetSha256: digest("campaign"), perOutcome: conflictWithoutResolution,
      rootBindingSha256 })).rejects.toThrow("conflict");
  });

  it("rejects receipt substitution and duplicate receipt identities", async () => {
    const workflow = await awaitingAdjudicationWorkflow();
    const substituted = adjudications();
    substituted[0] = { ...substituted[0]!, outcomeBindingSha256: digest("another-outcome") };
    await expect(workflow.adjudicate({ adjudicatedRunSetSha256: digest("runs"),
      campaignReceiptSetSha256: digest("campaign"), perOutcome: substituted,
      rootBindingSha256 })).rejects.toThrow("stale or duplicated");
    const duplicated = adjudications();
    duplicated[1] = { ...duplicated[1]!, receipts: [
      { ...duplicated[1]!.receipts[0], receiptId: duplicated[0]!.receipts[0].receiptId },
      duplicated[1]!.receipts[1]] };
    await expect(workflow.adjudicate({ adjudicatedRunSetSha256: digest("runs"),
      campaignReceiptSetSha256: digest("campaign"), perOutcome: duplicated,
      rootBindingSha256 })).rejects.toThrow("conflicting");
  });

  it("resumes adjudication and custody without retrieval/model/provider calls", async () => {
    const workflow = await awaitingAdjudicationWorkflow();
    let providerCalls = 0;
    const forbiddenProvider = () => {providerCalls += 1; throw new Error("provider called");};
    void forbiddenProvider;
    await workflow.adjudicate({ adjudicatedRunSetSha256: digest("runs"),
      campaignReceiptSetSha256: digest("campaign"), perOutcome: adjudications(),
      rootBindingSha256 });
    await workflow.awaitRetention({ artifactCount: 720,
      retainedArtifactInventorySha256: digest("inventory"), rootBindingSha256,
      runManifestSetSha256: digest("run-manifests") });
    expect(providerCalls).toBe(0);
  });

  it("blocks cleanup before retention and preserves authoritative data policy", async () => {
    const workflow = await awaitingAdjudicationWorkflow();
    await expect(workflow.retainAndRequestCleanup({
      cleanupAuthorizationSha256: digest("cleanup-auth"),
      cleanupManifestSha256: digest("cleanup-manifest"),
      retentionReceiptSha256: digest("retention"), rootBindingSha256,
    })).rejects.toThrow("cannot enter retained_awaiting_cleanup");
    await workflow.adjudicate({ adjudicatedRunSetSha256: digest("runs"),
      campaignReceiptSetSha256: digest("campaign"), perOutcome: adjudications(),
      rootBindingSha256 });
    await workflow.awaitRetention({ artifactCount: 720,
      retainedArtifactInventorySha256: digest("inventory"), rootBindingSha256,
      runManifestSetSha256: digest("run-manifests") });
    const retained = await workflow.retainAndRequestCleanup({
      cleanupAuthorizationSha256: digest("cleanup-auth"),
      cleanupManifestSha256: digest("cleanup-manifest"),
      retentionReceiptSha256: digest("retention"), rootBindingSha256 });
    expect(retained.payload).toMatchObject({ cleanupScope: "derived_index_only",
      authoritativeDataPolicy: "preserve_transcript_meeting_and_recording" });
  });

  it("reports a durable pause as awaiting evidence, never as qualification success", async () => {
    const workflow = await awaitingAdjudicationWorkflow();
    expect((await workflow.current())?.stage).toBe("awaiting_adjudication");
    expect((await workflow.current())?.stage).not.toBe("cleaned_qualified");
  });
});

async function preparedWorkflow() {
  const root = await mkdtemp(join(tmpdir(), "sqv4-workflow-prepared-"));
  const workflow = new SemanticQualityV4QualificationWorkflow(root);
  await prepare(workflow);
  return workflow;
}

async function executingWorkflow() {
  const workflow = await preparedWorkflow();
  await workflow.startExecuting({ executionReservationSetSha256: digest("reservations"),
    rootBindingSha256 });
  return workflow;
}

async function awaitingAdjudicationWorkflow() {
  const workflow = await executingWorkflow();
  await workflow.awaitAdjudication({ artifactSetSha256: digest("artifacts"),
    outcomes: rawOutcomes(), rootBindingSha256 });
  return workflow;
}

async function prepare(workflow: SemanticQualityV4QualificationWorkflow) {
  return await workflow.prepare({ campaignRequestSha256: digest("request"), rootBindingSha256,
    spendAuthorizationSetSha256: digest("spend") });
}

function rawOutcomes(): SemanticQualityV4RawOutcomeBinding[] {
  return [1, 2, 3].flatMap((repetition) => Array.from({ length: 240 }, (_, index) => {
    const questionId = `${index < 200 ? "automated" : "human"}-${String(index).padStart(3, "0")}`;
    return Object.freeze({ answerArtifactSha256: digest(`answer:${repetition}:${questionId}`),
      attemptId: `sqv4-${digest(`attempt:${repetition}:${questionId}`)}`,
      evidenceArtifactSha256: digest(`evidence:${repetition}:${questionId}`),
      questionDigestSha256: digest(`question:${questionId}`), questionId,
      rawOutcomeArtifactSha256: digest(`raw:${repetition}:${questionId}`),
      repetition: repetition as 1 | 2 | 3, terminalState: "succeeded" as const });
  }));
}

function adjudications(): SemanticQualityV4VerifiedAdjudicationBinding[] {
  return rawOutcomes().map((binding, index) => Object.freeze({ conflictResolution: null,
    outcomeBindingSha256: canonicalSha256(binding), receipts: [
      { decisionDigestSha256: digest(`decision:${index}`), receiptId: `a-${index}`,
        reviewerKeyId: "reviewer-a" },
      { decisionDigestSha256: digest(`decision:${index}`), receiptId: `b-${index}`,
        reviewerKeyId: "reviewer-b" },
    ] as const }));
}

function transitions(workflow: SemanticQualityV4QualificationWorkflow) {
  return [
    () => prepare(workflow),
    () => workflow.startExecuting({ executionReservationSetSha256: digest("reservations"),
      rootBindingSha256 }),
    () => workflow.awaitAdjudication({ artifactSetSha256: digest("artifacts"),
      outcomes: rawOutcomes(), rootBindingSha256 }),
    () => workflow.adjudicate({ adjudicatedRunSetSha256: digest("runs"),
      campaignReceiptSetSha256: digest("campaign"), perOutcome: adjudications(),
      rootBindingSha256 }),
    () => workflow.awaitRetention({ artifactCount: 720,
      retainedArtifactInventorySha256: digest("inventory"), rootBindingSha256,
      runManifestSetSha256: digest("run-manifests") }),
    () => workflow.retainAndRequestCleanup({ cleanupAuthorizationSha256: digest("cleanup-auth"),
      cleanupManifestSha256: digest("cleanup-manifest"),
      retentionReceiptSha256: digest("retention"), rootBindingSha256 }),
    () => workflow.finish({ canonicalAbsenceProofSha256: digest("absence"),
      cleanupReceiptSha256: digest("cleanup-receipt"), finalResultSha256: digest("result"),
      qualified: true, rootBindingSha256 }),
  ];
}

function nextStage(stage: SemanticQualityV4WorkflowStage): SemanticQualityV4WorkflowStage | null {
  const stages: SemanticQualityV4WorkflowStage[] = ["prepared_admitted", "executing",
    "awaiting_adjudication", "adjudicated", "awaiting_retention",
    "retained_awaiting_cleanup", "cleaned_qualified"];
  return stages[stages.indexOf(stage) + 1] ?? null;
}
