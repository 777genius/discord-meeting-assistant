import { createHash } from "node:crypto";

import { canonicalIntegerJson, canonicalSha256 } from "./semantic-quality-v4-manifest.js";
import type {
  RealSemanticQualityV4Corpus,
  RealSemanticQualityV4Question,
  RealSemanticQualityV4Turn,
} from "./semantic-quality-v4-private-corpus.js";
import type { SemanticQualityV4PinnedReviewerKey } from
  "./semantic-quality-v4-trusted-receipts.js";

export interface HumanSemanticQualityV4CorpusInput {
  readonly approvedCommit: string;
  readonly bindingPaths: {
    readonly dataset: string;
    readonly identity: string;
    readonly source: string;
  };
  readonly datasetPath: string;
  readonly goldPath: string;
  readonly identityPath: string;
  readonly meetingId: string;
  readonly pinnedReviewerKeys: readonly SemanticQualityV4PinnedReviewerKey[];
  readonly pinnedSha256: {
    readonly dataset: string;
    readonly gold: string;
    readonly identity: string;
    readonly source: string;
  };
  readonly profile: "human_corpus_v1";
  readonly reviewReceipts: readonly unknown[];
  readonly sourcePath: string;
}

type DecodedHumanCorpus = Omit<RealSemanticQualityV4Corpus, "reviewReceipts"> & {
  readonly bindings: Readonly<Record<string, string>>;
};

interface IdentityEntry {
  readonly displayName: string;
  readonly speakerId: string;
}

interface Locator {
  readonly endMs: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly turnId: string;
}

interface DatasetCase {
  readonly caseId: string;
  readonly category: string;
  readonly disposition: "answer" | "abstain";
  readonly evidence: readonly (Locator & { readonly speakerName: string })[];
  readonly language: "en" | "ru";
  readonly question: string;
}

interface GoldCase {
  readonly caseId: string;
  readonly disposition: "answer" | "abstain";
  readonly evidenceLocators: readonly Locator[];
  readonly expectedClaimIds: readonly string[];
}

const digestPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// Canonical transcript IDs include a producer-delimited opaque composite key.
const safeTurnIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:|-]{0,127}$/u;
const safeCategoryPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function decodeHumanSemanticQualityV4Corpus(input: {
  readonly approvedCommit: string;
  readonly bindingPaths: {
    readonly dataset: string;
    readonly identity: string;
    readonly source: string;
  };
  readonly datasetBytes: Uint8Array;
  readonly goldBytes: Uint8Array;
  readonly identityBytes: Uint8Array;
  readonly meetingId: string;
  readonly pinnedSha256: {
    readonly dataset: string;
    readonly gold: string;
    readonly identity: string;
    readonly source: string;
  };
  readonly sourceBytes: Uint8Array;
}): DecodedHumanCorpus {
  validatePins(input);
  for (const bytes of [input.sourceBytes, input.datasetBytes, input.goldBytes,
    input.identityBytes]) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
      bytes.byteLength > 4_000_000) {
      throw new Error("semantic quality V4 human private file size is invalid");
    }
  }
  const sourceFileSha256 = rawSha256(input.sourceBytes);
  const questionFileSha256 = rawSha256(input.datasetBytes);
  const goldFileSha256 = rawSha256(input.goldBytes);
  const identityFileSha256 = rawSha256(input.identityBytes);
  if (sourceFileSha256 !== input.pinnedSha256.source ||
    questionFileSha256 !== input.pinnedSha256.dataset ||
    goldFileSha256 !== input.pinnedSha256.gold ||
    identityFileSha256 !== input.pinnedSha256.identity) {
    throw new Error("semantic quality V4 human corpus raw-file digest is invalid");
  }

  const sourceValue = parsePrivateJson(input.sourceBytes);
  const datasetValue = parsePrivateJson(input.datasetBytes);
  const goldValue = parsePrivateJson(input.goldBytes);
  const identityValue = parsePrivateJson(input.identityBytes);
  requireCanonicalFraming(input.identityBytes, identityValue, "identity");
  requireCanonicalFraming(input.goldBytes, goldValue, "gold");

  const source = decodeSource(sourceValue, input.meetingId);
  const identity = decodeIdentity(identityValue, {
    identityFileSha256,
    meetingId: input.meetingId,
    sourceFileSha256,
  });
  const humanTurns = selectHumanTurns(source.turns, identity);
  const turnsById = new Map(humanTurns.map((turn) => [turn.turnId, turn]));
  const dataset = decodeDataset(datasetValue, {
    identity,
    identityFileSha256,
    meetingId: input.meetingId,
    turnsById,
  });
  const gold = decodeGold(goldValue, {
    approvedCommit: input.approvedCommit,
    bindingPaths: input.bindingPaths,
    dataset,
    goldFileSha256,
    identityFileSha256,
    meetingId: input.meetingId,
    questionFileSha256,
    sourceFileSha256,
    turnsById,
  });

  const questions = dataset.cases.map((item): RealSemanticQualityV4Question => {
    const authority = gold.casesById.get(item.caseId)!;
    return Object.freeze({
      category: item.category,
      evidenceTurnIds: Object.freeze(authority.disposition === "answer" ?
        authority.evidenceLocators.map(({ turnId }) => turnId) : []),
      expectedClaimIds: Object.freeze([...authority.expectedClaimIds]),
      id: item.caseId,
      kind: item.disposition === "answer" ? "answerable" : "unsupported",
      locale: item.language,
      question: item.question,
      // Query constraints must come from independent query metadata. This packet
      // has none, so evidence authority must not be reflected into query filters.
      speakerIds: Object.freeze([]),
      timeWindow: null,
    });
  });
  const counts = countQuestions(dataset.cases);
  if (canonicalIntegerJson(counts) !== canonicalIntegerJson({
    abstention: 11,
    answerable: 29,
    locales: { en: 10, ru: 30 },
    questions: 40,
  })) {
    throw new Error("semantic quality V4 human corpus exact case counts are invalid");
  }
  const categories = Object.freeze(Object.fromEntries(
    [...Map.groupBy(dataset.cases, ({ category }) => category)]
      .map(([category, values]) => [category, values.length] as const)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  ));
  const questionSetSha256 = canonicalSha256(dataset.cases.map((item) => ({
    caseId: item.caseId,
    category: item.category,
    disposition: item.disposition,
    language: item.language,
    question: item.question,
  })));
  const corpusSha256 = canonicalSha256({
    identityFileSha256,
    meetingId: input.meetingId,
    questionFileSha256,
    sourceFileSha256,
  });
  const inputSha256 = canonicalSha256({
    goldFileSha256,
    identityFileSha256,
    questionFileSha256,
    sourceFileSha256,
  });
  const bindings = Object.freeze({
    corpusSha256,
    declaredTranscriptSha256: sourceFileSha256,
    goldFileSha256,
    identityFileSha256,
    inputSha256,
    questionFileSha256,
    questionSetSha256,
    rubricFileSha256: goldFileSha256,
    rubricSha256: goldFileSha256,
    sourceFileSha256,
    transcriptFileSha256: sourceFileSha256,
  });
  return Object.freeze({
    bindings,
    privateGoldAuthority: freezePrivateJson(goldValue),
    profile: "human_corpus_v1",
    questions: Object.freeze(questions),
    safeCounts: Object.freeze({
      abstention: counts.abstention,
      answerable: counts.answerable,
      categories,
      evidenceReferences: questions.reduce((sum, question) =>
        sum + question.evidenceTurnIds.length, 0),
      locales: counts.locales,
      questions: counts.questions,
      speakers: identity.entries.length,
      turns: humanTurns.length,
    }),
    turns: Object.freeze(humanTurns),
  });
}

