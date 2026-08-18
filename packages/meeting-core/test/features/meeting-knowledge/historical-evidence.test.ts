import { describe, expect, it } from "vitest";

import {
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  HistoricalEvidenceInvariantError,
  admitAcceptedFinalMeeting,
  admitsHistoricalRetrieval,
  buildHistoricalIndexPlan,
  classifyHistoricalGroundingMode,
  createHistoricalReleaseBinding,
  decodeHistoricalIndexPlanV1,
  rehydrateHistoricalBlock,
  type HistoricalOpaqueIdPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";

class DeterministicTestIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    let hash = 2_166_136_261;
    for (const character of `${namespace}\u0000${parts.join("\u0000")}`) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
}

function acceptedMeeting() {
  const binding = createHistoricalReleaseBinding({
    acceptedMeetingRevision: 7,
    desiredGeneration: 2,
    meetingId: "meeting-private-id",
    roomId: "room-private-id",
    scopeId: "guild-private-id",
    transcriptId: "transcript-private-id",
    transcriptVersion: 3,
  });
  return admitAcceptedFinalMeeting({
    actors: [
      { actorId: "human-a", kind: "human" },
      { actorId: "botik", kind: "automation" },
      { actorId: "unverified", kind: "unknown" },
    ],
    binding,
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "fixture-r1",
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingRevision: 7,
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion: binding.transcriptVersion,
    turns: [
      { endMs: 2_000, speakerId: "botik", startMs: 1_000, text: "generated answer", turnId: "b" },
      { endMs: 1_000, speakerId: "human-a", startMs: 0, text: "accepted human evidence", turnId: "a" },
      { endMs: 3_000, speakerId: "unverified", startMs: 2_000, text: "unknown actor", turnId: "c" },
    ],
  });
}

describe("historical evidence admission and block identity", () => {
  it("admits only final turns positively bound to human actors", () => {
    const meeting = acceptedMeeting();

    expect(meeting?.humanTurns).toEqual([
      expect.objectContaining({ text: "accepted human evidence", turnId: "a" }),
    ]);
    expect(JSON.stringify(meeting)).not.toContain("generated answer");
    expect(JSON.stringify(meeting)).not.toContain("unknown actor");
  });

  it("denies legacy evidence and fails closed on a stale release binding", () => {
    const meeting = acceptedMeeting();
    expect(meeting).not.toBeNull();
    if (meeting === null) {
      throw new Error("fixture admission failed");
    }
    expect(admitAcceptedFinalMeeting({
      actors: null,
      binding: meeting.binding,
      identityProvenance: null,
      lifecycleGeneration: null,
      meetingRevision: 7,
      roomId: meeting.binding.roomId,
      scopeId: meeting.binding.scopeId,
      transcriptId: meeting.binding.transcriptId,
      transcriptVersion: meeting.binding.transcriptVersion,
      turns: [],
    })).toBeNull();
    expect(() => admitAcceptedFinalMeeting({
      actors: [{ actorId: "human-a", kind: "human" }],
      binding: meeting.binding,
      identityProvenance: {
        actorObservationState: "consistent",
        actorSemanticsVersion: 1,
        producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
        producerRevision: "fixture-r1",
        rosterState: "sealed",
      },
      lifecycleGeneration: 3,
      meetingRevision: 7,
      roomId: "another-room",
      scopeId: meeting.binding.scopeId,
      transcriptId: meeting.binding.transcriptId,
      transcriptVersion: meeting.binding.transcriptVersion,
      turns: meeting.humanTurns,
    })).toThrow(expect.objectContaining({
      code: "CONFLICTING_BINDING",
      name: HistoricalEvidenceInvariantError.name,
    }));
  });

  it("keeps long-meeting retrieval independently disabled at exact authoritative thresholds", () => {
    const short = acceptedMeeting();
    if (short === null) {
      throw new Error("fixture admission failed");
    }
    const durationThreshold = Object.freeze({
      ...short,
      authoritativeDurationMs:
        DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE.minimumDurationMs,
    });
    const turnThreshold = Object.freeze({
      ...short,
      humanTurns: Object.freeze(Array.from(
        { length: DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE.minimumHumanTurnCount },
        (_, index) => Object.freeze({
          ...short.humanTurns[0]!,
          endMs: index * 2 + 2,
          startMs: index * 2 + 1,
          turnId: `long-turn-${index}`,
        }),
      )),
    });

    expect(admitsHistoricalRetrieval(short)).toBe(true);
    expect(admitsHistoricalRetrieval(durationThreshold)).toBe(false);
    expect(admitsHistoricalRetrieval(turnThreshold)).toBe(false);
    expect(admitsHistoricalRetrieval(durationThreshold, {
      ...DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
      qualification: {
        evidenceSha256: "e".repeat(64),
        releaseRevision: "f".repeat(40),
        rolloutEpoch: "test-r1",
        schemaVersion: 1,
      },
    })).toBe(true);
  });

  it("builds replay-stable opaque topology and turn-aligned documents", () => {
    const meeting = acceptedMeeting();
    if (meeting === null) {
      throw new Error("fixture admission failed");
    }
    const ids = new DeterministicTestIds();
    const first = buildHistoricalIndexPlan(meeting, ids);
    const replay = buildHistoricalIndexPlan(meeting, ids);

    expect(replay).toEqual(first);
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0]?.manifest.turnIds).toEqual(["a"]);
    expect(first.documents[0]?.remoteText).toContain("accepted human evidence");
    expect(JSON.stringify(first.topology)).not.toContain("private-id");
    expect(decodeHistoricalIndexPlanV1(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(() => decodeHistoricalIndexPlanV1({ ...first, unexpected: true }))
      .toThrow("unknown field");
    expect(() => decodeHistoricalIndexPlanV1({
      ...first,
      documents: [{ ...first.documents[0], providerMetadata: "untrusted" }],
    })).toThrow("unknown field");
    expect(rehydrateHistoricalBlock(meeting, first, 0, ids).turns).toEqual(meeting.humanTurns);
  });

  it.each([
    "Count every action item across all meetings",
    "Were there no mentions of Project Cedar?",
    "Сколько раз это обсуждали во всю историю?",
    "Give me the complete list",
    "List the decisions from these meetings",
    "Summarize the project history",
    "Какие решения были приняты?",
    "Перечисли риски проекта",
  ])("routes exhaustive truth claims away from top-k: %s", (question) => {
    expect(classifyHistoricalGroundingMode(question)).toBe("exhaustive_coverage");
  });

  it("keeps focused lookup as the bounded default", () => {
    expect(classifyHistoricalGroundingMode("What date did Maya propose for launch?"))
      .toBe("focused_retrieval");
  });
});
