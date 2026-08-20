import { normalizeHistoricalQuestion } from "../domain/grounding-mode.js";
import type {
  HistoricalCandidateLocatorV1,
  HistoricalMemoryPort,
  LocallyRehydratedEvidenceBlockV1,
} from "./ports/historical-memory.js";
export {
  resolveRequestedSpeakerIds,
  type SpeakerAliasMapV1,
} from "./speaker-alias-resolution.js";

interface HistoricalRerankBounds {
  readonly maximumEvidenceBytes: number;
  readonly minimumProviderScore: number;
  readonly neighborRadius: number;
  readonly rerankLimit: number;
}

const minimumQualifiedScore = 0.2;
const ignoredQueryTokens = new Set([
  "about", "and", "are", "did", "do", "does", "for", "from", "how", "is",
  "the", "that", "this", "was", "were", "what", "when", "where", "which",
  "who", "why", "with",
  "был", "была", "были", "для", "как", "когда", "кто", "почему", "что",
]);

export interface RankedHistoricalBlockV1 {
  readonly block: LocallyRehydratedEvidenceBlockV1;
  readonly lexicalScore: number;
  readonly providerRank: number | null;
  readonly providerScore: number | null;
  readonly qualifiedScore: number;
}

export function decomposeHistoricalQuery(
  question: string,
  limit: number,
): readonly string[] {
  const normalized = normalizeHistoricalQuestion(question);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return Object.freeze([]);
  }
  if (limit === 1) {
    return Object.freeze([normalized]);
  }
  const clauses = normalized
    .split(/[?;.!]+|\s+(?:and|then|also|but|и|затем|также|но)\s+/iu)
    .map((value) => value.trim())
    .filter((value) => value.length >= 3);
  // Keep the complete question even when clause expansion reaches the bound,
  // so omitted clauses still contribute to retrieval and abstention.
  const candidates = clauses.length > 1 ? [normalized, ...clauses] : [normalized];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.toLocaleLowerCase("und");
    if (!seen.has(key)) {
      seen.add(key);
      output.push(candidate);
    }
    if (output.length >= limit) {
      break;
    }
  }
  return Object.freeze(output);
}

export function isRequestedMeeting(
  meetingId: string,
  input: {
    readonly currentMeetingId?: string;
    readonly sourceSet: "current" | "historical" | "room";
  },
): boolean {
  if (input.sourceSet === "room") {
    return true;
  }
  return input.sourceSet === "current"
    ? input.currentMeetingId !== undefined && meetingId === input.currentMeetingId
    : input.currentMeetingId === undefined || meetingId !== input.currentMeetingId;
}

export function mergeQualifiedHistoricalSearchResults(
  results: readonly Awaited<ReturnType<HistoricalMemoryPort["searchRoom"]>>[],
): { readonly candidates: readonly HistoricalCandidateLocatorV1[] } | null {
  const available = results.filter((result) => result.status === "available");
  if (
    available.length !== results.length ||
    available.some((result) => !result.hybridQualified)
  ) {
    return null;
  }
  const deduplicated = new Map<string, {
    readonly providerRank: number;
    readonly providerScore: number;
  }>();
  for (const result of available) {
    for (const candidate of result.candidates) {
      const prior = deduplicated.get(candidate.locator);
      deduplicated.set(candidate.locator, prior === undefined
        ? {
            providerRank: candidate.providerRank,
            providerScore: candidate.providerScore,
          }
        : {
            providerRank: Math.min(prior.providerRank, candidate.providerRank),
            providerScore: Math.max(prior.providerScore, candidate.providerScore),
          });
    }
  }
  return Object.freeze({
    candidates: Object.freeze(
      [...deduplicated].map(([locator, signals]) => ({ locator, ...signals })),
    ),
  });
}

