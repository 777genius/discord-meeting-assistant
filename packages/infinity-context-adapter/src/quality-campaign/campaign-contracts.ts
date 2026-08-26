export const MAIN_CARDINALITY = Object.freeze({ automatic: 200, independentReview: 40,
  perRepetition: 240, repetitions: 3, total: 720 });
export const HOLDOUT_CARDINALITY = Object.freeze({ perRepetition: 30, repetitions: 3,
  total: 90, providerCalls: 270 });

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

/**
 * Consumer-owned seam for the sibling core's question-scoped gold authority. The runner never
 * searches another question's rubric; the temporary admitted-question adapter can be removed when
 * the core contract lands without changing metric reconstruction.
 */
export interface QuestionScopedGold {
  readonly goldClaimIds: readonly string[];
  readonly goldSpeakerAttributions: CampaignQuestion["goldSpeakerAttributions"];
  readonly goldTimeAttributions: CampaignQuestion["goldTimeAttributions"];
  readonly questionDigestSha256: string;
  readonly questionId: string;
}

export interface QuestionScopedGoldPort {
  forQuestion(input: { readonly questionDigestSha256: string; readonly questionId: string }):
  QuestionScopedGold;
}

export function admittedQuestionGoldPort(questions: readonly CampaignQuestion[]):
QuestionScopedGoldPort {
  const byId = new Map(questions.map((question) => [question.questionId, question]));
  return Object.freeze({ forQuestion: (identity: { readonly questionDigestSha256: string;
    readonly questionId: string }) => {
    const question = byId.get(identity.questionId);
    if (question === undefined || question.questionDigestSha256 !== identity.questionDigestSha256) {
      throw new Error("question-scoped gold authority has no exact question binding");
    }
    return Object.freeze({ goldClaimIds: question.goldClaimIds,
      goldSpeakerAttributions: question.goldSpeakerAttributions,
      goldTimeAttributions: question.goldTimeAttributions,
      questionDigestSha256: question.questionDigestSha256, questionId: question.questionId });
  } });
}