function validatePins(input: {
  readonly approvedCommit: string;
  readonly bindingPaths: Readonly<Record<"dataset" | "identity" | "source", string>>;
  readonly meetingId: string;
  readonly pinnedSha256: Readonly<Record<"dataset" | "gold" | "identity" | "source", string>>;
}): void {
  if (!commitPattern.test(input.approvedCommit) ||
    !safeIdPattern.test(input.meetingId) ||
    Object.values(input.pinnedSha256).some((digest) => !digestPattern.test(digest)) ||
    Object.values(input.bindingPaths).some((path) =>
      typeof path !== "string" || path.trim() === "" || path.includes("\0"))) {
    throw new Error("semantic quality V4 human corpus caller authority is invalid");
  }
}

function decodeSource(value: unknown, meetingId: string) {
  const root = exactRecord(value, ["meetingId", "summary", "transcript"]);
  const transcript = exactRecord(root.transcript, ["readableSegments", "recordingId",
    "transcriptId", "turns", "version"]);
  if (root.meetingId !== meetingId || root.summary === null ||
    typeof root.summary !== "object" || Array.isArray(root.summary) ||
    !Array.isArray(transcript.readableSegments) ||
    typeof transcript.recordingId !== "string" || transcript.recordingId.trim() === "" ||
    typeof transcript.transcriptId !== "string" || transcript.transcriptId.trim() === "" ||
    !Number.isSafeInteger(transcript.version) || !Array.isArray(transcript.turns)) {
    throw new Error("semantic quality V4 human source schema is invalid");
  }
  const turns = transcript.turns.map((candidate): RealSemanticQualityV4Turn => {
    const turn = exactRecord(candidate, ["endMs", "speakerId", "startMs", "text", "turnId"]);
    if (typeof turn.turnId !== "string" || !safeTurnIdPattern.test(turn.turnId) ||
      typeof turn.speakerId !== "string" || !safeIdPattern.test(turn.speakerId) ||
      typeof turn.text !== "string" || turn.text.trim() === "" ||
      !validInterval(turn.startMs, turn.endMs)) {
      throw new Error("semantic quality V4 human source turn is invalid");
    }
    return Object.freeze({
      endMs: turn.endMs as number,
      speakerId: turn.speakerId,
      startMs: turn.startMs as number,
      text: turn.text,
      turnId: turn.turnId,
    });
  });
  if (turns.length !== 1779 ||
    new Set(turns.map(({ turnId }) => turnId)).size !== turns.length ||
    turns.some((turn, index) => index > 0 && turn.startMs < turns[index - 1]!.startMs)) {
    throw new Error("semantic quality V4 human source aggregates are invalid");
  }
  return { turns: Object.freeze(turns) };
}

function decodeIdentity(value: unknown, expected: {
  readonly identityFileSha256: string;
  readonly meetingId: string;
  readonly sourceFileSha256: string;
}) {
  const root = exactRecord(value, ["authorityKind", "canonicalSha256Semantics", "entries",
    "excludedIds", "meetingId", "schema", "sourceSha256", "version"]);
  const semantics = exactRecord(root.canonicalSha256Semantics, ["algorithm",
    "canonicalization", "encoding", "framing", "scope"]);
  if (root.schema !== "meeting-identity-authority" || root.version !== 1 ||
    root.authorityKind !== "operator_confirmed_discord_identity_map" ||
    root.meetingId !== expected.meetingId ||
    root.sourceSha256 !== expected.sourceFileSha256 ||
    semantics.algorithm !== "sha256" || semantics.canonicalization !== "RFC8785" ||
    semantics.encoding !== "UTF-8" || semantics.framing !== "single_trailing_lf" ||
    semantics.scope !== "entire_document" ||
    !Array.isArray(root.entries) || !Array.isArray(root.excludedIds)) {
    throw new Error("semantic quality V4 human identity authority is invalid");
  }
  const entries = root.entries.map((candidate): IdentityEntry => {
    const entry = exactRecord(candidate, ["displayName", "speakerId", "type"]);
    if (entry.type !== "human" || typeof entry.displayName !== "string" ||
      entry.displayName.trim() === "" || typeof entry.speakerId !== "string" ||
      !safeIdPattern.test(entry.speakerId)) {
      throw new Error("semantic quality V4 human identity entry is invalid");
    }
    return Object.freeze({ displayName: entry.displayName, speakerId: entry.speakerId });
  });
  const excludedIds = root.excludedIds.map((candidate) => {
    const entry = exactRecord(candidate, ["reason", "speakerId"]);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "" ||
      typeof entry.speakerId !== "string" || !safeIdPattern.test(entry.speakerId)) {
      throw new Error("semantic quality V4 human identity exclusion is invalid");
    }
    return entry.speakerId;
  });
  const humanIds = new Set(entries.map(({ speakerId }) => speakerId));
  const excluded = new Set(excludedIds);
  if (entries.length !== 6 || excludedIds.length !== 1 ||
    humanIds.size !== entries.length || excluded.size !== excludedIds.length ||
    [...humanIds].some((speakerId) => excluded.has(speakerId))) {
    throw new Error("semantic quality V4 human identity actor map is invalid");
  }
  return {
    entries: Object.freeze(entries),
    excluded,
    humanIds,
  };
}

