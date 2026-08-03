import type {
  AuthoritativeTrackUploadMetadata,
  CraigLifecycleEvent,
  VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";
import {
  Meeting,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core";
import type { Metrics, Logger } from "@discord-meeting/observability-adapter";
import type {
  LifecycleIngressResult,
  PacketBatchIngressResult,
} from "@discord-meeting/recording-ingress-adapter";

interface RecordedMeetingOutbox {
  recordAndSchedule(snapshot: MeetingSnapshot, expectedRevision: number): Promise<void>;
}

interface PostCallOutboxDispatcherPort {
  dispatchPending(): Promise<{ readonly dispatched: number; readonly failed: number }>;
}

interface RecordingIngressPort {
  ingestAuthoritativeTrack(
    metadata: AuthoritativeTrackUploadMetadata,
    body: AsyncIterable<Uint8Array>,
  ): Promise<{ readonly replayed: boolean }>;
  ingestLifecycleEvent(event: CraigLifecycleEvent): Promise<LifecycleIngressResult>;
  ingestPacketBatch(batch: VoicePacketBatch): Promise<PacketBatchIngressResult>;
}

interface DerivedLiveIngressPort {
  acceptLifecycle(event: CraigLifecycleEvent): void;
  acceptVoiceBatch(batch: VoicePacketBatch): void;
  prepareForAuthoritativeFinal(recordingId: string): void;
}

interface PublicationTargetResolverPort {
  resolve(input: {
    readonly guildId: string;
    readonly voiceChannelId: string;
  }): Promise<string | null>;
}

export class MeetingPublicationTargetUnavailableError extends Error {
  public override readonly name = "MeetingPublicationTargetUnavailableError";
  public constructor(
    public readonly guildId: string,
    public readonly voiceChannelId: string,
  ) {
    super("Discord guild and voice channel are not configured for publication");
  }
}

export interface PlatformCraigIngressDependencies {
  readonly dispatcher: PostCallOutboxDispatcherPort;
  readonly ingress: RecordingIngressPort;
  readonly live?: DerivedLiveIngressPort;
  readonly logger: Logger;
  readonly outbox: RecordedMeetingOutbox;
  readonly metrics: Metrics;
  /** Compatibility-only direct target for deterministic legacy tests. */
  readonly publicationTargetId?: string;
  readonly publicationTargets?: PublicationTargetResolverPort;
}

export class PlatformCraigIngress {
  public constructor(private readonly dependencies: PlatformCraigIngressDependencies) {
    if (
      dependencies.publicationTargets === undefined &&
      dependencies.publicationTargetId === undefined
    ) {
      throw new Error("a publication target source is required");
    }
  }

  public async ingestAuthoritativeTrack(
    metadata: AuthoritativeTrackUploadMetadata,
    body: AsyncIterable<Uint8Array>,
  ): Promise<{ readonly replayed: boolean }> {
    const result = await this.dependencies.ingress.ingestAuthoritativeTrack(metadata, body);
    this.dependencies.metrics.recordIngress("accepted", "accepted");
    this.dependencies.logger.info("Authoritative Craig speaker track accepted", {
      recordingId: metadata.recordingId,
      replayed: result.replayed,
      speakerId: metadata.speakerId,
      trackNumber: metadata.trackNumber,
    });
    return result;
  }

  public async ingestVoiceBatch(batch: VoicePacketBatch): Promise<void> {
    const result = await this.dependencies.ingress.ingestPacketBatch(batch);
    this.dependencies.live?.acceptVoiceBatch(batch);
    this.dependencies.metrics.recordIngress("accepted", "accepted");
    this.dependencies.logger.debug("Craig packet batch accepted", {
      acceptedPackets: result.acceptedPackets,
      duplicatePackets: result.duplicatePackets,
      recordingId: result.recordingId,
    });
  }

  public async ingestLifecycle(event: CraigLifecycleEvent): Promise<void> {
    const result = await this.dependencies.ingress.ingestLifecycleEvent(event);
    await Promise.resolve(this.dependencies.live?.acceptLifecycle(event));
    this.dependencies.metrics.recordIngress("accepted", "accepted");
    if (result.kind !== "finalized") {
      return;
    }

    this.dependencies.live?.prepareForAuthoritativeFinal(result.recording.recordingId);

    const publicationTargetId = this.dependencies.publicationTargetId ??
      await this.dependencies.publicationTargets?.resolve({
        guildId: event.guildId,
        voiceChannelId: event.channelId,
      }) ?? null;
    if (publicationTargetId === null) {
      throw new MeetingPublicationTargetUnavailableError(event.guildId, event.channelId);
    }
    const meeting = Meeting.record({
      meetingId: result.recording.recordingId,
      publicationTargetId,
      recording: result.recording,
    });
    await this.dependencies.outbox.recordAndSchedule(meeting.toSnapshot(), 0);
    const dispatch = await this.dependencies.dispatcher.dispatchPending();
    this.dependencies.logger.info("Finalized recording queued for post-call processing", {
      dispatchFailures: dispatch.failed,
      meetingId: meeting.meetingId,
      replayed: result.replayed,
    });
  }
}
