import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { QualityCampaignAuthorityPolicy } from "./release.js";

export const MAIN_CARDINALITY = Object.freeze({
  automatic: 200,
  independentReview: 40,
  perRepetition: 240,
  repetitions: 3,
  total: 720,
});
export const HOLDOUT_CARDINALITY = 30;

export interface CampaignQuestion {
  readonly locale: "en" | "mixed" | "ru";
  readonly questionDigestSha256: string;
  readonly questionId: string;
  readonly rubricDigestSha256: string;
  readonly source: "automatic" | "independent_review";
}

interface SignedDocument<T> {
  readonly payload: T;
  readonly signatureBase64: string;
  readonly signerKeyId: string;
}

export interface AdmissionAuthority {
  readonly keyId: string;
  readonly publicKeyPem: string;
}

export interface AdmittedMainCampaign {
  readonly executionAuthorizationSha256: string;
  readonly forbiddenLocatorManifestSha256: string;
  readonly inputManifestSha256: string;
  readonly questions: readonly CampaignQuestion[];
  readonly questionSetSha256: string;
  readonly releaseRootSha256: string;
  readonly reviewerReceiptSetSha256: string;
  readonly rootBindingSha256: string;
  readonly snapshotSha256: string;
  readonly turnToBlockManifestSha256: string;
}

type InputManifest = {
  readonly acceptanceReceiptPath: string;
  readonly checksumInventory: readonly { readonly path: string; readonly sha256: string }[];
  readonly corpusDigestSha256: string;
  readonly executionAuthorizationPath: string;
  readonly forbiddenLocatorManifestPath: string;
  readonly independentReviewQuestionsPath: string;
  readonly questionReviewReceiptPaths: readonly string[];
  readonly reviewerDigestSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_input_manifest.v4";
  readonly sealedAutomaticQuestionsPath: string;
  readonly sourceDigestSha256: string;
  readonly turnToBlockManifestPath: string;
};