export function rerankHistoricalBlocks(
  blocks: readonly LocallyRehydratedEvidenceBlockV1[],
  queries: readonly string[],
  candidates: readonly HistoricalCandidateLocatorV1[],
  bounds: HistoricalRerankBounds,
  requestedSpeakerIds: ReadonlySet<string> = new Set<string>(),
): readonly RankedHistoricalBlockV1[] {
  const queryTokens = relevantQueryTokens(queries);
  const providerSignals = new Map(
    candidates.map(({ locator, providerRank, providerScore }) => [
      locator,
      { providerRank, providerScore },
    ]),
  );
  const scored = blocks.map((block): RankedHistoricalBlockV1 => {
    const lexical = lexicalScore(block, queryTokens);
    const provider = providerSignals.get(block.candidateLocator);
    const normalizedProviderScore = provider === undefined
      ? 0
      : normalizeProviderScore(provider.providerScore);
    const speaker = speakerScore(block, queryTokens, requestedSpeakerIds);
    const temporal = temporalScore(block, blocks, queries);
    return Object.freeze({
      block,
      lexicalScore: lexical,
      providerRank: provider?.providerRank ?? null,
      providerScore: provider?.providerScore ?? null,
      qualifiedScore: Math.min(1, lexical * 0.6 +
        normalizedProviderScore * 0.25 + speaker * 0.1 + temporal * 0.02 +
        (provider === undefined ? 0 : 0.03 / (1 + provider.providerRank))),
    });
  });
  const primary = scored.filter(({
    lexicalScore: lexical,
    providerScore,
    qualifiedScore,
  }) =>
    qualifiedScore >= minimumQualifiedScore &&
    (lexical > 0 ||
      (providerScore !== null && providerScore >= bounds.minimumProviderScore))
  );
  const ranked = scored.map((item): RankedHistoricalBlockV1 | null => {
    if (primary.some(({ block }) =>
      block.candidateLocator === item.block.candidateLocator
    )) {
      return item;
    }
    const neighbor = primary
      .filter(({ block }) =>
        block.binding.releaseId === item.block.binding.releaseId &&
        Math.abs(block.ordinal - item.block.ordinal) <= bounds.neighborRadius
      )
      .toSorted((left, right) =>
        Math.abs(left.block.ordinal - item.block.ordinal) -
          Math.abs(right.block.ordinal - item.block.ordinal) ||
        right.qualifiedScore - left.qualifiedScore
      )[0];
    if (neighbor === undefined) {
      return null;
    }
    const distance = Math.abs(neighbor.block.ordinal - item.block.ordinal);
    return Object.freeze({
      ...item,
      qualifiedScore: neighbor.qualifiedScore * 0.5 / Math.max(1, distance),
    });
  }).filter((item): item is RankedHistoricalBlockV1 => item !== null)
    .toSorted((left, right) =>
    right.qualifiedScore - left.qualifiedScore ||
    left.block.binding.desiredGeneration - right.block.binding.desiredGeneration ||
    compareOpaque(left.block.candidateLocator, right.block.candidateLocator)
  );
  const selected: RankedHistoricalBlockV1[] = [];
  let bytes = 0;
  for (const rankedBlock of ranked) {
    const { block } = rankedBlock;
    const nextBytes = blockBytes(block);
    if (
      selected.length < bounds.rerankLimit &&
      bytes + nextBytes <= bounds.maximumEvidenceBytes
    ) {
      selected.push(rankedBlock);
      bytes += nextBytes;
    }
  }
  return Object.freeze(selected);
}

function normalizeProviderScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  if (score >= 0 && score <= 1) {
    return score;
  }
  return score > 1 ? score / (1 + score) : 0;
}

