import { LiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  PostgresConversationOneShotReceiptStore,
  PostgresDerivedGreetingObligationStore,
  PostgresLiveMeetingRepository,
} from "../src/index.js";
import {
  databaseOrSkip,
  usePostgresIntegrationDatabase,
} from "./postgres-integration-fixtures.js";

usePostgresIntegrationDatabase();

describe("PostgreSQL derived greeting retention", () => {
  it("purges once, then returns zero while retaining terminal receipt evidence",
    async (context) => {
      const database = databaseOrSkip(context);
      const meetingId = "terminal-greeting-retention-meeting-1";
      await saveRetentionMeeting(database, meetingId, 1);
      await saveTerminalObligation(database, meetingId, "played-participant");
      await saveTerminalObligation(database, meetingId, "suppressed-participant");
      await saveGreetingReceipt(database, meetingId, "played-participant", "played");
      await saveGreetingReceipt(database, meetingId, "suppressed-participant", "suppressed");
      const obligations = new PostgresDerivedGreetingObligationStore(database);

      await expect(obligations.purgeTerminal(retentionInput(10))).resolves.toEqual({
        capacityAdmissionsDeleted: 2,
        meetingsProcessed: 1,
        obligationsDeleted: 2,
      });
      await expect(obligations.purgeTerminal(retentionInput(10))).resolves.toEqual(zeroPurge());
      const evidence = await database.query<{ readonly state: string }>(
        `SELECT state FROM meeting_core.conversation_one_shot_receipts ORDER BY state`,
      );
      expect(evidence.rows).toEqual([{ state: "played" }, { state: "suppressed" }]);
    });

  it("advances deterministically through more than two retention batches", async (context) => {
    const database = databaseOrSkip(context);
    const obligations = new PostgresDerivedGreetingObligationStore(database);
    for (let index = 1; index <= 7; index += 1) {
      const meetingId = `batched-greeting-retention-meeting-${index}`;
      await saveRetentionMeeting(database, meetingId, index);
      await saveTerminalObligation(database, meetingId, `participant-${index}`);
    }

    const purge = () => obligations.purgeTerminal(retentionInput(2));
    await expect(purge()).resolves.toEqual(purgeResult(2));
    const remaining = await database.query<{ readonly recording_id: string }>(
      `SELECT recording_id FROM meeting_core.derived_greeting_obligations
       ORDER BY recording_id`,
    );
    expect(remaining.rows.map(({ recording_id }) => recording_id)).toEqual(
      Array.from({ length: 5 }, (_, index) =>
        `batched-greeting-retention-meeting-${index + 3}`),
    );
    await expect((async () => [
      await purge(), await purge(), await purge(), await purge(),
    ])()).resolves.toEqual([purgeResult(2), purgeResult(2), purgeResult(1), zeroPurge()]);
  });

  it("serializes concurrent retention and remains idempotent", async (context) => {
    const database = databaseOrSkip(context);
    const obligations = new PostgresDerivedGreetingObligationStore(database);
    for (let index = 1; index <= 6; index += 1) {
      const meetingId = `concurrent-greeting-retention-meeting-${index}`;
      await saveRetentionMeeting(database, meetingId, index);
      await saveTerminalObligation(database, meetingId, `participant-${index}`);
    }
    const input = retentionInput(10);

    const concurrent = await Promise.all([
      obligations.purgeTerminal(input), obligations.purgeTerminal(input),
    ]);
    expect(concurrent.reduce((total, result) => total + result.meetingsProcessed, 0)).toBe(6);
    expect(concurrent.reduce((total, result) => total + result.obligationsDeleted, 0)).toBe(6);
    await expect(Promise.all([
      obligations.purgeTerminal(input), obligations.purgeTerminal(input),
    ])).resolves.toEqual([zeroPurge(), zeroPurge()]);
  });

  it("leaves every unsafe retention scope untouched", async (context) => {
    const database = databaseOrSkip(context);
    const obligations = new PostgresDerivedGreetingObligationStore(database);
    await saveRetentionMeeting(database, "unsafe-active-meeting", 1, "active");
    await saveTerminalObligation(database, "unsafe-active-meeting", "participant");
    await saveRetentionMeeting(database, "unsafe-pending-meeting", 2);
    await saveTerminalObligation(database, "unsafe-pending-meeting", "terminal");
    await obligations.accept(greetingObligation("unsafe-pending-meeting", "pending"));
    const receiptStates = ["missing", "reserved", "commanded", "started"] as const;
    for (const [index, state] of receiptStates.entries()) {
      const meetingId = `unsafe-${state}-receipt-meeting`;
      await saveRetentionMeeting(database, meetingId, index + 3);
      await saveTerminalObligation(database, meetingId, "participant");
      await saveGreetingReceipt(database, meetingId, "participant", state);
    }

    await expect(obligations.purgeTerminal(retentionInput(10))).resolves.toEqual(zeroPurge());
    const retained = await database.query<{ readonly count: string }>(
      `SELECT count(*) FROM meeting_core.derived_greeting_obligations`,
    );
    expect(retained.rows).toEqual([{ count: "7" }]);
    const admissions = await database.query<{ readonly count: string }>(
      `SELECT count(*) FROM meeting_core.conversation_greeting_capacity_admissions`,
    );
    expect(admissions.rows).toEqual([{ count: "4" }]);
    const receipts = await database.query<{ readonly state: string }>(
      `SELECT state FROM meeting_core.conversation_one_shot_receipts ORDER BY state`,
    );
    expect(receipts.rows).toEqual([
      { state: "commanded" }, { state: "reserved" }, { state: "started" },
    ]);
  });
});

