import { readFileSync } from "node:fs";

import {
  frozenSemanticQualityCorpus,
  type FrozenQualityQuestion,
  type QualityLocale,
} from "./semantic-quality-corpus.js";

const fixtureRoot = new URL("./fixtures/meeting-memory-v4/", import.meta.url);

interface PrimaryTurnOverride {
  readonly speakerId: string;
  readonly text: string;
  readonly turnId: string;
}

interface AutomatedQuestionPatch {
  readonly addForbiddenLocatorIds?: readonly string[];
  readonly addGoldTurnIds?: readonly string[];
  readonly addTags: readonly string[];
  readonly id: string;
  readonly question?: string;
}

export interface V4QualityQuestion extends FrozenQualityQuestion {
  readonly forbiddenLocatorIds: readonly string[];
  readonly goldLocatorRelevance: readonly V4GoldLocatorRelevance[];
  readonly reviewStatus: "not_applicable" | "unreviewed";
}

export interface V4GoldLocatorRelevance {
  readonly locatorId: string;
  readonly relevance: 3;
}

export interface V4AuxiliaryTurn {
  readonly endMs: number;
  readonly meetingId: string;
  readonly roomId: string;
  readonly scopeId: string;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
  readonly turnId: string;
}

export interface V4FactFamilyNegativeTurn extends V4AuxiliaryTurn {
  readonly anchor: string;
  readonly factFamilyId: string;
  readonly negativeKind: "contradictory" | "stale" | "wrong_room" | "wrong_scope";
}

interface HumanReviewQuestion {
  readonly expectedClaimIds: readonly string[];
  readonly forbiddenLocatorIds: readonly string[];
  readonly goldTurnIds: readonly string[];
  readonly id: string;
  readonly kind: "answerable" | "unsupported";
  readonly locale: QualityLocale;
  readonly question: string;
  readonly reviewStatus: "unreviewed";
  readonly tags: readonly string[];
}

export interface FrozenSemanticQualityCorpusV4 {
  readonly automatedQuestions: readonly V4QualityQuestion[];
  readonly auxiliaryTurns: readonly V4AuxiliaryTurn[];
  readonly fixtureComponents: {
    readonly automatedQuestionPatches: readonly AutomatedQuestionPatch[];
    readonly factFamilyNegatives: readonly V4FactFamilyNegativeTurn[];
    readonly humanReviewQuestions: readonly HumanReviewQuestion[];
    readonly primaryTurnOverrides: readonly PrimaryTurnOverride[];
  };
  readonly globalForbiddenLocatorIds: readonly string[];
  readonly humanReviewQuestions: readonly V4QualityQuestion[];
  readonly knownLocatorIds: readonly string[];
  readonly primaryMeeting: ReturnType<typeof frozenSemanticQualityCorpus>["meeting"];
  readonly schemaVersion: "meeting_knowledge.semantic_quality_corpus.v4";
  readonly status: "synthetic_unqualified";
}

const syntheticMarkerPattern = /(?:corpusfact|sentinel|synthetic[-_ ]?marker)/iu;
const locatorLeakagePattern = /(?:quality-turn|foreign-(?:room|scope)-turn)-\d{3}/iu;
const digestLeakagePattern = /\b[a-f0-9]{40,64}\b/iu;
const factFamilyAnchors = Object.freeze([
  "Aurora", "Borealis", "Cobalt", "Driftwood", "Ember", "Fjord", "Granite", "Harbor",
  "Iris", "Juniper", "Kestrel", "Lagoon", "Meadow", "Nimbus", "Orchard", "Prairie",
  "Quartz", "River", "Summit", "Tundra", "Umber", "Valley", "Willow", "Xenon", "Yarrow",
]);
const russianAnchorlessQuestions = new Map<string, string>([
  ["fact-10", "Какой предел установил Назар для первой группы пользователей?"],
  ["fact-11", "Какое место Мария подтвердила для хранения данных клиентов?"],
  ["fact-12", "Кто принял ответственность за решения по дизайну?"],
  ["fact-13", "Какой процент доступности Виталий назвал обязательным?"],
  ["fact-15", "Какой порог очереди Назар установил после обсуждения нагрузки?"],
  ["fact-16", "Какое решение команда приняла о языках документации?"],
  ["fact-17", "Какую дату группа утвердила для полного нагрузочного теста?"],
  ["fact-18", "Какую базу данных выбрали вместо документного хранилища?"],
  ["fact-20", "Каково текущее состояние решения о поставщике аналитики?"],
  ["fact-21", "Какую обязательную периодичность проверки доступов предложил Назар?"],
  ["fact-22", "Какую возможность явно исключили из первой мобильной версии?"],
  ["fact-23", "Какую дату Мария подтвердила для отключения старого интерфейса?"],
]);

/** The fourth automated answerable variant is the frozen codename-free stratum. */
export function v4RetrievalStratum(
  question: V4QualityQuestion,
): "anchorless" | "named_anchor" | "not_applicable" {
  if (question.kind !== "answerable" || !question.id.startsWith("fact-")) {
    return "not_applicable";
  }
  return question.id.endsWith("-contextual") || question.id.endsWith("-mixed-multihop")
    ? "anchorless"
    : "named_anchor";
}

