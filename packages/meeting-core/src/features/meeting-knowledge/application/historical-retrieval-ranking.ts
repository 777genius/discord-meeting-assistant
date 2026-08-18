import { normalizeHistoricalQuestion } from "../domain/grounding-mode.js";
import type {
  HistoricalCandidateLocatorV1,
  HistoricalMemoryPort,
  LocallyRehydratedEvidenceBlockV1,
} from "./ports/historical-memory.js";

interface HistoricalRerankBounds {
  readonly maximumEvidenceBytes: number;
  readonly minimumProviderScore: number;
  readonly neighborRadius: number;
  readonly rerankLimit: number;
}

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
  const candidates = [
    normalized,
    ...normalized.split(/[?;.!]+|\s+(?:and|then|also|и|затем|также)\s+/iu),
  ].map((value) => value.trim()).filter((value) => value.length >= 3);
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
): readonly RankedHistoricalBlockV1[] {
  const queryTokens = tokens(queries.join(" "));
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
      : Math.max(0, Math.min(1, provider.providerScore));
    return Object.freeze({
      block,
      lexicalScore: lexical,
      providerRank: provider?.providerRank ?? null,
      providerScore: provider?.providerScore ?? null,
      qualifiedScore: lexical * 0.7 + normalizedProviderScore * 0.25 +
        (provider === undefined ? 0 : 0.05 / (1 + provider.providerRank)),
    });
  });
  const primary = scored.filter(({ lexicalScore: lexical, providerScore }) =>
    lexical > 0 ||
    (providerScore !== null && providerScore >= bounds.minimumProviderScore)
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

function compareOpaque(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
