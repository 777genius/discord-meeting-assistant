import {
  type RecordingArtifactSnapshot,
} from "@discord-meeting/meeting-core/recording";

/**
 * Consumer-owned commands accepted by the Meeting Platform application edge.
 * Provider adapters validate their wire contracts and normalize source identity
 * and audio before invoking this boundary.
 */

export interface RecordingSource {
  /** Provider-owned tenant, workspace, or installation identity. */
  readonly scopeId: string;
  /** Provider-owned room or call identity within the source scope. */
  readonly roomId: string;
}

type RecordingActorKind = "automation" | "human" | "unknown";

interface RecordingActor {
  readonly actorId: string;
  readonly kind: RecordingActorKind;
}

type RecordingActorObservationState = "consistent" | "conflicted";
type RecordingRosterState = "sealed" | "unsealed";

interface RecordingIdentityProvenance {
  readonly actorObservationState: RecordingActorObservationState;
  readonly actorSemanticsVersion: number;
  readonly producerCapabilityId: string;
  readonly producerRevision: string;
  readonly rosterState: RecordingRosterState;
}

interface DerivedLiveMemoryIdentity {
  readonly actors: readonly RecordingActor[];
  readonly identityProvenance: RecordingIdentityProvenance;
  readonly lifecycleGeneration: 3;
  readonly roomId: string;
  readonly scopeId: string;
}

interface RecordingLifecycleEnvelope {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly recordingId: string;
  readonly source: RecordingSource;
}

interface TrustedRecordingLifecycleEnvelope extends RecordingLifecycleEnvelope {
  readonly actorObservationState: RecordingActorObservationState;
  readonly actorSemanticsVersion: number;
  readonly producerCapabilityId: string;
  readonly producerRevision: string;
  readonly schemaVersion: 3;
}

export type RecordingLifecycleCommand =
  | (RecordingLifecycleEnvelope & {
      readonly participantIds: string[];
      readonly schemaVersion: 1;
      readonly type: "meeting.started";
    })
  | (RecordingLifecycleEnvelope & {
      readonly participantId: string;
      readonly schemaVersion: 1;
      readonly type: "participant.joined" | "participant.left";
    })
  | (RecordingLifecycleEnvelope & {
      readonly reason: string | null;
      readonly schemaVersion: 1;
      readonly type: "meeting.connection_lost" | "meeting.connection_recovered";
    })
  | (RecordingLifecycleEnvelope & {
      readonly reason: string | null;
      readonly schemaVersion: 1;
      readonly type: "meeting.ended" | "meeting.aborted";
    })
  | (RecordingLifecycleEnvelope & {
      readonly endedAt: string;
      readonly multitrackManifestKey: string;
      readonly schemaVersion: 1;
      readonly type: "recording.artifact_ready";
      readonly usersManifestKey: string;
    })
  | (RecordingLifecycleEnvelope & {
      readonly endedAt: string;
      readonly schemaVersion: 1;
      readonly sourceFilesChecksumSha256: string;
      readonly trackCount: number;
      readonly type: "recording.authoritative_ready";
    })
  | (RecordingLifecycleEnvelope & {
      readonly actors: readonly RecordingActor[];
      readonly schemaVersion: 2;
      readonly type: "meeting.started";
    })
  | (RecordingLifecycleEnvelope & {
      readonly actor: RecordingActor;
      readonly schemaVersion: 2;
      readonly type: "participant.joined" | "participant.left";
    })
  | (RecordingLifecycleEnvelope & {
      readonly reason: string | null;
      readonly schemaVersion: 2;
      readonly type: "meeting.connection_lost" | "meeting.connection_recovered";
    })
  | (RecordingLifecycleEnvelope & {
      readonly reason: string | null;
      readonly schemaVersion: 2;
      readonly type: "meeting.ended" | "meeting.aborted";
    })
  | (RecordingLifecycleEnvelope & {
      readonly endedAt: string;
      readonly multitrackManifestKey: string;
      readonly schemaVersion: 2;
      readonly type: "recording.artifact_ready";
      readonly usersManifestKey: string;
    })
  | (RecordingLifecycleEnvelope & {
      readonly actors: readonly RecordingActor[];
      readonly endedAt: string;
      readonly schemaVersion: 2;
      readonly sourceFilesChecksumSha256: string;
      readonly trackCount: number;
      readonly type: "recording.authoritative_ready";
    })
  | (TrustedRecordingLifecycleEnvelope & {
      readonly actors: readonly RecordingActor[];
      readonly rosterState: "unsealed";
      readonly type: "meeting.started";
    })
  | (TrustedRecordingLifecycleEnvelope & {
      readonly actor: RecordingActor;
      readonly type: "participant.joined" | "participant.left";
    })
  | (TrustedRecordingLifecycleEnvelope & {
      readonly reason: string | null;
      readonly type: "meeting.connection_lost" | "meeting.connection_recovered";
    })
  | (TrustedRecordingLifecycleEnvelope & {
      readonly reason: string | null;
      readonly type: "meeting.ended" | "meeting.aborted";
    })
  | (TrustedRecordingLifecycleEnvelope & {
      readonly actors: readonly RecordingActor[];
      readonly endedAt: string;
      readonly rosterState: "sealed";
      readonly sourceFilesChecksumSha256: string;
      readonly trackCount: number;
      readonly type: "recording.authoritative_ready";
    });

