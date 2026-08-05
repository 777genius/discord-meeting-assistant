import {
  Meeting,
  type MeetingSnapshot,
  type RecordingArtifactSnapshot,
} from "@discord-meeting/meeting-core";

import type {
  AuthoritativeSpeakerTrackUpload,
  LiveVoicePacketBatchCommand,
  RecordingIngressRejection,
  RecordingLifecycleCommand,
} from "./recording-ingress.js";
import { RecordingIngressRejectedError } from "./recording-ingress.js";

interface RecordedMeetingOutbox {
  recordAndSchedule(
    snapshot: MeetingSnapshot,
    expectedRevision: number,
  ): Promise<void>;
}

interface ApplicationLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

interface IngressMetricsPort {
  recordIngress(
    outcome: "accepted" | "dropped",
    reason:
      | "accepted"
      | "duplicate"
      | "invalid"
      | "over-capacity"
      | "shutting-down"
      | "unknown",
  ): void;
  recordDerivedLiveFailure(phase: "lifecycle" | "prepare-final" | "voice"): void;
}

interface PacketBatchIngressResult {
  readonly acceptedPackets: number;
  readonly duplicatePackets: number;
  readonly recordingId: string;
}

type LifecycleIngressResult =
  | {
      readonly kind: "accepted" | "aborted";
      readonly recordingId: string;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "finalized";
      readonly recording: RecordingArtifactSnapshot;
      readonly replayed: boolean;
    };

interface PostCallOutboxDispatcherPort {
  dispatchPending(): Promise<{
    readonly dispatched: number;
    readonly failed: number;
  }>;
}

interface RecordingIngressPort {
  ingestAuthoritativeTrack(
    metadata: AuthoritativeSpeakerTrackUpload,
    body: AsyncIterable<Uint8Array>,
  ): Promise<{ readonly replayed: boolean }>;
  ingestLifecycleEvent(
    event: RecordingLifecycleCommand,
  ): Promise<LifecycleIngressResult>;
  ingestPacketBatch(batch: LiveVoicePacketBatchCommand): Promise<PacketBatchIngressResult>;
}

interface DerivedLiveIngressPort {
  acceptLifecycle(event: RecordingLifecycleCommand): void | Promise<void>;
  /**
   * Resolves after bounded derived admission. It must not reject the durable
   * durable ingress request when live captions are degraded.
   */
  acceptVoiceBatch(batch: LiveVoicePacketBatchCommand): void | Promise<void>;
  prepareForAuthoritativeFinal(recordingId: string): void | Promise<void>;
}

interface RecordingIngressFailureClassifier {
  classify(error: unknown): RecordingIngressRejection | null;
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
    super("Guild and voice channel are not configured for publication");
  }
}

export interface PlatformRecordingIngressDependencies {
  readonly dispatcher: PostCallOutboxDispatcherPort;
  readonly failureClassifier: RecordingIngressFailureClassifier;
  readonly ingress: RecordingIngressPort;
  readonly live?: DerivedLiveIngressPort;
  readonly logger: ApplicationLogger;
  readonly outbox: RecordedMeetingOutbox;
  readonly metrics: IngressMetricsPort;
  /** Compatibility-only direct target for deterministic legacy tests. */
  readonly publicationTargetId?: string;
  readonly publicationTargets?: PublicationTargetResolverPort;
}

export class PlatformRecordingIngress {
  public constructor(
    private readonly dependencies: PlatformRecordingIngressDependencies,
  ) {
    if (
      dependencies.publicationTargets === undefined &&
      dependencies.publicationTargetId === undefined
    ) {
      throw new Error("a publication target source is required");
    }
  }

  public async ingestAuthoritativeTrack(
    metadata: AuthoritativeSpeakerTrackUpload,
    body: AsyncIterable<Uint8Array>,
  ): Promise<{ readonly replayed: boolean }> {
    const result = await this.acceptDurably(() =>
      this.dependencies.ingress.ingestAuthoritativeTrack(metadata, body),
    );
    this.dependencies.metrics.recordIngress("accepted", "accepted");
    this.dependencies.logger.info(
      "Authoritative speaker track accepted",
      {
        recordingId: metadata.recordingId,
        replayed: result.replayed,
        speakerId: metadata.speakerId,
        trackNumber: metadata.trackNumber,
      },
    );
    return result;
  }

