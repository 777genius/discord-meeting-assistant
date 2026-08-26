import { createHash } from "node:crypto";

import {
  buildHistoricalIndexPlan,
  type HistoricalIndexPlanV1,
  type HistoricalOpaqueIdPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { describe, expect, it } from "vitest";

import {
  PostgresHistoricalEvidenceAuthority,
  PostgresHistoricalMemoryStore,
  PostgresMeetingRepository,
} from "../src/index.js";
import {
  databaseOrSkip,
  evidenceBackedMeeting,
  recordedMeeting,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

const selectedBinding = "voicetext-batch-v3:elevenlabs-scribe-v2";

class CollidingHistoricalCandidateTestIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    return namespace === "historical-candidate"
      ? "c".repeat(64)
      : createHash("sha256")
        .update([namespace, ...parts].join("\u0000"), "utf8")
        .digest("hex");
  }
}

usePostgresIntegrationDatabase();

describe("PostgreSQL historical locator ownership", () => {
  it("returns no arbitrary evidence when two current releases own one locator", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresHistoricalMemoryStore(database);
    const authority = new PostgresHistoricalEvidenceAuthority(database);
    const ids = new CollidingHistoricalCandidateTestIds();
    const plans: HistoricalIndexPlanV1[] = [];

    for (const meetingId of ["meeting-ambiguous-locator-a", "meeting-ambiguous-locator-b"]) {
      const repository = new PostgresMeetingRepository(database);
      await repository.recordAndSchedule(recordedMeeting(meetingId).toSnapshot(), 0, selectedBinding);
      await repository.save(evidenceBackedMeeting(meetingId).toSnapshot(), 0);
      const lease = await store.claimNext({ allowIndex: true, leaseDurationMs: 30_000 });
      if (lease === null) {
        throw new Error("historical duplicate-locator fixture was not claimed");
      }
      const accepted = await authority.loadAcceptedFinalMeeting(lease.binding);
      if (accepted === null) {
        throw new Error("historical duplicate-locator authority was not available");
      }
      const plan = buildHistoricalIndexPlan(accepted, ids);
      plans.push(plan);
      await store.recordApplied(lease, plan, {}, "profile-ambiguous-locator");
    }

    const locator = plans[0]?.documents[0]?.manifest.candidateLocator;
    expect(locator).toBe(plans[1]?.documents[0]?.manifest.candidateLocator);
    if (locator === undefined) {
      throw new Error("historical duplicate-locator fixture has no candidate");
    }
    await expect(store.findCurrentCandidates("scope-1", "room-1", [locator]))
      .rejects.toThrow("ambiguous current ownership");
    await expect(store.findCurrentCandidate("scope-1", "room-1", locator))
      .rejects.toThrow("ambiguous current ownership");
  });
});
