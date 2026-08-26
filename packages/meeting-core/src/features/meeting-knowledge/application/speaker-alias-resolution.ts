export interface SpeakerAliasMapV1 {
  readonly [speakerId: string]: readonly string[];
}

export interface RetrievalActorAliasOwnerV1 {
  readonly actorKeys: readonly string[];
  readonly aliases: readonly string[];
}

export interface RetrievalActorReferenceAuthorityV1 {
  readonly actorKeysForQuestion: (question: string) => readonly string[];
}

export interface IdentitySkeletonV1 {
  readonly canonical: string;
  readonly certainty: "certain" | "uncertain";
  readonly skeleton: string;
}

/** Consumer-owned deterministic port implemented at the Discord boundary. */
export interface IdentitySkeletonPortV1 {
  readonly skeleton: (value: string) => IdentitySkeletonV1;
}

export interface RequestedSpeakerAliasV1 {
  readonly matchedAlias: string;
  readonly speakerId: string;
}

export interface RequestedRetrievalActorAliasV1 {
  readonly actorKeys: readonly string[];
  readonly matchedAlias: string;
}

interface AliasQuestionSpan {
  readonly certainty: "certain" | "uncertain";
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

interface AliasCandidate extends RequestedSpeakerAliasV1 {
  readonly end: number;
  readonly start: number;
}

interface RetrievalAliasCandidate extends RequestedRetrievalActorAliasV1 {
  readonly end: number;
  readonly ownerIndex: number;
  readonly start: number;
}

interface IdentityToken extends IdentitySkeletonV1 {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

const ambiguousEnglishAliasTokens = new Set([
  "bill", "mark", "may", "will",
]);

export function resolveRequestedSpeakerIds(
  question: string,
  aliases: SpeakerAliasMapV1 = {},
  skeletons?: IdentitySkeletonPortV1,
): ReadonlySet<string> {
  return new Set(resolveRequestedSpeakerAliases(question, aliases, skeletons).map(
    ({ speakerId }) => speakerId,
  ));
}

export function resolveRequestedSpeakerAliases(
  question: string,
  aliases: SpeakerAliasMapV1 = {},
  skeletons?: IdentitySkeletonPortV1,
): readonly RequestedSpeakerAliasV1[] {
  const candidates: AliasCandidate[] = [];
  for (const [speakerId, values] of Object.entries(aliases)) {
    for (const alias of values) {
      const match = matchAlias(question, alias, skeletons);
      if (match?.certainty === "certain") {
        candidates.push(Object.freeze({
          end: match.end,
          matchedAlias: match.text,
          speakerId,
          start: match.start,
        }));
      }
    }
  }
  const selected = new Map<string, RequestedSpeakerAliasV1>();
  for (const candidate of candidates) {
    if (
      !selected.has(candidate.speakerId) &&
      !hasConflictingSpeakerOwner(candidate, candidates)
    ) {
      selected.set(candidate.speakerId, Object.freeze({
        matchedAlias: candidate.matchedAlias,
        speakerId: candidate.speakerId,
      }));
    }
  }
  return Object.freeze([...selected.values()]);
}

export function resolveRequestedActorKeys(
  question: string,
  aliases: readonly RetrievalActorAliasOwnerV1[] = [],
  skeletons?: IdentitySkeletonPortV1,
): ReadonlySet<string> {
  return new Set(resolveRequestedActorAliases(question, aliases, skeletons).flatMap(
    ({ actorKeys }) => actorKeys,
  ));
}

export function resolveRequestedActorAliases(
  question: string,
  aliases: readonly RetrievalActorAliasOwnerV1[] = [],
  skeletons?: IdentitySkeletonPortV1,
): readonly RequestedRetrievalActorAliasV1[] {
  const candidates: RetrievalAliasCandidate[] = [];
  for (const [ownerIndex, owner] of aliases.entries()) {
    for (const alias of owner.aliases) {
      const match = matchAlias(question, alias, skeletons);
      if (match?.certainty === "certain") {
        candidates.push(Object.freeze({ actorKeys: owner.actorKeys,
          end: match.end, matchedAlias: match.text, ownerIndex, start: match.start }));
      }
    }
  }
  const selected = new Map<number, RequestedRetrievalActorAliasV1>();
  for (const candidate of candidates) {
    if (!selected.has(candidate.ownerIndex) &&
      !hasConflictingRetrievalOwner(candidate, candidates)) {
      selected.set(candidate.ownerIndex, Object.freeze({
        actorKeys: candidate.actorKeys, matchedAlias: candidate.matchedAlias,
      }));
    }
  }
  return Object.freeze([...selected.values()]);
}

export function hasAmbiguousRequestedActorAlias(
  question: string,
  aliases: readonly RetrievalActorAliasOwnerV1[] = [],
  skeletons?: IdentitySkeletonPortV1,
): boolean {
  const candidates: RetrievalAliasCandidate[] = [];
  for (const [ownerIndex, owner] of aliases.entries()) {
    for (const alias of owner.aliases) {
      const match = matchAlias(question, alias, skeletons);
      if (match?.certainty === "certain") {
        candidates.push(Object.freeze({ actorKeys: owner.actorKeys,
          end: match.end, matchedAlias: match.text, ownerIndex, start: match.start }));
      }
    }
  }
  return candidates.some((candidate) =>
    hasConflictingRetrievalOwner(candidate, candidates));
}

export function hasUncertainRequestedActorAlias(
  question: string,
  aliases: readonly RetrievalActorAliasOwnerV1[] = [],
  skeletons?: IdentitySkeletonPortV1,
): boolean {
  return aliases.some(({ aliases: values }) => values.some((alias) =>
    matchAlias(question, alias, skeletons)?.certainty === "uncertain"
  ));
}

export function identityAliasSpans(
  question: string,
  alias: string,
  skeletons?: IdentitySkeletonPortV1,
): readonly AliasQuestionSpan[] {
  const canonicalQuestion = canonicalIdentityText(question);
  const aliasTokens = identityTokens(canonicalIdentityText(alias), skeletons);
  if (aliasTokens.length === 0) {
    return literalAliasSpans(canonicalQuestion, canonicalIdentityText(alias));
  }
  const questionTokens = identityTokens(canonicalQuestion, skeletons);
  const spans: AliasQuestionSpan[] = [];
  for (let start = 0; start + aliasTokens.length <= questionTokens.length; start += 1) {
    const window = questionTokens.slice(start, start + aliasTokens.length);
    const comparisons = window.map((token, index) =>
      compareIdentityToken(token, aliasTokens[index]));
    if (comparisons.some((comparison) => comparison === "different")) {
      continue;
    }
    const first = window[0];
    const last = window.at(-1);
    if (first === undefined || last === undefined) {
      continue;
    }
    const text = canonicalQuestion.slice(first.start, last.end);
    if (!aliasMentionIsUnambiguous(canonicalQuestion, text,
      aliasTokens.map(({ canonical }) => canonical))) {
      continue;
    }
    spans.push(Object.freeze({
      certainty: comparisons.includes("uncertain") ? "uncertain" : "certain",
      end: last.end,
      start: first.start,
      text,
    }));
  }
  return Object.freeze(spans);
}

function matchAlias(
  question: string,
  alias: string,
  skeletons?: IdentitySkeletonPortV1,
): AliasQuestionSpan | undefined {
  return identityAliasSpans(question, alias, skeletons)[0];
}

function literalAliasSpans(
  question: string,
  alias: string,
): readonly AliasQuestionSpan[] {
  if (alias.length === 0) {
    return Object.freeze([]);
  }
  return Object.freeze([...question.matchAll(new RegExp(`(${escapeRegExp(alias)})`, "gu"))]
    .flatMap((match) => {
      const text = match[1];
      return text === undefined ? [] : [Object.freeze({
        certainty: "certain" as const,
        end: match.index + text.length,
        start: match.index,
        text,
      })];
    }));
}

function hasConflictingSpeakerOwner(
  candidate: AliasCandidate,
  candidates: readonly AliasCandidate[],
): boolean {
  return candidates.some((other) =>
    other.speakerId !== candidate.speakerId &&
    candidate.start < other.end && other.start < candidate.end
  );
}

function hasConflictingRetrievalOwner(
  candidate: RetrievalAliasCandidate,
  candidates: readonly RetrievalAliasCandidate[],
): boolean {
  return candidates.some((other) =>
    other.ownerIndex !== candidate.ownerIndex &&
    candidate.start < other.end && other.start < candidate.end
  );
}

function aliasMentionIsUnambiguous(
  question: string,
  alias: string,
  aliasTokens: readonly string[],
): boolean {
  if (aliasTokens.length !== 1) {
    return true;
  }
  const token = aliasTokens[0];
  if (token === undefined || !ambiguousEnglishAliasTokens.has(token)) {
    return true;
  }
  const escaped = escapeRegExp(alias.trim());
  return new RegExp(
    `(?:\\b(?:by|did|from|has|said)\\s+${escaped}\\b|\\b${escaped}\\s+(?:decided|proposed|said|suggested)\\b)`,
    "iu",
  ).test(question);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function identityTokens(
  value: string,
  skeletons?: IdentitySkeletonPortV1,
): readonly IdentityToken[] {
  return Object.freeze([...value.matchAll(/[\p{L}\p{N}\p{M}\p{Cf}]+/gu)]
    .flatMap((match) => {
      const text = match[0];
      if (!/[\p{L}\p{N}]/u.test(text)) {
        return [];
      }
      const identity = skeletons?.skeleton(text) ?? Object.freeze({
        canonical: canonicalIdentityText(text),
        certainty: "certain" as const,
        skeleton: canonicalIdentityText(text),
      });
      return [Object.freeze({ ...identity, end: match.index + text.length,
        start: match.index, text })];
    }));
}

function compareIdentityToken(
  question: IdentityToken,
  alias: IdentityToken | undefined,
): "certain" | "different" | "uncertain" {
  if (alias === undefined) {
    return "different";
  }
  if (question.canonical === alias.canonical) {
    return "certain";
  }
  if (question.skeleton !== alias.skeleton) {
    return "different";
  }
  return question.certainty === "certain" && alias.certainty === "certain"
    ? "certain"
    : "uncertain";
}

function canonicalIdentityText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}
