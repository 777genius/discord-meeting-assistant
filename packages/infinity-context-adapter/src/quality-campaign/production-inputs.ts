import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { type AdmittedMainCampaign, type AdmissionAuthority,
  type CampaignQuestion } from "./admission.js";
import { canonicalJson, digest, exactRecord, sha256 } from "./canonical.js";
import { verifyExternalSignedValue } from "./execution.js";
import type { FrozenMainInputProof, HoldoutAuthorization } from "./holdout.js";
import type { ProtectedCampaignEvidence } from "./production-cleanup.js";
import type { DerivedCampaignArtifact, QualityCampaignProductionPorts } from
  "./production-ports.js";

export interface ProductionOperatorConfiguration {
  readonly absenceAuthorityPath: string;
  readonly admissionAuthorityPath: string;
  readonly adjudicationAuthorityPaths: readonly [string, string, string];
  readonly authoritativeEvidenceInventoryPath: string;
  readonly checkpointRoot: string;
  readonly cleanupPlanPath: string;
  readonly concurrency: number;
  readonly deletionAuthorityPath: string;
  readonly holdoutAuthorityPath: string;
  readonly holdoutCleanupPlanPath: string;
  readonly holdoutInputPath: string;
  readonly holdoutJournalRoot: string;
  readonly journalRoot: string;
  readonly mainManifestPath: string;
  readonly releaseAuthorityPublicKeyPath: string;
  readonly releaseRootPath: string;
  readonly reviewerAuthorityPaths: readonly [string, string];
  readonly schemaVersion: "meeting_knowledge.semantic_quality_production_operator.v2";
  readonly spendAuthorityPath: string;
  readonly spendReservationsPath: string;
}

export interface CanonicalCustodyEvidence {
  readonly loadedLocatorDigests: readonly string[];
  readonly loadedQuestionDigests: readonly string[];
  readonly mainInputRootSha256: string;
  readonly mainKeyNamespace: string;
  readonly protectedEvidence: readonly ProtectedCampaignEvidence[];
  readonly releaseRootSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_authoritative_custody.v1";
  readonly tuningEvidenceDigests: readonly string[];
}

interface ProductionHoldoutAuthorization extends HoldoutAuthorization {
  readonly expiresAtEpochMs: number;
  readonly tuningEvidenceDigests: readonly string[];
}

export async function loadProductionConfiguration(path: string):
Promise<ProductionOperatorConfiguration> {
  const keys = ["absenceAuthorityPath", "adjudicationAuthorityPaths", "admissionAuthorityPath",
    "authoritativeEvidenceInventoryPath", "checkpointRoot", "cleanupPlanPath", "concurrency",
    "deletionAuthorityPath", "holdoutAuthorityPath", "holdoutCleanupPlanPath",
    "holdoutInputPath", "holdoutJournalRoot", "journalRoot", "mainManifestPath",
    "releaseAuthorityPublicKeyPath", "releaseRootPath", "reviewerAuthorityPaths",
    "schemaVersion", "spendAuthorityPath", "spendReservationsPath"];
  const record = exactRecord(await readProductionJson(path, "production operator configuration"),
    keys, "production operator configuration");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_production_operator.v2" ||
    !Array.isArray(record.reviewerAuthorityPaths) || record.reviewerAuthorityPaths.length !== 2 ||
    !Array.isArray(record.adjudicationAuthorityPaths) ||
    record.adjudicationAuthorityPaths.length !== 3 || typeof record.concurrency !== "number") {
    throw new Error("production operator configuration is invalid");
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith("Path") || key.endsWith("Root")) {absolute(String(value), key);}
    if (key.endsWith("Paths")) {for (const item of value as unknown[]) {absolute(String(item), key);}}
  }
  return record as unknown as ProductionOperatorConfiguration;
}

export async function loadProductionAuthority(path: string): Promise<AdmissionAuthority> {
  const record = exactRecord(await readProductionJson(path, "authority"),
    ["keyId", "publicKeyPath"], "authority");
  return Object.freeze({ keyId: String(record.keyId), publicKeyPem: await readProductionText(
    absolute(String(record.publicKeyPath), "public key"), "public key") });
}

export async function loadCanonicalCustody(input: { readonly authority: AdmissionAuthority;
  readonly mainInputRootSha256: string; readonly path: string;
  readonly questions: readonly CampaignQuestion[]; readonly releaseRootSha256: string }):
Promise<CanonicalCustodyEvidence> {
  const signed = verifyExternalSignedValue<CanonicalCustodyEvidence>(await readProductionJson(
    input.path, "authoritative custody inventory"), input.authority.keyId,
  input.authority.publicKeyPem, "authoritative custody inventory");
  const raw = exactRecord(signed.payload, ["loadedLocatorDigests", "loadedQuestionDigests",
    "mainInputRootSha256", "mainKeyNamespace", "protectedEvidence", "releaseRootSha256",
    "schemaVersion", "tuningEvidenceDigests"], "authoritative custody inventory payload");
  if (raw.schemaVersion !== "meeting_knowledge.semantic_quality_authoritative_custody.v1") {
    throw new Error("canonical custody inventory does not reconstruct from admitted main inputs");
  }
  const record = raw as unknown as CanonicalCustodyEvidence;
  if (
    record.mainInputRootSha256 !== input.mainInputRootSha256 ||
    record.releaseRootSha256 !== input.releaseRootSha256 ||
    record.mainKeyNamespace.startsWith("holdout:") ||
    canonicalJson([...record.loadedQuestionDigests].toSorted()) !== canonicalJson(
      input.questions.map(({ questionDigestSha256 }) => questionDigestSha256).toSorted()) ||
    record.loadedLocatorDigests.length === 0 || record.tuningEvidenceDigests.length === 0) {
    throw new Error("canonical custody inventory does not reconstruct from admitted main inputs");
  }
  const requiredProtectedKinds = ["original_craig_recording", "final_transcript",
    "meeting_database", "frozen_snapshot", "frozen_signed_root"];
  if (!Array.isArray(record.protectedEvidence) || requiredProtectedKinds.some((kind) =>
    !record.protectedEvidence.some((value) => value.kind === kind))) {
    throw new Error("canonical custody inventory omits authoritative evidence");
  }
  for (const value of [...record.loadedLocatorDigests, ...record.loadedQuestionDigests,
    ...record.tuningEvidenceDigests]) {digest(value, "custody evidence digest");}
  return record;
}