/** Deterministic codename ablation applied before the retrieval port is called. */
export function v4EvaluationQuestionText(question: V4QualityQuestion): string {
  if (v4RetrievalStratum(question) !== "anchorless") {return question.question;}
  let value = question.question.normalize("NFKC");
  const replacement = question.locale === "ru" ? "упомянутого направления" :
    question.locale === "mixed" ? "the referenced workstream / упомянутого направления" :
      "the referenced workstream";
  for (const anchor of factFamilyAnchors) {
    const token = new RegExp(`(?<![\\p{L}\\p{N}_])${anchor}(?![\\p{L}\\p{N}_])`, "giu");
    value = value.replace(token, replacement);
  }
  return value;
}

/**
 * Frozen retrieval negatives are scored independently from gold. Foreign-room
 * and foreign-scope locators apply to every query; question-owned distractors
 * retain stale, contradictory, explicit-negation, and collision cases.
 */
export function v4HardNegativeLocatorIds(
  corpus: FrozenSemanticQualityCorpusV4,
  question: V4QualityQuestion,
): readonly string[] {
  return Object.freeze(unique([
    ...question.distractorTurnIds,
    ...question.forbiddenLocatorIds,
    ...corpus.globalForbiddenLocatorIds,
  ]));
}

function containsCaseFoldedToken(value: string, token: string): boolean {
  const folded = value.normalize("NFKC").toLocaleLowerCase();
  const foldedToken = token.normalize("NFKC").toLocaleLowerCase();
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${foldedToken}(?![\\p{L}\\p{N}_])`, "u");
  return pattern.test(folded);
}

function anchorlessLanguage(question: Pick<V4QualityQuestion, "id" | "locale">,
  questionText: string): { readonly locale: QualityLocale; readonly question: string } {
  if (!question.id.endsWith("-contextual")) {
    return { locale: question.locale, question: questionText };
  }
  const familyId = /^(fact-\d{2})-/u.exec(question.id)?.[1];
  const russian = familyId === undefined ? undefined : russianAnchorlessQuestions.get(familyId);
  return russian === undefined ? { locale: "en", question: questionText } :
    { locale: "ru", question: russian };
}

function detectedQuestionLocale(value: string): QualityLocale {
  let withoutAnchors = value.normalize("NFKC");
  for (const anchor of factFamilyAnchors) {
    const token = new RegExp(`(?<![\\p{L}\\p{N}_])${anchor}(?![\\p{L}\\p{N}_])`, "giu");
    withoutAnchors = withoutAnchors.replace(token, "");
  }
  const hasCyrillic = /\p{Script=Cyrillic}/u.test(withoutAnchors);
  const hasLatin = /\p{Script=Latin}/u.test(withoutAnchors);
  return hasCyrillic && hasLatin ? "mixed" : hasCyrillic ? "ru" : "en";
}

function questionFactFamilyIds(question: Pick<V4QualityQuestion, "id" | "question">): readonly string[] {
  const direct = /^(fact-\d{2})-/u.exec(question.id)?.[1];
  if (direct !== undefined) {return [direct];}
  return factFamilyAnchors.flatMap((anchor, index) => containsCaseFoldedToken(question.question, anchor)
    ? [`fact-${index.toString().padStart(2, "0")}`] : []);
}

function questionFactFamilyNegatives(
  question: Pick<V4QualityQuestion, "id" | "question">,
  byFamily: ReadonlyMap<string, readonly V4FactFamilyNegativeTurn[]>,
): readonly string[] {
  return questionFactFamilyIds(question).flatMap((familyId) =>
    (byFamily.get(familyId) ?? []).map(({ turnId }) => turnId));
}

function assertQuestionSpecificFactFamilyNegatives(corpus: FrozenSemanticQualityCorpusV4,
  answerableQuestions: readonly V4QualityQuestion[]): void {
  const byFamily = Map.groupBy(corpus.fixtureComponents.factFamilyNegatives,
    ({ factFamilyId }) => factFamilyId);
  const requiredKinds = new Set(["contradictory", "stale", "wrong_room", "wrong_scope"]);
  for (const question of answerableQuestions) {
    const familyIds = questionFactFamilyIds(question);
    if (familyIds.length === 0) {
      throw new Error(`V4 answerable question ${question.id} lacks a target fact family`);
    }
    for (const familyId of familyIds) {
      const negatives = byFamily.get(familyId) ?? [];
      const anchorIndex = Number.parseInt(familyId.slice(5), 10);
      const anchor = factFamilyAnchors[anchorIndex];
      if (anchor === undefined || negatives.length !== 4 ||
        new Set(negatives.map(({ negativeKind }) => negativeKind)).size !== requiredKinds.size ||
        [...requiredKinds].some((kind) => !negatives.some((turn) => turn.negativeKind === kind)) ||
        negatives.some((turn) => turn.anchor !== anchor ||
          !containsCaseFoldedToken(turn.text, anchor) ||
          !question.forbiddenLocatorIds.includes(turn.turnId))) {
        throw new Error(`V4 question ${question.id} lacks four same-codename fact-family negatives`);
      }
    }
  }
}

/** Static fixture defense; this never examines runtime retrieval output. */
export function assertSemanticQualityV4StaticLeakageSafety(
  corpus: FrozenSemanticQualityCorpusV4,
): void {
  const questions = [...corpus.automatedQuestions, ...corpus.humanReviewQuestions];
  const answerableAutomated = corpus.automatedQuestions.filter(({ kind }) => kind === "answerable");
  const anchorless = answerableAutomated.filter((question) =>
    v4RetrievalStratum(question) === "anchorless");
  const named = answerableAutomated.filter((question) =>
    v4RetrievalStratum(question) === "named_anchor");
  if (anchorless.length !== 25 || named.length !== 75 ||
    countQuestionLocales(anchorless).en !== 8 || countQuestionLocales(anchorless).ru !== 12 ||
    countQuestionLocales(anchorless).mixed !== 5 ||
    anchorless.some((question) => detectedQuestionLocale(v4EvaluationQuestionText(question)) !==
      question.locale) ||
    questions.some(({ question }) => syntheticMarkerPattern.test(question) ||
      locatorLeakagePattern.test(question) || digestLeakagePattern.test(question)) ||
    answerableAutomated.some((question) => v4HardNegativeLocatorIds(corpus, question).length === 0)) {
    throw new Error("V4 corpus failed static leakage or frozen retrieval-strata safety");
  }
  if (anchorless.some((question) => factFamilyAnchors.some((anchor) =>
    containsCaseFoldedToken(v4EvaluationQuestionText(question), anchor)))) {
    throw new Error("V4 corpus failed codename-ablation static leakage safety");
  }
  assertQuestionSpecificFactFamilyNegatives(corpus,
    questions.filter(({ kind }) => kind === "answerable"));
  for (const question of questions) {
    const forbiddenTokens = [...question.goldTurnIds, ...question.expectedClaimIds];
    if (forbiddenTokens.some((token) => containsCaseFoldedToken(question.question, token))) {
      throw new Error(`V4 question ${question.id} contains gold-unique identifier static leakage`);
    }
  }
}

/**
 * Builds the frozen V4 evaluation topology without provider calls. The legacy
 * 421-turn meeting and 200-question cardinality remain primary; V4 replaces
 * only 16 unreferenced routine turns and attaches deterministic evaluation metadata.
 */
export function frozenSemanticQualityCorpusV4(): FrozenSemanticQualityCorpusV4 {
  const base = frozenSemanticQualityCorpus();
  const primaryTurnOverrides = readJsonLines("primary-turn-overrides.jsonl",
    decodePrimaryTurnOverride);
  const automatedQuestionPatches = readJsonLines("automated-question-patches.jsonl",
    decodeAutomatedQuestionPatch);
  const auxiliaryTurns = readJsonLines("auxiliary-meetings.jsonl", decodeAuxiliaryTurn);
  const factFamilyNegatives = readJsonLines("fact-family-negatives.jsonl",
    decodeFactFamilyNegativeTurn);
  const allAuxiliaryTurns = Object.freeze([...auxiliaryTurns, ...factFamilyNegatives]);
  const humanReviewQuestions = readJsonLines("human-review-questions.jsonl",
    decodeHumanReviewQuestion);
  validateFixtureRecords({
    automatedQuestionPatches,
    auxiliaryTurns: allAuxiliaryTurns,
    baseQuestions: base.questions,
    baseProfileTurnIds: new Set([
      ...base.profile.asrNoiseTurnIds, ...base.profile.interruptionTurnIds,
    ]),
    humanReviewQuestions,
    primaryTurnIds: new Set(base.meeting.humanTurns.map(({ turnId }) => turnId)),
    primaryTurnOverrides,
  });

  const overrideById = new Map(primaryTurnOverrides.map((turn) => [turn.turnId, turn]));
  const humanTurns = Object.freeze(base.meeting.humanTurns.map((turn) => {
    const override = overrideById.get(turn.turnId);
    return override === undefined
      ? turn
      : Object.freeze({ ...turn, speakerId: override.speakerId, text: override.text });
  }));
  const primaryMeeting = Object.freeze({ ...base.meeting, humanTurns });
  const primaryTurnIds = new Set(primaryMeeting.humanTurns.map(({ turnId }) => turnId));
  const auxiliaryTurnIds = new Set(allAuxiliaryTurns.map(({ turnId }) => turnId));
  const factNegativesByFamily = Map.groupBy(factFamilyNegatives, ({ factFamilyId }) => factFamilyId);

  const patchById = new Map(automatedQuestionPatches.map((patch) => [patch.id, patch]));
  const automatedQuestions = Object.freeze(base.questions.map((question): V4QualityQuestion => {
    const patch = patchById.get(question.id);
    const goldTurnIds = Object.freeze(unique(
      [...question.goldTurnIds, ...(patch?.addGoldTurnIds ?? [])],
    ));
    const language = anchorlessLanguage(question, patch?.question ?? question.question);
    return Object.freeze({
      ...question,
      forbiddenLocatorIds: Object.freeze(unique([...(patch?.addForbiddenLocatorIds ?? []),
        ...questionFactFamilyNegatives(question, factNegativesByFamily)])),
      goldLocatorRelevance: locatorRelevance(goldTurnIds),
      goldTurnIds,
      locale: language.locale,
      question: language.question,
      reviewStatus: "not_applicable" as const,
      tags: Object.freeze(unique([...question.tags, ...(patch?.addTags ?? [])])),
    });
  }));
  const reviewQuestions = Object.freeze(humanReviewQuestions.map((question): V4QualityQuestion =>
    Object.freeze({
      ...question,
      contradictedClaimIds: Object.freeze([]),
      distractorTurnIds: Object.freeze([]),
      expectedClaimIds: Object.freeze([...question.expectedClaimIds]),
      forbiddenLocatorIds: Object.freeze(unique([...question.forbiddenLocatorIds,
        ...questionFactFamilyNegatives(question, factNegativesByFamily)])),
      goldLocatorRelevance: locatorRelevance(question.goldTurnIds),
      goldTurnIds: Object.freeze([...question.goldTurnIds]),
      tags: Object.freeze([...question.tags]),
    })));

  const globalForbiddenLocatorIds = Object.freeze([...auxiliaryTurnIds]);
  const knownLocatorIds = Object.freeze([...primaryTurnIds, ...auxiliaryTurnIds]);
  const corpus = Object.freeze({
    automatedQuestions,
    auxiliaryTurns: Object.freeze(allAuxiliaryTurns.map((turn) => Object.freeze({ ...turn }))),
    fixtureComponents: Object.freeze({
      automatedQuestionPatches,
      factFamilyNegatives,
      humanReviewQuestions,
      primaryTurnOverrides,
    }),
    globalForbiddenLocatorIds,
    humanReviewQuestions: reviewQuestions,
    knownLocatorIds,
    primaryMeeting,
    schemaVersion: "meeting_knowledge.semantic_quality_corpus.v4",
    status: "synthetic_unqualified",
  });
  assertSemanticQualityV4CorpusIntegrity(corpus, base.questions);
  assertSemanticQualityV4StaticLeakageSafety(corpus);
  return corpus;
}

function validateFixtureRecords(input: {
  readonly automatedQuestionPatches: readonly AutomatedQuestionPatch[];
  readonly auxiliaryTurns: readonly V4AuxiliaryTurn[];
  readonly baseQuestions: readonly FrozenQualityQuestion[];
  readonly baseProfileTurnIds: ReadonlySet<string>;
  readonly humanReviewQuestions: readonly HumanReviewQuestion[];
  readonly primaryTurnIds: ReadonlySet<string>;
  readonly primaryTurnOverrides: readonly PrimaryTurnOverride[];
}): void {
  uniqueIds(input.primaryTurnOverrides, "primary override", "turnId");
  uniqueIds(input.automatedQuestionPatches, "automated patch");
  uniqueIds(input.humanReviewQuestions, "human question");
  uniqueIds(input.auxiliaryTurns, "auxiliary turn", "turnId");
  const baseQuestionIds = new Set(input.baseQuestions.map(({ id }) => id));
  const boundBaseTurnIds = new Set(input.baseQuestions.flatMap((question) =>
    [...question.goldTurnIds, ...question.distractorTurnIds]));
  for (const turnId of input.baseProfileTurnIds) {boundBaseTurnIds.add(turnId);}
  if (input.primaryTurnOverrides.length !== 16 || input.primaryTurnOverrides.some((turn) =>
    !input.primaryTurnIds.has(turn.turnId) || boundBaseTurnIds.has(turn.turnId) ||
    turn.text.trim() === "" || turn.speakerId.trim() === "")) {
    throw new Error("V4 requires exactly 16 unreferenced valid primary turn overrides");
  }
  if (input.automatedQuestionPatches.some((patch) => !baseQuestionIds.has(patch.id))) {
    throw new Error("V4 automated patch references an unknown frozen question");
  }
  if (input.humanReviewQuestions.some((question) =>
    !sameString(question.reviewStatus, "unreviewed"))) {
    throw new Error("V4 human-review candidates must remain unreviewed");
  }
}

// Keep the frozen-corpus integrity proof in one audit surface.
export function assertSemanticQualityV4CorpusIntegrity(
  input: FrozenSemanticQualityCorpusV4,
  baseQuestions: readonly FrozenQualityQuestion[] = frozenSemanticQualityCorpus().questions,
): void {
  const frozenBase = frozenSemanticQualityCorpus();
  assertV4CorpusCardinality(input, baseQuestions, frozenBase);
  assertHumanReviewCoverage(input);
  const locatorAuthority = assertAuxiliaryTopology(input);
  assertFixtureLocatorReferences(input, locatorAuthority);
  assertQuestionLocatorAuthority(input, locatorAuthority);
  assertBaseSemanticRelationships(input, baseQuestions, frozenBase);
  assertDerivedV4Records(input, baseQuestions, frozenBase);
}

function assertV4CorpusCardinality(
  input: FrozenSemanticQualityCorpusV4,
  baseQuestions: readonly FrozenQualityQuestion[],
  frozenBase: ReturnType<typeof frozenSemanticQualityCorpus>,
): void {
  if (!sameString(input.schemaVersion, "meeting_knowledge.semantic_quality_corpus.v4") ||
    !sameString(input.status, "synthetic_unqualified")) {
    throw new Error("V4 corpus schema and qualification status are pinned");
  }
  validateFixtureRecords({
    ...input.fixtureComponents,
    auxiliaryTurns: input.auxiliaryTurns,
    baseQuestions,
    baseProfileTurnIds: new Set([
      ...frozenBase.profile.asrNoiseTurnIds, ...frozenBase.profile.interruptionTurnIds,
    ]),
    primaryTurnIds: new Set(frozenBase.meeting.humanTurns.map(({ turnId }) => turnId)),
  });
  const automatedAnswerable = input.automatedQuestions.filter(({ kind }) => kind === "answerable");
  const automatedUnsupported = input.automatedQuestions.filter(({ kind }) => kind === "unsupported");
  if (input.primaryMeeting.humanTurns.length !== 421 ||
    input.primaryMeeting.humanTurns.at(-1)?.endMs !== 8_418_500 ||
    automatedAnswerable.length !== 100 || automatedUnsupported.length !== 100) {
    throw new Error("V4 changed the frozen primary meeting or automated 100/100 topology");
  }
}

function assertHumanReviewCoverage(input: FrozenSemanticQualityCorpusV4): void {
  const reviewAnswerable = input.humanReviewQuestions.filter(({ kind }) => kind === "answerable");
  const reviewUnsupported = input.humanReviewQuestions.filter(({ kind }) => kind === "unsupported");
  const locales = countQuestionLocales(input.humanReviewQuestions);
  if (reviewAnswerable.length !== 20 || reviewUnsupported.length !== 20 ||
    locales.en !== 12 || locales.ru !== 12 || locales.mixed !== 16 ||
    new Set(input.humanReviewQuestions.map(({ question }) => question.toLocaleLowerCase())).size !== 40) {
    throw new Error("V4 requires 40 unique unreviewed questions stratified 20/20 and 12/12/16");
  }
  const minimumTags = new Map([
    ["alias", 8], ["ambiguous-alias", 4], ["asr-text-challenge", 8],
    ["correction", 8], ["contradiction", 8], ["cross-scope", 12],
    ["multi-hop", 8], ["natural-paraphrase", 40], ["overlap", 6],
  ]);
  for (const [tag, minimum] of minimumTags) {
    if (input.humanReviewQuestions.filter(({ tags }) => tags.includes(tag)).length < minimum) {
      throw new Error(`V4 human-review candidates lack ${tag} coverage`);
    }
  }
}

interface LocatorAuthority {
  readonly auxiliaryIds: ReadonlySet<string>;
  readonly primaryIds: ReadonlySet<string>;
}

function assertAuxiliaryTopology(input: FrozenSemanticQualityCorpusV4): LocatorAuthority {
  const foreignMeetings = new Set(input.auxiliaryTurns.map(({ meetingId }) => meetingId));
  const groups = Map.groupBy(input.auxiliaryTurns, ({ meetingId }) => meetingId);
  const legacyMeetings = ["fixture-quality-wrong-room-meeting",
    "fixture-quality-wrong-scope-meeting"];
  const familyMeetings = ["fixture-quality-stale-meeting",
    "fixture-quality-contradictory-meeting", "fixture-quality-family-wrong-room-meeting",
    "fixture-quality-family-wrong-scope-meeting"];
  if (input.auxiliaryTurns.length !== 112 || foreignMeetings.size !== 6 ||
    legacyMeetings.some((meetingId) => (groups.get(meetingId) ?? []).length !== 6) ||
    familyMeetings.some((meetingId) => (groups.get(meetingId) ?? []).length !== 25) ||
    [...groups.values()].some((turns) => turns.some((turn, index) =>
      turn.startMs !== index * 20_000 || turn.endMs !== (index + 1) * 20_000))) {
    throw new Error("V4 requires the frozen auxiliary and fact-family negative meetings");
  }
  const primary = input.primaryMeeting.binding;
  const wrongRoom = groups.get("fixture-quality-wrong-room-meeting") ?? [];
  const wrongScope = groups.get("fixture-quality-wrong-scope-meeting") ?? [];
  if (wrongRoom.length !== 6 || wrongScope.length !== 6 ||
    wrongRoom.some((turn) => turn.scopeId !== primary.scopeId || turn.roomId === primary.roomId) ||
    wrongScope.some((turn) => turn.scopeId === primary.scopeId || turn.roomId !== primary.roomId)) {
    throw new Error("V4 auxiliary scope topology is not adversarially isolated");
  }
  const stale = groups.get("fixture-quality-stale-meeting") ?? [];
  const contradictory = groups.get("fixture-quality-contradictory-meeting") ?? [];
  const familyWrongRoom = groups.get("fixture-quality-family-wrong-room-meeting") ?? [];
  const familyWrongScope = groups.get("fixture-quality-family-wrong-scope-meeting") ?? [];
  if ([...stale, ...contradictory].some((turn) => turn.scopeId !== primary.scopeId ||
      turn.roomId !== primary.roomId) ||
    familyWrongRoom.some((turn) => turn.scopeId !== primary.scopeId ||
      turn.roomId === primary.roomId) ||
    familyWrongScope.some((turn) => turn.scopeId === primary.scopeId ||
      turn.roomId !== primary.roomId)) {
    throw new Error("V4 fact-family negative scope topology is invalid");
  }
  const primaryIds = new Set(input.primaryMeeting.humanTurns.map(({ turnId }) => turnId));
  const auxiliaryIds = new Set(input.auxiliaryTurns.map(({ turnId }) => turnId));
  return { auxiliaryIds, primaryIds };
}

function assertFixtureLocatorReferences(input: FrozenSemanticQualityCorpusV4,
  authority: LocatorAuthority): void {
  const { auxiliaryIds, primaryIds } = authority;
  for (const patch of input.fixtureComponents.automatedQuestionPatches) {
    const gold = patch.addGoldTurnIds ?? [];
    const forbidden = patch.addForbiddenLocatorIds ?? [];
    if (hasDuplicates(gold) || hasDuplicates(forbidden) || hasDuplicates(patch.addTags) ||
      gold.some((id) => !primaryIds.has(id)) || forbidden.some((id) => !auxiliaryIds.has(id)) ||
      patch.addTags.some((tag) => tag.trim() === "")) {
      throw new Error(`V4 patch ${patch.id} has malformed references`);
    }
  }
  for (const question of input.fixtureComponents.humanReviewQuestions) {
    if (hasDuplicates(question.goldTurnIds) || hasDuplicates(question.forbiddenLocatorIds) ||
      question.goldTurnIds.some((id) => !primaryIds.has(id)) ||
      question.forbiddenLocatorIds.some((id) => !auxiliaryIds.has(id))) {
      throw new Error(`V4 human fixture ${question.id} has malformed references`);
    }
  }
}

function assertQuestionLocatorAuthority(input: FrozenSemanticQualityCorpusV4,
  authority: LocatorAuthority): void {
  const { auxiliaryIds, primaryIds } = authority;
  const expectedKnown = new Set([...primaryIds, ...auxiliaryIds]);
  if (input.knownLocatorIds.length !== expectedKnown.size ||
    new Set(input.knownLocatorIds).size !== input.knownLocatorIds.length ||
    input.knownLocatorIds.some((id) => !expectedKnown.has(id)) ||
    input.globalForbiddenLocatorIds.length !== auxiliaryIds.size ||
    new Set(input.globalForbiddenLocatorIds).size !== input.globalForbiddenLocatorIds.length ||
    input.globalForbiddenLocatorIds.some((id) => !auxiliaryIds.has(id))) {
    throw new Error("V4 locator authority must contain every canonical primary and auxiliary ID");
  }
  const questions = [...input.automatedQuestions, ...input.humanReviewQuestions];
  for (const question of questions) {
    if (hasDuplicates(question.goldTurnIds) || hasDuplicates(question.forbiddenLocatorIds) ||
      hasDuplicates(question.goldLocatorRelevance.map(({ locatorId }) => locatorId)) ||
      question.goldTurnIds.some((id) => !primaryIds.has(id)) ||
      question.forbiddenLocatorIds.some((id) => !auxiliaryIds.has(id)) ||
      question.goldLocatorRelevance.length !== question.goldTurnIds.length ||
      question.goldLocatorRelevance.some(({ locatorId, relevance }) =>
        !sameNumber(relevance, 3) || !question.goldTurnIds.includes(locatorId))) {
      throw new Error(`V4 question ${question.id} has malformed canonical locator references`);
    }
    if ((question.kind === "answerable") !== (question.goldTurnIds.length > 0 &&
      question.expectedClaimIds.length > 0)) {
      throw new Error(`V4 question ${question.id} has inconsistent answerability semantics`);
    }
  }
}

function assertBaseSemanticRelationships(
  input: FrozenSemanticQualityCorpusV4,
  baseQuestions: readonly FrozenQualityQuestion[],
  frozenBase: ReturnType<typeof frozenSemanticQualityCorpus>,
): void {
  const baseById = new Map(baseQuestions.map((question) => [question.id, question]));
  const turnById = new Map(input.primaryMeeting.humanTurns.map((turn) => [turn.turnId, turn]));
  const baseTurnById = new Map(frozenBase.meeting.humanTurns.map((turn) => [turn.turnId, turn]));
  for (const question of input.automatedQuestions) {
    const baseQuestion = baseById.get(question.id);
    if (baseQuestion === undefined || question.kind !== baseQuestion.kind ||
      canonicalSemanticArray(question.expectedClaimIds) !==
        canonicalSemanticArray(baseQuestion.expectedClaimIds) ||
      canonicalSemanticArray(question.contradictedClaimIds) !==
        canonicalSemanticArray(baseQuestion.contradictedClaimIds) ||
      baseQuestion.goldTurnIds.some((id) => !question.goldTurnIds.includes(id)) ||
      canonicalSemanticArray(question.distractorTurnIds) !==
        canonicalSemanticArray(baseQuestion.distractorTurnIds)) {
      throw new Error(`V4 changed base semantic relationship ${question.id}`);
    }
    for (const turnId of [...baseQuestion.goldTurnIds, ...baseQuestion.distractorTurnIds]) {
      if (JSON.stringify(turnById.get(turnId)) !== JSON.stringify(baseTurnById.get(turnId))) {
        throw new Error(`V4 overwrote base-bound turn ${turnId}`);
      }
    }
  }
}

function assertDerivedV4Records(
  input: FrozenSemanticQualityCorpusV4,
  baseQuestions: readonly FrozenQualityQuestion[],
  frozenBase: ReturnType<typeof frozenSemanticQualityCorpus>,
): void {
  const overrideById = new Map(input.fixtureComponents.primaryTurnOverrides.map((turn) =>
    [turn.turnId, turn]));
  const expectedPrimaryTurns = frozenBase.meeting.humanTurns.map((turn) => {
    const override = overrideById.get(turn.turnId);
    return override === undefined ? turn : { ...turn, speakerId: override.speakerId,
      text: override.text };
  });
  if (canonicalSemanticArray(input.primaryMeeting.humanTurns.map((value) =>
    JSON.stringify(value))) !== canonicalSemanticArray(expectedPrimaryTurns.map((value) =>
    JSON.stringify(value)))) {
    throw new Error("V4 derived primary turns do not match committed override records");
  }
  const patchById = new Map(input.fixtureComponents.automatedQuestionPatches.map((patch) =>
    [patch.id, patch]));
  const factNegativesByFamily = Map.groupBy(input.fixtureComponents.factFamilyNegatives,
    ({ factFamilyId }) => factFamilyId);
  const expectedAutomated = baseQuestions.map((question): V4QualityQuestion => {
    const patch = patchById.get(question.id);
    const goldTurnIds = unique([...question.goldTurnIds, ...(patch?.addGoldTurnIds ?? [])]);
    const language = anchorlessLanguage(question, patch?.question ?? question.question);
    return { ...question,
      forbiddenLocatorIds: unique([...(patch?.addForbiddenLocatorIds ?? []),
        ...questionFactFamilyNegatives(question, factNegativesByFamily)]),
      goldLocatorRelevance: locatorRelevance(goldTurnIds), goldTurnIds,
      locale: language.locale, question: language.question, reviewStatus: "not_applicable",
      tags: unique([...question.tags, ...(patch?.addTags ?? [])]) };
  });
  if (canonicalSemanticArray(input.automatedQuestions.map((value) =>
    JSON.stringify(value))) !== canonicalSemanticArray(expectedAutomated.map((value) =>
    JSON.stringify(value)))) {
    throw new Error("V4 derived automated questions do not match committed patch records");
  }
  const expectedHuman = input.fixtureComponents.humanReviewQuestions.map(
    (question): V4QualityQuestion => ({ ...question, contradictedClaimIds: [],
      distractorTurnIds: [], expectedClaimIds: [...question.expectedClaimIds],
      forbiddenLocatorIds: unique([...question.forbiddenLocatorIds,
        ...questionFactFamilyNegatives(question, factNegativesByFamily)]),
      goldLocatorRelevance: locatorRelevance(question.goldTurnIds),
      goldTurnIds: [...question.goldTurnIds], tags: [...question.tags] }),
  );
  if (canonicalSemanticArray(input.humanReviewQuestions.map((value) =>
    JSON.stringify(value))) !== canonicalSemanticArray(expectedHuman.map((value) =>
    JSON.stringify(value)))) {
    throw new Error("V4 derived human questions do not match committed fixture records");
  }
}

function readJsonLines<T>(name: string, decode: (value: unknown, label: string) => T): readonly T[] {
  const source = readFileSync(new URL(name, fixtureRoot), "utf8");
  if (!source.endsWith("\n")) {throw new Error(`${name} must end with a newline`);}
  return Object.freeze(source.trimEnd().split("\n").map((line, index) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return Object.freeze(decode(parsed, `${name}:${index + 1}`));
    }
    catch (error) {throw new Error(`${name}:${index + 1} is not valid JSON`, { cause: error });}
  }));
}

function decodePrimaryTurnOverride(value: unknown, label: string): PrimaryTurnOverride {
  const record = fixtureRecord(value, ["speakerId", "text", "turnId"], label);
  return { speakerId: fixtureString(record.speakerId, label),
    text: fixtureString(record.text, label), turnId: fixtureString(record.turnId, label) };
}

function decodeAutomatedQuestionPatch(value: unknown, label: string): AutomatedQuestionPatch {
  const allowed = ["addForbiddenLocatorIds", "addGoldTurnIds", "addTags", "id", "question"];
  const record = fixtureRecord(value, ["addTags", "id"], label, allowed);
  return {
    ...(record.addForbiddenLocatorIds === undefined ? {} :
      { addForbiddenLocatorIds: fixtureStrings(record.addForbiddenLocatorIds, label) }),
    ...(record.addGoldTurnIds === undefined ? {} :
      { addGoldTurnIds: fixtureStrings(record.addGoldTurnIds, label) }),
    addTags: fixtureStrings(record.addTags, label), id: fixtureString(record.id, label),
    ...(record.question === undefined ? {} : { question: fixtureString(record.question, label) }),
  };
}

function decodeAuxiliaryTurn(value: unknown, label: string): V4AuxiliaryTurn {
  const record = fixtureRecord(value, ["endMs", "meetingId", "roomId", "scopeId", "speakerId",
    "startMs", "text", "turnId"], label);
  return { endMs: fixtureNumber(record.endMs, label), meetingId: fixtureString(record.meetingId, label),
    roomId: fixtureString(record.roomId, label), scopeId: fixtureString(record.scopeId, label),
    speakerId: fixtureString(record.speakerId, label), startMs: fixtureNumber(record.startMs, label),
    text: fixtureString(record.text, label), turnId: fixtureString(record.turnId, label) };
}

function decodeFactFamilyNegativeTurn(value: unknown,
  label: string): V4FactFamilyNegativeTurn {
  const record = fixtureRecord(value, ["anchor", "endMs", "factFamilyId", "meetingId",
    "negativeKind", "roomId", "scopeId", "speakerId", "startMs", "text", "turnId"], label);
  if (!isFixtureValue(record.negativeKind,
    ["contradictory", "stale", "wrong_room", "wrong_scope"])) {
    throw new Error(`${label} has an invalid fact-family negative kind`);
  }
  return { anchor: fixtureString(record.anchor, label), endMs: fixtureNumber(record.endMs, label),
    factFamilyId: fixtureString(record.factFamilyId, label),
    meetingId: fixtureString(record.meetingId, label), negativeKind: record.negativeKind,
    roomId: fixtureString(record.roomId, label), scopeId: fixtureString(record.scopeId, label),
    speakerId: fixtureString(record.speakerId, label), startMs: fixtureNumber(record.startMs, label),
    text: fixtureString(record.text, label), turnId: fixtureString(record.turnId, label) };
}

function decodeHumanReviewQuestion(value: unknown, label: string): HumanReviewQuestion {
  const record = fixtureRecord(value, ["expectedClaimIds", "forbiddenLocatorIds", "goldTurnIds",
    "id", "kind", "locale", "question", "reviewStatus", "tags"], label);
  if (!isFixtureValue(record.kind, ["answerable", "unsupported"]) ||
    !isFixtureValue(record.locale, ["en", "mixed", "ru"]) ||
    record.reviewStatus !== "unreviewed") {
    throw new Error(`${label} has invalid question classifications`);
  }
  return { expectedClaimIds: fixtureStrings(record.expectedClaimIds, label),
    forbiddenLocatorIds: fixtureStrings(record.forbiddenLocatorIds, label),
    goldTurnIds: fixtureStrings(record.goldTurnIds, label), id: fixtureString(record.id, label),
    kind: record.kind, locale: record.locale, question: fixtureString(record.question, label),
    reviewStatus: record.reviewStatus, tags: fixtureStrings(record.tags, label) };
}

function fixtureRecord(value: unknown, requiredKeys: readonly string[], label: string,
  allowedKeys: readonly string[] = requiredKeys): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    requiredKeys.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new Error(`${label} has an invalid object shape`);
  }
  return Object.fromEntries(Object.entries(value));
}

function fixtureString(value: unknown, label: string): string {
  if (typeof value !== "string") {throw new Error(`${label} requires string fields`);}
  return value;
}

function fixtureNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {throw new Error(`${label} requires numeric fields`);}
  return value;
}

function fixtureStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} requires string-array fields`);
  }
  return value.filter((item): item is string => typeof item === "string");
}