export function retainStrictSourceSubsets(
  blocks: readonly LocallyRehydratedEvidenceBlockV1[],
  authoritativeLocators: ReadonlyMap<string, ReadonlySet<string>>,
): readonly LocallyRehydratedEvidenceBlockV1[] {
  const selectedLocators = new Map<string, Set<string>>();
  for (const block of blocks) {
    const key = historicalSourceKey(block.binding);
    const locators = selectedLocators.get(key) ?? new Set<string>();
    locators.add(block.candidateLocator);
    selectedLocators.set(key, locators);
  }
  const lastLocatorForCompleteSource = new Map<string, string>();
  for (const block of blocks) {
    const key = historicalSourceKey(block.binding);
    const selected = selectedLocators.get(key);
    const authoritative = authoritativeLocators.get(key);
    if (selected !== undefined && authoritative !== undefined &&
      selected.size === authoritative.size &&
      [...authoritative].every((locator) => selected.has(locator))) {
      lastLocatorForCompleteSource.set(key, block.candidateLocator);
    }
  }
  return Object.freeze(blocks.filter((block) =>
    lastLocatorForCompleteSource.get(historicalSourceKey(block.binding)) !==
      block.candidateLocator
  ));
}

export function historicalSourceKey(binding: {
  readonly meetingId: string;
  readonly transcriptId: string;
  readonly transcriptVersion: number;
}): string {
  return `${binding.meetingId}\u0000${binding.transcriptId}\u0000${binding.transcriptVersion}`;
}

function tokens(value: string): ReadonlySet<string> {
  return new Set(
    value.normalize("NFKC").toLocaleLowerCase("und").match(/[\p{L}\p{N}]{2,}/gu) ?? [],
  );
}

function relevantQueryTokens(queries: readonly string[]): ReadonlySet<string> {
  return new Set([...tokens(queries.join(" "))].filter((token) =>
    !ignoredQueryTokens.has(token)
  ));
}

function blockBytes(block: LocallyRehydratedEvidenceBlockV1): number {
  return new TextEncoder().encode(
    block.turns.map(({ text }) => text).join("\n"),
  ).byteLength;
}

function lexicalScore(
  block: LocallyRehydratedEvidenceBlockV1,
  queryTokens: ReadonlySet<string>,
): number {
  const evidenceTokens = tokens(block.turns.map(({ text }) => text).join(" "));
  let matches = 0;
  for (const token of queryTokens) {
    if (evidenceTokens.has(token)) {
      matches += 1;
    }
  }
  return queryTokens.size === 0 ? 0 : matches / queryTokens.size;
}

function speakerScore(
  block: LocallyRehydratedEvidenceBlockV1,
  queryTokens: ReadonlySet<string>,
  requestedSpeakerIds: ReadonlySet<string>,
): number {
  if (block.turns.some(({ speakerId }) => requestedSpeakerIds.has(speakerId))) {
    return 1;
  }
  const speakerTokens = tokens(block.turns.map(({ speakerId }) => speakerId).join(" "));
  return [...queryTokens].some((token) => speakerTokens.has(token)) ? 1 : 0;
}

function temporalScore(
  block: LocallyRehydratedEvidenceBlockV1,
  blocks: readonly LocallyRehydratedEvidenceBlockV1[],
  queries: readonly string[],
): number {
  if (new Set(blocks.map(({ binding }) => binding.releaseId)).size > 1) {
    return 0;
  }
  const question = queries.join(" ").toLocaleLowerCase("und");
  const wantsStart = /\b(?:beginning|early|earlier|first|initial|start)\b|(?:вначал|начал|перв|раньш)/iu
    .test(question);
  const wantsEnd = /\b(?:end|final|last|late|latest|recent)\b|(?:в\s+конце|итог|конеч|послед|поздн)/iu
    .test(question);
  if (wantsStart === wantsEnd) {
    return 0;
  }
  let minimum = Number.MAX_SAFE_INTEGER;
  let maximum = 0;
  for (const candidate of blocks) {
    for (const { startMs } of candidate.turns) {
      minimum = Math.min(minimum, startMs);
      maximum = Math.max(maximum, startMs);
    }
  }
  if (minimum === Number.MAX_SAFE_INTEGER) {
    minimum = 0;
  }
  const start = block.turns[0]?.startMs ?? minimum;
  const position = maximum === minimum ? 1 : (start - minimum) / (maximum - minimum);
  return wantsEnd ? position : 1 - position;
}

function compareOpaque(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