/** Admits only exact sealed files. It never returns question or rubric text. */
export async function admitMainCampaign(policy: QualityCampaignAuthorityPolicy, input: {
  readonly authorityKeyId: string;
  readonly manifestPath: string;
  readonly nowEpochMs: number;
  readonly releaseRootSha256: string;
  readonly reviewerAuthorityKeyIds: readonly [string, string];
}): Promise<AdmittedMainCampaign> {
  const authority = policy.assertReference("artifact_custody", input.authorityKeyId);
  const reviewerAuthorities = [policy.assertReference("reviewer_1",
    input.reviewerAuthorityKeyIds[0]), policy.assertReference("reviewer_2",
    input.reviewerAuthorityKeyIds[1])] as const;
  digest(input.releaseRootSha256, "release root");
  const manifestPath = absolute(input.manifestPath, "input manifest");
  const manifestBytes = await readFile(manifestPath);
  const manifest = decodeManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  if (manifest.questionReviewReceiptPaths.length !== 2) {
    throw new Error("exactly two question review receipts are required");
  }
  const base = dirname(manifestPath);
  const inventory = await verifyInventory(base, manifest.checksumInventory);
  const requiredInventoryPaths = [manifest.acceptanceReceiptPath,
    manifest.executionAuthorizationPath, manifest.forbiddenLocatorManifestPath,
    manifest.independentReviewQuestionsPath, manifest.sealedAutomaticQuestionsPath,
    manifest.turnToBlockManifestPath, ...manifest.questionReviewReceiptPaths]
    .map((path) => normalize(path)).toSorted();
  if (canonicalJson(inventory.map(({ path }) => path).toSorted()) !==
    canonicalJson(requiredInventoryPaths)) {
    throw new Error("checksum inventory does not cover the exact sealed input set");
  }
  const acceptance = await readSigned(base, manifest.acceptanceReceiptPath, authority);
  const acceptancePayload = exactRecord(acceptance.payload, ["corpusDigestSha256", "purpose",
    "reviewerDigestSha256", "schemaVersion", "sourceDigestSha256"], "acceptance receipt");
  if (acceptancePayload.schemaVersion !== "meeting_knowledge.semantic_quality_acceptance.v1" ||
    acceptancePayload.purpose !== "custody_only" ||
    acceptancePayload.sourceDigestSha256 !== manifest.sourceDigestSha256 ||
    acceptancePayload.corpusDigestSha256 !== manifest.corpusDigestSha256 ||
    acceptancePayload.reviewerDigestSha256 !== manifest.reviewerDigestSha256) {
    throw new Error("custody receipt does not seal this immutable input");
  }
  const authorization = await readSigned(base, manifest.executionAuthorizationPath,
    authority);
  const authPayload = exactRecord(authorization.payload, ["acceptanceReceiptSha256",
    "authorizedProviderExecution", "corpusDigestSha256", "expiresAtEpochMs",
    "releaseRootSha256", "schemaVersion"], "execution authorization");
  assertExecutionAuthorization(authPayload, acceptance, manifest, input.releaseRootSha256,
    input.nowEpochMs);

  const automatic = await readQuestions(base, manifest.sealedAutomaticQuestionsPath,
    "automatic", MAIN_CARDINALITY.automatic);
  const reviewed = await readQuestions(base, manifest.independentReviewQuestionsPath,
    "independent_review", MAIN_CARDINALITY.independentReview);
  const questions = Object.freeze([...automatic, ...reviewed]);
  if (new Set(questions.map(({ questionId }) => questionId)).size !== MAIN_CARDINALITY.perRepetition ||
    new Set(questions.map(({ questionDigestSha256 }) => questionDigestSha256)).size !==
      MAIN_CARDINALITY.perRepetition) {
    throw new Error("sealed question membership is duplicated");
  }
  const questionSetSha256 = sha256(questions);
  const reviewReceipts = await Promise.all(manifest.questionReviewReceiptPaths.map(async (path,
    index) => await readSigned(base, path, reviewerAuthorities[index]!)));
  if (reviewReceipts.some(({ payload }) => {
      const record = exactRecord(payload, ["corpusDigestSha256", "questionSetSha256",
        "reviewerDigestSha256", "rubricSetSha256", "schemaVersion"], "review receipt");
      return record.schemaVersion !== "meeting_knowledge.semantic_quality_question_review.v1" ||
        record.corpusDigestSha256 !== manifest.corpusDigestSha256 ||
        record.questionSetSha256 !== questionSetSha256 ||
        record.reviewerDigestSha256 !== manifest.reviewerDigestSha256 ||
        record.rubricSetSha256 !== sha256(questions.map((question) => ({
          questionId: question.questionId, rubricDigestSha256: question.rubricDigestSha256,
        })));
    })) {throw new Error("questions lack two independent exact-binding reviews");}

  const mapping = await readSigned(base, manifest.turnToBlockManifestPath, authority);
  const forbidden = await readSigned(base, manifest.forbiddenLocatorManifestPath, authority);
  const snapshotSha256 = requireSnapshotManifest(mapping.payload, "turn-to-block",
    input.releaseRootSha256);
  if (requireSnapshotManifest(forbidden.payload, "forbidden-locator",
    input.releaseRootSha256) !== snapshotSha256) {
    throw new Error("locator authorities were not derived from one frozen snapshot");
  }
  const root = {
    authorizationSha256: sha256(authorization), cardinality: MAIN_CARDINALITY,
    corpusDigestSha256: manifest.corpusDigestSha256,
    forbiddenLocatorManifestSha256: sha256(forbidden), inputManifestSha256: sha256(manifestBytes),
    inventorySha256: sha256(inventory), questionSetSha256, releaseRootSha256: input.releaseRootSha256,
    reviewerReceiptSetSha256: sha256(reviewReceipts), snapshotSha256,
    sourceDigestSha256: manifest.sourceDigestSha256,
    turnToBlockManifestSha256: sha256(mapping),
  };
  return Object.freeze({ executionAuthorizationSha256: root.authorizationSha256,
    forbiddenLocatorManifestSha256: root.forbiddenLocatorManifestSha256,
    inputManifestSha256: root.inputManifestSha256, questions, questionSetSha256,
    releaseRootSha256: input.releaseRootSha256,
    reviewerReceiptSetSha256: root.reviewerReceiptSetSha256,
    rootBindingSha256: sha256(root), snapshotSha256,
    turnToBlockManifestSha256: root.turnToBlockManifestSha256 });
}

function assertExecutionAuthorization(authPayload: Record<string, unknown>, acceptance: unknown,
  manifest: InputManifest, releaseRootSha256: string, nowEpochMs: number): void {
  if (authPayload.schemaVersion !== "meeting_knowledge.semantic_quality_execution_authorization.v1" ||
    authPayload.authorizedProviderExecution !== true ||
    authPayload.acceptanceReceiptSha256 !== sha256(acceptance) ||
    authPayload.corpusDigestSha256 !== manifest.corpusDigestSha256 ||
    authPayload.releaseRootSha256 !== releaseRootSha256 ||
    typeof authPayload.expiresAtEpochMs !== "number" ||
    !Number.isSafeInteger(nowEpochMs) || !Number.isSafeInteger(authPayload.expiresAtEpochMs) ||
    authPayload.expiresAtEpochMs <= nowEpochMs) {
    throw new Error("provider execution is not separately authorized");
  }
}

async function readQuestions(base: string, path: string, source: CampaignQuestion["source"],
  count: number): Promise<readonly CampaignQuestion[]> {
  const value = JSON.parse((await readFile(inside(base, path))).toString("utf8")) as unknown;
  if (!Array.isArray(value) || value.length !== count) {throw new Error("sealed corpus cardinality is invalid");}
  return Object.freeze(value.map((item) => validateCampaignQuestion(item, source)));
}

