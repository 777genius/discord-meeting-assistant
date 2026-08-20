import {
  type FocusedMemoryReference,
  type QuestionBindingSnapshot,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresFinalReplyEvidence } from
  "@discord-meeting/postgres-adapter";
import type { Pool } from "pg";
import { expect } from "vitest";

export async function expectHistoricalRebuildToInvalidateReferences(
  pool: Pool,
  evidence: PostgresFinalReplyEvidence,
  binding: QuestionBindingSnapshot,
  historicalMeetingId: string,
  references: readonly FocusedMemoryReference[],
): Promise<void> {
  const selected = await pool.query<{ readonly plan: unknown }>(
    `SELECT plan FROM meeting_core.historical_memory_sync
     WHERE meeting_id = $1 AND is_current AND state = 'applied'`,
    [historicalMeetingId],
  );
  const originalPlan = selected.rows[0]?.plan;
  if (originalPlan === undefined) {
    throw new Error("historical rebuild fixture has no applied plan");
  }
  try {
    await pool.query(
      `UPDATE meeting_core.historical_memory_sync
       SET plan = jsonb_set(
         plan,
         '{topology,indexGeneration}',
         to_jsonb('mkgen1.synthetic-rebuild'::text)
       )
       WHERE meeting_id = $1 AND is_current AND state = 'applied'`,
      [historicalMeetingId],
    );
    await expect(evidence.rehydrateSelectedEvidence(binding, references))
      .resolves.toEqual({ status: "invalid_selection" });
  } finally {
    await pool.query(
      `UPDATE meeting_core.historical_memory_sync SET plan = $2::jsonb
       WHERE meeting_id = $1 AND is_current`,
      [historicalMeetingId, originalPlan],
    );
  }
}
