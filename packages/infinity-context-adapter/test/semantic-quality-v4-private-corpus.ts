import { readFileSync } from "node:fs";

import { canonicalSha256 } from "./semantic-quality-v4-manifest.js";
import {
  v4EvaluationQuestionText,
  type FrozenSemanticQualityCorpusV4,
} from "./semantic-quality-v4-corpus.js";
import type {
  SemanticQualityV4ScoringAuthority,
  V4ScoringQuestion,
} from "./semantic-quality-v4-evaluation.js";
import {
  decodeHumanSemanticQualityV4Corpus,
  type HumanSemanticQualityV4CorpusInput,
} from "./semantic-quality-v4-human-corpus.js";
import {
  requireIndependentSemanticQualityV4Receipts,
  type VerifiedSemanticQualityV4Receipt,
} from "./semantic-quality-v4-trusted-receipts.js";

export type RealSemanticQualityV4Locale = "en" | "ru";

export interface RealSemanticQualityV4Turn {
  readonly endMs: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
  readonly turnId: string;
}

export interface RealSemanticQualityV4Question {
  readonly category: string;
  readonly evidenceTurnIds: readonly string[];
  readonly expectedClaimIds: readonly string[];
  readonly id: string;
  readonly kind: "answerable" | "unsupported";
  readonly locale: RealSemanticQualityV4Locale;
  readonly question: string;
  readonly speakerIds: readonly string[];
  readonly timeWindow: { readonly endMs: number; readonly startMs: number } | null;
}

export interface RealSemanticQualityV4Corpus {
  readonly bindings: {
    readonly corpusSha256: string;
    readonly declaredTranscriptSha256: string;
    readonly goldFileSha256?: string;
    readonly identityFileSha256?: string;
    readonly inputSha256: string;
    readonly questionFileSha256: string;
    readonly questionSetSha256: string;
    readonly rubricFileSha256: string;
    readonly rubricSha256: string;
    readonly sourceFileSha256?: string;
    readonly transcriptFileSha256: string;
  };
  /** Private adjudication data, never generator input or public evidence. */
  readonly privateGoldAuthority: unknown;
  readonly profile: "human_corpus_v1";
  readonly questions: readonly RealSemanticQualityV4Question[];
  readonly reviewReceipts: readonly VerifiedSemanticQualityV4Receipt[];
  readonly safeCounts: {
    readonly abstention: number;
    readonly answerable: number;
    readonly categories: Readonly<Record<string, number>>;
    readonly evidenceReferences: number;
    readonly locales: { readonly en: number; readonly ru: number };
    readonly questions: number;
    readonly speakers: number;
    readonly turns: number;
  };
  readonly turns: readonly RealSemanticQualityV4Turn[];
}

const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const safeTurnIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:|-]{0,127}$/u;

/**
 * Reads the three operator-injected private files. Text is retained only in
 * memory for execution and never included in returned bindings, errors, or logs.
 */
export function loadRealSemanticQualityV4Corpus(input: HumanSemanticQualityV4CorpusInput):
RealSemanticQualityV4Corpus {
  const decoded = decodeHumanSemanticQualityV4Corpus({
    approvedCommit: input.approvedCommit,
    bindingPaths: input.bindingPaths,
    datasetBytes: readPrivateFile(input.datasetPath),
    goldBytes: readPrivateFile(input.goldPath),
    identityBytes: readPrivateFile(input.identityPath),
    meetingId: input.meetingId,
    pinnedSha256: input.pinnedSha256,
    sourceBytes: readPrivateFile(input.sourcePath),
  });
  const reviewReceipts = requireIndependentSemanticQualityV4Receipts({
    binding: decoded.bindings,
    minimum: 2,
    pinnedKeys: input.pinnedReviewerKeys,
    receipts: input.reviewReceipts,
    role: "question_rubric_review",
  });
  return Object.freeze({ ...decoded, reviewReceipts });
}

export interface RealSemanticQualityV4MappedQuestion extends RealSemanticQualityV4Question {
  readonly goldLocatorRelevance: readonly {
    readonly locatorId: string;
    readonly relevance: 3;
  }[];
}

