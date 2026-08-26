import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresFinalReplyMaintenance } from "../src/index.js";

const questionPolicy = Object.freeze({
  authorizationPolicyVersion: "discord.participant-current-results.v1",
  policyEpoch: 1,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
});

function fixture(policyIsCurrent = true) {
  const queries: { readonly parameters: readonly unknown[]; readonly text: string }[] = [];
  const release = vi.fn();
  const clientQuery = vi.fn(async (text: string, parameters: readonly unknown[] = []) => {
    if (text.includes("INSERT INTO meeting_knowledge.current_question_policy")) {
      return {
        rows: policyIsCurrent ? [{
          authorization_policy_version: questionPolicy.authorizationPolicyVersion,
          policy_epoch: questionPolicy.policyEpoch,
          policy_version: questionPolicy.policyVersion,
        }] : [],
      };
    }
    if (text.includes("FROM meeting_knowledge.current_question_policy") &&
        !text.includes("WITH current_policy")) {
      return { rows: policyIsCurrent ? [{
        authorization_policy_version: questionPolicy.authorizationPolicyVersion,
        policy_epoch: questionPolicy.policyEpoch,
        policy_version: questionPolicy.policyVersion,
      }] : [{
        authorization_policy_version: "discord.participant-current-results.v2",
        policy_epoch: questionPolicy.policyEpoch + 1,
        policy_version: "meeting-knowledge.focused-memory-final-reply.v3",
      }] };
    }
    if (text.includes("AS cancelled") || text.includes("AS expired")) {
      queries.push({ parameters, text });
      return text.includes("AS cancelled")
        ? { rows: [{ cancelled: "2" }] }
        : { rows: [{ expired: "1" }] };
    }
    return { rows: [] };
  });
  const maintenance = new PostgresFinalReplyMaintenance({
    connect: vi.fn(async () => ({ query: clientQuery, release })),
  } as unknown as Pool, questionPolicy);
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
    expect(queries[0]?.parameters).toEqual([
      100,
      questionPolicy.policyEpoch,
      questionPolicy.policyVersion,
      questionPolicy.authorizationPolicyVersion,
    ]);
    expect(queries[0]?.text).toContain(
      "WHEN effect.state IN ('reserved', 'claimed') THEN 'cancelled'",
    );
    expect(queries[0]?.text).toContain("ELSE 'retraction_pending'");
    expect(queries[0]?.text).toContain("ELSE effect.payload_bytes");
    expect(queries[0]?.text).toContain(
      "'absent_unconfirmed', 'retraction_pending'",
    );
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
    expect(queries[0]?.parameters).toEqual([
      25,
      questionPolicy.policyEpoch,
      questionPolicy.policyVersion,
      questionPolicy.authorizationPolicyVersion,
    ]);
    expect(queries[0]?.text).toContain("expires_at <= transaction_timestamp()");
    expect(queries[0]?.text).toContain("question_text = NULL");
    expect(queries[0]?.text).toContain(
      "WHEN effect.state IN ('reserved', 'claimed') THEN 'cancelled'",
    );
    expect(queries[0]?.text).toContain("ELSE 'retraction_pending'");
    expect(queries[0]?.text).toContain("ELSE effect.payload_bytes");
  });

  it("fails closed without issuing maintenance updates when its policy is stale", async () => {
    const { maintenance, queries } = fixture(false);

    await expect(maintenance.maintain({
      maximumJobs: 100,
      servingEnabled: false,
    })).rejects.toThrow("maintenance policy is not current");
    expect(queries).toEqual([]);
  });
});
