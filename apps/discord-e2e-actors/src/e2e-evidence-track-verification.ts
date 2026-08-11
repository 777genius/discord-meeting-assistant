import type { RetainedE2eEvidenceV8 } from "./e2e-evidence-schema.js";

export interface EvidenceInterval {
  readonly endMs: number;
  readonly startMs: number;
}

export type TrackCoverageIssue = "interval-outside-track" | "track-missing" | undefined;

export function authoritativeTrackCoverage(
  evidence: Pick<RetainedE2eEvidenceV8, "recording">,
  speakerId: string,
  intervals: readonly EvidenceInterval[],
  timestampToleranceMs: number,
): TrackCoverageIssue {
  const tracks = evidence.recording.s3.tracks.filter((track) => track.speakerId === speakerId);
  const track = tracks[0];
  if (tracks.length !== 1 || track === undefined) {
    return "track-missing";
  }
  const toleranceMs = Math.min(timestampToleranceMs, 250);
  const trackStartMs = track.timelineOffsetMs - toleranceMs;
  const trackEndMs = track.timelineOffsetMs + track.durationMs + toleranceMs;
  return intervals.some(({ endMs, startMs }) => startMs < trackStartMs || endMs > trackEndMs)
    ? "interval-outside-track"
    : undefined;
}