function selectHumanTurns(turns: readonly RealSemanticQualityV4Turn[], identity: {
  readonly excluded: ReadonlySet<string>;
  readonly humanIds: ReadonlySet<string>;
}): readonly RealSemanticQualityV4Turn[] {
  if (turns.some(({ speakerId }) =>
    !identity.humanIds.has(speakerId) && !identity.excluded.has(speakerId))) {
    throw new Error("semantic quality V4 human identity does not cover every source speaker");
  }
  const excludedCount = turns.filter(({ speakerId }) => identity.excluded.has(speakerId)).length;
  const humanTurns = turns.filter(({ speakerId }) => identity.humanIds.has(speakerId));
  if (excludedCount !== 10 || humanTurns.length !== 1769 ||
    new Set(humanTurns.map(({ speakerId }) => speakerId)).size !== 6) {
    throw new Error("semantic quality V4 canonical human turn selection is invalid");
  }
  return Object.freeze(humanTurns);
}

function decodeDataset(value: unknown, authority: {
  readonly identity: {
    readonly entries: readonly IdentityEntry[];
  };
  readonly identityFileSha256: string;
  readonly meetingId: string;
  readonly turnsById: ReadonlyMap<string, RealSemanticQualityV4Turn>;
}) {
  const root = exactRecord(value, ["cases", "identityAuthoritySha256", "meetingId",
    "schemaVersion", "sourceTurnCount"]);
  if (root.schemaVersion !== "meeting-memory-human-eval-v1" ||
    root.meetingId !== authority.meetingId ||
    root.identityAuthoritySha256 !== authority.identityFileSha256 ||
    root.sourceTurnCount !== 1779 || !Array.isArray(root.cases)) {
    throw new Error("semantic quality V4 human dataset binding is invalid");
  }
  const names = new Map(authority.identity.entries.map((entry) =>
    [entry.speakerId, entry.displayName]));
  const cases = root.cases.map((candidate): DatasetCase => {
    const base = requiredRecord(candidate, ["expectedDisposition"]);
    if (base.expectedDisposition === "answer") {
      const item = exactRecord(candidate, ["adjudicationRule", "caseId", "category", "evidence",
        "expectedAnswer", "expectedDisposition", "language", "question", "tags"]);
      validateDatasetBase(item);
      if (typeof item.expectedAnswer !== "string" || item.expectedAnswer.trim() === "" ||
        !Array.isArray(item.evidence) || item.evidence.length === 0) {
        throw new Error("semantic quality V4 human answer case is invalid");
      }
      return Object.freeze({
        caseId: item.caseId as string,
        category: item.category as string,
        disposition: "answer",
        evidence: Object.freeze(item.evidence.map((locator) =>
          decodeDatasetLocator(locator, authority.turnsById, names))),
        language: item.language as "en" | "ru",
        question: item.question as string,
      });
    }
    const item = exactRecord(candidate, ["abstentionReason", "adjudicationRule", "caseId",
      "category", "distractorEvidence", "expectedDisposition", "language", "question", "tags"]);
    validateDatasetBase(item);
    if (item.expectedDisposition !== "abstain" ||
      typeof item.abstentionReason !== "string" || item.abstentionReason.trim() === "" ||
      !Array.isArray(item.distractorEvidence)) {
      throw new Error("semantic quality V4 human abstention case is invalid");
    }
    return Object.freeze({
      caseId: item.caseId as string,
      category: item.category as string,
      disposition: "abstain",
      evidence: Object.freeze(item.distractorEvidence.map((locator) =>
        decodeDatasetLocator(locator, authority.turnsById, names))),
      language: item.language as "en" | "ru",
      question: item.question as string,
    });
  });
  if (cases.length !== 40 ||
    new Set(cases.map(({ caseId }) => caseId)).size !== cases.length) {
    throw new Error("semantic quality V4 human dataset case authority is invalid");
  }
  return { cases: Object.freeze(cases) };
}

