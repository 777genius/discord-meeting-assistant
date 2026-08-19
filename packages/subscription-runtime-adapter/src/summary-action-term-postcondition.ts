import type { TranscriptTurnSnapshot } from "@discord-meeting/meeting-core/transcription";

import type { ProviderMeetingSummary } from "./provider-summary-schema.js";

type ProviderActionItem = ProviderMeetingSummary["actionItems"][number];

const wordCharacter = /[\p{L}\p{N}_]/u;

/**
 * Finds compound vocabulary terms that a generated action may have shortened.
 * The source term must occur in an evidence-anchored, contiguous section spoken
 * by the action owner. Ambiguous prefixes, such as Quanta when both Quanta ID
 * and Quanta Pages are known, are deliberately ignored.
 */
export function findPotentiallyTruncatedActionTerms(
  actionItems: readonly ProviderActionItem[],
  transcriptTurns: readonly TranscriptTurnSnapshot[],
  vocabulary: readonly string[],
): readonly string[] {
  const orderedTurns = transcriptTurns.toSorted(compareTranscriptTurns);
  const vocabularyTerms = normalizedVocabulary(vocabulary);
  const uniqueExpansionByPrefix = new Map<string, string>();

  for (const prefix of vocabularyTerms) {
    const expansions = vocabularyTerms.filter((candidate) =>
      normalizedTerm(candidate).startsWith(`${normalizedTerm(prefix)} `),
    );
    if (expansions.length === 1) {
      uniqueExpansionByPrefix.set(prefix, expansions[0] ?? "");
    }
  }

  const candidates = new Set<string>();
  for (const actionItem of actionItems) {
    if (actionItem.ownerSpeakerId === null) {
      continue;
    }
    const ownerContext = evidenceAnchoredOwnerContext(actionItem, orderedTurns);
    if (ownerContext.length === 0) {
      continue;
    }
    for (const [prefix, expansion] of uniqueExpansionByPrefix) {
      if (
        containsTerm(actionItem.text, prefix) &&
        !containsTerm(actionItem.text, expansion) &&
        containsTerm(ownerContext, expansion)
      ) {
        candidates.add(expansion);
      }
    }
  }
  return vocabularyTerms.filter((term) => candidates.has(term));
}

function evidenceAnchoredOwnerContext(
  actionItem: ProviderActionItem,
  orderedTurns: readonly TranscriptTurnSnapshot[],
): string {
  const evidenceTurnIds = new Set(actionItem.evidenceTurnIds);
  const contextIndexes = new Set<number>();
  for (const [anchorIndex, turn] of orderedTurns.entries()) {
    if (!evidenceTurnIds.has(turn.turnId) || turn.speakerId !== actionItem.ownerSpeakerId) {
      continue;
    }
    contextIndexes.add(anchorIndex);
    for (const direction of [-1, 1] as const) {
      let candidateIndex = anchorIndex + direction;
      while (
        orderedTurns[candidateIndex]?.speakerId === actionItem.ownerSpeakerId
      ) {
        contextIndexes.add(candidateIndex);
        candidateIndex += direction;
      }
    }
  }
  return [...contextIndexes]
    .toSorted((left, right) => left - right)
    .map((index) => orderedTurns[index]?.text ?? "")
    .join("\n");
}

function normalizedVocabulary(vocabulary: readonly string[]): readonly string[] {
  const unique = new Map<string, string>();
  for (const rawTerm of vocabulary) {
    const term = rawTerm.trim().replace(/\s+/gu, " ");
    if (term.length > 0 && !unique.has(normalizedTerm(term))) {
      unique.set(normalizedTerm(term), term);
    }
  }
  return [...unique.values()];
}

function containsTerm(text: string, term: string): boolean {
  const normalizedText = normalizedTerm(text);
  const normalizedNeedle = normalizedTerm(term);
  let index = normalizedText.indexOf(normalizedNeedle);
  while (index >= 0) {
    const before = normalizedText[index - 1];
    const after = normalizedText[index + normalizedNeedle.length];
    if ((before === undefined || !wordCharacter.test(before)) &&
      (after === undefined || !wordCharacter.test(after))) {
      return true;
    }
    index = normalizedText.indexOf(normalizedNeedle, index + 1);
  }
  return false;
}

function normalizedTerm(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function compareTranscriptTurns(
  left: TranscriptTurnSnapshot,
  right: TranscriptTurnSnapshot,
): number {
  return left.startMs - right.startMs || left.endMs - right.endMs ||
    left.turnId.localeCompare(right.turnId);
}
