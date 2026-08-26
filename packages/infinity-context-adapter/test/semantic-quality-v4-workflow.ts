import { open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalIntegerJson, canonicalSha256 } from "./semantic-quality-v4-manifest.js";

export const semanticQualityV4CampaignCardinality = Object.freeze({
  automatedQuestionsPerRepetition: 200,
  humanQuestionsPerRepetition: 40,
  outcomesPerRepetition: 240,
  repetitionCount: 3,
  totalOutcomes: 720,
});

export type SemanticQualityV4WorkflowStage = "prepared_admitted" | "executing" |
  "awaiting_adjudication" | "adjudicated" | "awaiting_retention" |
  "retained_awaiting_cleanup" | "cleaned_qualified" | "terminal_unqualified";

export interface SemanticQualityV4RawOutcomeBinding {
  readonly answerArtifactSha256: string;
  readonly attemptId: string;
  readonly evidenceArtifactSha256: string;
  readonly questionDigestSha256: string;
  readonly questionId: string;
  readonly rawOutcomeArtifactSha256: string;
  readonly repetition: 1 | 2 | 3;
  readonly terminalState: "failed" | "outcome_unknown" | "succeeded";
}

export interface SemanticQualityV4VerifiedAdjudicationBinding {
  readonly conflictResolution: null | {
    readonly decisionDigestSha256: string;
    readonly receiptId: string;
    readonly reviewerKeyId: string;
  };
  readonly outcomeBindingSha256: string;
  readonly receipts: readonly [{ readonly decisionDigestSha256: string;
    readonly receiptId: string; readonly reviewerKeyId: string }, {
    readonly decisionDigestSha256: string; readonly receiptId: string;
    readonly reviewerKeyId: string }];
}

interface WorkflowRecord {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly previousTransitionSha256: string | null;
  readonly rootBindingSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_workflow_transition.v1";
  readonly stage: SemanticQualityV4WorkflowStage;
  readonly transitionSha256: string;
}

const orderedStages: readonly SemanticQualityV4WorkflowStage[] = [
  "prepared_admitted", "executing", "awaiting_adjudication", "adjudicated",
  "awaiting_retention", "retained_awaiting_cleanup", "cleaned_qualified",
];
const digestPattern = /^[a-f0-9]{64}$/u;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Create-only, root-bound custodian handoff ledger. It contains digests, never evidence bytes. */
export class SemanticQualityV4QualificationWorkflow {
  private readonly root: string;

  public constructor(root: string, private readonly afterFileSync?: (stage:
    SemanticQualityV4WorkflowStage) => void) {
    this.root = resolve(root);
    if (!this.root.startsWith("/") || root.includes("\0")) {
      throw new Error("semantic quality V4 workflow root is invalid");
    }
  }

  public async prepare(input: { readonly campaignRequestSha256: string;
    readonly rootBindingSha256: string; readonly spendAuthorizationSetSha256: string }) {
    assertDigests(input);
    return await this.append("prepared_admitted", input.rootBindingSha256, null, {
      campaignRequestSha256: input.campaignRequestSha256,
      cardinality: semanticQualityV4CampaignCardinality,
      spendAuthorizationSetSha256: input.spendAuthorizationSetSha256,
    });
  }

  public async startExecuting(input: { readonly executionReservationSetSha256: string;
    readonly rootBindingSha256: string }) {
    assertDigests(input);
    return await this.next("executing", input.rootBindingSha256, {
      executionReservationSetSha256: input.executionReservationSetSha256,
    });
  }

  public async awaitAdjudication(input: { readonly artifactSetSha256: string;
    readonly outcomes: readonly SemanticQualityV4RawOutcomeBinding[];
    readonly rootBindingSha256: string }) {
    assertDigests({ artifactSetSha256: input.artifactSetSha256,
      rootBindingSha256: input.rootBindingSha256 });
    const outcomes = validateRawOutcomeBindings(input.outcomes);
    const handoff = Object.freeze({
      artifactSetSha256: input.artifactSetSha256,
      bindings: outcomes,
      cardinality: semanticQualityV4CampaignCardinality,
      outcomeBindingSetSha256: canonicalSha256(outcomes),
      rootBindingSha256: input.rootBindingSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_adjudication_handoff.v1" as const,
    });
    return await this.next("awaiting_adjudication", input.rootBindingSha256, { handoff });
  }

