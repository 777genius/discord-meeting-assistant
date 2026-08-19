import {
  createHistoricalReleaseBinding,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresExhaustiveCoverageStore,
  PostgresLiveFinalizedMemoryLifecycle,
} from "../src/index.js";

function result<Row extends QueryResultRow>(
  rows: readonly Row[] = [],
): QueryResult<Row> {
  return {
    command: "SELECT",
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows: [...rows],
  };
}

function poolFor(
  query: (text: string, values?: readonly unknown[]) => Promise<QueryResult>,
): Pool {
  const client = {
    query: vi.fn(query),
    release: vi.fn(),
  } as unknown as PoolClient;
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

function parseJson(value: unknown): unknown {
  return JSON.parse(String(value)) as unknown;
}

describe("PostgreSQL JSONB parameters", () => {
  it("serializes exhaustive release and block arrays as JSON text", async () => {
    let insertedValues: readonly unknown[] | undefined;
    const release = createHistoricalReleaseBinding({
      acceptedMeetingRevision: 4,
      desiredGeneration: 1,
      meetingId: "jsonb-coverage-meeting",
      roomId: "jsonb-coverage-room",
      scopeId: "jsonb-coverage-scope",
      transcriptId: "jsonb-coverage-transcript",
      transcriptVersion: 1,
    });
    const pool = poolFor(async (text, values) => {
      if (text.includes("INSERT INTO meeting_core.historical_coverage_checkpoints")) {
        insertedValues = values;
        return result([{
          attempt_count: 1,
          block_locators: parseJson(values?.[4]),
          checkpoint_id: values?.[0],
          coverage_bitmap: parseJson(values?.[5]),
          extracts: {},
          lease_fence: 1,
          plan_digest: values?.[2],
          question_hash: values?.[1],
          reduction: null,
          release_bindings: parseJson(values?.[3]),
          state: "active",
          terminal_reason: null,
        }]);
      }
      return result();
    });

    await new PostgresExhaustiveCoverageStore(pool).open({
      blockLocators: ["block-a", "block-b"],
      checkpointId: "jsonb-checkpoint",
      planDigest: "a".repeat(64),
      questionHash: "b".repeat(64),
      releaseBindings: [release],
      retentionSeconds: 300,
    });

    expect(insertedValues?.slice(3, 6).every((value) => typeof value === "string"))
      .toBe(true);
    expect(parseJson(insertedValues?.[3])).toEqual([release]);
    expect(parseJson(insertedValues?.[4])).toEqual(["block-a", "block-b"]);
    expect(parseJson(insertedValues?.[5])).toEqual([false, false]);
  });

  it("serializes the trusted live human roster as JSON text", async () => {
    let insertedValues: readonly unknown[] | undefined;
    const pool = poolFor(async (text, values) => {
      if (text.includes("INSERT INTO meeting_knowledge.live_memory_meetings")) {
        insertedValues = values;
      }
      return result();
    });

    await expect(new PostgresLiveFinalizedMemoryLifecycle(pool).registerMeeting({
      actors: [
        { actorId: "human-b", kind: "human" },
        { actorId: "human-a", kind: "human" },
      ],
      identityProvenance: {
        actorObservationState: "consistent",
        actorSemanticsVersion: 1,
        producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
        producerRevision: "jsonb-producer-r1",
        rosterState: "unsealed",
      },
      lifecycleGeneration: 3,
      meetingId: "jsonb-live-meeting",
      roomId: "jsonb-live-room",
      scopeId: "jsonb-live-scope",
    })).resolves.toBe("accepted");

    expect(typeof insertedValues?.[6]).toBe("string");
    expect(parseJson(insertedValues?.[6])).toEqual(["human-a", "human-b"]);
  });
});