export async function loadCleanupTargets(path: string):
Promise<readonly DerivedCampaignArtifact[]> {
  const record = exactRecord(await readProductionJson(path, "cleanup plan"),
    ["schemaVersion", "targets"], "cleanup plan");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_cleanup_plan.v2" ||
    !Array.isArray(record.targets)) {throw new Error("cleanup plan is invalid");}
  return record.targets as DerivedCampaignArtifact[];
}

export async function loadProductionHoldout(input: { readonly admitted: AdmittedMainCampaign;
  readonly authority: AdmissionAuthority; readonly custody: CanonicalCustodyEvidence;
  readonly nowEpochMs: number; readonly path: string;
  readonly ports: QualityCampaignProductionPorts }) {
  const record = exactRecord(await readProductionJson(input.path, "holdout input"),
    ["authorizationReceiptPath", "locatorDigestsPath", "questionsPath", "schemaVersion",
      "tuningEvidenceDigestsPath"], "holdout input");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_holdout_input.v2") {
    throw new Error("holdout input is invalid");
  }
  const receipt = verifyExternalSignedValue<ProductionHoldoutAuthorization>(
    await readProductionJson(absolute(String(record.authorizationReceiptPath),
      "holdout authorization"), "holdout authorization"), input.authority.keyId,
  input.authority.publicKeyPem, "holdout authorization");
  const questions = await readProductionArray(absolute(String(record.questionsPath),
    "holdout questions"), "holdout questions") as CampaignQuestion[];
  const holdoutLocatorDigests = await readProductionArray(absolute(
    String(record.locatorDigestsPath), "holdout locators"), "holdout locators") as string[];
  const tuningEvidenceDigests = await readProductionArray(absolute(
    String(record.tuningEvidenceDigestsPath), "holdout tuning evidence"),
  "holdout tuning evidence") as string[];
  assertHoldoutIsolation({ authorization: receipt.payload, holdoutLocatorDigests, input,
    questions, tuningEvidenceDigests });
  const main: FrozenMainInputProof = Object.freeze({ loadedLocatorDigests:
    input.custody.loadedLocatorDigests, loadedQuestionDigests: input.custody.loadedQuestionDigests,
    mainInputRootSha256: input.admitted.rootBindingSha256,
    mainReleaseRootSha256: input.admitted.releaseRootSha256,
    tuningCorpusSha256: sha256(input.custody.tuningEvidenceDigests) });
  return { authorization: receipt.payload, holdoutLocatorDigests, main, questions };
}

function assertHoldoutIsolation(value: { readonly authorization: ProductionHoldoutAuthorization;
  readonly holdoutLocatorDigests: readonly string[];
  readonly input: Parameters<typeof loadProductionHoldout>[0];
  readonly questions: readonly CampaignQuestion[]; readonly tuningEvidenceDigests:
  readonly string[] }): void {
  const { admitted, custody, nowEpochMs, ports } = value.input;
  if (!Number.isSafeInteger(value.authorization.expiresAtEpochMs) ||
    value.authorization.expiresAtEpochMs <= nowEpochMs ||
    value.authorization.holdoutRootSha256 === admitted.rootBindingSha256 ||
    value.authorization.keyNamespace === custody.mainKeyNamespace ||
    ports.holdoutProvider.resultAuthority.keyId === ports.mainProvider.resultAuthority.keyId ||
    ports.holdoutProvider.resultAuthority.publicKeyPem === ports.mainProvider.resultAuthority.publicKeyPem ||
    value.authorization.questionReceiptSha256 !== sha256(value.questions) ||
    canonicalJson(value.authorization.tuningEvidenceDigests) !==
      canonicalJson(value.tuningEvidenceDigests) ||
    value.tuningEvidenceDigests.some((item) => custody.tuningEvidenceDigests.includes(item)) ||
    value.holdoutLocatorDigests.some((item) => custody.loadedLocatorDigests.includes(item)) ||
    value.questions.some(({ questionDigestSha256 }) => custody.loadedQuestionDigests
      .includes(questionDigestSha256))) {
    throw new Error("holdout authorization, root, key, locator, question, or tuning evidence overlaps main");
  }
}

export async function readProductionJson(path: string, label: string): Promise<unknown> {
  try {return JSON.parse(await readProductionText(absolute(path, label), label)) as unknown;}
  catch {throw new Error(`${label} is invalid`);}
}
export async function readProductionArray(path: string, label: string):
Promise<readonly unknown[]> {
  const value = await readProductionJson(path, label);
  if (!Array.isArray(value)) {throw new Error(`${label} is invalid`);}
  return value as readonly unknown[];
}
export async function readProductionText(path: string, label: string): Promise<string> {
  try {return await readFile(absolute(path, label), "utf8");}
  catch {throw new Error(`${label} is unavailable`);}
}
function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {throw new Error(`${label} must be an absolute path`);}
  return resolve(path);
}