function validateDatasetBase(item: Record<string, unknown>): void {
  if (typeof item.caseId !== "string" || !safeIdPattern.test(item.caseId) ||
    typeof item.category !== "string" || !safeCategoryPattern.test(item.category) ||
    (item.language !== "en" && item.language !== "ru") ||
    typeof item.question !== "string" || item.question.trim() === "" ||
    !Array.isArray(item.tags) ||
    item.tags.some((tag) => typeof tag !== "string" || tag.trim() === "") ||
    new Set(item.tags).size !== item.tags.length ||
    typeof item.adjudicationRule !== "string" || item.adjudicationRule.trim() === "") {
    throw new Error("semantic quality V4 human dataset case is invalid");
  }
}

function decodeDatasetLocator(value: unknown,
  turnsById: ReadonlyMap<string, RealSemanticQualityV4Turn>,
  names: ReadonlyMap<string, string>): Locator & { readonly speakerName: string } {
  const item = exactRecord(value, ["endMs", "speakerId", "speakerName", "startMs", "turnId"]);
  const locator = decodeLocator({ endMs: item.endMs, speakerId: item.speakerId,
    startMs: item.startMs, turnId: item.turnId }, turnsById);
  if (typeof item.speakerName !== "string" ||
    names.get(locator.speakerId) !== item.speakerName) {
    throw new Error("semantic quality V4 human evidence identity is invalid");
  }
  return Object.freeze({ ...locator, speakerName: item.speakerName });
}

