/* oxlint-disable max-lines -- offline corpus custody and its closed publication inventory stay co-located */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { admitMainCampaign, MAIN_CARDINALITY, type CampaignQuestion } from "./admission.js";
import { canonicalJson, digest, exactRecord, publicKeyFingerprintSha256, safeId, sha256 } from
  "./canonical.js";
import { nodeCampaignAuthentication } from "./production-authentication.js";
import { joinFromHandle, loadSecureQualityAuthority, loadSecureQualityAuthorityPolicy,
  openQualityCampaignDirectory, readCanonicalQualityCampaignJson, readQualityCampaignBytesAt,
  readQualityCampaignText } from
  "./production-execution-corpus-custody.js";
import { validateQualificationExecutionPacket, validateQualificationGoldPacket,
  type QualificationGoldPacket } from "./qualification-corpus-packets.js";
import type { TrustedAuthorityPin } from "./release.js";

const MAXIMUM_INPUT_BYTES = 8_000_000;
const OUTPUT_FILES = Object.freeze({
  acceptance: "acceptance-receipt.json", authorization: "execution-authorization.json",
  automatic: "automatic-questions.json", execution: "execution-corpus.json",
  forbidden: "forbidden-locator-manifest.json", forbiddenEvidence: "forbidden-locators.json",
  gold: "gold-relevance.json", inventory: "locator-inventory.json",
  manifest: "InputManifest.v4.json", preparation: "corpus-admission-manifest.json",
  review1: "question-review-1.json", review2: "question-review-2.json",
  reviewed: "independent-review-questions.json", turnMapping: "turn-to-block-manifest.json",
});

interface CorpusEntry {
  readonly execution: ReturnType<typeof validateQualificationExecutionPacket>;
  readonly gold: QualificationGoldPacket;
}

interface CorpusAdmissionResult {
  readonly campaignRootSha256: string; readonly corpusAdmissionManifestSha256: string;
  readonly executionCorpusSha256: string;
  readonly goldRelevanceSha256: string;
  readonly questionCount: number;
}

interface CorpusAdmissionPhase {
  readonly acceptanceReceiptPath: string;
  readonly authorityPolicyPath: string;
  readonly custodyAuthorityPath: string;
  readonly executionAuthorizationPath: string;
  readonly executionSignerPath: string;
  readonly forbiddenLocatorManifestPath: string;
  readonly goldRelevanceSignerPath: string;
  readonly locatorSignerPath: string;
  readonly outputRoot: string;
  readonly questionReviewReceiptPaths: readonly [string, string];
  readonly releaseRootSha256: string;
  readonly reviewerAuthorityPaths: readonly [string, string];
  readonly sealedCorpusPath: string;
  readonly turnToBlockManifestPath: string;
}

export interface CorpusAdmissionClock { readonly nowEpochMs: () => number; }

/** Offline-only custodian slice. Runtime time enters through the adapter-owned clock boundary. */
export async function admitSealedQualificationCorpus(value: unknown,
  clock: CorpusAdmissionClock):
