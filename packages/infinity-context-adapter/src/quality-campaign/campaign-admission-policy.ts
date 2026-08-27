import { digest, exactRecord, safeId } from "./canonical.js";

export const MAIN_CARDINALITY = Object.freeze({
  automatic: 200, independentReview: 40, perRepetition: 240, repetitions: 3, total: 720,
});
export const HOLDOUT_CARDINALITY = 30;

export interface CampaignQuestion {
  readonly locale: "en" | "mixed" | "ru";
  readonly questionDigestSha256: string;
  readonly questionId: string;
  readonly rubricDigestSha256: string;
  readonly source: "automatic" | "independent_review";
}

const ALLOWED_QUESTION_LOCALES: readonly CampaignQuestion["locale"][] = ["en", "mixed", "ru"];
const ALLOWED_QUESTION_SOURCES: readonly CampaignQuestion["source"][] =
  ["automatic", "independent_review"];

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
