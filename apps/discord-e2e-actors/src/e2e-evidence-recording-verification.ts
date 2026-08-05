import type {
  FixtureManifestV1,
  RetainedE2eEvidence,
} from "./e2e-evidence-schema.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";

export function verifyFixtures(
  manifest: FixtureManifestV1,
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  const retainedById = new Map(evidence.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const actorById = new Map(evidence.actorRun.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  if (retainedById.size !== evidence.fixtures.length) {
    fail("DUPLICATE_FIXTURE", "retained evidence contains duplicate fixture IDs");
  }

  for (const fixture of manifest.fixtures) {
    const retained = retainedById.get(fixture.fixtureId);
    if (retained === undefined) {
      fail("MISSING_FIXTURE", `fixture ${fixture.fixtureId} has no retained integrity evidence`);
      continue;
    }
    if (retained.sourceSha256 !== fixture.sourceSha256) {
      fail("SOURCE_HASH_MISMATCH", `fixture ${fixture.fixtureId} source hash changed`);
    }
    if (retained.audioSha256 !== fixture.audioSha256) {
      fail("AUDIO_HASH_MISMATCH", `fixture ${fixture.fixtureId} audio hash changed`);
    }
    if (retained.durationMs !== fixture.durationMs) {
      fail("FIXTURE_DURATION_MISMATCH", `fixture ${fixture.fixtureId} duration changed`);
    }
    const actorFixture = actorById.get(fixture.fixtureId);
    if (
      actorFixture === undefined ||
      actorFixture.audioSha256 !== retained.audioSha256 ||
      actorFixture.sourceSha256 !== retained.sourceSha256 ||
      actorFixture.durationMs !== retained.durationMs
    ) {
      fail("ACTOR_FIXTURE_MISMATCH", `actor proof for ${fixture.fixtureId} is absent or changed`);
    }
  }

  const expectedIds = new Set(manifest.fixtures.map(({ fixtureId }) => fixtureId));
  for (const retained of evidence.fixtures) {
    if (!expectedIds.has(retained.fixtureId)) {
      fail("UNKNOWN_FIXTURE", `retained fixture ${retained.fixtureId} is not in the manifest`);
    }
  }
  if (new Set(evidence.fixtures.map(({ audioSha256 }) => audioSha256)).size !== evidence.fixtures.length) {
    fail("DUPLICATE_AUDIO_HASH", "different speaker fixtures must not share one audio hash");
  }
}

export function verifyS3Evidence(
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  const s3 = evidence.recording.s3;
  if (Date.parse(evidence.recording.endedAt) <= Date.parse(evidence.recording.startedAt)) {
    fail("INVALID_RECORDING_INTERVAL", "authoritative recording must end after it starts");
  }
  const speakers = new Set(s3.tracks.map(({ speakerId }) => speakerId));
  if (speakers.size !== s3.tracks.length) {
    fail("DUPLICATE_S3_TRACK", "S3 manifest contains duplicate speaker tracks");
  }
  if (s3.manifestLocator.length === 0 || s3.sourceChecksumSha256.length !== 64) {
    fail("INVALID_S3_MANIFEST", "authoritative S3 manifest proof is incomplete");
  }
  const recordingMediaOriginMs = Math.min(
    ...s3.tracks.map(({ timelineOffsetMs }) => timelineOffsetMs),
  );
  const durationMs = recordingMediaOriginMs + Math.max(
    ...s3.tracks.map(({ durationMs: trackDurationMs }) => trackDurationMs),
  );
  if (Math.abs(durationMs - evidence.recording.durationMs) > 1) {
    fail("S3_DURATION_MISMATCH", "recording duration does not match verified S3 tracks");
  }
  const expectedSpeakers = new Set(evidence.recording.speakerIds);
  if (
    speakers.size !== expectedSpeakers.size ||
    [...speakers].some((speakerId) => !expectedSpeakers.has(speakerId))
  ) {
    fail("S3_SPEAKER_MISMATCH", "S3 tracks do not match recording speakers");
  }
}

export function verifyStages(
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  for (const required of ["transcription", "summary", "publication"] as const) {
    const matches = evidence.stages.filter(({ stage }) => stage === required);
    if (matches.length !== 1) {
      fail("INVALID_STAGE_PROOF", `expected exactly one succeeded ${required} stage snapshot`);
    }
  }
}
