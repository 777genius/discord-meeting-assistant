import { createHash } from "node:crypto";

import {
  LIVE_FINALIZED_MEMORY_POLICY_VERSION,
  admitTrustedLiveMemoryIdentity,
  type LiveFinalizedMemoryLifecyclePort,
  type TrustedLiveMemoryIdentityInputV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { TranscriptTurnSnapshot } from "@discord-meeting/meeting-core/transcription";
import type { Pool, PoolClient } from "pg";

import { canonicalFinalReplyTurnHash } from "./postgres-final-reply-evidence.js";

interface RegistrationRow {
  readonly human_actor_ids: unknown; readonly identity_generation: number;
  readonly producer_capability_id: string; readonly producer_revision: string;
  readonly room_id: string;
  readonly roster_state: "sealed" | "unsealed";
  readonly scope_id: string;
  readonly source_generation: number;
  readonly state: "active" | "ended" | "withdrawn";
}

interface ExistingOutboxRow { readonly turn_hash: string }
interface StoredTurnRow { readonly turn: TranscriptTurnSnapshot }

function humanActors(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("stored live memory human roster is invalid");
  }
  const actors = value.filter(
    (actorId): actorId is string =>
      typeof actorId === "string" && actorId.length > 0,
  );
  if (actors.length !== value.length) {
    throw new Error("stored live memory human roster is invalid");
  }
  return Object.freeze([...new Set(actors)].toSorted((left, right) =>
    left.localeCompare(right)
  ));
}

function mutationId(input: {
  readonly meetingId: string;
  readonly roomId: string;
  readonly scopeId: string;
  readonly turnHash: string;
  readonly turnId: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    meetingId: input.meetingId,
    policyVersion: LIVE_FINALIZED_MEMORY_POLICY_VERSION,
    roomId: input.roomId,
    scopeId: input.scopeId,
    turnHash: input.turnHash,
    turnId: input.turnId,
  }), "utf8").digest("hex");
}