function decodeGold(value: unknown, authority: {
  readonly approvedCommit: string;
  readonly bindingPaths: Readonly<Record<"dataset" | "identity" | "source", string>>;
  readonly dataset: { readonly cases: readonly DatasetCase[] };
  readonly goldFileSha256: string;
  readonly identityFileSha256: string;
  readonly meetingId: string;
  readonly questionFileSha256: string;
  readonly sourceFileSha256: string;
  readonly turnsById: ReadonlyMap<string, RealSemanticQualityV4Turn>;
}) {
  const root = requiredRecord(value, ["bindings", "canonicalization", "cases", "denominators",
    "dimensionDefinitions", "schemaVersion"]);
  const bindings = exactRecord(root.bindings, ["dataset", "identityAuthority", "meetingId",
    "source"]);
  const datasetBinding = exactRecord(bindings.dataset, ["approvedCommit", "path", "sha256"]);
  const identityBinding = exactRecord(bindings.identityAuthority, ["path", "sha256"]);
  const sourceBinding = exactRecord(bindings.source, ["path", "sha256"]);
  const canonicalization = exactRecord(root.canonicalization, ["encoding", "framing", "scheme"]);
  if (root.schemaVersion !== "gold-claims-v1" ||
    bindings.meetingId !== authority.meetingId ||
    datasetBinding.approvedCommit !== authority.approvedCommit ||
    datasetBinding.path !== authority.bindingPaths.dataset ||
    datasetBinding.sha256 !== authority.questionFileSha256 ||
    identityBinding.path !== authority.bindingPaths.identity ||
    identityBinding.sha256 !== authority.identityFileSha256 ||
    sourceBinding.path !== authority.bindingPaths.source ||
    sourceBinding.sha256 !== authority.sourceFileSha256 ||
    canonicalization.encoding !== "UTF-8" ||
    canonicalization.framing !== "single_trailing_lf" ||
    canonicalization.scheme !== "RFC8785" ||
    !Array.isArray(root.cases)) {
    throw new Error("semantic quality V4 human gold binding is invalid");
  }
  const denominators = requiredRecord(root.denominators, ["citation_entailment",
    "latest_correction", "semantic_correctness", "speaker_identity", "time_phase"]);
  const expectedDenominators = {
    citation_entailment: 72,
    latest_correction: 10,
    semantic_correctness: 72,
    speaker_identity: 72,
    time_phase: 44,
  };
  if (Object.entries(expectedDenominators).some(([key, count]) =>
    denominators[key] !== count)) {
    throw new Error("semantic quality V4 human gold denominators are invalid");
  }

  const datasetById = new Map(authority.dataset.cases.map((item) => [item.caseId, item]));
  const claimIds = new Set<string>();
  const observedDimensions = Object.fromEntries(Object.keys(expectedDenominators)
    .map((dimension) => [dimension, 0]));
  let requiredClaimCount = 0;
  let forbiddenClaimCount = 0;
  const cases = root.cases.map((candidate): GoldCase => {
    const item = requiredRecord(candidate, ["caseId", "expectedDisposition"]);
    if (typeof item.caseId !== "string" || !safeIdPattern.test(item.caseId) ||
      (item.expectedDisposition !== "answer" && item.expectedDisposition !== "abstain")) {
      throw new Error("semantic quality V4 human gold case is invalid");
    }
    const datasetCase = datasetById.get(item.caseId);
    if (datasetCase === undefined || datasetCase.disposition !== item.expectedDisposition) {
      throw new Error("semantic quality V4 human gold disposition binding is invalid");
    }
    if (item.expectedDisposition === "answer") {
      const answer = requiredRecord(candidate, ["evidenceLocators", "forbiddenClaims",
        "requiredClaims"]);
      if (!Array.isArray(answer.evidenceLocators) ||
        !Array.isArray(answer.requiredClaims) || !Array.isArray(answer.forbiddenClaims) ||
        answer.evidenceLocators.length === 0 || answer.requiredClaims.length === 0) {
        throw new Error("semantic quality V4 human answer gold is invalid");
      }
      const evidenceLocators = answer.evidenceLocators.map((locator) =>
        decodeLocator(locator, authority.turnsById));
      if (!sameLocators(evidenceLocators, datasetCase.evidence)) {
        throw new Error("semantic quality V4 human dataset and gold evidence disagree");
      }
      const evidenceIds = new Set(evidenceLocators.map(({ turnId }) => turnId));
      const expectedClaimIds = answer.requiredClaims.map((claimCandidate) => {
        const claim = requiredRecord(claimCandidate, ["claimId", "dimensions",
          "evidenceTurnIds", "normalizedClaim", "speakerTargets"]);
        if (typeof claim.claimId !== "string" || !safeIdPattern.test(claim.claimId) ||
          typeof claim.normalizedClaim !== "string" || claim.normalizedClaim.trim() === "" ||
          !Array.isArray(claim.dimensions) || !Array.isArray(claim.evidenceTurnIds) ||
          !Array.isArray(claim.speakerTargets) ||
          claim.speakerTargets.length === 0 ||
          new Set(claim.speakerTargets).size !== claim.speakerTargets.length ||
          claim.speakerTargets.some((speakerId) => typeof speakerId !== "string" ||
            !evidenceLocators.some((locator) => locator.speakerId === speakerId)) ||
          new Set(claim.dimensions).size !== claim.dimensions.length ||
          claim.dimensions.some((dimension) => typeof dimension !== "string" ||
            !Object.hasOwn(expectedDenominators, dimension)) ||
          claim.evidenceTurnIds.length === 0 ||
          new Set(claim.evidenceTurnIds).size !== claim.evidenceTurnIds.length ||
          claim.evidenceTurnIds.some((turnId) =>
            typeof turnId !== "string" || !evidenceIds.has(turnId)) ||
          claimIds.has(claim.claimId)) {
          throw new Error("semantic quality V4 human required claim is invalid");
        }
        for (const dimension of claim.dimensions as string[]) {
          observedDimensions[dimension] = observedDimensions[dimension]! + 1;
        }
        for (const [dimension, field] of [["time_phase", "timeTarget"],
          ["latest_correction", "latestCorrectionTarget"]] as const) {
          if (claim.dimensions.includes(dimension) ?
            typeof claim[field] !== "string" || (claim[field] as string).trim() === "" :
            Object.hasOwn(claim, field)) {
            throw new Error("semantic quality V4 human claim dimension authority is invalid");
          }
        }
        claimIds.add(claim.claimId);
        requiredClaimCount += 1;
        return claim.claimId;
      });
      for (const forbiddenCandidate of answer.forbiddenClaims) {
        const forbidden = requiredRecord(forbiddenCandidate, ["category", "claimId",
          "normalizedClaim"]);
        if (typeof forbidden.claimId !== "string" ||
          !safeIdPattern.test(forbidden.claimId) || claimIds.has(forbidden.claimId) ||
          typeof forbidden.category !== "string" || forbidden.category.trim() === "" ||
          typeof forbidden.normalizedClaim !== "string" ||
          forbidden.normalizedClaim.trim() === "") {
          throw new Error("semantic quality V4 human forbidden claim is invalid");
        }
        claimIds.add(forbidden.claimId);
        forbiddenClaimCount += 1;
      }
      return Object.freeze({
        caseId: item.caseId,
        disposition: "answer",
        evidenceLocators: Object.freeze(evidenceLocators),
        expectedClaimIds: Object.freeze(expectedClaimIds),
      });
    }
    const abstain = requiredRecord(candidate, ["distractorLocators", "forbiddenAssertions",
      "forbiddenCategories"]);
    if (!Array.isArray(abstain.distractorLocators) ||
      !Array.isArray(abstain.forbiddenAssertions) ||
      !Array.isArray(abstain.forbiddenCategories)) {
      throw new Error("semantic quality V4 human abstention gold is invalid");
    }
    const distractors = abstain.distractorLocators.map((locator) =>
      decodeLocator(locator, authority.turnsById));
    if (!sameLocators(distractors, datasetCase.evidence)) {
      throw new Error("semantic quality V4 human distractor authority disagrees");
    }
    for (const assertionCandidate of abstain.forbiddenAssertions) {
      registerForbiddenAssertion(assertionCandidate, claimIds);
    }
    if (abstain.forbiddenCategories.some((category) =>
      typeof category !== "string" || category.trim() === "")) {
      throw new Error("semantic quality V4 human forbidden categories are invalid");
    }
    return Object.freeze({
      caseId: item.caseId,
      disposition: "abstain",
      evidenceLocators: Object.freeze([]),
      expectedClaimIds: Object.freeze([]),
    });
  });
  if (cases.length !== 40 ||
    new Set(cases.map(({ caseId }) => caseId)).size !== cases.length ||
    cases.some(({ caseId }) => !datasetById.has(caseId)) ||
    requiredClaimCount !== 72 || forbiddenClaimCount !== 34 ||
    Object.entries(expectedDenominators).some(([key, count]) =>
      observedDimensions[key] !== count)) {
    throw new Error("semantic quality V4 human gold aggregates are invalid");
  }
  return { casesById: new Map(cases.map((item) => [item.caseId, item])) };
}

