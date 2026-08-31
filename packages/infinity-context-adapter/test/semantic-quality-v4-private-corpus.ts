import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalIntegerJson, canonicalSha256 } from "./semantic-quality-v4-manifest.js";
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
  type SemanticQualityV4PinnedReviewerKey,
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
  readonly privateGoldAuthority: unknown | null;
  readonly profile: "human_corpus_v1" | "legacy_private_v1";
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

interface PrivateQuestionRecord {
  readonly category: string;
  readonly evidenceTurnIds: readonly string[];
  readonly expectedAnswer: string;
  readonly id: string;
  readonly kind: "answerable" | "abstention";
  readonly locale: RealSemanticQualityV4Locale;
  readonly question: string;
  readonly speakerIds: readonly string[];
  readonly timeWindow: { readonly endMs: number; readonly startMs: number } | null;
}

const digestPattern = /^[a-f0-9]{64}$/u;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const safeTurnIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:|-]{0,127}$/u;
const safeCategoryPattern = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * Reads the three operator-injected private files. Text is retained only in
 * memory for execution and never included in returned bindings, errors, or logs.
 */
export function loadRealSemanticQualityV4Corpus(input: {
  readonly profile?: "legacy_private_v1";
  readonly pinnedReviewerKeys: readonly SemanticQualityV4PinnedReviewerKey[];
  readonly questionPath: string;
  readonly reviewReceipts: readonly unknown[];
  readonly rubricPath: string;
  readonly transcriptPath: string;
} | HumanSemanticQualityV4CorpusInput): RealSemanticQualityV4Corpus {
  if (input.profile === "human_corpus_v1") {
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
  if (input.profile !== undefined && input.profile !== "legacy_private_v1") {
    throw new Error("semantic quality V4 private corpus profile is invalid");
  }
  const transcriptBytes = readPrivateFile(input.transcriptPath);
  const questionBytes = readPrivateFile(input.questionPath);
  const rubricBytes = readPrivateFile(input.rubricPath);
  const transcriptFileSha256 = sha256(transcriptBytes);
  const questionFileSha256 = sha256(questionBytes);
  const rubricFileSha256 = sha256(rubricBytes);
  const transcript = decodeTranscript(parsePrivateJson(transcriptBytes));
  const questionSet = decodeQuestionSet(parsePrivateJson(questionBytes), transcript.speakerIds);
  const rubric = decodeRubric(parsePrivateJson(rubricBytes));
  if (questionSet.corpusId !== transcript.corpusId || rubric.corpusId !== transcript.corpusId) {
    throw new Error("semantic quality V4 private corpus file bindings do not match");
  }
  if (questionSet.declaredTranscriptSha256 !== transcriptFileSha256) {
    throw new Error("semantic quality V4 declared transcript digest lacks raw-file authority");
  }
  const questionSetSha256 = canonicalSha256(questionSet.questions.map((question) => ({
    category: question.category,
    evidenceTurnIds: question.evidenceTurnIds,
    id: question.id,
    kind: question.kind,
    locale: question.locale,
    speakerIds: question.speakerIds,
    timeWindow: question.timeWindow,
  })));
  const corpusSha256 = canonicalSha256({
    corpusId: transcript.corpusId,
    questionFileSha256,
    transcriptFileSha256,
  });
  const rubricSha256 = canonicalSha256(rubric.questions.map(({ expectedClaims, questionId }) => ({
    expectedClaimIds: expectedClaims.map(({ claimId }) => claimId),
    questionId,
  })));
  const inputSha256 = canonicalSha256({
    questionFileSha256,
    transcriptFileSha256,
  });
  if (rubric.corpusSha256 !== corpusSha256 || rubric.questionSetSha256 !== questionSetSha256 ||
    rubric.inputSha256 !== inputSha256) {
    throw new Error("semantic quality V4 private rubric binding does not match exact input");
  }
  const turnsById = new Map(transcript.turns.map((turn) => [turn.turnId, turn]));
  const rubricByQuestion = new Map(rubric.questions.map((item) => [item.questionId, item]));
  const questions = questionSet.questions.map((question): RealSemanticQualityV4Question => {
    const claims = rubricByQuestion.get(question.id);
    if (claims === undefined || question.evidenceTurnIds.some((id) => !turnsById.has(id)) ||
      question.speakerIds.some((id) => !transcript.speakerIds.includes(id)) ||
      (question.kind === "answerable") !== (question.evidenceTurnIds.length > 0) ||
      (question.kind === "answerable") !== (claims.expectedClaims.length > 0)) {
      throw new Error("semantic quality V4 private question authority is invalid");
    }
    const evidenceTurns = question.evidenceTurnIds.map((turnId) => turnsById.get(turnId)!);
    const evidenceSpeakers = new Set(evidenceTurns.map(({ speakerId }) => speakerId));
    if (question.speakerIds.some((speakerId) => !evidenceSpeakers.has(speakerId)) ||
      !validQuestionTimeAuthority(question, evidenceTurns)) {
      throw new Error("semantic quality V4 private question speaker/time authority is invalid");
    }
    return Object.freeze({
      category: question.category,
      evidenceTurnIds: Object.freeze([...question.evidenceTurnIds]),
      expectedClaimIds: Object.freeze(claims.expectedClaims.map(({ claimId }) => claimId)),
      id: question.id,
      kind: question.kind === "answerable" ? "answerable" : "unsupported",
      locale: question.locale,
      question: question.question,
      speakerIds: Object.freeze([...question.speakerIds]),
      timeWindow: question.timeWindow,
    });
  });
  if (rubricByQuestion.size !== questions.length) {
    throw new Error("semantic quality V4 private rubric question coverage is invalid");
  }
  const counts = safeCounts(transcript, questionSet.questions);
  if (counts.evidenceReferences !== 338 ||
    new Set(questionSet.questions.flatMap(({ evidenceTurnIds }) => evidenceTurnIds)).size !== 296 ||
    questions.filter(({ timeWindow }) => timeWindow !== null).length !== 5) {
    throw new Error("semantic quality V4 private evidence aggregates are invalid");
  }
  const reviewBinding = Object.freeze({ corpusSha256,
    declaredTranscriptSha256: questionSet.declaredTranscriptSha256,
    inputSha256, questionFileSha256, questionSetSha256, rubricFileSha256,
    rubricSha256, transcriptFileSha256 });
  const reviewReceipts = requireIndependentSemanticQualityV4Receipts({
    binding: reviewBinding,
    minimum: 2,
    pinnedKeys: input.pinnedReviewerKeys,
    receipts: input.reviewReceipts,
    role: "question_rubric_review",
  });
  return Object.freeze({
    bindings: Object.freeze({ corpusSha256,
      declaredTranscriptSha256: questionSet.declaredTranscriptSha256,
      inputSha256, questionFileSha256, questionSetSha256, rubricFileSha256,
      rubricSha256, transcriptFileSha256 }),
    privateGoldAuthority: null,
    profile: "legacy_private_v1",
    questions: Object.freeze(questions),
    reviewReceipts,
    safeCounts: counts,
    turns: Object.freeze(transcript.turns),
  });
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

function decodeTranscript(value: unknown) {
  const record = exactRecord(value, ["createdAt", "meetingId", "schemaVersion", "summary",
    "transcript"]);
  const transcript = exactRecord(record.transcript, ["readableSegments", "recordingId",
    "transcriptId", "turns", "version"]);
  if (record.schemaVersion !== 1 || typeof record.createdAt !== "string" ||
    typeof record.meetingId !== "string" || !safeIdPattern.test(record.meetingId) ||
    record.summary === null || typeof record.summary !== "object" ||
    typeof transcript.recordingId !== "string" || transcript.recordingId.trim() === "" ||
    typeof transcript.transcriptId !== "string" || transcript.transcriptId.trim() === "" ||
    !Number.isSafeInteger(transcript.version) || !Array.isArray(transcript.readableSegments) ||
    !Array.isArray(transcript.turns)) {
    throw new Error("semantic quality V4 private transcript schema is invalid");
  }
  const turns = transcript.turns.map((candidate): RealSemanticQualityV4Turn => {
    const turn = exactRecord(candidate, ["endMs", "speakerId", "startMs", "text", "turnId"]);
    if (typeof turn.turnId !== "string" || !safeTurnIdPattern.test(turn.turnId) ||
      typeof turn.speakerId !== "string" || !safeIdPattern.test(turn.speakerId) ||
      typeof turn.text !== "string" || turn.text.trim() === "" ||
      !validInterval(turn.startMs, turn.endMs)) {
      throw new Error("semantic quality V4 private transcript turn is invalid");
    }
    return Object.freeze({ endMs: turn.endMs as number, speakerId: turn.speakerId,
      startMs: turn.startMs as number, text: turn.text, turnId: turn.turnId });
  });
  const speakerIds = [...new Set(turns.map(({ speakerId }) => speakerId))];
  if (turns.length !== 2209 || speakerIds.length !== 8 ||
    new Set(turns.map(({ turnId }) => turnId)).size !== turns.length ||
    turns.some((turn, index) => index > 0 && turn.startMs < turns[index - 1]!.startMs)) {
    throw new Error("semantic quality V4 private transcript aggregates are invalid");
  }
  return { corpusId: record.meetingId, speakerIds: Object.freeze(speakerIds),
    turns: Object.freeze(turns) };
}

function decodeQuestionSet(value: unknown, canonicalSpeakerIds: readonly string[]) {
  const record = exactRecord(value, ["categoryCounts", "curatorChecks", "meetingId",
    "participantMap", "questions", "schemaVersion", "transcriptSha256"]);
  if (record.schemaVersion !== 1 || typeof record.meetingId !== "string" ||
    !safeIdPattern.test(record.meetingId) || typeof record.transcriptSha256 !== "string" ||
    !digestPattern.test(record.transcriptSha256) || !Array.isArray(record.questions) ||
    !validParticipantMap(record.participantMap, canonicalSpeakerIds) ||
    !validCuratorChecks(record.curatorChecks)) {
    throw new Error("semantic quality V4 private question schema is invalid");
  }
  const questions = record.questions.map(decodeQuestion);
  const counts = declaredCategoryCounts(questions);
  if (canonicalIntegerJson(record.categoryCounts) !== canonicalIntegerJson(counts) ||
    questions.length !== 40 || new Set(questions.map(({ id }) => id)).size !== 40) {
    throw new Error("semantic quality V4 private question aggregates are invalid");
  }
  return { corpusId: record.meetingId, declaredTranscriptSha256: record.transcriptSha256,
    questions: Object.freeze(questions) };
}

function decodeQuestion(value: unknown): PrivateQuestionRecord {
  const record = exactRecord(value, ["category", "difficulty", "evidenceSufficiency",
    "evidenceTurnIds", "expectedAnswer", "id", "involvedSpeakerIds", "language", "question",
    "shouldAbstain", "timeWindow"]);
  if (typeof record.id !== "string" || !safeIdPattern.test(record.id) ||
    typeof record.question !== "string" || record.question.trim() === "" ||
    typeof record.expectedAnswer !== "string" ||
    (record.shouldAbstain === false ? record.expectedAnswer.trim() === "" :
      record.shouldAbstain !== true || record.expectedAnswer !== "") ||
    (record.language !== "en" && record.language !== "ru") ||
    (record.difficulty !== "easy" && record.difficulty !== "medium" &&
      record.difficulty !== "hard") ||
    typeof record.evidenceSufficiency !== "string" ||
      record.evidenceSufficiency.trim() === "" ||
    typeof record.category !== "string" || !safeCategoryPattern.test(record.category) ||
    !Array.isArray(record.evidenceTurnIds) || !Array.isArray(record.involvedSpeakerIds)) {
    throw new Error("semantic quality V4 private question record is invalid");
  }
  const kind = record.shouldAbstain === true ? "abstention" as const : "answerable" as const;
  const timeWindow = decodeTimeWindow(record.timeWindow);
  if ((record.category === "time_window_relative_order") !== (timeWindow !== null)) {
    throw new Error("semantic quality V4 private question time metadata is invalid");
  }
  return Object.freeze({
    category: record.category,
    evidenceTurnIds: Object.freeze(decodeStringArray(record.evidenceTurnIds, safeTurnIdPattern)),
    expectedAnswer: record.expectedAnswer,
    id: record.id,
    kind,
    locale: record.language,
    question: record.question,
    speakerIds: Object.freeze(decodeStringArray(record.involvedSpeakerIds, safeIdPattern)),
    timeWindow,
  });
}

function decodeRubric(value: unknown) {
  const record = exactRecord(value, ["corpusId", "corpusSha256", "inputSha256", "questions",
    "questionSetSha256", "schemaVersion"]);
  if (record.schemaVersion !== "meeting_memory.atomic_claim_rubric.v1" ||
    typeof record.corpusId !== "string" || !safeIdPattern.test(record.corpusId) ||
    !Array.isArray(record.questions) ||
    [record.corpusSha256, record.inputSha256, record.questionSetSha256]
      .some((digest) => typeof digest !== "string" || !digestPattern.test(digest))) {
    throw new Error("semantic quality V4 private rubric schema is invalid");
  }
  const questions = record.questions.map((candidate) => {
    const item = exactRecord(candidate, ["expectedClaims", "questionId"]);
    if (typeof item.questionId !== "string" || !safeIdPattern.test(item.questionId) ||
      !Array.isArray(item.expectedClaims)) {
      throw new Error("semantic quality V4 private rubric question is invalid");
    }
    const expectedClaims = item.expectedClaims.map((claimCandidate) => {
      const claim = exactRecord(claimCandidate, ["claimId", "text"]);
      if (typeof claim.claimId !== "string" || !safeIdPattern.test(claim.claimId) ||
        typeof claim.text !== "string" || claim.text.trim() === "") {
        throw new Error("semantic quality V4 private rubric claim is invalid");
      }
      return Object.freeze({ claimId: claim.claimId, text: claim.text });
    });
    return Object.freeze({ expectedClaims: Object.freeze(expectedClaims),
      questionId: item.questionId });
  });
  if (new Set(questions.map(({ questionId }) => questionId)).size !== questions.length) {
    throw new Error("semantic quality V4 private rubric contains duplicate questions");
  }
  return { corpusId: record.corpusId, corpusSha256: record.corpusSha256,
    inputSha256: record.inputSha256, questionSetSha256: record.questionSetSha256,
    questions: Object.freeze(questions) };
}

function safeCounts(transcript: ReturnType<typeof decodeTranscript>,
  questions: readonly PrivateQuestionRecord[]): RealSemanticQualityV4Corpus["safeCounts"] {
  const counts = safeQuestionCounts(questions);
  const expected = { abstention: 3, answerable: 37,
    categories: expectedCategoryCounts, locales: { en: 22, ru: 18 }, questions: 40 };
  if (canonicalIntegerJson(counts) !== canonicalIntegerJson(expected) ||
    transcript.turns.length !== 2209 || transcript.speakerIds.length !== 8) {
    throw new Error("semantic quality V4 private corpus exact counts are invalid");
  }
  return Object.freeze({
    abstention: counts.abstention as 3,
    answerable: counts.answerable as 37,
    categories: counts.categories,
    evidenceReferences: questions.reduce((sum, question) =>
      sum + question.evidenceTurnIds.length, 0),
    locales: counts.locales as { readonly en: 22; readonly ru: 18 },
    questions: counts.questions as 40,
    speakers: transcript.speakerIds.length,
    turns: transcript.turns.length,
  });
}

function safeQuestionCounts(questions: readonly PrivateQuestionRecord[]) {
  const categories = Object.fromEntries([...Map.groupBy(questions, ({ category }) => category)]
    .map(([category, values]) => [category, values.length] as const)
    .toSorted(([left], [right]) => left.localeCompare(right)));
  return Object.freeze({
    abstention: questions.filter(({ kind }) => kind === "abstention").length,
    answerable: questions.filter(({ kind }) => kind === "answerable").length,
    categories: Object.freeze(categories),
    locales: Object.freeze({
      en: questions.filter(({ locale }) => locale === "en").length,
      ru: questions.filter(({ locale }) => locale === "ru").length,
    }),
    questions: questions.length,
  });
}

function declaredCategoryCounts(questions: readonly PrivateQuestionRecord[]) {
  const categories = safeQuestionCounts(questions).categories;
  const expected = ["direct_fact", "multi_turn_multi_hop",
    "negation_correction_changed_decision", "semantic_paraphrase", "speaker_attribution",
    "time_window_relative_order", "unanswerable"];
  if (canonicalIntegerJson(Object.keys(categories).toSorted()) !==
    canonicalIntegerJson(expected.toSorted()) ||
    canonicalIntegerJson(categories) !== canonicalIntegerJson(expectedCategoryCounts)) {
    throw new Error("semantic quality V4 private categories are invalid");
  }
  return Object.freeze({ ...categories, total: questions.length });
}

function validParticipantMap(value: unknown, canonicalSpeakerIds: readonly string[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {return false;}
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 8 &&
    canonicalIntegerJson(entries.map(([speakerId]) => speakerId).toSorted()) ===
      canonicalIntegerJson([...canonicalSpeakerIds].toSorted()) &&
    entries.every(([speakerId, participant]) => safeIdPattern.test(speakerId) &&
      typeof participant === "string" && participant.trim() !== "");
}

const expectedCategoryCounts = Object.freeze({ direct_fact: 8,
  multi_turn_multi_hop: 5, negation_correction_changed_decision: 4,
  semantic_paraphrase: 8, speaker_attribution: 7,
  time_window_relative_order: 5, unanswerable: 3 });

function decodeTimeWindow(value: unknown): PrivateQuestionRecord["timeWindow"] {
  if (value === null) {return null;}
  const record = exactRecord(value, ["endMs", "startMs"]);
  if (!validInterval(record.startMs, record.endMs)) {
    throw new Error("semantic quality V4 private question time metadata is invalid");
  }
  return Object.freeze({ endMs: record.endMs as number, startMs: record.startMs as number });
}

function validQuestionTimeAuthority(question: PrivateQuestionRecord,
  evidenceTurns: readonly RealSemanticQualityV4Turn[]): boolean {
  if (question.timeWindow === null) {return question.category !== "time_window_relative_order";}
  return evidenceTurns.length > 0 && question.category === "time_window_relative_order" &&
    question.timeWindow.startMs === Math.min(...evidenceTurns.map(({ startMs }) => startMs)) &&
    question.timeWindow.endMs === Math.max(...evidenceTurns.map(({ endMs }) => endMs));
}

function validCuratorChecks(value: unknown): boolean {
  const keys = ["allCitedTurnIdsExist", "allEvidenceTextSupportsExpectedAnswer",
    "distributionSumsTo40", "noQuestionUsesSummaryAsEvidence", "questionCountIs40",
    "secondPassCompletedBeforeWrite", "speakerFieldsMatchEvidence", "timeFieldsMatchEvidence",
    "transcriptTurnsWereSoleAnswerEvidence"];
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    canonicalIntegerJson(Object.keys(value).toSorted()) !== canonicalIntegerJson(keys.toSorted())) {
    return false;
  }
  return Object.values(value).every((item) => item === true);
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

function parsePrivateJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("semantic quality V4 private input JSON is invalid");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    canonicalIntegerJson(Object.keys(value).toSorted()) !==
      canonicalIntegerJson([...keys].toSorted())) {
    throw new Error("semantic quality V4 private input object shape is invalid");
  }
  return value as Record<string, unknown>;
}

function decodeStringArray(value: readonly unknown[], pattern: RegExp): string[] {
  if (value.some((item) => typeof item !== "string" || !pattern.test(item)) ||
    new Set(value).size !== value.length) {
    throw new Error("semantic quality V4 private input identifier list is invalid");
  }
  return value as string[];
}

function validInterval(start: unknown, end: unknown): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    (start as number) >= 0 && (end as number) > (start as number);
}