export function validateCampaignQuestion(value: unknown,
  source?: CampaignQuestion["source"]): CampaignQuestion {
  const record = exactRecord(value, ["locale", "questionDigestSha256", "questionId",
    "rubricDigestSha256", "source"], "sealed question");
  if (!ALLOWED_QUESTION_SOURCES.includes(record.source as CampaignQuestion["source"]) ||
    source !== undefined && record.source !== source ||
    !ALLOWED_QUESTION_LOCALES.includes(record.locale as CampaignQuestion["locale"])) {
    throw new Error("sealed question provenance is invalid");
  }
  return Object.freeze({ locale: record.locale as CampaignQuestion["locale"],
    questionDigestSha256: digest(record.questionDigestSha256, "question digest"),
    questionId: safeId(record.questionId, "question ID"),
    rubricDigestSha256: digest(record.rubricDigestSha256, "rubric digest"),
    source: record.source as CampaignQuestion["source"] });
}

const ALLOWED_QUESTION_LOCALES: readonly CampaignQuestion["locale"][] = ["en", "mixed", "ru"];
const ALLOWED_QUESTION_SOURCES: readonly CampaignQuestion["source"][] =
  ["automatic", "independent_review"];

async function readSigned(base: string, path: string, authority: AdmissionAuthority):
Promise<SignedDocument<unknown>> {
  if (authority.keyId.trim() === "") {throw new Error("admission authority is invalid");}
  const record = exactRecord(JSON.parse((await readFile(inside(base, path))).toString("utf8")),
    ["payload", "signatureBase64", "signerKeyId"], "signed document");
  if (record.signerKeyId !== authority.keyId || typeof record.signatureBase64 !== "string") {
    throw new Error("signed document authority is invalid");
  }
  const signed = record as unknown as SignedDocument<unknown>;
  let valid = false;
  try {valid = verify(null, Buffer.from(canonicalJson(signed.payload)),
    createPublicKey(authority.publicKeyPem), Buffer.from(signed.signatureBase64, "base64"));}
  catch {valid = false;}
  if (!valid) {throw new Error("detached signature is invalid");}
  return Object.freeze(signed);
}

async function verifyInventory(base: string, entries: InputManifest["checksumInventory"]) {
  if (entries.length === 0) {throw new Error("checksum inventory is empty");}
  const seen = new Set<string>();
  const output = [];
  for (const entry of entries) {
    const record = exactRecord(entry, ["path", "sha256"], "checksum entry");
    const path = inside(base, String(record.path));
    if (seen.has(path)) {throw new Error("checksum inventory contains duplicates");}
    seen.add(path);
    const actual = createHash("sha256").update(await readFile(path)).digest("hex");
    if (actual !== digest(record.sha256, "inventory digest")) {throw new Error("checksum mismatch");}
    output.push({ path: normalize(String(record.path)), sha256: actual });
  }
  return Object.freeze(output);
}

function requireSnapshotManifest(value: unknown, label: string, releaseRootSha256: string): string {
  const record = exactRecord(value, ["entriesSha256", "releaseRootSha256", "schemaVersion",
    "snapshotSha256"], label);
  digest(record.entriesSha256, `${label} entries`);
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_locator_authority.v1") {
    throw new Error(`${label} schema version is unsupported`);
  }
  if (digest(record.releaseRootSha256, `${label} release`) !== releaseRootSha256) {
    throw new Error(`${label} is bound to another release`);
  }
  return digest(record.snapshotSha256, `${label} snapshot`);
}

function decodeManifest(value: unknown): InputManifest {
  const keys = ["acceptanceReceiptPath", "checksumInventory", "corpusDigestSha256",
    "executionAuthorizationPath", "forbiddenLocatorManifestPath",
    "independentReviewQuestionsPath", "questionReviewReceiptPaths", "reviewerDigestSha256",
    "schemaVersion", "sealedAutomaticQuestionsPath", "sourceDigestSha256",
    "turnToBlockManifestPath"];
  const record = exactRecord(value, keys, "InputManifest.v4.json");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_input_manifest.v4" ||
    !Array.isArray(record.checksumInventory) || !Array.isArray(record.questionReviewReceiptPaths)) {
    throw new Error("InputManifest.v4.json is invalid");
  }
  digest(record.sourceDigestSha256, "source digest");
  digest(record.corpusDigestSha256, "corpus digest");
  digest(record.reviewerDigestSha256, "reviewer digest");
  return record as unknown as InputManifest;
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {throw new Error(`${label} path must be absolute`);}
  return resolve(path);
}

function inside(base: string, path: string): string {
  if (typeof path !== "string" || path.includes("\0") || isAbsolute(path)) {
    throw new Error("sealed input path must be relative");
  }
  const result = resolve(join(base, path));
  if (!result.startsWith(`${resolve(base)}/`)) {throw new Error("sealed input escapes its root");}
  return result;
}