  public async adjudicate(input: {
    readonly adjudicatedRunSetSha256: string;
    readonly campaignReceiptSetSha256: string;
    readonly perOutcome: readonly SemanticQualityV4VerifiedAdjudicationBinding[];
    readonly rootBindingSha256: string;
  }) {
    assertDigests({ adjudicatedRunSetSha256: input.adjudicatedRunSetSha256,
      campaignReceiptSetSha256: input.campaignReceiptSetSha256,
      rootBindingSha256: input.rootBindingSha256 });
    const current = await this.current();
    const awaiting = await this.readStage("awaiting_adjudication");
    if (awaiting === null || current === null ||
      current.stage !== "awaiting_adjudication" && current.stage !== "adjudicated" ||
      current.rootBindingSha256 !== input.rootBindingSha256) {
      throw new Error("semantic quality V4 workflow requires awaiting_adjudication");
    }
    const handoff = (awaiting.payload as { handoff?: { bindings?: unknown } }).handoff;
    if (handoff === undefined || !Array.isArray(handoff.bindings)) {
      throw new Error("semantic quality V4 adjudication handoff is invalid");
    }
    const expected = new Set((handoff.bindings as SemanticQualityV4RawOutcomeBinding[])
      .map((binding) => canonicalSha256(binding)));
    const perOutcome = validateAdjudicationBindings(input.perOutcome, expected);
    return await this.append("adjudicated", input.rootBindingSha256, awaiting, {
      adjudicatedRunSetSha256: input.adjudicatedRunSetSha256,
      campaignReceiptSetSha256: input.campaignReceiptSetSha256,
      perOutcomeReceiptSetSha256: canonicalSha256(perOutcome),
    });
  }

  public async awaitRetention(input: { readonly artifactCount: number;
    readonly retainedArtifactInventorySha256: string; readonly rootBindingSha256: string;
    readonly runManifestSetSha256: string }) {
    assertDigests(input);
    if (!Number.isSafeInteger(input.artifactCount) || input.artifactCount < 720) {
      throw new Error("semantic quality V4 retained artifact inventory is incomplete");
    }
    return await this.next("awaiting_retention", input.rootBindingSha256, {
      artifactCount: input.artifactCount,
      retainedArtifactInventorySha256: input.retainedArtifactInventorySha256,
      runManifestSetSha256: input.runManifestSetSha256,
    });
  }

  public async retainAndRequestCleanup(input: {
    readonly cleanupAuthorizationSha256: string;
    readonly cleanupManifestSha256: string;
    readonly retentionReceiptSha256: string;
    readonly rootBindingSha256: string;
  }) {
    assertDigests(input);
    return await this.next("retained_awaiting_cleanup", input.rootBindingSha256, {
      authoritativeDataPolicy: "preserve_transcript_meeting_and_recording",
      cleanupAuthorizationSha256: input.cleanupAuthorizationSha256,
      cleanupManifestSha256: input.cleanupManifestSha256,
      cleanupScope: "derived_index_only",
      retentionReceiptSha256: input.retentionReceiptSha256,
    });
  }

  public async finish(input: { readonly canonicalAbsenceProofSha256: string;
    readonly cleanupReceiptSha256: string; readonly finalResultSha256: string;
    readonly qualified: boolean; readonly rootBindingSha256: string }) {
    assertDigests(input);
    const stage = input.qualified ? "cleaned_qualified" : "terminal_unqualified";
    const current = await this.current();
    const retained = await this.readStage("retained_awaiting_cleanup");
    if (retained === null || current === null ||
      current.stage !== "retained_awaiting_cleanup" && current.stage !== stage ||
      current.rootBindingSha256 !== input.rootBindingSha256) {
      throw new Error("semantic quality V4 workflow requires retained_awaiting_cleanup");
    }
    return await this.append(stage, input.rootBindingSha256, retained, {
      canonicalAbsenceProofSha256: input.canonicalAbsenceProofSha256,
      cleanupReceiptSha256: input.cleanupReceiptSha256,
      finalResultSha256: input.finalResultSha256,
      qualificationStatus: input.qualified ? "qualified" : "unqualified",
    });
  }