/** Called by the live-turn append transaction and by restart backfill. */
export async function projectLiveFinalizedMemoryOutbox(
  client: PoolClient,
  meetingId: string,
  turn: TranscriptTurnSnapshot,
): Promise<"ineligible" | "projected" | "replayed"> {
  const registration = await client.query<RegistrationRow>(
    `
      SELECT scope_id, room_id, producer_capability_id, producer_revision,
             human_actor_ids, roster_state,
             identity_generation::float8 AS identity_generation,
             source_generation::float8 AS source_generation,
             state
      FROM meeting_knowledge.live_memory_meetings
      WHERE meeting_id = $1
      FOR UPDATE
    `,
    [meetingId],
  );
  const row = registration.rows[0];
  if (
    row === undefined ||
    row.state !== "active" ||
    !humanActors(row.human_actor_ids).includes(turn.speakerId)
  ) {
    return "ineligible";
  }
  const hash = canonicalFinalReplyTurnHash(turn);
  const existing = await client.query<ExistingOutboxRow>(
    `
      SELECT turn_hash
      FROM meeting_knowledge.live_memory_outbox
      WHERE meeting_id = $1 AND turn_id = $2
      FOR UPDATE
    `,
    [meetingId, turn.turnId],
  );
  if (existing.rows[0] !== undefined) {
    if (existing.rows[0].turn_hash !== hash) {
      throw new Error("live memory turn replay changed canonical content");
    }
    return "replayed";
  }
  const sourceGeneration = row.source_generation + 1;
  const mutation = mutationId({
    meetingId,
    roomId: row.room_id,
    scopeId: row.scope_id,
    turnHash: hash,
    turnId: turn.turnId,
  });
  await client.query(
    `
      INSERT INTO meeting_knowledge.live_memory_outbox (
        mutation_id, meeting_id, turn_id, source_generation,
        identity_generation, turn_hash
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      mutation,
      meetingId,
      turn.turnId,
      sourceGeneration,
      row.identity_generation,
      hash,
    ],
  );
  const updated = await client.query(
    `
      UPDATE meeting_knowledge.live_memory_meetings
      SET source_generation = $2,
          updated_at = transaction_timestamp()
      WHERE meeting_id = $1 AND source_generation = $3
    `,
    [meetingId, sourceGeneration, row.source_generation],
  );
  if (updated.rowCount !== 1) {
    throw new Error("live memory generation lost its locked compare-and-swap");
  }
  return "projected";
}

export class PostgresLiveFinalizedMemoryLifecycle
  implements LiveFinalizedMemoryLifecyclePort
{
  public constructor(private readonly pool: Pool) {}

  public registerMeeting(identity: TrustedLiveMemoryIdentityInputV1):
    Promise<"accepted" | "ineligible" | "replayed"> {
    return this.upsertIdentity(identity, false);
  }

  public sealMeeting(identity: TrustedLiveMemoryIdentityInputV1):
    Promise<"accepted" | "ineligible" | "replayed"> {
    return this.upsertIdentity(identity, true);
  }

  public async observeHuman(input: {
    readonly actorId: string;
    readonly meetingId: string;
    readonly producerRevision: string;
  }): Promise<"accepted" | "ineligible" | "replayed"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<RegistrationRow>(
        `
          SELECT scope_id, room_id, producer_capability_id, producer_revision,
                 human_actor_ids, roster_state,
                 identity_generation::float8 AS identity_generation,
                 source_generation::float8 AS source_generation,
                 state
          FROM meeting_knowledge.live_memory_meetings
          WHERE meeting_id = $1
          FOR UPDATE
        `,
        [input.meetingId],
      );
      const row = found.rows[0];
      if (
        row === undefined ||
        row.state !== "active" ||
        row.producer_revision !== input.producerRevision
      ) {
        await client.query("COMMIT");
        return "ineligible";
      }
      const actors = humanActors(row.human_actor_ids);
      if (actors.includes(input.actorId)) {
        await client.query("COMMIT");
        return "replayed";
      }
      await client.query(
        `
          UPDATE meeting_knowledge.live_memory_meetings
          SET human_actor_ids = $2::jsonb,
              identity_generation = identity_generation + 1,
              updated_at = transaction_timestamp()
          WHERE meeting_id = $1
        `,
        [input.meetingId, JSON.stringify([...actors, input.actorId].toSorted())],
      );
      await client.query("COMMIT");
      return "accepted";
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async removeHuman(input: {
    readonly actorId: string;
    readonly meetingId: string;
    readonly producerRevision: string;
  }): Promise<"accepted" | "ineligible" | "replayed"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<RegistrationRow>(
        `
          SELECT scope_id, room_id, producer_capability_id, producer_revision,
                 human_actor_ids, roster_state,
                 identity_generation::float8 AS identity_generation,
                 source_generation::float8 AS source_generation,
                 state
          FROM meeting_knowledge.live_memory_meetings
          WHERE meeting_id = $1
          FOR UPDATE
        `,
        [input.meetingId],
      );
      const row = found.rows[0];
      if (
        row === undefined ||
        row.state !== "active" ||
        row.producer_revision !== input.producerRevision
      ) {
        await client.query("COMMIT");
        return "ineligible";
      }
      const actors = humanActors(row.human_actor_ids);
      if (!actors.includes(input.actorId)) {
        await client.query("COMMIT");
        return "replayed";
      }
      await client.query(
        `
          UPDATE meeting_knowledge.live_memory_meetings
          SET human_actor_ids = $2::jsonb,
              identity_generation = identity_generation + 1,
              updated_at = transaction_timestamp()
          WHERE meeting_id = $1
        `,
        [input.meetingId, JSON.stringify(actors.filter((actorId) => actorId !== input.actorId))],
      );
      await client.query("COMMIT");
      return "accepted";
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async finishMeeting(meetingId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE meeting_knowledge.live_memory_meetings
        SET state = CASE WHEN state = 'withdrawn' THEN state ELSE 'ended' END,
            updated_at = transaction_timestamp()
        WHERE meeting_id = $1
      `,
      [meetingId],
    );
  }

  private async upsertIdentity(
    candidate: TrustedLiveMemoryIdentityInputV1,
    sealing: boolean,
  ): Promise<"accepted" | "ineligible" | "replayed"> {
    const identity = admitTrustedLiveMemoryIdentity(candidate);
    if (
      identity === null ||
      (sealing && identity.rosterState !== "sealed")
    ) {
      return "ineligible";
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<RegistrationRow>(
        `
          SELECT scope_id, room_id, producer_capability_id, producer_revision,
                 human_actor_ids, roster_state,
                 identity_generation::float8 AS identity_generation,
                 source_generation::float8 AS source_generation,
                 state
          FROM meeting_knowledge.live_memory_meetings
          WHERE meeting_id = $1
          FOR UPDATE
        `,
        [identity.meetingId],
      );
      const existing = found.rows[0];
      let changed = false;
      if (existing === undefined) {
        await client.query(
          `
            INSERT INTO meeting_knowledge.live_memory_meetings (
              meeting_id, schema_version, scope_id, room_id,
              producer_capability_id, actor_semantics_version,
              producer_revision, human_actor_ids, roster_state
            ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7::jsonb, $8)
          `,
          [
            identity.meetingId,
            identity.scopeId,
            identity.roomId,
            candidate.identityProvenance.producerCapabilityId,
            candidate.identityProvenance.actorSemanticsVersion,
            identity.producerRevision,
            JSON.stringify(identity.humanActorIds),
            identity.rosterState,
          ],
        );
        changed = true;
      } else {
        if (
          existing.scope_id !== identity.scopeId ||
          existing.room_id !== identity.roomId ||
          existing.producer_capability_id !==
            candidate.identityProvenance.producerCapabilityId ||
          existing.state === "withdrawn"
        ) {
          throw new Error("live memory identity replay conflicts with its source");
        }
        if (existing.state !== "active") {
          await client.query("COMMIT");
          return "ineligible";
        }
        if (existing.roster_state === "sealed") {
          await client.query("COMMIT");
          return "replayed";
        }
        const currentActors = humanActors(existing.human_actor_ids);
        const nextActors = sealing
          ? identity.humanActorIds
          : Object.freeze([...new Set([
              ...currentActors,
              ...identity.humanActorIds,
            ])].toSorted());
        const nextRosterState = sealing
          ? "sealed"
          : identity.rosterState;
        changed = [
          existing.producer_revision !== identity.producerRevision,
          existing.roster_state !== nextRosterState,
          currentActors.length !== nextActors.length,
          currentActors.some((actorId, index) => actorId !== nextActors[index]),
        ].includes(true);
        if (changed) {
          await client.query(
            `
              UPDATE meeting_knowledge.live_memory_meetings
              SET producer_revision = $2,
                  human_actor_ids = $3::jsonb,
                  roster_state = $4,
                  identity_generation = identity_generation + 1,
                  updated_at = transaction_timestamp()
              WHERE meeting_id = $1
            `,
            [
              identity.meetingId,
              identity.producerRevision,
              JSON.stringify(nextActors),
              nextRosterState,
            ],
          );
        }
      }
      const turns = await client.query<StoredTurnRow>(
        `
          SELECT turn
          FROM meeting_core.live_meeting_turns
          WHERE meeting_id = $1
          ORDER BY start_ms, end_ms, speaker_id, turn_id
        `,
        [identity.meetingId],
      );
      for (const row of turns.rows) {
        const outcome = await projectLiveFinalizedMemoryOutbox(
          client,
          identity.meetingId,
          row.turn,
        );
        changed ||= outcome === "projected";
      }
      await client.query("COMMIT");
      return changed ? "accepted" : "replayed";
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}
