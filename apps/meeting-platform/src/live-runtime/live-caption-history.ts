import type { LiveCaptionSnapshot } from "./contracts.js";

const maximumRetainedFinalCaptions = 4_096;
const retainedOpeningFinalCaptions = 64;

/**
 * Bounds the derived live-caption cache without reverting it to a short-lived
 * "now speaking" buffer. The opening gives a reader orientation, while the
 * remaining slots are one contiguous newest chronological tail. The final
 * Publication adapters later use the authoritative persisted transcript.
 */
export function boundLiveFinalCaptionHistory(
  captions: Map<string, LiveCaptionSnapshot>,
): void {
  if (captions.size <= maximumRetainedFinalCaptions) {
    return;
  }

  const ordered = [...captions.entries()].toSorted(compareCaptionEntries);
  const openingCount = Math.min(
    retainedOpeningFinalCaptions,
    maximumRetainedFinalCaptions - 1,
  );
  const tailCount = maximumRetainedFinalCaptions - openingCount;
  const retainedIds = new Set([
    ...ordered.slice(0, openingCount).map(([turnId]) => turnId),
    ...ordered.slice(-tailCount).map(([turnId]) => turnId),
  ]);

  for (const turnId of captions.keys()) {
    if (!retainedIds.has(turnId)) {
      captions.delete(turnId);
    }
  }
}

export function compareLiveCaptionSnapshots(
  left: LiveCaptionSnapshot,
  right: LiveCaptionSnapshot,
): number {
  return left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.speakerId.localeCompare(right.speakerId) ||
    left.text.localeCompare(right.text) ||
    Number(left.isFinal) - Number(right.isFinal);
}

function compareCaptionEntries(
  [leftTurnId, left]: readonly [string, LiveCaptionSnapshot],
  [rightTurnId, right]: readonly [string, LiveCaptionSnapshot],
): number {
  return compareLiveCaptionSnapshots(left, right) || leftTurnId.localeCompare(rightTurnId);
}
