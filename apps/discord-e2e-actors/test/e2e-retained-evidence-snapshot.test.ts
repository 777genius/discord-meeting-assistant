import { describe, expect, it } from "vitest";

import type { UnboundActorRunEvidenceV1 } from "../src/e2e-evidence-schema.js";
import { bindActorRun } from "../src/e2e-retained-evidence-snapshot.js";
import type { S3RecordingEvidence } from "../src/e2e-retained-evidence-contracts.js";

const recordingStartedAtMs = 1_000_000;

describe("actor run recording correlation", () => {
  it("admits bounded connection-ready pre-roll without relaxing playback timing", () => {
    const result = bindActorRun(actorRun([
      { actorName: "speaker-a", atEpochMs: recordingStartedAtMs - 10_000, type: "ready" },
      {
        actorName: "speaker-a",
        atEpochMs: recordingStartedAtMs + 1_000,
        fixtureId: "speaker-a",
        type: "playback-start",
      },
    ]), "recording-1", recording());

    expect(result.events).toEqual([
      { actorName: "speaker-a", atRecordingMs: 0, type: "ready" },
      {
        actorName: "speaker-a",
        atRecordingMs: 1_000,
        fixtureId: "speaker-a",
        type: "playback-start",
      },
    ]);
  });

  it("rejects playback before the authoritative recording window", () => {
    expect(() => bindActorRun(actorRun([{
      actorName: "speaker-a",
      atEpochMs: recordingStartedAtMs - 1,
      fixtureId: "speaker-a",
      type: "playback-start",
    }]), "recording-1", recording())).toThrow(
      "Actor event is outside the authoritative recording window",
    );
  });

  it("rejects an unbounded ready pre-roll", () => {
    expect(() => bindActorRun(actorRun([{
      actorName: "speaker-a",
      atEpochMs: recordingStartedAtMs - 30_001,
      type: "ready",
    }]), "recording-1", recording())).toThrow(
      "Actor event is outside the authoritative recording window",
    );
  });
});

function actorRun(
  events: UnboundActorRunEvidenceV1["events"],
): UnboundActorRunEvidenceV1 {
  return {
    events,
    fixtureSetId: "fixture-set",
    fixtures: [
      {
        audioSha256: "a".repeat(64),
        durationMs: 1_000,
        fixtureId: "speaker-a",
        sourceSha256: "b".repeat(64),
      },
      {
        audioSha256: "c".repeat(64),
        durationMs: 1_000,
        fixtureId: "speaker-b",
        sourceSha256: "d".repeat(64),
      },
    ],
    recordingId: null,
    runId: "run-1",
    scenario: "sequential",
    schemaVersion: 1,
    timelineOrigin: "unix-epoch",
  };
}

function recording(): S3RecordingEvidence {
  return {
    endedAt: new Date(recordingStartedAtMs + 60_000).toISOString(),
    manifestChecksumSha256: "e".repeat(64),
    manifestLocator: "s3://meeting-artifacts/recording-1/manifest.json",
    recordingId: "recording-1",
    sourceChecksumSha256: "f".repeat(64),
    startedAt: new Date(recordingStartedAtMs).toISOString(),
    tracks: [],
  };
}
