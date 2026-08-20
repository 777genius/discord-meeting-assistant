export interface SpeakerAliasMapV1 {
  readonly [speakerId: string]: readonly string[];
}

export interface RequestedSpeakerAliasV1 {
  readonly matchedAlias: string;
  readonly speakerId: string;
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
      !hasConflictingOwner(candidate, candidates)
    ) {
      selected.set(candidate.speakerId, Object.freeze({
        matchedAlias: candidate.matchedAlias,
        speakerId: candidate.speakerId,
      }));
    }
  }
  return Object.freeze([...selected.values()]);
}

function matchAlias(question: string, alias: string): AliasQuestionSpan | undefined {
  const aliasTokens = orderedTokens(alias);
  const span = contiguousAliasSpan(question, aliasTokens);
  return span !== undefined && aliasTokens.length > 0 &&
      aliasMentionIsUnambiguous(question, span.text, aliasTokens)
    ? span
    : undefined;
}

function hasConflictingOwner(
  candidate: AliasCandidate,
  candidates: readonly AliasCandidate[],
): boolean {
  return candidates.some((other) =>
    other.speakerId !== candidate.speakerId &&
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
