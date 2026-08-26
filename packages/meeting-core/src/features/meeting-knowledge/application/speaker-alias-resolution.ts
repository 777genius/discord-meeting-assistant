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

export interface RequestedSpeakerAliasV1 {
  readonly matchedAlias: string;
  readonly speakerId: string;
}

export interface RequestedRetrievalActorAliasV1 {
  readonly actorKeys: readonly string[];
  readonly matchedAlias: string;
}

interface AliasQuestionSpan {
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

const ambiguousEnglishAliasTokens = new Set([
  "bill", "mark", "may", "will",
]);

export function resolveRequestedSpeakerIds(
  question: string,
  aliases: SpeakerAliasMapV1 = {},
): ReadonlySet<string> {
  return new Set(resolveRequestedSpeakerAliases(question, aliases).map(
    ({ speakerId }) => speakerId,
  ));
}

export function resolveRequestedSpeakerAliases(
  question: string,
  aliases: SpeakerAliasMapV1 = {},
): readonly RequestedSpeakerAliasV1[] {
  const candidates: AliasCandidate[] = [];
  for (const [speakerId, values] of Object.entries(aliases)) {
    for (const alias of values) {
      const match = matchAlias(question, alias);
      if (match !== undefined) {
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
): ReadonlySet<string> {
  return new Set(resolveRequestedActorAliases(question, aliases).flatMap(
    ({ actorKeys }) => actorKeys,
  ));
}

export function resolveRequestedActorAliases(
  question: string,
  aliases: readonly RetrievalActorAliasOwnerV1[] = [],
): readonly RequestedRetrievalActorAliasV1[] {
  const candidates: RetrievalAliasCandidate[] = [];
  for (const [ownerIndex, owner] of aliases.entries()) {
    for (const alias of owner.aliases) {
      const match = matchAlias(question, alias);
      if (match !== undefined) {
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
): boolean {
  const candidates: RetrievalAliasCandidate[] = [];
  for (const [ownerIndex, owner] of aliases.entries()) {
    for (const alias of owner.aliases) {
      const match = matchAlias(question, alias);
      if (match !== undefined) {
        candidates.push(Object.freeze({ actorKeys: owner.actorKeys,
          end: match.end, matchedAlias: match.text, ownerIndex, start: match.start }));
      }
    }
  }
  return candidates.some((candidate) =>
    hasConflictingRetrievalOwner(candidate, candidates));
}

function matchAlias(question: string, alias: string): AliasQuestionSpan | undefined {
  const aliasTokens = orderedTokens(alias);
  const span = contiguousAliasSpan(question, aliasTokens);
  return span !== undefined && aliasTokens.length > 0 &&
      aliasMentionIsUnambiguous(question, span.text, aliasTokens)
    ? span
    : undefined;
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

function contiguousAliasSpan(
  question: string,
  aliasTokens: readonly string[],
): AliasQuestionSpan | undefined {
  if (aliasTokens.length === 0) {
    return undefined;
  }
  const pattern = aliasTokens.map(escapeRegExp).join("[^\\p{L}\\p{N}]+");
  const match = new RegExp(
    `(?<![\\p{L}\\p{N}])(${pattern})(?![\\p{L}\\p{N}])`,
    "iu",
  ).exec(question);
  const text = match?.[1];
  if (text === undefined || match === null) {
    return undefined;
  }
  return Object.freeze({
    end: match.index + text.length,
    start: match.index,
    text,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function orderedTokens(value: string): readonly string[] {
  return Object.freeze(
    value.normalize("NFKC").toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}
