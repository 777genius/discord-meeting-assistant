import type {
  AuthoritativeTrackUploadMetadata,
  CraigLifecycleEvent,
  VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";

import type {
  AuthoritativeSpeakerTrackUpload,
  LiveVoicePacketBatchCommand,
  RecordingDurabilityPort,
  RecordingLifecycleCommand,
  RecordingLifecycleIngressResult,
} from "../../application/recording-ingress.js";

interface CraigRecordingIngressDelegate {
  ingestAuthoritativeTrack(
    metadata: AuthoritativeTrackUploadMetadata,
    body: AsyncIterable<Uint8Array>,
  ): Promise<{ readonly replayed: boolean }>;
  ingestLifecycleEvent(
    event: CraigLifecycleEvent,
  ): Promise<RecordingLifecycleIngressResult>;
  ingestPacketBatch(batch: VoicePacketBatch): Promise<{
    readonly acceptedPackets: number;
    readonly duplicatePackets: number;
    readonly recordingId: string;
  }>;
}

/** Anti-corruption adapter from Meeting Platform commands to Craig durability. */
export class CraigRecordingIngressAdapter implements RecordingDurabilityPort {
  public constructor(private readonly delegate: CraigRecordingIngressDelegate) {}

  public ingestAuthoritativeTrack(
    metadata: AuthoritativeSpeakerTrackUpload,
    body: AsyncIterable<Uint8Array>,
  ): Promise<{ readonly replayed: boolean }> {
    return this.delegate.ingestAuthoritativeTrack(
      {
        channelId: metadata.source.roomId,
        checksumSha256: metadata.checksumSha256,
        guildId: metadata.source.scopeId,
        recordingId: metadata.recordingId,
        schemaVersion: metadata.schemaVersion,
        sizeBytes: metadata.sizeBytes,
        speakerId: metadata.speakerId,
        timelineOffsetMs: metadata.timelineOffsetMs,
        trackNumber: metadata.trackNumber,
        uploadId: metadata.uploadId,
      },
      body,
    );
  }

  public ingestLifecycleEvent(
    event: RecordingLifecycleCommand,
  ): Promise<RecordingLifecycleIngressResult> {
    if (
      event.schemaVersion !== 1 &&
      (event.type === "meeting.started" || event.type === "recording.authoritative_ready")
    ) {
      const { source, ...providerNeutralEvent } = event;
      return this.delegate.ingestLifecycleEvent({
        ...providerNeutralEvent,
        actors: event.actors.map((actor) => ({ ...actor })),
        channelId: source.roomId,
        guildId: source.scopeId,
      });
    }
    const { source, ...providerNeutralEvent } = event;
    return this.delegate.ingestLifecycleEvent({
      ...providerNeutralEvent,
      channelId: source.roomId,
      guildId: source.scopeId,
    });
  }

  public ingestPacketBatch(batch: LiveVoicePacketBatchCommand): Promise<{
    readonly acceptedPackets: number;
    readonly duplicatePackets: number;
    readonly recordingId: string;
  }> {
    return this.delegate.ingestPacketBatch({
      packets: batch.packets.map((packet) => ({
        channelId: packet.source.roomId,
        guildId: packet.source.scopeId,
        opusBase64: packet.payloadBase64,
        receivedAtMs: packet.receivedAtMs,
        recordingId: packet.recordingId,
        relativeTimeMs: packet.relativeTimeMs,
        rtpSequence: packet.sequenceNumber,
        rtpTimestamp: packet.mediaTimestamp,
        schemaVersion: packet.schemaVersion,
        speakerId: packet.speakerId,
      })),
      schemaVersion: batch.schemaVersion,
    });
  }
}