  public async ingestVoiceBatch(batch: LiveVoicePacketBatchCommand): Promise<void> {
    const result = await this.acceptDurably(() =>
      this.dependencies.ingress.ingestPacketBatch(batch),
    );
    // The recording spool is authoritative. Only after it accepted this batch
    // may a bounded live-admission wait slow the source down; live failure cannot
    // turn a durable packet into a failed ingress request.
    try {
      await Promise.resolve(this.dependencies.live?.acceptVoiceBatch(batch));
    } catch (error) {
      this.dependencies.metrics.recordDerivedLiveFailure("voice");
      this.dependencies.logger.warn(
        "Derived live admission failed after durable ingress accept",
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          recordingId: result.recordingId,
        },
      );
    }
    this.dependencies.metrics.recordIngress("accepted", "accepted");
    this.dependencies.logger.debug("Voice packet batch accepted", {
      acceptedPackets: result.acceptedPackets,
      duplicatePackets: result.duplicatePackets,
      recordingId: result.recordingId,
    });
  }

  public async ingestLifecycle(event: RecordingLifecycleCommand): Promise<void> {
    const result = await this.acceptDurably(() =>
      this.dependencies.ingress.ingestLifecycleEvent(event),
    );
    await this.acceptDerivedLifecycle(event);
    this.dependencies.metrics.recordIngress("accepted", "accepted");
    if (result.kind !== "finalized") {
      return;
    }

    await this.prepareDerivedAuthoritativeFinal(result.recording.recordingId);

    const publicationTargetId =
      this.dependencies.publicationTargetId ??
      (await this.dependencies.publicationTargets?.resolve({
        guildId: event.guildId,
        voiceChannelId: event.channelId,
      })) ??
      null;
    if (publicationTargetId === null) {
      throw new MeetingPublicationTargetUnavailableError(
        event.guildId,
        event.channelId,
      );
    }
    const meeting = Meeting.record({
      meetingId: result.recording.recordingId,
      publicationTargetId,
      recording: result.recording,
    });
    await this.dependencies.outbox.recordAndSchedule(meeting.toSnapshot(), 0);
    const dispatch = await this.dependencies.dispatcher.dispatchPending();
    this.dependencies.logger.info(
      "Finalized recording queued for post-call processing",
      {
        dispatchFailures: dispatch.failed,
        meetingId: meeting.meetingId,
        replayed: result.replayed,
      },
    );
  }

  private async acceptDurably<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      const rejection = this.dependencies.failureClassifier.classify(error);
      if (rejection !== null) {
        throw new RecordingIngressRejectedError(rejection, { cause: error });
      }
      throw error;
    }
  }

  private async acceptDerivedLifecycle(
    event: RecordingLifecycleCommand,
  ): Promise<void> {
    try {
      await Promise.resolve(this.dependencies.live?.acceptLifecycle(event));
    } catch (error) {
      this.recordDerivedFailure("lifecycle", event.recordingId, error);
    }
  }

  private async prepareDerivedAuthoritativeFinal(recordingId: string): Promise<void> {
    try {
      await Promise.resolve(
        this.dependencies.live?.prepareForAuthoritativeFinal(recordingId),
      );
    } catch (error) {
      this.recordDerivedFailure("prepare-final", recordingId, error);
    }
  }

  private recordDerivedFailure(
    phase: "lifecycle" | "prepare-final",
    recordingId: string,
    error: unknown,
  ): void {
    this.dependencies.metrics.recordDerivedLiveFailure(phase);
    this.dependencies.logger.warn(
      "Derived live lifecycle failed after durable ingress accept",
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        phase,
        recordingId,
      },
    );
  }
}
