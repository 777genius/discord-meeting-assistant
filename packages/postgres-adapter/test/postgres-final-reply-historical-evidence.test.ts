import {
  admitAcceptedFinalMeeting,
  buildHistoricalIndexPlan,
  createHistoricalReleaseBinding,
  type FocusedMemoryReference,
  type HistoricalOpaqueIdPort,
  type QuestionBindingSnapshot,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { loadCurrentHistoricalReferenceBatch } from
  "../src/postgres-final-reply-historical-evidence.js";

class TestIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    return `${namespace}:${parts.join("|")}`;
  }
}

function fixture() {
  const release = createHistoricalReleaseBinding({
    acceptedMeetingRevision: 9,
    desiredGeneration: 1,
    meetingId: "current-meeting",
    roomId: "room-1",
    scopeId: "scope-1",
    transcriptId: "current-transcript",
    transcriptVersion: 2,
  });
  const meeting = admitAcceptedFinalMeeting({
    actors: [{ actorId: "speaker-1", kind: "human" }],
    authoritativeDurationMs: 60_000,
    binding: release,
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "test-r1",
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingRevision: 9,
    roomId: release.roomId,
    scopeId: release.scopeId,
    transcriptId: release.transcriptId,
    transcriptVersion: release.transcriptVersion,
    turns: [{ endMs: 2_000, speakerId: "speaker-1", startMs: 1_000,
      text: "The release is Monday.", turnId: "turn-1" }],
  });
  if (meeting === null) {throw new Error("current meeting fixture was not admitted");}
  const plan = buildHistoricalIndexPlan(meeting, new TestIds());
  const manifest = plan.documents[0]?.manifest;
  const source = manifest?.turnSources[0];
  if (manifest === undefined || source === undefined) {
    throw new Error("current meeting plan has no source range");
  }
  const binding = {
    meetingId: release.meetingId,
    meetingRevision: release.acceptedMeetingRevision,
    roomId: release.roomId,
    scopeId: release.scopeId,
    transcriptId: release.transcriptId,
    transcriptVersion: release.transcriptVersion,
  } as QuestionBindingSnapshot;
  const reference: FocusedMemoryReference = {
    historicalSource: {
      candidateLocator: manifest.candidateLocator,
      indexGeneration: plan.topology.indexGeneration,
      releaseId: release.releaseId,
    },
    meetingId: release.meetingId,
    sourceEndCodePoint: source.sourceEndCodePoint,
    sourceStartCodePoint: source.sourceStartCodePoint,
    transcriptId: release.transcriptId,
    transcriptVersion: release.transcriptVersion,
    turnHash: "a".repeat(64),
    turnId: source.turnId,
  };
  const pool = {
    query: async (statement: string) => statement.includes("historical_memory_sync")
      ? { rows: [{
          meeting_id: release.meetingId,
          plan,
          release_id: release.releaseId,
          room_id: release.roomId,
          scope_id: release.scopeId,
          transcript_id: release.transcriptId,
          transcript_version: release.transcriptVersion,
        }] }
      : { rows: [] },
  } as unknown as Pool;
  return { binding, plan, pool, reference };
}

describe("PostgreSQL current-meeting indexed reference authority", () => {
  it("accepts only the exact current release, plan, source range, and binding", async () => {
    const { binding, plan, pool, reference } = fixture();
    const exact = await loadCurrentHistoricalReferenceBatch(pool, binding, [reference]);

    expect(exact.rows).toEqual([]);
    expect(exact.validReferences.has(reference)).toBe(true);

    const mismatches: FocusedMemoryReference[] = [
      { ...reference, historicalSource: { ...reference.historicalSource!,
        releaseId: "wrong-release" } },
      { ...reference, historicalSource: { ...reference.historicalSource!,
        candidateLocator: "wrong-locator" } },
      { ...reference, historicalSource: { ...reference.historicalSource!,
        indexGeneration: "wrong-generation" } },
      { ...reference, sourceEndCodePoint: reference.sourceEndCodePoint! + 1 },
    ];
    for (const mismatch of mismatches) {
      const batch = await loadCurrentHistoricalReferenceBatch(pool, binding, [mismatch]);
      expect(batch.validReferences.has(mismatch)).toBe(false);
    }

    const staleBinding = { ...binding,
      meetingRevision: plan.binding.acceptedMeetingRevision + 1 };
    const stale = await loadCurrentHistoricalReferenceBatch(
      pool,
      staleBinding,
      [reference],
    );
    expect(stale.validReferences.has(reference)).toBe(false);

    for (const mismatchedBinding of [
      { ...binding, roomId: "wrong-room" },
      { ...binding, scopeId: "wrong-scope" },
      { ...binding, transcriptId: "wrong-transcript" },
      { ...binding, transcriptVersion: binding.transcriptVersion + 1 },
    ]) {
      const batch = await loadCurrentHistoricalReferenceBatch(
        pool,
        mismatchedBinding,
        [reference],
      );
      expect(batch.validReferences.has(reference)).toBe(false);
    }
  });
});