function retentionInput(limit: number) {
  return { limit, terminalBeforeMilliseconds: Date.now() + 60_000 } as const;
}

function purgeResult(count: number) {
  return { capacityAdmissionsDeleted: 0, meetingsProcessed: count, obligationsDeleted: count };
}

function zeroPurge() {
  return purgeResult(0);
}

function greetingObligation(meetingId: string, subjectId: string) {
  return {
    eventId: `${meetingId}:${subjectId}`,
    notAfterMilliseconds: 6_000,
    occurredAt: "1970-01-01T00:00:01.000Z",
    participantId: subjectId,
    recordingId: meetingId,
  } as const;
}

async function saveRetentionMeeting(
  database: Pool,
  meetingId: string,
  order: number,
  status: "active" | "ended" = "ended",
): Promise<void> {
  const repository = new PostgresLiveMeetingRepository(database);
  const meeting = LiveMeeting.start({
    meetingId, publicationTargetId: `retention-channel-${order}`, startedAtMs: 1_000,
  });
  await repository.save(meeting.toSnapshot(), null);
  if (status === "ended") {
    const initialRevision = meeting.revision;
    meeting.end(2_000);
    await repository.save(meeting.toSnapshot(), initialRevision);
  }
  await database.query(
    `UPDATE meeting_core.live_meetings SET updated_at = to_timestamp($2)
     WHERE meeting_id = $1`,
    [meetingId, order],
  );
}

async function saveTerminalObligation(
  database: Pool,
  meetingId: string,
  subjectId: string,
): Promise<void> {
  const obligations = new PostgresDerivedGreetingObligationStore(database);
  const obligation = greetingObligation(meetingId, subjectId);
  await obligations.accept(obligation);
  await obligations.markDelivered(obligation.eventId);
}

async function saveGreetingReceipt(
  database: Pool,
  meetingId: string,
  subjectId: string,
  targetState: "commanded" | "missing" | "played" | "reserved" | "started" | "suppressed",
): Promise<void> {
  const receipts = new PostgresConversationOneShotReceiptStore(database);
  await receipts.reconcileGreetingCapacity({
    capacity: 12, kind: "greeting", meetingId, orderedSubjectIds: [subjectId],
  });
  if (targetState === "missing") {
    return;
  }
  const reservation = await receipts.reserve({
    kind: "greeting", leaseSeconds: 120, meetingId, subjectId,
  });
  if (reservation.status !== "reserved" || reservation.providerCommandId === undefined) {
    throw new Error("retention fixture greeting receipt was not reserved");
  }
  if (targetState === "reserved") {
    return;
  }
  if (targetState === "suppressed") {
    await receipts.settleGreeting({
      kind: "greeting", leaseToken: reservation.leaseToken, meetingId,
      outcome: "suppressed", reason: "stale", subjectId,
    });
    return;
  }
  await receipts.beginGreetingAttempt({
    kind: "greeting", leaseToken: reservation.leaseToken, locale: "en", meetingId,
    prompt: "Hi!", providerCommandId: reservation.providerCommandId, subjectId,
  });
  if (targetState === "commanded") {
    return;
  }
  await receipts.confirmGreetingStarted({
    kind: "greeting", leaseToken: reservation.leaseToken, meetingId,
    providerCommandId: reservation.providerCommandId,
    startedAtMilliseconds: 3_000, subjectId,
  });
  if (targetState === "played") {
    await receipts.settleGreeting({
      kind: "greeting", leaseToken: reservation.leaseToken, meetingId,
      outcome: "played", subjectId,
    });
  }
}
