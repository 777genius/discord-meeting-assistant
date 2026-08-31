import type { FocusedHistoricalEvidenceV2Result } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";
import { expect } from "vitest";

import { currentMeetingId, currentMixedEvidenceText, historicalMeetingId,
  historicalMixedEvidenceText } from
  "./meeting-knowledge-production-composition-fixtures.js";

export function assertHistoricalSelection(
  selection: FocusedHistoricalEvidenceV2Result,
): void {
  // A failure prints only the closed diagnostic reason; candidate locators and
  // canonical text never cross this assertion boundary.
  expect(selection.status === "current" ? "current" :
    selection.status === "empty" ? "empty" : selection.reason)
    .toBe("current");
  if (selection.status === "current") {
    expect(selection.turns.some(({ source }) =>
      source?.meetingId === historicalMeetingId
    )).toBe(true);
  }
}

export function assertDirectMixedEvidence(
  observedEvidence: readonly (readonly string[])[],
): void {
  expect(observedEvidence).toHaveLength(1);
  expect(observedEvidence[0]).toEqual(expect.arrayContaining([
    expect.stringMatching(new RegExp(`^${currentMeetingId}:`, "u")),
    expect.stringMatching(new RegExp(`^${historicalMeetingId}:`, "u")),
  ]));
  expect(observedEvidence[0]?.findIndex((text) =>
    text.startsWith(`${currentMeetingId}:`)
  )).toBeLessThan(observedEvidence[0]?.findIndex((text) =>
    text.startsWith(`${historicalMeetingId}:`)
  ) ?? -1);
}

export function assertFinalReplyMixedEvidence(
  observedEvidence: readonly (readonly string[])[],
): void {
  assertDirectMixedEvidence(observedEvidence);
  expect(observedEvidence[0]).toEqual(expect.arrayContaining([
    `${currentMeetingId}:${currentMixedEvidenceText}`,
    `${historicalMeetingId}:${historicalMixedEvidenceText}`,
  ]));
}

export async function assertUnavailableHistoryFinalReplyState(
  pool: Pool,
): Promise<void> {
  const state = await Promise.all([
    pool.query<{ readonly count: number }>(
      "SELECT count(*)::integer AS count FROM meeting_knowledge.question_jobs"),
    pool.query<{ readonly question_id: string; readonly state: string }>(
      "SELECT question_id, state FROM meeting_knowledge.question_jobs WHERE question_id = $1",
      ["777777777777777703"]),
    pool.query<{ readonly count: number }>(
      "SELECT count(*)::integer AS count FROM meeting_core.answer_effects"),
    pool.query<{ readonly effect_id: string; readonly state: string }>(
      "SELECT effect_id, state FROM meeting_core.answer_effects WHERE effect_id = $1",
      ["meeting-knowledge-answer:v1:777777777777777703"]),
  ]);
  expect(state.map(({ rows }) => rows)).toEqual([
    [{ count: 1 }], [], [{ count: 1 }], [],
  ]);
}