function decodeLocator(value: unknown,
  turnsById: ReadonlyMap<string, RealSemanticQualityV4Turn>): Locator {
  const item = exactRecord(value, ["endMs", "speakerId", "startMs", "turnId"]);
  if (typeof item.turnId !== "string" || !safeTurnIdPattern.test(item.turnId) ||
    typeof item.speakerId !== "string" || !safeIdPattern.test(item.speakerId) ||
    !validInterval(item.startMs, item.endMs)) {
    throw new Error("semantic quality V4 human evidence locator is invalid");
  }
  const turn = turnsById.get(item.turnId);
  if (turn === undefined || turn.speakerId !== item.speakerId ||
    turn.startMs !== item.startMs || turn.endMs !== item.endMs) {
    throw new Error("semantic quality V4 human evidence is not an exact local turn");
  }
  return Object.freeze({
    endMs: item.endMs as number,
    speakerId: item.speakerId,
    startMs: item.startMs as number,
    turnId: item.turnId,
  });
}

function registerForbiddenAssertion(candidate: unknown, claimIds: Set<string>): void {
  const assertion = exactRecord(candidate, ["assertionId", "normalizedAssertion"]);
  if (typeof assertion.assertionId !== "string" ||
    !safeIdPattern.test(assertion.assertionId) || claimIds.has(assertion.assertionId) ||
    typeof assertion.normalizedAssertion !== "string" ||
    assertion.normalizedAssertion.trim() === "") {
    throw new Error("semantic quality V4 human forbidden assertion is invalid");
  }
  claimIds.add(assertion.assertionId);
}