export function mapRealGoldTurnsToProductionLocators(input: {
  readonly corpus: RealSemanticQualityV4Corpus;
  readonly mapping: readonly { readonly sourceLocatorId: string; readonly turnId: string }[];
}): {
  readonly mappingSha256: string;
  readonly questions: readonly RealSemanticQualityV4MappedQuestion[];
  readonly structuralCeilings: Readonly<Record<"overall" | "en" | "ru", {
    readonly completeRecallAt10: { readonly denominator: number; readonly numerator: number };
    readonly completeRecallAt5: { readonly denominator: number; readonly numerator: number };
  }>>;
} {
  const mapping = new Map<string, string>();
  for (const item of input.mapping) {
    if (!safeTurnIdPattern.test(item.turnId) || !safeIdPattern.test(item.sourceLocatorId) ||
      mapping.has(item.turnId)) {
      throw new Error("semantic quality V4 gold block mapping is invalid");
    }
    mapping.set(item.turnId, item.sourceLocatorId);
  }
  if (mapping.size !== input.corpus.turns.length ||
    input.corpus.turns.some(({ turnId }) => !mapping.has(turnId))) {
    throw new Error("semantic quality V4 gold block mapping is incomplete");
  }
  const questions = input.corpus.questions.map((question): RealSemanticQualityV4MappedQuestion => {
    const locators = [...new Set(question.evidenceTurnIds.map((turnId) => mapping.get(turnId)!))];
    return Object.freeze({ ...question, goldLocatorRelevance: Object.freeze(locators.map(
      (locatorId) => Object.freeze({ locatorId, relevance: 3 as const }),
    )) });
  });
  const structuralCeilings = structuralCeilingsFor(questions);
  for (const key of ["overall", "en", "ru"] as const) {
    const ceiling = structuralCeilings[key].completeRecallAt5;
    if (ceiling.denominator > 0 && ceiling.numerator * 10 < ceiling.denominator * 9) {
      throw new Error("semantic quality V4 structural Recall@5 ceiling is below threshold");
    }
  }
  return Object.freeze({
    mappingSha256: canonicalSha256([...mapping.entries()].map(([turnId, sourceLocatorId]) => ({
      sourceLocatorId, turnId,
    })).toSorted((left, right) => left.turnId.localeCompare(right.turnId))),
    questions: Object.freeze(questions),
    structuralCeilings,
  });
}

