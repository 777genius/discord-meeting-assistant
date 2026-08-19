import { describe, expect, it } from "vitest";

import { PostgresConversationOneShotReceiptStore } from "../src/index.js";
import {
  databaseOrSkip,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

usePostgresIntegrationDatabase();

describe("PostgreSQL conversation one-shot receipts", () => {
  it("durably releases a failed farewell lease so one retry can settle", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresConversationOneShotReceiptStore(database);
    const input = {
      kind: "farewell" as const,
      meetingId: "farewell-retry-receipt-meeting-1",
      subjectId: "meeting",
    };
    const first = await store.reserve({ ...input, leaseSeconds: 120 });
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") {
      throw new Error("initial farewell receipt was not reserved");
    }

    await store.beginFarewellAttempt({ ...input, leaseToken: first.leaseToken });
    await store.releaseFarewellAttempt({
      ...input, evidence: "unplayed", leaseToken: first.leaseToken,
    });
    const retry = await store.reserve({ ...input, leaseSeconds: 120 });
    expect(retry.status).toBe("reserved");
    if (retry.status !== "reserved") {
      throw new Error("released farewell receipt could not be retried");
    }
    expect(retry.leaseToken).not.toBe(first.leaseToken);

    await store.beginFarewellAttempt({ ...input, leaseToken: retry.leaseToken });
    await store.settleFarewell({
      ...input, leaseToken: retry.leaseToken, outcome: "played",
    });
    await expect(store.reserve({ ...input, leaseSeconds: 120 })).resolves.toEqual({
      status: "completed",
    });
  });

  it("keeps a pre-provider farewell attempt terminal across crash and lease expiry", async (context) => {
    const database = databaseOrSkip(context);
    const input = {
      kind: "farewell" as const,
      meetingId: "farewell-crash-window-meeting-1",
      subjectId: "meeting",
    };
    const first = new PostgresConversationOneShotReceiptStore(database);
    const reservation = await first.reserve({ ...input, leaseSeconds: 5 });
    if (reservation.status !== "reserved") {
      throw new Error("initial farewell receipt was not reserved");
    }
    await first.beginFarewellAttempt({ ...input, leaseToken: reservation.leaseToken });
    await database.query("SELECT pg_sleep(5.1)");

    const restarted = new PostgresConversationOneShotReceiptStore(database);
    await expect(restarted.reserve({ ...input, leaseSeconds: 5 })).resolves.toEqual({
      status: "completed",
    });
    const attempted = await database.query<{
      readonly lease_expires_at: Date | null;
      readonly state: string;
    }>(`
      SELECT state, lease_expires_at
      FROM meeting_core.conversation_one_shot_receipts
    `);
    expect(attempted.rows).toEqual([{ state: "attempted", lease_expires_at: null }]);

    await first.settleFarewell({
      ...input,
      leaseToken: reservation.leaseToken,
      outcome: "suppressed",
      reason: "ambiguous",
    });
    const settled = await database.query<{
      readonly state: string;
      readonly suppression_reason: string | null;
    }>(`
      SELECT state, suppression_reason
      FROM meeting_core.conversation_one_shot_receipts
    `);
    expect(settled.rows).toEqual([{
      state: "suppressed", suppression_reason: "ambiguous",
    }]);
  }, 10_000);

  it("reclaims an expired crash lease and fences its stale owner across restart", async (context) => {
    const database = databaseOrSkip(context);
    const input = {
      kind: "greeting" as const,
      meetingId: "restart-receipt-meeting-1",
      subjectId: "restart-receipt-participant-1",
    };
    const first = new PostgresConversationOneShotReceiptStore(database);
    const firstLease = await first.reserve({ ...input, leaseSeconds: 5 });
    expect(firstLease.status).toBe("reserved");
    if (firstLease.status !== "reserved") {
      throw new Error("initial receipt lease was not acquired");
    }
    await expect(first.reserve({ ...input, leaseSeconds: 5 })).resolves.toEqual({
      status: "in_flight",
    });
    await database.query(`
      UPDATE meeting_core.conversation_one_shot_receipts
      SET lease_expires_at = transaction_timestamp() - interval '1 second'
    `);

    const restarted = new PostgresConversationOneShotReceiptStore(database);
    const recoveredLease = await restarted.reserve({ ...input, leaseSeconds: 5 });
    expect(recoveredLease.status).toBe("reserved");
    if (recoveredLease.status !== "reserved") {
      throw new Error("expired receipt lease was not recovered");
    }
    expect(recoveredLease.leaseToken).not.toBe(firstLease.leaseToken);
    await expect(first.complete({
      ...input,
      leaseToken: firstLease.leaseToken,
    })).rejects.toThrow("lost its reservation");
    await restarted.complete({ ...input, leaseToken: recoveredLease.leaseToken });
    await expect(restarted.reserve({ ...input, leaseSeconds: 5 })).resolves.toEqual({
      status: "completed",
    });
    const rows = await database.query<{
      readonly cue_kind: string;
      readonly receipt_id: string;
      readonly state: string;
    }>(`
      SELECT receipt_id, cue_kind, state
      FROM meeting_core.conversation_one_shot_receipts
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      cue_kind: "greeting",
      state: "completed",
    });
    expect(rows.rows[0]?.receipt_id).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(rows.rows)).not.toContain(input.meetingId);
    expect(JSON.stringify(rows.rows)).not.toContain(input.subjectId);
  });
  it("persists attempted and ambiguous greeting states across restart without replay", async (context) => {
    const database = databaseOrSkip(context);
    const input = {
      kind: "greeting" as const,
      meetingId: "ambiguous-greeting-meeting-1",
      subjectId: "ambiguous-greeting-participant-1",
    };
    const first = new PostgresConversationOneShotReceiptStore(database);
    const reservation = await first.reserve({ ...input, leaseSeconds: 120 });
    if (reservation.status !== "reserved") {
      throw new Error("initial greeting receipt was not reserved");
    }
    await first.beginGreetingAttempt({ ...input, leaseToken: reservation.leaseToken });
    await expect(new PostgresConversationOneShotReceiptStore(database).reserve({
      ...input,
      leaseSeconds: 120,
    })).resolves.toEqual({ status: "completed" });
    await first.settleGreeting({
      ...input, leaseToken: reservation.leaseToken,
      outcome: "suppressed", reason: "ambiguous",
    });
    const row = await database.query<{
      readonly state: string;
      readonly suppression_reason: string | null;
    }>(`
      SELECT state, suppression_reason
      FROM meeting_core.conversation_one_shot_receipts
    `);
    expect(row.rows).toEqual([{
      state: "suppressed", suppression_reason: "ambiguous",
    }]);
  });

  it("releases proven zero-audio greeting attempts and records played after retry", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresConversationOneShotReceiptStore(database);
    const input = {
      kind: "greeting" as const,
      meetingId: "zero-audio-greeting-meeting-1",
      subjectId: "zero-audio-greeting-participant-1",
    };
    const first = await store.reserve({ ...input, leaseSeconds: 120 });
    if (first.status !== "reserved") {
      throw new Error("initial greeting receipt was not reserved");
    }
    await store.beginGreetingAttempt({ ...input, leaseToken: first.leaseToken });
    await store.releaseGreetingAttempt({ ...input, evidence: "unplayed", leaseToken: first.leaseToken });
    const retry = await store.reserve({ ...input, leaseSeconds: 120 });
    if (retry.status !== "reserved") {
      throw new Error("released greeting attempt could not be retried");
    }
    await store.beginGreetingAttempt({ ...input, leaseToken: retry.leaseToken });
    await store.settleGreeting({
      ...input, leaseToken: retry.leaseToken, outcome: "played",
    });
    await expect(store.reserve({ ...input, leaseSeconds: 120 })).resolves.toEqual({
      status: "completed",
    });
    const row = await database.query<{
      readonly state: string;
      readonly suppression_reason: string | null;
    }>(`
      SELECT state, suppression_reason
      FROM meeting_core.conversation_one_shot_receipts
    `);
    expect(row.rows).toEqual([{ state: "played", suppression_reason: null }]);
  });

  it("terminalizes a stale greeting before any provider attempt", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresConversationOneShotReceiptStore(database);
    const input = {
      kind: "greeting" as const,
      meetingId: "stale-greeting-meeting-1",
      subjectId: "stale-greeting-participant-1",
    };
    const reservation = await store.reserve({ ...input, leaseSeconds: 120 });
    if (reservation.status !== "reserved") {
      throw new Error("stale greeting receipt was not reserved");
    }
    await store.settleGreeting({
      ...input, leaseToken: reservation.leaseToken,
      outcome: "suppressed", reason: "stale",
    });
    await expect(store.reserve({ ...input, leaseSeconds: 120 })).resolves.toEqual({
      status: "completed",
    });
  });

});