function sameLocators(left: readonly Locator[], right: readonly Locator[]): boolean {
  if (new Set(left.map(({ turnId }) => turnId)).size !== left.length ||
    new Set(right.map(({ turnId }) => turnId)).size !== right.length) {return false;}
  const ordered = (values: readonly Locator[]) => values.map(normalizeLocator)
    .toSorted((a, b) => a.turnId.localeCompare(b.turnId));
  return canonicalIntegerJson(ordered(left)) === canonicalIntegerJson(ordered(right));
}

function freezePrivateJson(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {freezePrivateJson(child);}
    Object.freeze(value);
  }
  return value;
}

function normalizeLocator(locator: Locator) {
  return {
    endMs: locator.endMs,
    speakerId: locator.speakerId,
    startMs: locator.startMs,
    turnId: locator.turnId,
  };
}

function countQuestions(cases: readonly DatasetCase[]) {
  return Object.freeze({
    abstention: cases.filter(({ disposition }) => disposition === "abstain").length,
    answerable: cases.filter(({ disposition }) => disposition === "answer").length,
    locales: Object.freeze({
      en: cases.filter(({ language }) => language === "en").length,
      ru: cases.filter(({ language }) => language === "ru").length,
    }),
    questions: cases.length,
  });
}

function requireCanonicalFraming(bytes: Uint8Array, value: unknown, kind: string): void {
  const expected = new TextEncoder().encode(`${canonicalIntegerJson(value)}\n`);
  if (bytes.length !== expected.length ||
    bytes.some((byte, index) => byte !== expected[index])) {
    throw new Error(`semantic quality V4 human ${kind} canonical framing is invalid`);
  }
}

function parsePrivateJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("semantic quality V4 human private JSON is invalid");
  }
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = requiredRecord(value, keys);
  if (canonicalIntegerJson(Object.keys(record).toSorted()) !==
    canonicalIntegerJson([...keys].toSorted())) {
    throw new Error("semantic quality V4 human private object shape is invalid");
  }
  return record;
}

function requiredRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("semantic quality V4 human private object shape is invalid");
  }
  return value as Record<string, unknown>;
}

function validInterval(start: unknown, end: unknown): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    (start as number) >= 0 && (end as number) > (start as number);
}
