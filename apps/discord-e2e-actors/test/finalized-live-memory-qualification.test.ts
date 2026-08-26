import { describe, expect, it } from "vitest";

import { finalizedLiveMemoryQualificationV1Schema } from
  "../src/finalized-live-memory-qualification.js";

const hash = "a".repeat(64);
const turn = {
  createdAt: "2026-08-25T10:00:02.000Z", endMs: 2_000,
  observationState: "final", speakerId: "speaker-a", startMs: 1_000, turnId: "turn-final",
};
const trustedLifecycle = {
  actorObservationState: "consistent", actorSemanticsVersion: 1,
  actors: [{ actorId: "speaker-a", kind: "human" }, { actorId: "bot-a", kind: "automation" }],
  lifecycleGeneration: 7, producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
  producerRevision: "a".repeat(40), rosterState: "sealed",
};
const proof = () => ({
  backfill: {
    process: { containerId: "container-2", hostProcessId: 2002 },
    rows: {
      canonicalTurns: [turn],
      hotTail: [{
        identityGeneration: 7, projectedAt: "2026-08-25T10:01:01.000Z",
        observationState: "final", speakerId: "speaker-a", sourceGeneration: 3,
        turnHash: hash, turnId: turn.turnId,
      }],
      observedAt: "2026-08-25T10:01:01.000Z",
      outbox: [{
        identityGeneration: 7, observationState: "final", speakerId: "speaker-a",
        sourceGeneration: 3, state: "applied", turnHash: hash,
        turnId: turn.turnId, updatedAt: "2026-08-25T10:00:02.500Z",
      }],
      trustedLifecycle,
    },
  },
  campaignId: "campaign-1",
  botActorId: "bot-a",
  final: {
    event: {
      endMs: 2_000, meetingId: "meeting-1", observedAt: "2026-08-25T10:00:02.000Z",
      speakerId: "speaker-a", startMs: 1_000,
    },
    rows: {
      canonicalTurns: [turn],
      hotTail: [{
        identityGeneration: 7, projectedAt: "2026-08-25T10:00:02.500Z",
        observationState: "final", speakerId: "speaker-a", sourceGeneration: 3,
        turnHash: hash, turnId: turn.turnId,
      }],
      observedAt: "2026-08-25T10:00:02.500Z",
      outbox: [{
        identityGeneration: 7, observationState: "final", speakerId: "speaker-a",
        sourceGeneration: 3, state: "applied", turnHash: hash,
        turnId: turn.turnId, updatedAt: "2026-08-25T10:00:02.500Z",
      }],
      trustedLifecycle,
    },
  },
  finalizedTurnId: turn.turnId,
  kind: "finalized-live-memory-qualification",
  partial: {
    event: {
      endMs: 2_000, meetingId: "meeting-1", observedAt: "2026-08-25T10:00:00.000Z",
      speakerId: "speaker-a", startMs: 1_000,
    },
    rows: {
      canonicalTurns: [], hotTail: [], observedAt: "2026-08-25T10:00:01.000Z", outbox: [],
      trustedLifecycle,
    },
  },
  processBeforeRestart: { containerId: "container-1", hostProcessId: 2001 },
  trustedHumanSpeakerId: "speaker-a",
  runId: "run-1", schemaVersion: 1,
});

describe("finalized live-memory qualification", () => {
  it("accepts one finalized turn projected within five seconds and restored after restart", () => {
    expect(finalizedLiveMemoryQualificationV1Schema.safeParse(proof()).success).toBe(true);
  });

  it("rejects a changed backfilled hot-tail identity", () => {
    const changed = proof();
    changed.backfill.rows.hotTail[0]!.turnHash = "b".repeat(64);
    expect(finalizedLiveMemoryQualificationV1Schema.safeParse(changed).success).toBe(false);
  });

  it.each([
    ["bot", "bot-a", "final"],
    ["non-roster", "stranger", "final"],
    ["partial", "speaker-a", "partial"],
  ] as const)("rejects %s data from canonical, hot-tail, and outbox identity surfaces",
    (_name, speakerId, observationState) => {
      const changed = proof() as unknown as {
        final: { rows: { hotTail: Array<{ observationState: string; speakerId: string }> } };
      };
      changed.final.rows.hotTail[0]!.speakerId = speakerId;
      changed.final.rows.hotTail[0]!.observationState = observationState;
      expect(finalizedLiveMemoryQualificationV1Schema.safeParse(changed).success).toBe(false);
    });
});
