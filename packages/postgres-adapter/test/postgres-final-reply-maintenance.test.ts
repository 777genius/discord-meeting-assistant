import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresFinalReplyMaintenance } from "../src/index.js";

function fixture() {
  const queries: { readonly parameters: readonly unknown[]; readonly text: string }[] = [];
  const query = vi.fn(async (text: string, parameters: readonly unknown[]) => {
    queries.push({ parameters, text });
    return text.includes("AS cancelled")
      ? { rows: [{ cancelled: "2" }] }
      : { rows: [{ expired: "1" }] };
  });
  const maintenance = new PostgresFinalReplyMaintenance({
    query,
  } as unknown as Pool);
  return { maintenance, queries };
}

describe("PostgresFinalReplyMaintenance", () => {
  it("cancels pre-send effects, schedules post-send retraction, and scrubs disabled jobs", async () => {
    const { maintenance, queries } = fixture();

    await expect(maintenance.maintain({
      maximumJobs: 100,
      servingEnabled: false,
    })).resolves.toEqual({ cancelled: 2, expired: 1 });

    expect(queries).toHaveLength(2);
    expect(queries[0]?.parameters).toEqual([100]);
    expect(queries[0]?.text).toContain(
      "WHEN effect.state IN ('reserved', 'claimed') THEN 'cancelled'",
    );
    expect(queries[0]?.text).toContain("ELSE 'retraction_pending'");
    expect(queries[0]?.text).toContain("question_text = NULL");
    expect(queries[0]?.text).toContain("authorization_principal_ref = NULL");
    expect(queries[0]?.text).toContain("scrubbed_at = transaction_timestamp()");
  });

  it("keeps serving jobs while still expiring and scrubbing stale work", async () => {
    const { maintenance, queries } = fixture();

    await expect(maintenance.maintain({
      maximumJobs: 25,
      servingEnabled: true,
    })).resolves.toEqual({ cancelled: 0, expired: 1 });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.parameters).toEqual([25]);
    expect(queries[0]?.text).toContain("expires_at <= transaction_timestamp()");
    expect(queries[0]?.text).toContain("question_text = NULL");
  });
});