Promise<CorpusAdmissionResult> {
  const input = decodePhase(value);
  const authorizationComparisonEpochMs = clock.nowEpochMs();
  if (!Number.isSafeInteger(authorizationComparisonEpochMs) || authorizationComparisonEpochMs < 0) {
    throw new Error("corpus admission clock is invalid");
  }
  const paths = inputPaths(input);
  if (pathsOverlap([...paths, input.outputRoot])) {
    throw new Error("corpus admission paths overlap or substitute an output");
  }
  const [corpusValue, acceptance, authorization, review1, review2, mapping, forbidden] =
    await Promise.all([readJson(input.sealedCorpusPath, "sealed corpus"),
      readJson(input.acceptanceReceiptPath, "acceptance receipt"),
      readJson(input.executionAuthorizationPath, "execution authorization"),
      readJson(input.questionReviewReceiptPaths[0], "question review 1"),
      readJson(input.questionReviewReceiptPaths[1], "question review 2"),
      readJson(input.turnToBlockManifestPath, "turn-to-block manifest"),
      readJson(input.forbiddenLocatorManifestPath, "forbidden-locator manifest")]);
  const corpus = decodeCorpus(corpusValue, input.releaseRootSha256);
  const policy = await loadSecureQualityAuthorityPolicy(input.authorityPolicyPath);
  const custody = await loadSecureQualityAuthority(input.custodyAuthorityPath);
  const reviewers = await Promise.all(input.reviewerAuthorityPaths.map(loadSecureQualityAuthority));
  policy.assertReference("artifact_custody", custody.keyId);
  policy.assertReference("reviewer_1", reviewers[0]!.keyId);
  policy.assertReference("reviewer_2", reviewers[1]!.keyId);
  const signers = await Promise.all([
    loadSigner(input.executionSignerPath, policy.authority("artifact_custody")),
    loadSigner(input.goldRelevanceSignerPath, policy.authority("gold_relevance")),
    loadSigner(input.locatorSignerPath, policy.authority("locator")),
  ]);
  const questions = corpus.entries.map(toCampaignQuestion);
  assertCorpusCounts(questions);
  const corpusDigestSha256 = sha256(corpusValue);
  const questionSetSha256 = sha256(questions);
  verifyPreparationReceipts({ acceptance, authorization, corpus, corpusDigestSha256,
    custody, input, mapping, forbidden, nowEpochMs: authorizationComparisonEpochMs,
    questionSetSha256, questions,
    reviewReceipts: [review1, review2], reviewers });

  const { output, outputName, parent } = await createPrivateOutput(input.outputRoot);
  try {
    const initialFiles: Readonly<Record<string, unknown>> = Object.freeze({
      [OUTPUT_FILES.acceptance]: acceptance, [OUTPUT_FILES.authorization]: authorization,
      [OUTPUT_FILES.automatic]: questions.filter(({ source }) => source === "automatic"),
      [OUTPUT_FILES.forbidden]: forbidden, [OUTPUT_FILES.review1]: review1,
      [OUTPUT_FILES.review2]: review2,
      [OUTPUT_FILES.reviewed]: questions.filter(({ source }) => source === "independent_review"),
      [OUTPUT_FILES.turnMapping]: mapping,
    });
    const checksumInventory = [];
    for (const [path, document] of Object.entries(initialFiles)) {
      const bytes = canonicalJson(document); await writeCreateOnly(output, path, bytes);
      checksumInventory.push({ path, sha256: sha256(Buffer.from(bytes)) });
    }
    const inputManifest = { acceptanceReceiptPath: OUTPUT_FILES.acceptance, checksumInventory,
      corpusDigestSha256, executionAuthorizationPath: OUTPUT_FILES.authorization,
      forbiddenLocatorManifestPath: OUTPUT_FILES.forbidden,
      independentReviewQuestionsPath: OUTPUT_FILES.reviewed,
      questionReviewReceiptPaths: [OUTPUT_FILES.review1, OUTPUT_FILES.review2],
      reviewerDigestSha256: corpus.reviewerDigestSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_input_manifest.v4",
      sealedAutomaticQuestionsPath: OUTPUT_FILES.automatic,
      sourceDigestSha256: corpus.sourceDigestSha256,
      turnToBlockManifestPath: OUTPUT_FILES.turnMapping } as const;
    await writeCreateOnly(output, OUTPUT_FILES.manifest, canonicalJson(inputManifest));
    const admitted = await admitMainCampaign(policy, { authorityKeyId: custody.keyId,
      manifestDirectory: output,
      manifestPath: joinFromHandle(output, OUTPUT_FILES.manifest),
      nowEpochMs: authorizationComparisonEpochMs,
      releaseRootSha256: input.releaseRootSha256,
      reviewerAuthorityKeyIds: [reviewers[0]!.keyId, reviewers[1]!.keyId] });
    const execution = signed(signers[0], { campaignRootSha256: admitted.rootBindingSha256,
      packets: corpus.entries.map(({ execution: packet }) => packet),
      schemaVersion: "meeting_knowledge.quality_execution_corpus.v1" });
    const goldEntries = corpus.entries.map(({ gold }, index) => ({
      ...questions[index]!, campaignRootSha256: admitted.rootBindingSha256,
      expectedAbstention: gold.abstentionAuthority === "must_abstain",
      releaseRootSha256: input.releaseRootSha256,
      relevantLocatorIds: gold.evidenceLocators,
    }));
    const gold = signed(signers[1], { campaignRootSha256: admitted.rootBindingSha256,
      entries: goldEntries, releaseRootSha256: input.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_gold_relevance.v1" });
    const locatorIds = [...new Set(corpus.turnMappings.map(({ sourceLocatorId }) =>
      sourceLocatorId))]
      .toSorted();
    if (locatorIds.length === 0) {throw new Error("sealed corpus has no authorized locators");}
    const locatorInventory = signed(signers[2], { campaignRootSha256:
      admitted.rootBindingSha256, locatorIds, releaseRootSha256: input.releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_locator_inventory.v1" });
    const forbiddenEvidence = signed(signers[2], { campaignRootSha256:
      admitted.rootBindingSha256, forbiddenLocatorIds: corpus.forbiddenLocatorIds,
      questionSetSha256: admitted.questionSetSha256, releaseRootSha256: input.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_forbidden_locators.v2" });
    const finalFiles = { [OUTPUT_FILES.execution]: execution,
      [OUTPUT_FILES.forbiddenEvidence]: forbiddenEvidence, [OUTPUT_FILES.gold]: gold,
      [OUTPUT_FILES.inventory]: locatorInventory };
    for (const [path, document] of Object.entries(finalFiles)) {
      await writeCreateOnly(output, path, canonicalJson(document));
    }
    const artifactInventory = await Promise.all([...Object.keys(initialFiles), OUTPUT_FILES.manifest,
      ...Object.keys(finalFiles)].toSorted().map(async (path) => ({ path,
        sha256: sha256(await readOutput(output, path)) })));
    const preparation = { artifactInventory, authorizationComparisonEpochMs,
      campaignRootSha256: admitted.rootBindingSha256, completionState: "complete",
      corpusDigestSha256, questionCount: questions.length,
      questionSetSha256: admitted.questionSetSha256, releaseRootSha256: input.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_corpus_admission_manifest.v1" } as const;
    await output.sync();
    await writeCreateOnly(output, OUTPUT_FILES.preparation, canonicalJson(preparation));
    await output.sync(); await parent.sync();
    const result = Object.freeze({ campaignRootSha256: admitted.rootBindingSha256,
      corpusAdmissionManifestSha256: sha256(preparation), executionCorpusSha256: sha256(execution),
      goldRelevanceSha256: sha256(gold), questionCount: questions.length });
    await output.close(); await parent.close();
    return result;
  } catch (error) {
    const cleanupError = await cleanupOutput(parent, output, outputName);
    if (cleanupError !== undefined && error instanceof Error) {
      Object.defineProperty(error, "cleanupError", { value: cleanupError });
    }
    throw error;
  }
}

async function createPrivateOutput(outputRoot: string) {
  const parent = await openQualityCampaignDirectory(dirname(outputRoot),
    "corpus admission parent");
  const metadata = await parent.stat();
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
    const error = new Error("corpus admission parent must be a private directory");
    try {await parent.close();} catch (cleanup) {attachCleanup(error, cleanup);}
    throw error;
  }
  const outputName = basename(outputRoot);
  let created = false;
  try {
    await mkdir(joinFromHandle(parent, outputName), { mode: 0o700 }); created = true;
    await parent.sync();
    const output = await open(joinFromHandle(parent, outputName), constants.O_RDONLY |
      constants.O_DIRECTORY | constants.O_NOFOLLOW);
    return { output, outputName, parent };
  } catch (error) {
    const cleanup = await cleanupOutput(parent, undefined, created ? outputName : undefined);
    if (error instanceof Error && cleanup !== undefined) {attachCleanup(error, cleanup);}
    throw error;
  }
}

async function cleanupOutput(parent: FileHandle, output: FileHandle | undefined,
  outputName: string | undefined): Promise<unknown> {
  let cleanupError: unknown;
  try {await output?.close();} catch (error) {cleanupError ??= error;}
  // A failed admission may have durable partial files. Retain them fail-closed: pathname-based
  // recursive cleanup cannot prove it still targets the directory descriptor we created.
  void outputName;
  try {await parent.sync();} catch (error) {cleanupError ??= error;}
  try {await parent.close();} catch (error) {cleanupError ??= error;}
  return cleanupError;
}

function attachCleanup(error: Error, cleanup: unknown): void {
  Object.defineProperty(error, "cleanupError", { value: cleanup });
}

function decodePhase(value: unknown): CorpusAdmissionPhase {
  const keys = ["acceptanceReceiptPath", "authorityPolicyPath",
    "custodyAuthorityPath", "executionAuthorizationPath", "executionSignerPath",
    "forbiddenLocatorManifestPath", "goldRelevanceSignerPath", "locatorSignerPath", "outputRoot",
    "questionReviewReceiptPaths", "releaseRootSha256", "reviewerAuthorityPaths",
    "sealedCorpusPath", "turnToBlockManifestPath"];
  const record = exactRecord(value, keys, "corpus admission phase payload");
  for (const pathKey of keys.filter((candidate) =>
    candidate.endsWith("Path") || candidate === "outputRoot")) {
    record[pathKey] = absolute(record[pathKey], pathKey);
  }
  for (const key of ["questionReviewReceiptPaths", "reviewerAuthorityPaths"] as const) {
    if (!Array.isArray(record[key]) || record[key].length !== 2) {
      throw new Error(`${key} must contain exactly two paths`);
    }
    record[key] = record[key].map((path) => absolute(path, key));
  }
  record.releaseRootSha256 = digest(record.releaseRootSha256, "corpus admission release root");
  return record as unknown as CorpusAdmissionPhase;
}

function decodeCorpus(value: unknown, releaseRootSha256: string) {
  const record = exactRecord(value, ["entries", "forbiddenLocatorIds", "releaseRootSha256",
    "reviewerDigestSha256", "schemaVersion", "snapshotSha256", "sourceDigestSha256",
    "turnMappings"], "sealed corpus");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_sealed_corpus.v1" ||
    record.releaseRootSha256 !== releaseRootSha256 || !Array.isArray(record.entries) ||
    record.entries.length !== MAIN_CARDINALITY.perRepetition) {
    throw new Error("sealed corpus version, release, or cardinality is invalid");
  }
  const entries = record.entries.map((entryValue): CorpusEntry => {
    const entry = exactRecord(entryValue, ["execution", "gold"],
      "sealed corpus entry");
    const execution = validateQualificationExecutionPacket(entry.execution);
    const gold = validateQualificationGoldPacket(entry.gold);
    locatorList(gold.evidenceLocators, "gold evidence locator");
    if (gold.questionId !== execution.questionId ||
      gold.abstentionAuthority === "must_abstain" && (gold.evidenceLocators.length !== 0 ||
        gold.expectedClaims.length !== 0 || gold.speakerTimeAuthority.length !== 0) ||
      gold.abstentionAuthority === "answerable" && (gold.evidenceLocators.length === 0 ||
      gold.expectedClaims.length === 0)) {
      throw new Error("sealed corpus answerability or question binding is invalid");
    }
    return Object.freeze({ execution, gold });
  });
  if (new Set(entries.map(({ execution }) => execution.questionId)).size !== entries.length) {
    throw new Error("sealed corpus contains duplicate question IDs");
  }
  const forbiddenLocatorIds = locatorList(record.forbiddenLocatorIds,
    "global forbidden locator", 100);
  if (forbiddenLocatorIds.length === 0) {throw new Error("global forbidden locator set is empty");}
  if (!Array.isArray(record.turnMappings) || record.turnMappings.length === 0 ||
    record.turnMappings.length > 100_000) {throw new Error("turn mapping dataset is invalid");}
  const turnMappings = record.turnMappings.map((mappingValue) => {
    const mapping = exactRecord(mappingValue, ["sourceLocatorId", "turnId"], "turn mapping");
    return Object.freeze({ sourceLocatorId: digest(mapping.sourceLocatorId,
      "turn mapping source locator"), turnId: safeId(mapping.turnId, "turn mapping turn ID") });
  });
  const evidenceLocators = [...new Set(entries.flatMap(({ gold }) => gold.evidenceLocators))];
  if (new Set(turnMappings.map(({ turnId }) => turnId)).size !== turnMappings.length ||
    evidenceLocators.some((locator) => !turnMappings.some(({ sourceLocatorId }) =>
      sourceLocatorId === locator)) || turnMappings.some(({ sourceLocatorId }) =>
      forbiddenLocatorIds.includes(sourceLocatorId))) {
    throw new Error("authoritative locator datasets are duplicated, incomplete, or overlapping");
  }
  return Object.freeze({ entries: Object.freeze(entries), forbiddenLocatorIds,
    releaseRootSha256: digest(record.releaseRootSha256, "sealed corpus release"),
    reviewerDigestSha256: digest(record.reviewerDigestSha256, "sealed corpus reviewers"),
    snapshotSha256: digest(record.snapshotSha256, "sealed corpus snapshot"), turnMappings,
    sourceDigestSha256: digest(record.sourceDigestSha256, "sealed corpus source") });
}

function toCampaignQuestion(entry: CorpusEntry): CampaignQuestion {
  return Object.freeze({ locale: entry.execution.locale,
    questionDigestSha256: sha256(entry.execution), questionId: entry.execution.questionId,
    rubricDigestSha256: sha256(entry.gold), source: entry.execution.source });
}

function assertCorpusCounts(questions: readonly CampaignQuestion[]): void {
  if (questions.filter(({ source }) => source === "automatic").length !== MAIN_CARDINALITY.automatic ||
    questions.filter(({ source }) => source === "independent_review").length !==
      MAIN_CARDINALITY.independentReview || new Set(questions.map(({ questionDigestSha256 }) =>
      questionDigestSha256)).size !== questions.length) {
    throw new Error("sealed corpus must contain exactly 200 automatic and 40 reviewed questions");
  }
}

// oxlint-disable-next-line complexity -- every independent corpus authority is checked together
function verifyPreparationReceipts(input: { readonly acceptance: unknown;
  readonly authorization: unknown; readonly corpus: ReturnType<typeof decodeCorpus>;
  readonly corpusDigestSha256: string;
  readonly custody: Awaited<ReturnType<typeof loadSecureQualityAuthority>>;
  readonly forbidden: unknown; readonly input: ReturnType<typeof decodePhase>;
  readonly mapping: unknown; readonly nowEpochMs: number; readonly questionSetSha256: string;
  readonly questions: readonly CampaignQuestion[]; readonly reviewReceipts: readonly [unknown, unknown];
  readonly reviewers: readonly Awaited<ReturnType<typeof loadSecureQualityAuthority>>[] }): void {
  const acceptance = nodeCampaignAuthentication.verify<Record<string, unknown>>(input.acceptance,
    input.custody.keyId, input.custody.publicKeyPem, "corpus acceptance");
  const payload = exactRecord(acceptance.payload, ["corpusDigestSha256", "purpose",
    "reviewerDigestSha256", "schemaVersion", "sourceDigestSha256"], "corpus acceptance payload");
  if (payload.schemaVersion !== "meeting_knowledge.semantic_quality_acceptance.v1" ||
    payload.purpose !== "custody_only" || payload.corpusDigestSha256 !== input.corpusDigestSha256 ||
    payload.reviewerDigestSha256 !== input.corpus.reviewerDigestSha256 ||
    payload.sourceDigestSha256 !== input.corpus.sourceDigestSha256) {
    throw new Error("custody acceptance does not seal this corpus");
  }
  const authorization = nodeCampaignAuthentication.verify<Record<string, unknown>>(
    input.authorization, input.custody.keyId, input.custody.publicKeyPem,
    "corpus execution authorization");
  const auth = exactRecord(authorization.payload, ["acceptanceReceiptSha256",
    "authorizedProviderExecution", "corpusDigestSha256", "expiresAtEpochMs",
    "releaseRootSha256", "schemaVersion"], "corpus execution authorization payload");
  if (auth.schemaVersion !== "meeting_knowledge.semantic_quality_execution_authorization.v1" ||
    auth.authorizedProviderExecution !== true || !Number.isSafeInteger(auth.expiresAtEpochMs) ||
    Number(auth.expiresAtEpochMs) <= input.nowEpochMs ||
    auth.acceptanceReceiptSha256 !== sha256(input.acceptance) ||
    auth.corpusDigestSha256 !== input.corpusDigestSha256 ||
    auth.releaseRootSha256 !== input.input.releaseRootSha256) {
    throw new Error("execution authorization does not bind this corpus");
  }
  const rubricSetSha256 = sha256(input.questions.map(({ questionId, rubricDigestSha256 }) =>
    ({ questionId, rubricDigestSha256 })));
  input.reviewReceipts.forEach((receipt, index) => {
    const verified = nodeCampaignAuthentication.verify<Record<string, unknown>>(receipt,
      input.reviewers[index]!.keyId, input.reviewers[index]!.publicKeyPem, "corpus review");
    const review = exactRecord(verified.payload, ["corpusDigestSha256", "questionSetSha256",
      "reviewerDigestSha256", "rubricSetSha256", "schemaVersion"], "corpus review payload");
    if (review.schemaVersion !== "meeting_knowledge.semantic_quality_question_review.v1" ||
      review.corpusDigestSha256 !== input.corpusDigestSha256 ||
      review.questionSetSha256 !== input.questionSetSha256 ||
      review.reviewerDigestSha256 !== input.corpus.reviewerDigestSha256 ||
      review.rubricSetSha256 !== rubricSetSha256) {
      throw new Error("independent review does not bind this corpus");
    }
  });
  for (const [label, document] of [["mapping", input.mapping], ["forbidden", input.forbidden]] as const) {
    const verified = nodeCampaignAuthentication.verify<Record<string, unknown>>(document,
      input.custody.keyId, input.custody.publicKeyPem, `${label} custody`);
    const digestKey = label === "mapping" ? "turnMappingsSha256" : "forbiddenLocatorSetSha256";
    const authority = exactRecord(verified.payload, [digestKey, "releaseRootSha256",
      "schemaVersion", "snapshotSha256"], `${label} custody payload`);
    const actualDataset = label === "mapping" ? input.corpus.turnMappings :
      input.corpus.forbiddenLocatorIds;
    const expectedDatasetSha256 = sha256({ dataset: actualDataset, purpose: label === "mapping" ?
      "turn_to_source_locator_authority" : "global_forbidden_locator_authority" });
    if (authority.schemaVersion !== "meeting_knowledge.semantic_quality_locator_authority.v1" ||
      authority.releaseRootSha256 !== input.input.releaseRootSha256 ||
      authority.snapshotSha256 !== input.corpus.snapshotSha256 ||
      authority[digestKey] !== expectedDatasetSha256) {
      throw new Error(`${label} custody is foreign`);
    }
  }
}

async function loadSigner(path: string, pin: TrustedAuthorityPin) {
  const record = exactRecord(await readJson(path, "signer"), ["keyId", "privateKeyPath"],
    "signer configuration");
  if (record.keyId !== pin.keyId) {throw new Error("signer role is foreign");}
  const pem = await readQualityCampaignText(absolute(record.privateKeyPath, "private key"),
    "private key", 16_384);
  let key; try {key = createPrivateKey(pem);} catch {throw new Error("signer private key is invalid");}
  const publicPem = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
  if (publicKeyFingerprintSha256(publicPem, "signer") !== pin.publicKeyFingerprintSha256) {
    throw new Error("signer private key does not match its pinned role");
  }
  return Object.freeze({ key, keyId: safeId(record.keyId, "signer key ID") });
}

function signed(signer: Awaited<ReturnType<typeof loadSigner>>, payload: unknown) {
  return Object.freeze({ payload, signatureBase64: sign(null, Buffer.from(canonicalJson(payload)),
    signer.key).toString("base64"), signerKeyId: signer.keyId });
}

function locatorList(value: unknown, label: string, maximum = 256): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {throw new Error(`${label} list is invalid`);}
  const values = value.map((item) => digest(item, label));
  if (new Set(values).size !== values.length) {throw new Error(`${label} list is duplicated`);}
  return Object.freeze(values);
}

function inputPaths(input: ReturnType<typeof decodePhase>): readonly string[] {
  return [input.acceptanceReceiptPath, input.authorityPolicyPath, input.custodyAuthorityPath,
    input.executionAuthorizationPath, input.executionSignerPath, input.forbiddenLocatorManifestPath,
    input.goldRelevanceSignerPath, input.locatorSignerPath, input.sealedCorpusPath,
    input.turnToBlockManifestPath, ...input.questionReviewReceiptPaths,
    ...input.reviewerAuthorityPaths].map((path) => resolve(path));
}

async function readJson(path: string, label: string): Promise<unknown> {
  return await readCanonicalQualityCampaignJson(path, label);
}

async function writeCreateOnly(directory: FileHandle, path: string, bytes: string): Promise<void> {
  if (Buffer.byteLength(bytes) > MAXIMUM_INPUT_BYTES) {throw new Error("artifact exceeds byte limit");}
  const file = await open(joinFromHandle(directory, path), constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {await file.writeFile(bytes); await file.sync();}
  finally {await file.close();}
}

async function readOutput(directory: FileHandle, path: string): Promise<Buffer> {
  return await readQualityCampaignBytesAt(directory, path, "published corpus artifact",
    MAXIMUM_INPUT_BYTES);
}

function absolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0"))
    {throw new Error(`${label} must be an absolute path`);}
  return resolve(value);
}

function isInside(root: string, path: string): boolean {return path === root ||
  path.startsWith(`${root}/`);}

function pathsOverlap(paths: readonly string[]): boolean {
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (isInside(paths[left]!, paths[right]!) || isInside(paths[right]!, paths[left]!)) {return true;}
    }
  }
  return false;
}
