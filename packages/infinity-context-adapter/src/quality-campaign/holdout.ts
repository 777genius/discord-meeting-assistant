import { canonicalJson, digest, exactRecord, publicKeyFingerprintSha256, safeId,
  sha256 } from "./canonical.js";
import { HOLDOUT_CARDINALITY, type AdmissionAuthority, type CampaignQuestion,
  validateCampaignQuestion } from "./admission.js";
import { verifyExternalSignedValue } from "./execution.js";

export interface FrozenMainInputProof {
  readonly loadedLocatorDigests: readonly string[];
  readonly loadedQuestionDigests: readonly string[];
  readonly mainInputRootSha256: string;
  readonly mainReleaseRootSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_main_input_proof.v1";
  readonly tuningCorpusSha256: string;
}

export interface HoldoutAuthorization {
  readonly holdoutLocatorSetSha256: string;
  readonly holdoutQuestionSetSha256: string;
  readonly holdoutRootSha256: string;
  readonly keyNamespace: string;
  readonly mainInputRootSha256: string;
  readonly mainReleaseRootSha256: string;
  readonly questionReceiptSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_holdout_authorization.v2";
}

export interface HoldoutQuestionReceipt {
  readonly mainInputRootSha256: string;
  readonly mainReleaseRootSha256: string;
  readonly questionSetSha256: string;
  readonly questions: readonly CampaignQuestion[];
  readonly schemaVersion: "meeting_knowledge.semantic_quality_holdout_questions.v1";
}

export interface AdmittedHoldout {
  readonly authorization: HoldoutAuthorization;
  readonly authorizationReceiptSha256: string;
  readonly holdoutQuestionSetSha256: string;
  readonly mainProofReceiptSha256: string;
  readonly questions: readonly CampaignQuestion[];
}

