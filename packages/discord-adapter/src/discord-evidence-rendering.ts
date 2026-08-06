import { escapeDiscordMarkdown } from "./discord-markdown-formatting.js";

interface DiscordEvidenceTurn {
  readonly endMs: number;
  readonly startMs: number;
  readonly text: string;
  readonly turnId: string;
}

interface EvidenceExcerpt {
  readonly omittedAfter: boolean;
  readonly omittedBefore: boolean;
  readonly text: string;
}

interface EvidenceWindow {
  readonly end: number;
  readonly score: number;
  readonly start: number;
}

interface IndexedWord {
  readonly end: number;
  readonly normalized: string;
  readonly start: number;
}

const maximumEvidenceQuoteGraphemes = 180;
const maximumContextGapMs = 30_000;
const evidenceStopWords = new Set([
  "and", "are", "for", "from", "that", "the", "this", "to", "with",
  "без", "будет", "для", "его", "как", "который", "надо", "она", "они",
  "это", "что", "чтобы",
]);

export function contextualDiscordEvidenceTurnIds(
  evidenceTurnIds: readonly string[],
  evidence: ReadonlyMap<string, DiscordEvidenceTurn>,
): readonly string[] {
  if (evidenceTurnIds.length !== 1) {
    return evidenceTurnIds;
  }
  const selectedTurn = evidence.get(evidenceTurnIds[0] ?? "");
  if (selectedTurn === undefined || !isContextDependentReply(selectedTurn.text)) {
    return evidenceTurnIds;
  }
  const orderedTurns = [...evidence.values()].toSorted(compareTranscriptTurns);
  const selectedIndex = orderedTurns.findIndex(
    ({ turnId }) => turnId === selectedTurn.turnId,
  );
  const previousTurn = orderedTurns[selectedIndex - 1];
  if (
    previousTurn === undefined ||
    selectedTurn.startMs - previousTurn.endMs > maximumContextGapMs
  ) {
    return evidenceTurnIds;
  }
  return [previousTurn.turnId, ...evidenceTurnIds];
}

export function renderDiscordEvidenceQuote(value: string, claimText: string): string {
  const normalized = value.trim().replaceAll(/\s+/gu, " ");
  const excerpt = relevantEvidenceExcerpt(normalized, claimText);
  const escaped = escapeDiscordMarkdown(excerpt.text);
  const prefix = excerpt.omittedBefore ? "…" : "";
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(escaped),
    (segment) => segment.segment,
  );
  const suffix = excerpt.omittedAfter ||
    graphemes.length > maximumEvidenceQuoteGraphemes - prefix.length
    ? "…"
    : "";
  const budget = maximumEvidenceQuoteGraphemes - prefix.length - suffix.length;
  const bounded = graphemes.length <= budget
    ? escaped
    : graphemes.slice(0, Math.max(0, budget)).join("");
  return `${prefix}${bounded}${suffix}`;
}

function isContextDependentReply(value: string): boolean {
  const words = value.trim().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length > 6) {
    return false;
  }
  return /^(?:ну\s+)?(?:да|ага|угу|ок(?:ей)?|хорошо|соглас(?:ен|на|ны)|я\s+думаю\s+можем|думаю\s+можем|можем|давайте|сделаем|так|авжеж|добре|домовились|можемо|yes|yeah|yep|ok(?:ay)?|agreed|sounds\s+good|we\s+can|let'?s\s+do\s+it)(?=$|[\s,.;:!?])/iu.test(
    value.trim(),
  );
}

function compareTranscriptTurns(
  left: DiscordEvidenceTurn,
  right: DiscordEvidenceTurn,
): number {
  return left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.turnId.localeCompare(right.turnId);
}

function relevantEvidenceExcerpt(value: string, claimText: string): EvidenceExcerpt {
  const claimWords = significantClaimWords(claimText);
  if (value.length <= maximumEvidenceQuoteGraphemes || claimWords.size === 0) {
    return fullEvidenceExcerpt(value);
  }
  const best = selectBestWindow(indexedWords(value), claimWords);
  if (best === undefined || best.score === 0) {
    return fullEvidenceExcerpt(value);
  }
  return {
    omittedAfter: best.end < value.length,
    omittedBefore: best.start > 0,
    text: value.slice(best.start, best.end).trim(),
  };
}

function significantClaimWords(value: string): ReadonlySet<string> {
  return new Set(
    indexedWords(value)
      .map(({ normalized }) => normalized)
      .filter((word) => word.length >= 3 && !evidenceStopWords.has(word)),
  );
}

function fullEvidenceExcerpt(value: string): EvidenceExcerpt {
  return {
    omittedAfter: value.length > maximumEvidenceQuoteGraphemes,
    omittedBefore: false,
    text: value,
  };
}

function selectBestWindow(
  sourceWords: readonly IndexedWord[],
  claimWords: ReadonlySet<string>,
): EvidenceWindow | undefined {
  let best: EvidenceWindow | undefined;
  for (let anchor = 0; anchor < sourceWords.length; anchor += 1) {
    if (!claimWords.has(sourceWords[anchor]?.normalized ?? "")) {
      continue;
    }
    const candidate = evidenceWindow(sourceWords, claimWords, anchor);
    if (isBetterWindow(candidate, best)) {
      best = candidate;
    }
  }
  return best;
}

function evidenceWindow(
  sourceWords: readonly IndexedWord[],
  claimWords: ReadonlySet<string>,
  anchor: number,
): EvidenceWindow {
  const startWord = Math.max(0, anchor - 7);
  const start = sourceWords[startWord]?.start ?? 0;
  let end = sourceWords[anchor]?.end ?? start;
  let score = 0;
  const matched = new Set<string>();
  for (let index = startWord; index < sourceWords.length; index += 1) {
    const word = sourceWords[index];
    if (word === undefined || word.end - start > maximumEvidenceQuoteGraphemes - 2) {
      break;
    }
    end = word.end;
    if (claimWords.has(word.normalized) && !matched.has(word.normalized)) {
      matched.add(word.normalized);
      score += Math.min(word.normalized.length, 16);
    }
  }
  return { end, score, start };
}

function isBetterWindow(
  candidate: EvidenceWindow,
  current: EvidenceWindow | undefined,
): boolean {
  return current === undefined ||
    candidate.score > current.score ||
    (candidate.score === current.score && candidate.start < current.start);
}

function indexedWords(value: string): readonly IndexedWord[] {
  const words: IndexedWord[] = [];
  for (const match of value.matchAll(/[\p{L}\p{N}_?=.-]+/gu)) {
    const token = match[0];
    const start = match.index;
    words.push({
      end: start + token.length,
      normalized: token.toLocaleLowerCase(),
      start,
    });
  }
  return words;
}