  public async current(): Promise<WorkflowRecord | null> {
    const records: WorkflowRecord[] = [];
    for (const stage of [...orderedStages, "terminal_unqualified" as const]) {
      const value = await readOptionalJson(this.path(stage));
      if (value !== null) {records.push(decodeRecord(value));}
    }
    if (records.length === 0) {return null;}
    const byDigest = new Map(records.map((record) => [record.transitionSha256, record]));
    const roots = new Set(records.map(({ rootBindingSha256 }) => rootBindingSha256));
    if (roots.size !== 1) {throw new Error("semantic quality V4 workflow root changed");}
    for (const record of records) {
      if (record.previousTransitionSha256 !== null &&
        !byDigest.has(record.previousTransitionSha256)) {
        throw new Error("semantic quality V4 workflow transition chain is stale");
      }
    }
    const heads = records.filter((candidate) => !records.some((record) =>
      record.previousTransitionSha256 === candidate.transitionSha256));
    if (heads.length !== 1) {throw new Error("semantic quality V4 workflow has conflicting heads");}
    return heads[0]!;
  }

  private async next(stage: SemanticQualityV4WorkflowStage, rootBindingSha256: string,
    payload: Readonly<Record<string, unknown>>) {
    const current = await this.current();
    if (current?.stage === stage) {
      if (current.rootBindingSha256 !== rootBindingSha256 ||
        canonicalIntegerJson(current.payload) !== canonicalIntegerJson(payload)) {
        throw new Error("semantic quality V4 create-only transition conflicts");
      }
      return current;
    }
    const expectedIndex = orderedStages.indexOf(stage) - 1;
    if (current === null || orderedStages.indexOf(current.stage) !== expectedIndex) {
      throw new Error(`semantic quality V4 workflow cannot enter ${stage}`);
    }
    if (current.rootBindingSha256 !== rootBindingSha256) {
      throw new Error("semantic quality V4 workflow root changed");
    }
    return await this.append(stage, rootBindingSha256, current, payload);
  }

  private async requireCurrent(stage: SemanticQualityV4WorkflowStage,
    rootBindingSha256: string): Promise<WorkflowRecord> {
    const current = await this.current();
    if (current?.stage !== stage) {
      throw new Error(`semantic quality V4 workflow requires ${stage}`);
    }
    if (current.rootBindingSha256 !== rootBindingSha256) {
      throw new Error("semantic quality V4 workflow root changed");
    }
    return current;
  }