/** Enforces that main admission was frozen first and never loaded holdout identities. */
export function admitIsolatedHoldout(input: { readonly authorization: unknown;
  readonly authorizationAuthority: AdmissionAuthority;
  readonly holdoutLocatorDigests: readonly string[]; readonly main: unknown;
  readonly mainAuthority: AdmissionAuthority;
  readonly questionAuthority: AdmissionAuthority; readonly questionReceipt: unknown;
  readonly questions: readonly CampaignQuestion[] }): AdmittedHoldout {
  assertIndependentAuthorities([input.authorizationAuthority, input.mainAuthority,
    input.questionAuthority]);
  const authorizationReceipt = verifyExternalSignedValue<HoldoutAuthorization>(input.authorization,
    input.authorizationAuthority.keyId, input.authorizationAuthority.publicKeyPem,
    "holdout authorization");
  const mainReceipt = verifyExternalSignedValue<FrozenMainInputProof>(input.main,
    input.mainAuthority.keyId, input.mainAuthority.publicKeyPem, "main input proof");
  const questionReceipt = verifyExternalSignedValue<HoldoutQuestionReceipt>(input.questionReceipt,
    input.questionAuthority.keyId, input.questionAuthority.publicKeyPem,
    "holdout question receipt");
  const authorization = decodeAuthorization(authorizationReceipt.payload);
  const main = decodeMainProof(mainReceipt.payload);
  for (const value of [authorization.holdoutLocatorSetSha256,
    authorization.holdoutQuestionSetSha256, authorization.holdoutRootSha256,
    authorization.mainInputRootSha256, authorization.mainReleaseRootSha256,
    authorization.questionReceiptSha256, main.mainInputRootSha256,
    main.mainReleaseRootSha256, main.tuningCorpusSha256]) {digest(value, "holdout binding");}
  if (authorization.mainInputRootSha256 !== main.mainInputRootSha256 ||
    authorization.mainReleaseRootSha256 !== main.mainReleaseRootSha256) {
    throw new Error("holdout cannot run before the main input/release root is frozen");
  }
  const questions = decodeQuestionReceipt(questionReceipt.payload, main);
  if (canonicalQuestions(input.questions) !== canonicalQuestions(questions)) {
    throw new Error("holdout questions differ from the independently signed receipt");
  }
  const questionIds = questions.map(({ questionId }) => questionId);
  const questionDigests = questions.map(({ questionDigestSha256 }) => questionDigestSha256);
  const rubricDigests = questions.map(({ rubricDigestSha256 }) => rubricDigestSha256);
  const locatorDigests = input.holdoutLocatorDigests.map((value) =>
    digest(value, "holdout locator"));
  const holdoutQuestionSetSha256 = sha256(questions);
  if (locatorDigests.length === 0 || new Set(questionIds).size !== HOLDOUT_CARDINALITY ||
    new Set(questionDigests).size !== HOLDOUT_CARDINALITY ||
    new Set(rubricDigests).size !== HOLDOUT_CARDINALITY ||
    new Set(locatorDigests).size !== locatorDigests.length ||
    questionDigests.some((value) => main.loadedQuestionDigests.includes(value)) ||
    locatorDigests.some((value) => main.loadedLocatorDigests.includes(value))) {
    throw new Error("holdout is not disjoint from main tuning inputs");
  }
  const questionReceiptSha256 = sha256(questionReceipt);
  const holdoutRootSha256 = sha256({ holdoutLocatorSetSha256: sha256(locatorDigests),
    holdoutQuestionSetSha256, mainInputRootSha256: main.mainInputRootSha256,
    mainReleaseRootSha256: main.mainReleaseRootSha256, questionReceiptSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_holdout_root.v1" });
  if (authorization.holdoutQuestionSetSha256 !== holdoutQuestionSetSha256 ||
    authorization.holdoutLocatorSetSha256 !== sha256(locatorDigests) ||
    authorization.questionReceiptSha256 !== questionReceiptSha256 ||
    authorization.holdoutRootSha256 !== holdoutRootSha256 ||
    authorization.keyNamespace !== `holdout:${holdoutRootSha256}`) {
    throw new Error("holdout authorization does not bind the exact isolated inputs");
  }
  return Object.freeze({ authorization, authorizationReceiptSha256: sha256(authorizationReceipt),
    holdoutQuestionSetSha256, mainProofReceiptSha256: sha256(mainReceipt),
    questions });
}

function decodeAuthorization(value: unknown): HoldoutAuthorization {
  const record = exactRecord(value, ["holdoutLocatorSetSha256", "holdoutQuestionSetSha256",
    "holdoutRootSha256", "keyNamespace", "mainInputRootSha256", "mainReleaseRootSha256",
    "questionReceiptSha256", "schemaVersion"], "holdout authorization payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_holdout_authorization.v2") {
    throw new Error("holdout authorization schema is invalid");
  }
  return record as unknown as HoldoutAuthorization;
}

function decodeMainProof(value: unknown): FrozenMainInputProof {
  const record = exactRecord(value, ["loadedLocatorDigests", "loadedQuestionDigests",
    "mainInputRootSha256", "mainReleaseRootSha256", "schemaVersion", "tuningCorpusSha256"],
  "main input proof payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_main_input_proof.v1" ||
    !Array.isArray(record.loadedLocatorDigests) || !Array.isArray(record.loadedQuestionDigests)) {
    throw new Error("main input proof is invalid");
  }
  validateDigestArray(record.loadedLocatorDigests);
  validateDigestArray(record.loadedQuestionDigests);
  if (new Set(record.loadedLocatorDigests).size !== record.loadedLocatorDigests.length ||
    new Set(record.loadedQuestionDigests).size !== record.loadedQuestionDigests.length) {
    throw new Error("main loaded input inventory is duplicated");
  }
  return record as unknown as FrozenMainInputProof;
}

function decodeQuestionReceipt(value: unknown,
  main: FrozenMainInputProof): readonly CampaignQuestion[] {
  const record = exactRecord(value, ["mainInputRootSha256", "mainReleaseRootSha256",
    "questionSetSha256", "questions", "schemaVersion"], "holdout question receipt payload");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_holdout_questions.v1" ||
    record.mainInputRootSha256 !== main.mainInputRootSha256 ||
    record.mainReleaseRootSha256 !== main.mainReleaseRootSha256 ||
    !Array.isArray(record.questions) || record.questions.length !== HOLDOUT_CARDINALITY) {
    throw new Error("holdout question receipt is invalid");
  }
  const questions = Object.freeze(record.questions.map((question) =>
    validateCampaignQuestion(question, "independent_review")));
  if (record.questionSetSha256 !== sha256(questions)) {
    throw new Error("holdout question receipt does not reconstruct");
  }
  return questions;
}

function canonicalQuestions(questions: readonly CampaignQuestion[]): string {
  return canonicalJson(questions.map((question) => validateCampaignQuestion(question)));
}

function validateDigestArray(value: unknown): void {
  if (!Array.isArray(value)) {throw new Error("main loaded input inventory is invalid");}
  for (const loadedDigest of value as unknown[]) {digest(loadedDigest, "main loaded input");}
}

function assertIndependentAuthorities(authorities: readonly AdmissionAuthority[]): void {
  const keyIds = authorities.map(({ keyId }, index) =>
    safeId(keyId, `holdout authority ${index + 1} key ID`));
  const fingerprints = authorities.map(({ publicKeyPem }, index) =>
    publicKeyFingerprintSha256(publicKeyPem, `holdout authority ${index + 1}`));
  if (new Set(keyIds).size !== authorities.length ||
    new Set(fingerprints).size !== authorities.length) {
    throw new Error("holdout and main proof authorities are not cryptographically independent");
  }
}

export function createHoldoutReport(input: { readonly cleanupReceiptSha256: string;
  readonly holdoutRootSha256: string; readonly outcomeCount: number;
  readonly reportMetricsSha256: string }): Readonly<Record<string, unknown>> {
  if (input.outcomeCount !== HOLDOUT_CARDINALITY) {
    throw new Error("holdout report requires exactly 30 outcomes");
  }
  for (const value of [input.cleanupReceiptSha256, input.holdoutRootSha256,
    input.reportMetricsSha256]) {digest(value, "holdout report digest");}
  return Object.freeze({ ...input, affectsMainQualification: false,
    schemaVersion: "meeting_knowledge.semantic_quality_holdout_report.v1",
    separateReportSha256: sha256(input) });
}