export interface CanonicalLiveAudioFormat {
  readonly channelCount: 1;
  readonly codec: "opus";
  readonly sampleRateHz: 48_000;
}

export const canonicalLiveAudioFormat: CanonicalLiveAudioFormat = Object.freeze({
  channelCount: 1,
  codec: "opus",
  sampleRateHz: 48_000,
});

interface LiveVoicePacket {
  readonly mediaTimestamp: number;
  readonly payloadBase64: string;
  readonly receivedAtMs: number;
  readonly recordingId: string;
  readonly relativeTimeMs: number;
  readonly sequenceNumber: number;
  readonly speakerId: string;
}

interface SourceLiveVoicePacketCommand extends LiveVoicePacket {
  readonly schemaVersion: 1;
  readonly source: RecordingSource;
}

export interface LiveVoicePacketBatchCommand {
  readonly format: CanonicalLiveAudioFormat;
  readonly packets: readonly SourceLiveVoicePacketCommand[];
  readonly schemaVersion: 1;
}

export interface DerivedLiveVoicePacketBatch {
  readonly format: CanonicalLiveAudioFormat;
  readonly packets: readonly LiveVoicePacket[];
}

export interface AuthoritativeSpeakerTrackUpload {
  readonly checksumSha256: string;
  readonly recordingId: string;
  readonly schemaVersion: 1;
  readonly sizeBytes: number;
  readonly source: RecordingSource;
  readonly speakerId: string;
  readonly timelineOffsetMs: number;
  readonly trackNumber: number;
  readonly uploadId: string;
}

export interface AuthoritativeTrackDurabilityReceipt {
  readonly checksumSha256: string;
  readonly locator: string;
  readonly recordingId: string;
  readonly replayed: boolean;
  readonly sizeBytes: number;
  readonly trackNumber: number;
  readonly uploadId: string;
  readonly versionId: string;
}

interface DeferredPublicationTarget {
  resolve(): Promise<string | null>;
}

export type DerivedLiveLifecycleEvent =
  | {
      readonly occurredAt: string;
      readonly participantIds: readonly string[];
      readonly publicationTarget: DeferredPublicationTarget;
      readonly recordingId: string;
      readonly roomId: string;
      readonly memoryIdentity?: DerivedLiveMemoryIdentity;
      readonly type: "meeting.started";
    }
  | {
      readonly occurredAt: string;
      readonly recordingId: string;
      readonly type: "meeting.ended" | "meeting.aborted";
    }
  | {
      readonly occurredAt: string;
      readonly memoryHumanObservation?: {
        readonly actorId: string;
        readonly producerRevision: string;
      };
      readonly participantId: string;
      readonly recordingId: string;
      readonly type: "participant.joined" | "participant.left";
    }
  | {
      readonly occurredAt: string;
      readonly recordingId: string;
      readonly type:
        | "meeting.connection_lost"
        | "meeting.connection_recovered"
        | "recording.artifact_ready";
    }
  | {
      readonly occurredAt: string;
      readonly memoryIdentity?: DerivedLiveMemoryIdentity;
      readonly recordingId: string;
      readonly type: "recording.authoritative_ready";
    };

export interface PublicationTargetResolverPort {
  resolve(source: RecordingSource): Promise<string | null>;
}

export type RecordingIngressRejection =
  | "conflict"
  | "invalid-request"
  | "limit-exceeded";

/** Stable application failure translated from a concrete durability adapter. */
export class RecordingIngressRejectedError extends Error {
  public override readonly name = "RecordingIngressRejectedError";

  public constructor(
    public readonly rejection: RecordingIngressRejection,
    options?: ErrorOptions,
  ) {
    super(`Recording ingress rejected: ${rejection}`, options);
  }
}

export type RecordingLifecycleIngressResult =
  | {
      readonly kind: "accepted" | "aborted";
      readonly recordingId: string;
      readonly replayed: boolean;
    }
  | {
      readonly actors: readonly RecordingActor[] | null;
      readonly identityProvenance: RecordingIdentityProvenance | null;
      readonly kind: "finalized";
      readonly lifecycleGeneration: 1 | 2 | 3;
      readonly recording: RecordingArtifactSnapshot;
      readonly replayed: boolean;
      readonly source: RecordingSource;
    };

/** Consumer-owned durability port implemented by one recording-source adapter. */
export interface RecordingDurabilityPort {
  ingestAuthoritativeTrack(
    metadata: AuthoritativeSpeakerTrackUpload,
    body: AsyncIterable<Uint8Array>,
  ): Promise<AuthoritativeTrackDurabilityReceipt>;
  ingestLifecycleEvent(
    event: RecordingLifecycleCommand,
  ): Promise<RecordingLifecycleIngressResult>;
  ingestPacketBatch(batch: LiveVoicePacketBatchCommand): Promise<{
    readonly acceptedPackets: number;
    readonly duplicatePackets: number;
    readonly recordingId: string;
  }>;
}

export interface MeetingRecordingIngress {
  ingestAuthoritativeTrack(
    metadata: AuthoritativeSpeakerTrackUpload,
    body: AsyncIterable<Uint8Array>,
  ): Promise<AuthoritativeTrackDurabilityReceipt>;
  ingestLifecycle(event: RecordingLifecycleCommand): Promise<void>;
  ingestVoiceBatch(batch: LiveVoicePacketBatchCommand): Promise<void>;
}
