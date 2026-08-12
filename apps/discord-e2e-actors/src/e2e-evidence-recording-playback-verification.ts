import type { RetainedE2eEvidence } from "./e2e-evidence-schema.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";

export function verifyRecordingPlaybackEvidence(
  evidence: RetainedE2eEvidence,
  fail: VerificationFailureReporter,
): void {
  if (!("recordingPlayback" in evidence) || evidence.recordingPlayback === undefined) {
    return;
  }
  const playback = evidence.recordingPlayback;
  if (
    playback.manifest.recordingId !== evidence.recording.recordingId ||
    playback.resume.recordingId !== evidence.recording.recordingId
  ) {
    fail(
      "RECORDING_PLAYBACK_RECORDING_MISMATCH",
      "recording playback session is bound to a different authoritative recording",
    );
  }
  const tracksMatch = playback.tracks.length === evidence.recording.s3.tracks.length &&
    playback.tracks.every((track, index) => {
      const authoritativeTrack = evidence.recording.s3.tracks[index];
      return authoritativeTrack !== undefined && track.index === index &&
        track.statusCode === 206 &&
        track.checksumSha256 === authoritativeTrack.checksumSha256 &&
        track.contentLength === authoritativeTrack.sizeBytes &&
        track.contentRange ===
          `bytes 0-${authoritativeTrack.sizeBytes - 1}/${authoritativeTrack.sizeBytes}`;
    });
  if (!tracksMatch) {
    fail(
      "RECORDING_PLAYBACK_TRACK_MISMATCH",
      "recording playback bytes do not match every authoritative S3 track",
    );
  }
  const statuses = playback.manifest.statuses;
  const pending = statuses.slice(0, -1);
  if (
    statuses.at(-1) !== "ready" ||
    (playback.manifest.readinessExpectation === "already-ready"
      ? statuses.length !== 1
      : !pending.some((status) => status === "processing" || status === "unavailable"))
  ) {
    fail(
      "RECORDING_PLAYBACK_READINESS_NOT_PROVEN",
      "recording playback did not satisfy its explicit readiness transition gate",
    );
  }
  if (playback.resume.statusCode !== 200) {
    fail(
      "RECORDING_PLAYBACK_RESUME_NOT_PROVEN",
      "recording playback did not resume the stripped-fragment session",
    );
  }
  const serialized = JSON.stringify({
    description: evidence.publication.embedDescription,
    playback,
  });
  if (
    /https?:\/\/[^\s)"']+#/u.test(serialized) ||
    /v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(serialized)
  ) {
    fail(
      "RECORDING_PLAYBACK_CAPABILITY_RETAINED",
      "retained Discord recording proof contains possession capability material",
    );
  }
}
