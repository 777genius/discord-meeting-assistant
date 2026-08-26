import { digest, safeId, sha256 } from "./canonical.js";
import { HOLDOUT_CARDINALITY, type CampaignQuestion } from "./admission.js";

export interface FrozenMainInputProof {
  readonly loadedLocatorDigests: readonly string[];
  readonly loadedQuestionDigests: readonly string[];
  readonly mainInputRootSha256: string;
  readonly mainReleaseRootSha256: string;
  readonly tuningCorpusSha256: string;
}

export interface HoldoutAuthorization {
  readonly authorizationSha256: string;
  readonly holdoutRootSha256: string;
  readonly keyNamespace: string;
  readonly mainInputRootSha256: string;
  readonly mainReleaseRootSha256: string;
  readonly questionReceiptSha256: string;
}

export interface AdmittedHoldout {
  readonly authorization: HoldoutAuthorization;
  readonly holdoutQuestionSetSha256: string;
  readonly questions: readonly CampaignQuestion[];
}

/** Enforces that main admission was frozen first and never loaded holdout identities. */
export function admitIsolatedHoldout(input: { readonly authorization: HoldoutAuthorization;
  readonly holdoutLocatorDigests: readonly string[]; readonly main: FrozenMainInputProof;
  readonly questions: readonly CampaignQuestion[] }): AdmittedHoldout {
  const { authorization, main } = input;
  for (const value of [authorization.authorizationSha256, authorization.holdoutRootSha256,
    authorization.mainInputRootSha256, authorization.mainReleaseRootSha256,
    authorization.questionReceiptSha256, main.mainInputRootSha256,
    main.mainReleaseRootSha256, main.tuningCorpusSha256]) {digest(value, "holdout binding");}
  safeId(authorization.keyNamespace, "holdout key namespace");
  if (!authorization.keyNamespace.startsWith("holdout:")) {
    throw new Error("holdout must use its own key namespace");
  }
  if (authorization.mainInputRootSha256 !== main.mainInputRootSha256 ||
    authorization.mainReleaseRootSha256 !== main.mainReleaseRootSha256) {
    throw new Error("holdout cannot run before the main input/release root is frozen");
  }
  if (input.questions.length !== HOLDOUT_CARDINALITY || input.questions.some(({ source }) =>
    source !== "independent_review")) {throw new Error("holdout must contain exactly 30 sealed questions");}
  const questionDigests = input.questions.map(({ questionDigestSha256 }) => questionDigestSha256);
  const locatorDigests = [...input.holdoutLocatorDigests];
  if (new Set(questionDigests).size !== HOLDOUT_CARDINALITY ||
    new Set(locatorDigests).size !== locatorDigests.length ||
    questionDigests.some((value) => main.loadedQuestionDigests.includes(value)) ||
    locatorDigests.some((value) => main.loadedLocatorDigests.includes(value))) {
    throw new Error("holdout is not disjoint from main tuning inputs");
  }
  return Object.freeze({ authorization, holdoutQuestionSetSha256: sha256(input.questions),
    questions: Object.freeze([...input.questions]) });
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
