import {
  Meeting,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core";

import type {
  AuthoritativeSpeakerTrackUpload,
  DerivedLiveLifecycleEvent,
  DerivedLiveVoicePacketBatch,
  LiveVoicePacketBatchCommand,
  PublicationTargetResolverPort,
  RecordingDurabilityPort,
  RecordingIngressRejection,
  RecordingLifecycleCommand,
  RecordingSource,
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

interface PostCallOutboxDispatcherPort {
  dispatchPending(): Promise<{
    readonly dispatched: number;
    readonly failed: number;
  }>;
}

interface DerivedLiveIngressPort {
  acceptLifecycle(event: DerivedLiveLifecycleEvent): void | Promise<void>;
  /**
   * Resolves after bounded derived admission. It must not reject the durable
   * durable ingress request when live captions are degraded.
   */
  acceptVoiceBatch(batch: DerivedLiveVoicePacketBatch): void | Promise<void>;
  prepareForAuthoritativeFinal(recordingId: string): void | Promise<void>;
}

interface RecordingIngressFailureClassifier {
  classify(error: unknown): RecordingIngressRejection | null;
}

export class MeetingPublicationTargetUnavailableError extends Error {
  public override readonly name = "MeetingPublicationTargetUnavailableError";
  public constructor(
    public readonly sourceScopeId: string,
    public readonly sourceRoomId: string,
  ) {
    super("Recording source is not configured for publication");
  }
}

export interface PlatformRecordingIngressDependencies {
  readonly dispatcher: PostCallOutboxDispatcherPort;
  readonly failureClassifier: RecordingIngressFailureClassifier;
  readonly ingress: RecordingDurabilityPort;
  readonly live?: DerivedLiveIngressPort;
  readonly logger: ApplicationLogger;
  readonly outbox: RecordedMeetingOutbox;
  readonly metrics: IngressMetricsPort;
  readonly publicationTargets: PublicationTargetResolverPort;
}

export class PlatformRecordingIngress {
  public constructor(
    private readonly dependencies: PlatformRecordingIngressDependencies,
  ) {}

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
      await Promise.resolve(
        this.dependencies.live?.acceptVoiceBatch({
          format: batch.format,
          packets: batch.packets.map((packet) => ({
            mediaTimestamp: packet.mediaTimestamp,
            payloadBase64: packet.payloadBase64,
            receivedAtMs: packet.receivedAtMs,
            recordingId: packet.recordingId,
            relativeTimeMs: packet.relativeTimeMs,
            sequenceNumber: packet.sequenceNumber,
            speakerId: packet.speakerId,
          })),
        }),
      );
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

    const publicationTargetId = await this.resolvePublicationTarget(event.source);
    if (publicationTargetId === null) {
      throw new MeetingPublicationTargetUnavailableError(
        event.source.scopeId,
        event.source.roomId,
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
    if (this.dependencies.live === undefined) {
      return;
    }
    try {
      const derivedEvent = await this.toDerivedLifecycleEvent(event);
      if (derivedEvent !== null) {
        await Promise.resolve(this.dependencies.live.acceptLifecycle(derivedEvent));
      }
    } catch (error) {
      this.recordDerivedFailure("lifecycle", event.recordingId, error);
    }
  }

  private async toDerivedLifecycleEvent(
    event: RecordingLifecycleCommand,
  ): Promise<DerivedLiveLifecycleEvent | null> {
    const common = {
      occurredAt: event.occurredAt,
      recordingId: event.recordingId,
    };
    if (event.type !== "meeting.started") {
      return { ...common, type: event.type };
    }
    const publicationTargetId = await this.resolvePublicationTarget(event.source);
    if (publicationTargetId === null) {
      this.dependencies.logger.warn(
        "Derived live meeting skipped for unconfigured recording source",
        {
          meetingId: event.recordingId,
          sourceRoomId: event.source.roomId,
          sourceScopeId: event.source.scopeId,
        },
      );
      return null;
    }
    return { ...common, publicationTargetId, type: event.type };
  }

  private async resolvePublicationTarget(
    source: RecordingSource,
  ): Promise<string | null> {
    return this.dependencies.publicationTargets.resolve(source);
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
