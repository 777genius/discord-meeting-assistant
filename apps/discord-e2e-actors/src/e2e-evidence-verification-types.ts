import type {
  FixtureManifestV1,
  RetainedE2eEvidence,
} from "./e2e-evidence-schema.js";

export interface VerificationFailure {
  readonly code: string;
  readonly message: string;
}

export interface SpeakerAccuracyMetrics {
  readonly characterErrorRate: number;
  readonly speakerId: string;
  readonly wordErrorRate: number;
}

export interface E2eVerificationResult {
  readonly failures: readonly VerificationFailure[];
  readonly metrics: readonly SpeakerAccuracyMetrics[];
  readonly passed: boolean;
}

export interface CampaignVerificationResult {
  readonly failures: readonly VerificationFailure[];
  readonly passed: boolean;
  readonly runResults: Readonly<Record<string, E2eVerificationResult>>;
}

export interface PlaybackWindow {
  readonly actorName: string;
  readonly endMs: number;
  readonly fixtureId: string;
  readonly startMs: number;
}

export type VerificationFailureReporter = (code: string, message: string) => void;

export interface ActorRunVerificationContext {
  readonly evidence: RetainedE2eEvidence;
  readonly fail: VerificationFailureReporter;
  readonly manifest: FixtureManifestV1;
  readonly playbackWindows: readonly PlaybackWindow[];
  readonly scenario: FixtureManifestV1["scenarios"][number];
}

export interface TranscriptVerificationContext extends ActorRunVerificationContext {
  readonly metrics: SpeakerAccuracyMetrics[];
}
