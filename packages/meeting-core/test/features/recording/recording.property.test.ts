import {
  createFastCheckParameters,
  normalizeDeterministicSeedBank,
  normalizePropertyReplayEvidence,
  type PropertyReplayEvidence,
} from "@agent-teams/engineering-foundation";
import {
  array,
  assert,
  constantFrom,
  nat,
  property,
  record,
  uniqueArray,
} from "fast-check";
import { describe, expect, it } from "vitest";

import { RecordingArtifact } from "@discord-meeting/meeting-core/recording";

const seedBank = normalizeDeterministicSeedBank({
  numRuns: 100,
  propertyId: "meeting.recording-artifact-round-trip",
  schemaVersion: 1,
  seeds: [-1_694_203_117, 842_177_031],
});

const token = array(constantFrom(...Array.from("abcdefghijklmnopqrstuvwxyz0123456789-")), {
    maxLength: 32,
    minLength: 1,
  })
  .map((characters) => characters.join(""));

const recordingArtifactSnapshot = record({
  authoritativeDurationMs: nat({ max: Number.MAX_SAFE_INTEGER }),
  manifestChecksumSha256: constantFrom("c".repeat(64), "d".repeat(64)),
  manifestLocator: token.map((value) => `recordings/${value}/manifest.json`),
  manifestRevision: token.map((value) => `revision-${value}`),
  manifestSizeBytes: nat({ max: Number.MAX_SAFE_INTEGER - 1 }).map((value) => value + 1),
  recordingId: token,
  speakerAudio: uniqueArray(
    record({
      artifactRevision: token.map((value) => `revision-${value}`),
      audioLocator: token.map((value) => `recordings/tracks/${value}.ogg`),
      checksumSha256: constantFrom("a".repeat(64), "b".repeat(64)),
      sizeBytes: nat({ max: Number.MAX_SAFE_INTEGER - 1 }).map((value) => value + 1),
      speakerId: token,
      timelineOffsetMs: nat({ max: Number.MAX_SAFE_INTEGER }),
    }),
    { maxLength: 20, selector: ({ audioLocator }) => audioLocator },
  ),
});

function requestedReplay(): PropertyReplayEvidence | undefined {
  const input = process.env["FAST_CHECK_REPLAY"];
  if (input === undefined) {
    return undefined;
  }
  return normalizePropertyReplayEvidence(JSON.parse(input) as PropertyReplayEvidence);
}

describe("RecordingArtifact properties", () => {
  it("round-trips every valid snapshot with deterministic replay evidence", () => {
    const replay = requestedReplay();
    const seeds = replay === undefined ? seedBank.seeds : [replay.seed];
    for (const seed of seeds) {
      assert(
        property(recordingArtifactSnapshot, (snapshot) => {
          const artifact = RecordingArtifact.create(snapshot);

          expect(artifact.toSnapshot()).toEqual(snapshot);
          expect(RecordingArtifact.create(artifact.toSnapshot()).equals(artifact)).toBe(true);
        }),
        createFastCheckParameters(seedBank, seed, replay),
      );
    }
  });

  it("keeps legacy snapshots without authoritative duration backward-compatible", () => {
    const snapshot = {
      manifestLocator: "recordings/legacy/manifest.json",
      recordingId: "legacy-recording",
      speakerAudio: [],
    };

    expect(RecordingArtifact.create(snapshot).toSnapshot()).toEqual(snapshot);
  });

  it("rejects duplicate speaker IDs independently from locators", () => {
    expect(() => RecordingArtifact.create({
      manifestLocator: "recordings/manifest.json",
      recordingId: "recording-1",
      speakerAudio: [
        { audioLocator: "recordings/a.ogg", speakerId: "speaker-1", timelineOffsetMs: 0 },
        { audioLocator: "recordings/b.ogg", speakerId: "speaker-1", timelineOffsetMs: 1 },
      ],
    })).toThrow("speaker IDs must be unique");
  });

  it("rejects partial or mutable artifact identities", () => {
    const base = {
      audioLocator: "recordings/track.ogg",
      speakerId: "speaker-1",
      timelineOffsetMs: 0,
    };
    expect(() => RecordingArtifact.create({
      manifestLocator: "recordings/manifest.json",
      recordingId: "recording-1",
      speakerAudio: [{ ...base, artifactRevision: "revision-1" }],
    })).toThrow("immutable identity must be complete");
    expect(() => RecordingArtifact.create({
      manifestLocator: "recordings/manifest.json",
      recordingId: "recording-1",
      speakerAudio: [{
        ...base,
        artifactRevision: "null",
        checksumSha256: "a".repeat(64),
        sizeBytes: 10,
      }],
    })).toThrow("immutable identity is invalid");
    expect(() => RecordingArtifact.create({
      manifestLocator: "recordings/manifest.json",
      manifestRevision: "version-1",
      recordingId: "recording-1",
      speakerAudio: [],
    })).toThrow("manifest immutable identity must be complete");
  });
});
