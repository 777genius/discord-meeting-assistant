import type { AuthoritativeTrackUploadMetadata } from "@discord-meeting/craig-gateway-contracts";
import type { RecordingArtifactSnapshot } from "@discord-meeting/meeting-core";

export interface RecordingBinaryArtifactWriteRequest {
  readonly body: AsyncIterable<Uint8Array> | Uint8Array;
  readonly checksumSha256: string;
  readonly contentType: string;
  readonly locator: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly sizeBytes: number;
}

export interface RecordingBinaryArtifactWriteReceipt {
  readonly checksumSha256: string;
  readonly locator: string;
  readonly sizeBytes: number;
}

/**
 * Consumer-owned port. The object-storage adapter satisfies it structurally;
 * recording ingress does not select or import an AWS implementation.
 */
export interface RecordingBinaryArtifactWriter {
  write(
    request: RecordingBinaryArtifactWriteRequest,
  ): Promise<RecordingBinaryArtifactWriteReceipt>;
}

export interface RecordingIngressLimits {
  readonly maxActiveRecordings: number;
  readonly maxBatchOpusBytes: number;
  readonly maxLifecycleEventsPerRecording: number;
  readonly maxOpusBytesPerPacket: number;
  readonly maxPacketsPerBatch: number;
  readonly maxPacketsPerRecording: number;
  readonly maxPacketsPerSpeaker: number;
  readonly maxRecordingOpusBytes: number;
  readonly maxSpeakerOpusBytes: number;
  readonly maxSpeakersPerRecording: number;
}

export interface DurableCraigRecordingIngressOptions {
  readonly artifactLocatorPrefix: string;
  readonly limits?: Partial<RecordingIngressLimits>;
  /**
   * One live ingress owner must have exclusive write authority for a spool
   * root. Horizontal scaling shards recordings across distinct spool roots.
   */
  readonly spoolRoot: string;
  readonly writer: RecordingBinaryArtifactWriter;
}

export interface AuthoritativeTrackIngressResult {
  readonly locator: string;
  readonly recordingId: string;
  readonly replayed: boolean;
  readonly speakerId: string;
}

export interface AuthoritativeTrackIngressPort {
  ingestAuthoritativeTrack(
    metadata: AuthoritativeTrackUploadMetadata,
    body: AsyncIterable<Uint8Array>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AuthoritativeTrackIngressResult>;
}

export interface PacketBatchIngressResult {
  readonly acceptedPackets: number;
  readonly duplicatePackets: number;
  readonly recordingId: string;
}

export type LifecycleIngressResult =
  | {
      readonly kind: "accepted";
      readonly recordingId: string;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "aborted";
      readonly recordingId: string;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "finalized";
      readonly recording: RecordingArtifactSnapshot;
      readonly replayed: boolean;
    };

export interface OggOpusPageSummary {
  readonly bodyLength: number;
  readonly granulePosition: bigint;
  readonly headerType: number;
  readonly sequence: number;
  readonly serial: number;
}

export interface OggOpusValidationResult {
  readonly pages: readonly OggOpusPageSummary[];
  readonly serial: number;
}
