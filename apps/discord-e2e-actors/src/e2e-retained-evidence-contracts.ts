import type {
  CollectedConversationLifecycleEvidence,
  CurrentDeploymentProvenance,
  ProcessingEvidence,
} from "./e2e-evidence-schema.js";
import type { RecordingPlaybackEvidenceProbe } from "./recording-playback-evidence-probe.js";

export interface DatabaseObservation {
  readonly matchingMeetingCount: number;
  readonly matchingRecordingCount: number;
  readonly matchingSummaryCount: number;
  readonly matchingTranscriptCount: number;
  readonly snapshot: unknown;
}

interface S3TrackEvidence {
  readonly checksumSha256: string;
  readonly durationMs: number;
  readonly locator: string;
  readonly sizeBytes: number;
  readonly speakerId: string;
  readonly timelineOffsetMs: number;
}

export interface S3RecordingEvidence {
  readonly endedAt: string;
  readonly manifestChecksumSha256: string;
  readonly manifestLocator: string;
  readonly recordingId: string;
  readonly sourceChecksumSha256: string;
  readonly startedAt: string;
  readonly tracks: readonly S3TrackEvidence[];
}

export interface ReplayJobEvidence {
  readonly afterProcessedOn: number;
  readonly beforeProcessedOn: number;
  readonly jobId: string;
  readonly state: "completed";
}

export interface ReplayTargetAttestation {
  readonly fixtureSetId: string;
  readonly recordingId: string;
  readonly runId: string;
}

export interface DeploymentEvidenceProbe {
  assertRecordingPlaybackTargetSafe(input: {
    readonly meetingPlatformContainerId: string;
    readonly origin: string;
    readonly scope: string;
  }): Promise<void>;
  assertReplayTargetSafe(attestation: ReplayTargetAttestation): Promise<void>;
  collectConversationLifecycle?(
    meetingId: string,
    recordingStartedAt: string,
  ): Promise<CollectedConversationLifecycleEvidence>;
  collectDatabase(recordingId: string): Promise<DatabaseObservation>;
  collectProcessing(meetingId: string, recordingStartedAt: string): Promise<ProcessingEvidence>;
  collectProvenance(): Promise<CurrentDeploymentProvenance>;
  collectS3(manifestLocator: string, recordingId: string): Promise<S3RecordingEvidence>;
  replayPostCall(attestation: ReplayTargetAttestation): Promise<ReplayJobEvidence>;
}

export interface DiscordProjectionObservation {
  readonly matchingMessages: readonly DiscordProjectionMessageObservation[];
  readonly matchingThreadIds: readonly string[];
}

export type DiscordProjectionContainerObservation =
  | { readonly kind: "channel-message"; readonly parentChannelId: string }
  | { readonly kind: "thread"; readonly parentChannelId: string; readonly threadId: string };

interface DiscordProjectionAttachmentObservation {
  readonly filename: string;
  readonly sizeBytes: number;
}

export interface DiscordProjectionMessageObservation {
  readonly attachments: readonly DiscordProjectionAttachmentObservation[];
  readonly container: DiscordProjectionContainerObservation;
  readonly embedDescription: string;
  readonly messageId: string;
  /** Capability-bearing transient input. Never retain or log this URL. */
  readonly recordingPlaybackUrl: string;
}

export interface DiscordEvidenceProbe {
  inspect(parentChannelId: string, marker: string): Promise<DiscordProjectionObservation>;
}

export interface CollectEvidenceInput {
  readonly actorRun: unknown;
  readonly conversation?: {
    readonly botSpeakerId: string;
    readonly reconnectParticipantId: string;
    readonly supplementalPlayback: unknown;
    readonly voice: readonly unknown[];
  };
  readonly fixtureSetId: string;
  readonly recordingId: string;
  readonly recordingPlayback: RecordingPlaybackEvidenceProbe;
  readonly recordingPlaybackOrigin: string;
  readonly recordingPlaybackReadiness: "already-ready" | "transition";
  readonly recordingPlaybackTestScope: "private-test-deployment";
  readonly runId: string;
}