  private async append(stage: SemanticQualityV4WorkflowStage, rootBindingSha256: string,
    previous: WorkflowRecord | null, payload: Readonly<Record<string, unknown>>) {
    assertDigest(rootBindingSha256);
    const unsigned = { payload, previousTransitionSha256: previous?.transitionSha256 ?? null,
      rootBindingSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_workflow_transition.v1" as const, stage };
    const record = Object.freeze({ ...unsigned, transitionSha256: canonicalSha256(unsigned) });
    await writeCreateOnlyExact(this.path(stage), canonicalIntegerJson(record), () =>
      this.afterFileSync?.(stage));
    return record;
  }

  private path(stage: SemanticQualityV4WorkflowStage): string {
    return join(this.root, `${String(stageOrdinal(stage)).padStart(2, "0")}-${stage}.json`);
  }

  private async readStage(stage: SemanticQualityV4WorkflowStage): Promise<WorkflowRecord | null> {
    const value = await readOptionalJson(this.path(stage));
    return value === null ? null : decodeRecord(value);
  }
}

function validateRawOutcomeBindings(input: readonly SemanticQualityV4RawOutcomeBinding[]) {
  if (input.length !== semanticQualityV4CampaignCardinality.totalOutcomes) {
    throw new Error("semantic quality V4 requires exactly 720 terminal raw outcomes");
  }
  const values = input.map((binding) => {
    assertDigests(binding);
    if (!safeIdPattern.test(binding.questionId) ||
      !/^sqv4-[a-f0-9]{64}$/u.test(binding.attemptId) ||
      ![1, 2, 3].includes(binding.repetition) ||
      !["failed", "outcome_unknown", "succeeded"].includes(binding.terminalState)) {
      throw new Error("semantic quality V4 raw outcome binding is invalid");
    }
    return Object.freeze({ ...binding });
  }).toSorted((left, right) => left.repetition - right.repetition ||
    left.questionId.localeCompare(right.questionId));
  if (new Set(values.map(({ attemptId }) => attemptId)).size !== values.length ||
    [1, 2, 3].some((repetition) => values.filter((item) =>
      item.repetition === repetition).length !== 240)) {
    throw new Error("semantic quality V4 raw outcome cardinality is invalid");
  }
  return Object.freeze(values);
}

function validateAdjudicationBindings(input: readonly SemanticQualityV4VerifiedAdjudicationBinding[],
  expected: ReadonlySet<string>) {
  if (input.length !== 720) {
    throw new Error("semantic quality V4 requires adjudication for all 720 outcomes");
  }
  const seen = new Set<string>();
  const receiptIds = new Set<string>();
  for (const item of input) {
    assertDigest(item.outcomeBindingSha256);
    const receiptCount = (item as { readonly receipts: readonly unknown[] }).receipts.length;
    if (!expected.has(item.outcomeBindingSha256) || seen.has(item.outcomeBindingSha256) ||
      receiptCount !== 2) {
      throw new Error("semantic quality V4 adjudication binding is stale or duplicated");
    }
    seen.add(item.outcomeBindingSha256);
    const reviewers = new Set(item.receipts.map(({ reviewerKeyId }) => reviewerKeyId));
    const decisions = new Set(item.receipts.map(({ decisionDigestSha256 }) =>
      decisionDigestSha256));
    for (const receipt of item.receipts) {
      assertDigest(receipt.decisionDigestSha256);
      if (!safeIdPattern.test(receipt.receiptId) || !safeIdPattern.test(receipt.reviewerKeyId) ||
        receiptIds.has(receipt.receiptId)) {
        throw new Error("semantic quality V4 adjudication receipt is conflicting");
      }
      receiptIds.add(receipt.receiptId);
    }
    if (reviewers.size !== 2 || (decisions.size === 1) !== (item.conflictResolution === null)) {
      throw new Error("semantic quality V4 adjudication independence/conflict is invalid");
    }
    if (item.conflictResolution !== null) {
      assertDigest(item.conflictResolution.decisionDigestSha256);
      if (reviewers.has(item.conflictResolution.reviewerKeyId) ||
        receiptIds.has(item.conflictResolution.receiptId)) {
        throw new Error("semantic quality V4 conflict resolution is not independent");
      }
      receiptIds.add(item.conflictResolution.receiptId);
    }
  }
  return Object.freeze([...input].toSorted((left, right) =>
    left.outcomeBindingSha256.localeCompare(right.outcomeBindingSha256)));
}

function decodeRecord(value: unknown): WorkflowRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("semantic quality V4 workflow transition is invalid");
  }
  const record = value as unknown as WorkflowRecord;
  const { transitionSha256, ...unsigned } = record;
  if (!orderedStages.includes(record.stage) && record.stage !== "terminal_unqualified" ||
    !digestPattern.test(record.rootBindingSha256) ||
    record.previousTransitionSha256 !== null &&
      !digestPattern.test(record.previousTransitionSha256) ||
    Reflect.get(value, "schemaVersion") !==
      "meeting_knowledge.semantic_quality_workflow_transition.v1" ||
    canonicalSha256(unsigned) !== transitionSha256) {
    throw new Error("semantic quality V4 workflow transition is invalid");
  }
  return Object.freeze(record);
}

function stageOrdinal(stage: SemanticQualityV4WorkflowStage): number {
  if (stage === "terminal_unqualified") {return 7;}
  return orderedStages.indexOf(stage) + 1;
}

function assertDigests(value: object): void {
  for (const [key, item] of Object.entries(value)) {
    if (key.endsWith("Sha256")) {
      if (typeof item !== "string") {throw new Error("semantic quality V4 digest is invalid");}
      assertDigest(item);
    }
  }
}

function assertDigest(value: string): void {
  if (!digestPattern.test(value) || /^([a-f0-9])\1{63}$/u.test(value)) {
    throw new Error("semantic quality V4 digest is invalid");
  }
}

async function writeCreateOnlyExact(path: string, bytes: string, afterFileSync: () => void) {
  await ensureDirectory(resolve(path, ".."));
  try {
    const file = await open(path, "wx", 0o600);
    try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
    await syncDirectory(resolve(path, ".."));
    afterFileSync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
    if (await readFile(path, "utf8") !== bytes) {
      throw new Error("semantic quality V4 create-only transition conflicts", { cause: error });
    }
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const parent = resolve(path, "..");
  if (parent !== path) {await ensureDirectory(parent);}
  let created = false;
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await stat(path)).isDirectory()) {
      throw error;
    }
  }
  await syncDirectory(path);
  if (created && parent !== path) {await syncDirectory(parent);}
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {await directory.sync();} finally {await directory.close();}
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {return JSON.parse(await readFile(path, "utf8")) as unknown;}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return null;}
    throw error;
  }
}