function isFixtureValue<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((candidate) => candidate === value);
}

function unique(values: readonly string[]): readonly string[] {return [...new Set(values)];}
function hasDuplicates(values: readonly string[]): boolean {return new Set(values).size !== values.length;}
function locatorRelevance(turnIds: readonly string[]): readonly V4GoldLocatorRelevance[] {
  return Object.freeze(turnIds.map((locatorId) => Object.freeze({ locatorId, relevance: 3 as const })));
}
function canonicalSemanticArray(values: readonly string[]): string {return JSON.stringify(values);}

function uniqueIds(values: readonly object[], label: string,
  field: "id" | "turnId" = "id"): void {
  const ids: readonly unknown[] = values.map((value) => {
    if (field === "id" && "id" in value) {return value.id;}
    if (field === "turnId" && "turnId" in value) {return value.turnId;}
    return null;
  });
  if (ids.some((id) => typeof id !== "string" || id.trim() === "") ||
    new Set(ids).size !== values.length) {
    throw new Error(`V4 ${label} IDs must be non-empty and unique`);
  }
}

function sameString(value: string, expected: string): boolean {return value === expected;}
function sameNumber(value: number, expected: number): boolean {return value === expected;}

function countQuestionLocales(values: readonly V4QualityQuestion[]): Record<QualityLocale, number> {
  const counts: Record<QualityLocale, number> = { en: 0, mixed: 0, ru: 0 };
  for (const value of values) {counts[value.locale] += 1;}
  return counts;
}
