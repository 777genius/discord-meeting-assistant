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

/**
 * Consumer-owned deterministic deny/ambiguity port implemented at the identity
 * adapter boundary. A skeleton collision is never positive identity authority;
 * only equal canonical tokens that are both certain may resolve an alias.
 */
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
const identityWordAuthorityCharacter = /[\p{L}\p{N}]/u;
const identityUnsafeCandidateCharacter =
  /(?:\p{Default_Ignorable_Code_Point}|\p{Bidi_Control}|\p{Join_Control}|\p{Cf}|\p{Cc}|[\uFFF0-\uFFF8]|[\u{E0000}-\u{E0FFF}])/u;
const literalModifierCharacter = /(?:\p{M}|\p{Emoji_Modifier})/u;
const safeLiteralBoundaryCharacter = /[\p{White_Space}\p{P}]/u;

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
    identityAliasSpans(question, alias, skeletons).some(
      ({ certainty }) => certainty === "uncertain",
    )
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
    return literalAliasSpans(
      canonicalQuestion,
      canonicalIdentityText(alias),
      skeletons,
    );
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
    const spanIdentity = skeletons?.skeleton(text);
    spans.push(Object.freeze({
      certainty: comparisons.includes("uncertain") ||
        spanIdentity?.certainty === "uncertain" ? "uncertain" : "certain",
      end: last.end,
      start: first.start,
      text,
    }));
  }
  spans.push(...compactedUncertainAliasSpans(
    canonicalQuestion, questionTokens, aliasTokens, skeletons,
  ));
  return Object.freeze(spans.filter((span, index) => spans.findIndex((other) =>
    other.start === span.start && other.end === span.end &&
    other.certainty === span.certainty
  ) === index));
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
  skeletons?: IdentitySkeletonPortV1,
): readonly AliasQuestionSpan[] {
  if (alias.length === 0) {
    return Object.freeze([]);
  }
  const spans: AliasQuestionSpan[] = [];
  const aliasIdentity = skeletons?.skeleton(alias);
  for (let start = question.indexOf(alias); start >= 0;
    start = question.indexOf(alias, start + 1)) {
    const exactEnd = start + alias.length;
    const prefix = codePointBefore(question, start);
    const suffix = codePointAt(question, exactEnd);
    const unsafePrefix = literalAttachmentIsUnsafe(prefix?.text, skeletons);
    const unsafeSuffix = literalAttachmentIsUnsafe(suffix?.text, skeletons);
    const safeBoundaries = literalBoundaryIsSafe(prefix?.text, alias) &&
      literalBoundaryIsSafe(suffix?.text, alias);
    if (![unsafePrefix, unsafeSuffix, safeBoundaries].includes(true)) {
      continue;
    }
    const spanStart = unsafePrefix ? prefix?.start ?? start : start;
    const spanEnd = unsafeSuffix ? suffix?.end ?? exactEnd : exactEnd;
    const text = question.slice(spanStart, spanEnd);
    const uncertain = [aliasIdentity?.certainty === "uncertain", unsafePrefix,
      unsafeSuffix].includes(true);
    spans.push(Object.freeze({
      certainty: uncertain ? "uncertain" as const : "certain" as const,
      end: spanEnd,
      start: spanStart,
      text,
    }));
  }
  return Object.freeze(spans);
}

function compactedUncertainAliasSpans(
  question: string,
  questionTokens: readonly IdentityToken[],
  aliasTokens: readonly IdentityToken[],
  skeletons?: IdentitySkeletonPortV1,
): readonly AliasQuestionSpan[] {
  if (skeletons === undefined) {
    return Object.freeze([]);
  }
  const expected = aliasTokens.map(({ skeleton }) => skeleton).join("");
  const maximum = Array.from(aliasTokens.map(({ canonical }) => canonical).join("")).length;
  const spans: AliasQuestionSpan[] = [];
  for (let start = 0; start < questionTokens.length; start += 1) {
    for (let end = start + 1;
      end <= Math.min(questionTokens.length, start + maximum); end += 1) {
      const window = questionTokens.slice(start, end);
      const first = window[0];
      const last = window.at(-1);
      if (first !== undefined && last !== undefined &&
        window.map(({ skeleton }) => skeleton).join("") === expected) {
        const text = question.slice(first.start, last.end);
        if (skeletons.skeleton(text).certainty === "uncertain") {
          spans.push(Object.freeze({ certainty: "uncertain", end: last.end,
            start: first.start, text }));
        }
      }
    }
  }
  return Object.freeze(spans);
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
  return Object.freeze([...value.matchAll(
    /[\p{L}\p{N}\p{M}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Join_Control}\p{Cf}\p{Cc}\uFFF0-\uFFF8\u{E0000}-\u{E0FFF}]+/gu,
  )].flatMap((match) => {
    const text = match[0];
    if (identityWordAuthorityCharacter.test(text)) {
      const identity = skeletons?.skeleton(text) ?? Object.freeze({
        canonical: canonicalIdentityText(text),
        certainty: "certain" as const,
        skeleton: canonicalIdentityText(text),
      });
      return [Object.freeze({ ...identity, end: match.index + text.length,
        start: match.index, text })];
    }
    return [];
  }));
}

function literalAttachmentIsUnsafe(
  character: string | undefined,
  skeletons?: IdentitySkeletonPortV1,
): boolean {
  return character !== undefined && (literalModifierCharacter.test(character) ||
    identityUnsafeCandidateCharacter.test(character) ||
    skeletons?.skeleton(character).certainty === "uncertain");
}

function literalBoundaryIsSafe(
  character: string | undefined,
  alias: string,
): boolean {
  return character === undefined ||
    (safeLiteralBoundaryCharacter.test(character) && !alias.includes(character));
}

function codePointAt(
  value: string,
  start: number,
): { readonly end: number; readonly text: string } | undefined {
  const codePoint = value.codePointAt(start);
  if (codePoint === undefined) {
    return undefined;
  }
  const text = String.fromCodePoint(codePoint);
  return { end: start + text.length, text };
}

function codePointBefore(
  value: string,
  end: number,
): { readonly start: number; readonly text: string } | undefined {
  if (end <= 0) {
    return undefined;
  }
  const last = value.charCodeAt(end - 1);
  const start = last >= 0xDC00 && last <= 0xDFFF && end > 1 ? end - 2 : end - 1;
  return { start, text: value.slice(start, end) };
}

function compareIdentityToken(
  question: IdentityToken,
  alias: IdentityToken | undefined,
): "certain" | "different" | "uncertain" {
  if (alias === undefined) {
    return "different";
  }
  if (question.canonical === alias.canonical) {
    return question.certainty === "certain" && alias.certainty === "certain"
      ? "certain"
      : "uncertain";
  }
  if (question.skeleton !== alias.skeleton) {
    return "different";
  }
  return "uncertain";
}

function canonicalIdentityText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}
