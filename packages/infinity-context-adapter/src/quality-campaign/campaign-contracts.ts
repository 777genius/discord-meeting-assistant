export const MAIN_CARDINALITY = Object.freeze({ automatic: 200, independentReview: 40,
  perRepetition: 240, repetitions: 3, total: 720 });
export const HOLDOUT_CARDINALITY = 30;

export interface CampaignQuestion {
  readonly expectedAnswer: "answerable" | "abstain";
  readonly forbiddenLocatorDigests: readonly string[];
  readonly goldClaimIds: readonly string[];
  readonly goldSpeakerAttributions: readonly { readonly speakerDigestSha256: string;
    readonly turnDigestSha256: string }[];
  readonly goldTimeAttributions: readonly { readonly endMs: number; readonly startMs: number;
    readonly turnDigestSha256: string }[];
  readonly locale: "en" | "mixed" | "ru";
  readonly questionDigestSha256: string;
  readonly questionId: string;
  readonly relevantBlockLocatorDigests: readonly string[];
  readonly relevantTurnDigests: readonly string[];
  readonly requiredAnswerSections: readonly string[];
  readonly rubricDigestSha256: string;
  readonly source: "automatic" | "independent_review";
}
