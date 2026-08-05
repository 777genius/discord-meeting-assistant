/**
 * Consumer-owned commands accepted by the Meeting Platform application edge.
 * Provider adapters must validate and map their wire contracts into these
 * shapes before invoking application coordination.
 */

interface RecordingLifecycleEnvelope {
  readonly channelId: string;
  readonly eventId: string;
  readonly guildId: string;
  readonly occurredAt: string;
  readonly recordingId: string;
  readonly schemaVersion: 1;
}

export type RecordingLifecycleCommand =
  | (RecordingLifecycleEnvelope & {
      readonly participantIds: string[];
      readonly type: "meeting.started";
    })
  | (RecordingLifecycleEnvelope & {
      readonly participantId: string;
      readonly type: "participant.joined" | "participant.left";
    })
  | (RecordingLifecycleEnvelope & {
      readonly reason: string | null;
      readonly type: "meeting.connection_lost" | "meeting.connection_recovered";
    })
  | (RecordingLifecycleEnvelope & {
      readonly reason: string | null;
      readonly type: "meeting.ended" | "meeting.aborted";
    })
  | (RecordingLifecycleEnvelope & {
      readonly endedAt: string;
      readonly multitrackManifestKey: string;
      readonly type: "recording.artifact_ready";
      readonly usersManifestKey: string;
    })
  | (RecordingLifecycleEnvelope & {
      readonly endedAt: string;
      readonly sourceFilesChecksumSha256: string;
      readonly trackCount: number;
      readonly type: "recording.authoritative_ready";
    });

interface LiveVoicePacketCommand {
  readonly channelId: string;
  readonly guildId: string;
  readonly opusBase64: string;
  readonly receivedAtMs: number;
  readonly recordingId: string;
  readonly relativeTimeMs: number;
  readonly rtpSequence: number;
  readonly rtpTimestamp: number;
  readonly schemaVersion: 1;
  readonly speakerId: string;
}

export interface LiveVoicePacketBatchCommand {
  readonly packets: LiveVoicePacketCommand[];
  readonly schemaVersion: 1;
}

export interface AuthoritativeSpeakerTrackUpload {
  readonly channelId: string;
  readonly checksumSha256: string;
  readonly guildId: string;
  readonly recordingId: string;
  readonly schemaVersion: 1;
  readonly sizeBytes: number;
  readonly speakerId: string;
  readonly timelineOffsetMs: number;
  readonly trackNumber: number;
  readonly uploadId: string;
}

export interface ActiveRecordingChannel {
  readonly guildId: string;
  readonly voiceChannelId: string;
}

/** Consumer-owned configuration capability used by inbound recording adapters. */
export interface ActiveRecordingChannelReader {
  listActiveGuildVoiceChannels(): Promise<readonly ActiveRecordingChannel[]>;
}

export type RecordingIngressRejection =
  | "conflict"
  | "invalid-request"
  | "limit-exceeded";

/**
 * Stable application failure exposed to inbound adapters. Concrete spool
 * failures are translated into this model at the composition boundary.
 */
export class RecordingIngressRejectedError extends Error {
  public override readonly name = "RecordingIngressRejectedError";

  public constructor(
    public readonly rejection: RecordingIngressRejection,
    options?: ErrorOptions,
  ) {
    super(`Recording ingress rejected: ${rejection}`, options);
  }
}

export interface MeetingRecordingIngress {
  ingestAuthoritativeTrack(
    metadata: AuthoritativeSpeakerTrackUpload,
    body: AsyncIterable<Uint8Array>,
  ): Promise<{ readonly replayed: boolean }>;
  ingestLifecycle(event: RecordingLifecycleCommand): Promise<void>;
  ingestVoiceBatch(batch: LiveVoicePacketBatchCommand): Promise<void>;
}
