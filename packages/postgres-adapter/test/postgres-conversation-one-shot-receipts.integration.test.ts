import { describe, expect, it } from "vitest";

import { PostgresConversationOneShotReceiptStore } from "../src/index.js";
import {
  databaseOrSkip,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

usePostgresIntegrationDatabase();

// oxlint-disable-next-line max-lines-per-function
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
      kind: "farewell" as const,
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
      cue_kind: "farewell",
      state: "completed",
    });
    expect(rows.rows[0]?.receipt_id).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(rows.rows)).not.toContain(input.meetingId);
    expect(JSON.stringify(rows.rows)).not.toContain(input.subjectId);
  });
  it("retries the same command before attested audio and fences it after start", async (context) => {
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
    const providerCommandId = reservation.providerCommandId;
    if (providerCommandId === undefined) {
      throw new Error("greeting command id was not assigned");
    }
    await first.beginGreetingAttempt({
      ...input, leaseToken: reservation.leaseToken, locale: "en",
      prompt: "Hi, retry participant!", providerCommandId,
    });
    const restarted = new PostgresConversationOneShotReceiptStore(database);
    await expect(restarted.reserve({ ...input, leaseSeconds: 120 }))
      .resolves.toEqual({ status: "in_flight" });
    const recovered = await restarted.reserve({
      ...input, leaseSeconds: 120, reclaimActive: true,
    });
    expect(recovered.status).toBe("reserved");
    if (recovered.status !== "reserved") {
      throw new Error("command was not recovered");
    }
    expect(recovered.providerCommandId).toBe(providerCommandId);
    expect(recovered.providerCommand).toEqual({
      locale: "en", prompt: "Hi, retry participant!",
    });
    await expect(first.confirmGreetingStarted({
      ...input,
      leaseToken: reservation.leaseToken,
      providerCommandId,
      startedAtMilliseconds: 123_455,
    })).rejects.toThrow("lost its commanded attempt");
    await restarted.confirmGreetingStarted({
      ...input,
      leaseToken: recovered.leaseToken,
      providerCommandId,
      startedAtMilliseconds: 123_456,
    });
    await expect(new PostgresConversationOneShotReceiptStore(database).reserve({
      ...input, leaseSeconds: 120,
    })).resolves.toEqual({ status: "completed" });
    await first.settleGreeting({
      ...input, leaseToken: recovered.leaseToken, outcome: "played",
    });
    const row = await database.query<{
      readonly state: string;
      readonly provider_command_id: string | null;
    }>(`
      SELECT state, provider_command_id
      FROM meeting_core.conversation_one_shot_receipts
    `);
    expect(row.rows).toEqual([{ state: "played", provider_command_id: providerCommandId }]);
  });

  it("atomically fences provider recovery at and after its deadline", async (context) => {
    const database = databaseOrSkip(context);
    for (const { offset, recovered } of [
      { offset: "1 minute", recovered: true },
      { offset: "0 milliseconds", recovered: false },
      { offset: "-1 millisecond", recovered: false },
    ]) {
      await database.query("TRUNCATE meeting_core.conversation_one_shot_receipts CASCADE");
      const store = new PostgresConversationOneShotReceiptStore(database);
      const input = {
        kind: "greeting" as const, meetingId: `recovery-boundary-${offset}`,
        subjectId: "participant-1",
      };
      const reservation = await store.reserve({ ...input, leaseSeconds: 120 });
      if (reservation.status !== "reserved" || reservation.providerCommandId === undefined) {
        throw new Error("boundary greeting was not reserved");
      }
      await store.beginGreetingAttempt({
        ...input, leaseToken: reservation.leaseToken, locale: "en",
        prompt: "Hello!", providerCommandId: reservation.providerCommandId,
      });
      await database.query(
        `UPDATE meeting_core.conversation_one_shot_receipts
         SET provider_recovery_expires_at = transaction_timestamp() + $1::interval,
             lease_expires_at = transaction_timestamp() - interval '1 second'`,
        [offset],
      );
      const result = await store.reserve({ ...input, leaseSeconds: 120 });
      expect(result.status).toBe(recovered ? "reserved" : "completed");
      const row = await database.query<{
        readonly state: string; readonly suppression_reason: string | null;
      }>("SELECT state, suppression_reason FROM meeting_core.conversation_one_shot_receipts");
      expect(row.rows).toEqual([recovered
        ? { state: "commanded", suppression_reason: null }
        : { state: "suppressed", suppression_reason: "ambiguous" }]);
    }
  });

  it("atomically confirms the full twelve-human domain cohort", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresConversationOneShotReceiptStore(database);
    const meetingId = "greeting-cohort-meeting-1";
    const inputs = Array.from(
      { length: 12 },
      (_, index) => `cohort-participant-${index + 1}`,
    ).map((subjectId) => ({
      kind: "greeting" as const,
      meetingId,
      subjectId,
    }));
    const reservations = await Promise.all(inputs.map(async (input) => {
      const reservation = await store.reserve({ ...input, leaseSeconds: 120 });
      if (reservation.status !== "reserved" || reservation.providerCommandId === undefined) {
        throw new Error("cohort greeting receipt was not reserved");
      }
      return reservation;
    }));
    const providerCommandId = reservations[0]!.providerCommandId!;
    const receipts = inputs.map((input, index) => ({
      leaseToken: reservations[index]!.leaseToken,
      subjectId: input.subjectId,
    }));
    const command = {
      kind: "greeting",
      meetingId,
      locale: "en",
      prompt: "Hi, cohort participant one, cohort participant two!",
      providerCommandId,
      receipts,
    } as const;
    const oneOverLimitReceipts = [...receipts, {
      leaseToken: "11111111-1111-4111-8111-111111111111",
      subjectId: "cohort-participant-13",
    }];
    await expect(store.beginGreetingCohortAttempt({
      ...command,
      receipts: oneOverLimitReceipts,
    })).rejects.toThrow("greeting cohort receipt batch is invalid");
    await expect(store.beginGreetingCohortAttempt({
      ...command,
      receipts: [receipts[0]!, {
        ...receipts[1]!,
        leaseToken: "00000000-0000-4000-8000-000000000000",
      }],
    })).rejects.toThrow("lost a reserved member");
    await expect(database.query<{ readonly state: string }>(
      "SELECT state FROM meeting_core.conversation_one_shot_receipts ORDER BY receipt_id",
    )).resolves.toMatchObject({
      rows: Array.from({ length: 12 }, () => ({ state: "reserved" })),
    });
    await store.beginGreetingCohortAttempt(command);
    await expect(store.confirmGreetingCohortStarted({
      kind: "greeting",
      meetingId,
      providerCommandId,
      receipts: [receipts[0]!, {
        ...receipts[1]!,
        leaseToken: "00000000-0000-4000-8000-000000000000",
      }],
      startedAtMilliseconds: 345_678,
    })).rejects.toThrow("lost a commanded member");
    await expect(database.query<{ readonly state: string }>(
      "SELECT state FROM meeting_core.conversation_one_shot_receipts ORDER BY receipt_id",
    )).resolves.toMatchObject({
      rows: Array.from({ length: 12 }, () => ({ state: "commanded" })),
    });

    await expect(store.confirmGreetingCohortStarted({
      kind: "greeting",
      meetingId,
      providerCommandId,
      receipts: oneOverLimitReceipts,
      startedAtMilliseconds: 345_678,
    })).rejects.toThrow("greeting cohort receipt batch is invalid");
    await store.confirmGreetingCohortStarted({
      kind: "greeting",
      meetingId,
      providerCommandId,
      receipts,
      startedAtMilliseconds: 345_678,
    });
    await expect(database.query<{ readonly state: string }>(
      "SELECT state FROM meeting_core.conversation_one_shot_receipts ORDER BY receipt_id",
    )).resolves.toMatchObject({
      rows: Array.from({ length: 12 }, () => ({ state: "started" })),
    });
    await store.settleGreeting({
      ...inputs[0]!, leaseToken: reservations[0]!.leaseToken, outcome: "played",
    });
    await expect(database.query<{ readonly state: string }>(
      "SELECT state FROM meeting_core.conversation_one_shot_receipts ORDER BY receipt_id",
    )).resolves.toMatchObject({
      rows: Array.from({ length: 12 }, () => ({ state: "played" })),
    });
  }, 10_000);

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
    if (first.providerCommandId === undefined) {
      throw new Error("greeting command id was not assigned");
    }
    await store.beginGreetingAttempt({
      ...input, leaseToken: first.leaseToken, locale: "en", prompt: "Hi!",
      providerCommandId: first.providerCommandId,
    });
    await store.releaseGreetingAttempt({ ...input, evidence: "unplayed", leaseToken: first.leaseToken });
    const retry = await store.reserve({ ...input, leaseSeconds: 120 });
    if (retry.status !== "reserved") {
      throw new Error("released greeting attempt could not be retried");
    }
    if (retry.providerCommandId === undefined) {
      throw new Error("greeting command id was not assigned");
    }
    await store.beginGreetingAttempt({
      ...input, leaseToken: retry.leaseToken, locale: "en", prompt: "Hi!",
      providerCommandId: retry.providerCommandId,
    });
    await store.confirmGreetingStarted({
      ...input,
      leaseToken: retry.leaseToken,
      providerCommandId: retry.providerCommandId,
      startedAtMilliseconds: 234_567,
    });
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

  it("accepts the 1024-character command prompt limit and rejects one over", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresConversationOneShotReceiptStore(database);
    const input = {
      kind: "greeting" as const,
      meetingId: "prompt-bound-greeting-meeting-1",
      subjectId: "prompt-bound-greeting-participant-1",
    };
    const reservation = await store.reserve({ ...input, leaseSeconds: 120 });
    if (reservation.status !== "reserved" || reservation.providerCommandId === undefined) {
      throw new Error("prompt-bound greeting receipt was not reserved");
    }
    await expect(store.beginGreetingAttempt({
      ...input,
      leaseToken: reservation.leaseToken,
      locale: "en",
      prompt: "x".repeat(1_025),
      providerCommandId: reservation.providerCommandId,
    })).rejects.toThrow("prompt is outside its bounds");
    await expect(store.beginGreetingAttempt({
      ...input,
      leaseToken: reservation.leaseToken,
      locale: "en",
      prompt: "x".repeat(1_024),
      providerCommandId: reservation.providerCommandId,
    })).resolves.toBeUndefined();
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

  it("terminalizes explicit cohort capacity rejection without claiming delivery", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresConversationOneShotReceiptStore(database);
    const subjectIds = Array.from({ length: 13 }, (_, index) =>
      `capacity-greeting-participant-${index + 1}`
    );
    const input = {
      kind: "greeting" as const,
      meetingId: "capacity-greeting-meeting-1",
      subjectId: subjectIds[12]!,
    };
    await expect(store.reconcileGreetingCapacity({
      capacity: 12,
      kind: "greeting",
      meetingId: input.meetingId,
      orderedSubjectIds: subjectIds,
    })).resolves.toEqual({
      commandedSubjectIds: [],
      suppressedSubjectIds: [input.subjectId],
      terminalSubjectIds: [],
    });
    await expect(store.reserve({ ...input, leaseSeconds: 120 }))
      .resolves.toEqual({ status: "completed" });
    const row = await database.query(`
      SELECT state, suppression_reason
      FROM meeting_core.conversation_one_shot_receipts
    `);
    expect(row.rows).toEqual([{ state: "suppressed", suppression_reason: "capacity" }]);
  });

  it("retains earlier capacity admissions across reordered reconciliation", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresConversationOneShotReceiptStore(database);
    const meetingId = "capacity-reconciliation-meeting-1";
    await store.reconcileGreetingCapacity({
      capacity: 1,
      kind: "greeting",
      meetingId,
      orderedSubjectIds: ["still-due", "already-terminal"],
    });
    const dueSubjectIds = Array.from({ length: 13 }, (_, index) => `due-${index + 1}`);

    await expect(store.reconcileGreetingCapacity({
      capacity: 12,
      kind: "greeting",
      meetingId,
      orderedSubjectIds: ["already-terminal", ...dueSubjectIds],
    })).resolves.toEqual({
      commandedSubjectIds: [],
      suppressedSubjectIds: ["already-terminal", "due-12", "due-13"],
      terminalSubjectIds: [],
    });
    await expect(store.reserve({
      kind: "greeting",
      leaseSeconds: 120,
      meetingId,
      subjectId: "due-13",
    })).resolves.toEqual({ status: "completed" });
  });

  it("atomically exhausts capacity across sequential incremental plans", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresConversationOneShotReceiptStore(database);
    const meetingId = "sequential-capacity-meeting-1";
    const subjectIds = Array.from({ length: 13 }, (_, index) => `sequential-${index + 1}`);

    for (const subjectId of subjectIds) {
      await store.reconcileGreetingCapacity({
        capacity: 12,
        kind: "greeting",
        meetingId,
        orderedSubjectIds: [subjectId],
      });
    }

    await expect(store.reserve({
      kind: "greeting",
      leaseSeconds: 120,
      meetingId,
      subjectId: subjectIds[12]!,
    })).resolves.toEqual({ status: "completed" });
    const admissions = await database.query<{ readonly count: string }>(
      "SELECT count(*) FROM meeting_core.conversation_greeting_capacity_admissions",
    );
    expect(admissions.rows).toEqual([{ count: "12" }]);
  });

  it("serializes simultaneous incremental capacity plans", async (context) => {
    const database = databaseOrSkip(context);
    const store = new PostgresConversationOneShotReceiptStore(database);
    const meetingId = "simultaneous-capacity-meeting-1";
    const subjectIds = Array.from({ length: 13 }, (_, index) => `simultaneous-${index + 1}`);

    const results = await Promise.all(subjectIds.map((subjectId) =>
      store.reconcileGreetingCapacity({
        capacity: 12,
        kind: "greeting",
        meetingId,
        orderedSubjectIds: [subjectId],
      })
    ));

    expect(results.flatMap(({ suppressedSubjectIds }) => suppressedSubjectIds)).toHaveLength(1);
    const admissions = await database.query<{ readonly count: string }>(
      "SELECT count(*) FROM meeting_core.conversation_greeting_capacity_admissions",
    );
    expect(admissions.rows).toEqual([{ count: "12" }]);
  });

});