export function createSemanticQualityV4RealRunAuthorities(input: {
  readonly automatedCorpus: FrozenSemanticQualityCorpusV4;
  readonly automatedMapping: readonly {
    readonly sourceLocatorId: string; readonly turnId: string;
  }[];
  readonly forbiddenLocatorIds: readonly string[];
  readonly realCorpus: RealSemanticQualityV4Corpus;
  readonly realMapping: readonly { readonly sourceLocatorId: string; readonly turnId: string }[];
}): {
  readonly automated: SemanticQualityV4ScoringAuthority;
  readonly overall: SemanticQualityV4ScoringAuthority;
  readonly real: SemanticQualityV4ScoringAuthority;
} {
  const automatedTurns = [...input.automatedCorpus.primaryMeeting.humanTurns,
    ...input.automatedCorpus.auxiliaryTurns];
  const automatedMap = exactTurnMapping(automatedTurns.map(({ turnId }) => turnId),
    input.automatedMapping);
  const realMap = exactTurnMapping(input.realCorpus.turns.map(({ turnId }) => turnId),
    input.realMapping);
  const automatedQuestions: V4ScoringQuestion[] = input.automatedCorpus.automatedQuestions
    .map((question) => Object.freeze({ ...question,
      evaluationQuestionText: v4EvaluationQuestionText(question),
      goldLocatorRelevance: Object.freeze([...new Set(question.goldTurnIds.map((turnId) =>
        automatedMap.get(turnId)!))].map((locatorId) => Object.freeze({ locatorId,
          relevance: 3 as const }))),
    }));
  const realMapped = mapRealGoldTurnsToProductionLocators({ corpus: input.realCorpus,
    mapping: input.realMapping });
  const realQuestions: V4ScoringQuestion[] = realMapped.questions.map((question) =>
    Object.freeze({
      contradictedClaimIds: Object.freeze([]),
      distractorTurnIds: Object.freeze([]),
      evaluationQuestionText: question.question,
      expectedClaimIds: question.expectedClaimIds,
      forbiddenLocatorIds: Object.freeze([...input.forbiddenLocatorIds]),
      goldLocatorRelevance: question.goldLocatorRelevance,
      goldTurnIds: question.evidenceTurnIds,
      id: question.id,
      kind: question.kind,
      locale: question.locale,
      question: question.question,
      reviewStatus: "not_applicable" as const,
      tags: Object.freeze([`category:${question.category}`, "real_private"]),
    }));
  const forbidden = Object.freeze([...new Set(input.forbiddenLocatorIds)]);
  const automatedKnown = Object.freeze([...new Set([...automatedMap.values(), ...forbidden])]);
  const realKnown = Object.freeze([...new Set([...realMap.values(), ...forbidden])]);
  const automatedWhole = Object.freeze(Object.fromEntries(automatedQuestions.map(({ id }) =>
    [id, input.automatedCorpus.primaryMeeting.humanTurns.map(({ turnId }) => turnId)])));
  const realWhole = Object.freeze(Object.fromEntries(realQuestions.map(({ id }) =>
    [id, input.realCorpus.turns.map(({ turnId }) => turnId)])));
  const automated = Object.freeze({ canonicalTurns: Object.freeze(automatedTurns),
    globallyForbiddenLocatorIds: forbidden, knownLocatorIds: automatedKnown,
    questions: Object.freeze(automatedQuestions),
    wholeTranscriptTurnIdsByQuestionId: automatedWhole });
  const real = Object.freeze({ canonicalTurns: input.realCorpus.turns,
    globallyForbiddenLocatorIds: forbidden, knownLocatorIds: realKnown,
    questions: Object.freeze(realQuestions), wholeTranscriptTurnIdsByQuestionId: realWhole });
  return Object.freeze({
    automated,
    overall: Object.freeze({ canonicalTurns: Object.freeze([...automatedTurns,
      ...input.realCorpus.turns]), globallyForbiddenLocatorIds: forbidden,
    knownLocatorIds: Object.freeze([...new Set([...automatedKnown, ...realKnown])]),
    questions: Object.freeze([...automatedQuestions, ...realQuestions]),
    wholeTranscriptTurnIdsByQuestionId: Object.freeze({ ...automatedWhole, ...realWhole }) }),
    real,
  });
}

function exactTurnMapping(turnIds: readonly string[], values: readonly {
  readonly sourceLocatorId: string; readonly turnId: string;
}[]): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();
  for (const value of values) {
    if (!safeTurnIdPattern.test(value.turnId) || !safeIdPattern.test(value.sourceLocatorId) ||
      mapping.has(value.turnId)) {
      throw new Error("semantic quality V4 production block mapping is invalid");
    }
    mapping.set(value.turnId, value.sourceLocatorId);
  }
  if (mapping.size !== turnIds.length || turnIds.some((turnId) => !mapping.has(turnId))) {
    throw new Error("semantic quality V4 production block mapping is incomplete");
  }
  return mapping;
}

function structuralCeilingsFor(questions: readonly RealSemanticQualityV4MappedQuestion[]) {
  const answerable = questions.filter(({ kind }) => kind === "answerable");
  return Object.freeze({
    en: structuralCeiling(answerable.filter(({ locale }) => locale === "en")),
    overall: structuralCeiling(answerable),
    ru: structuralCeiling(answerable.filter(({ locale }) => locale === "ru")),
  });
}

function structuralCeiling(values: readonly RealSemanticQualityV4MappedQuestion[]) {
  return Object.freeze({
    completeRecallAt10: Object.freeze({ denominator: values.length,
      numerator: values.filter(({ goldLocatorRelevance }) =>
        goldLocatorRelevance.length <= 10).length }),
    completeRecallAt5: Object.freeze({ denominator: values.length,
      numerator: values.filter(({ goldLocatorRelevance }) =>
        goldLocatorRelevance.length <= 5).length }),
  });
}

function readPrivateFile(path: string): Buffer {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error("semantic quality V4 private input path is invalid");
  }
  try {
    return readFileSync(path);
  } catch {
    throw new Error("semantic quality V4 private input is unavailable");
  }
}
