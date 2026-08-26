import {
  Meeting,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core/meeting-lifecycle";

import type {
  AuthoritativeSpeakerTrackUpload,
  AuthoritativeTrackDurabilityReceipt,
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
import {
  DerivedGreetingObligationDispatcher,
  type DerivedGreetingObligation,
  type DerivedGreetingObligationPort,
} from "./derived-greeting-obligations.js";

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
  acceptLifecycle(
    event: DerivedLiveLifecycleEvent,
  ): void | "accepted" | "retry" | Promise<void | "accepted" | "retry">;
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
  readonly greetingObligations?: DerivedGreetingObligationPort;
  readonly live?: DerivedLiveIngressPort;
  readonly logger: ApplicationLogger;
  /** Monotonic Unix-shaped observation clock supplied by composition. */
  readonly nowMilliseconds?: () => number;
  readonly outbox: RecordedMeetingOutbox;
  readonly metrics: IngressMetricsPort;
  readonly publicationTargets: PublicationTargetResolverPort;
}

export class PlatformRecordingIngress {
  private readonly greetingDispatcher: DerivedGreetingObligationDispatcher | null;
  public constructor(
    private readonly dependencies: PlatformRecordingIngressDependencies,
  ) {
    this.greetingDispatcher = dependencies.greetingObligations === undefined ||
      dependencies.live === undefined || dependencies.nowMilliseconds === undefined
      ? null
      : new DerivedGreetingObligationDispatcher({
          live: dependencies.live,
          nowMilliseconds: dependencies.nowMilliseconds,
          obligations: dependencies.greetingObligations,
          recordFailure: (recordingId, error) => {
            this.recordDerivedFailure("lifecycle", recordingId, error);
          },
        });
  }

  public async ingestAuthoritativeTrack(
    metadata: AuthoritativeSpeakerTrackUpload,
    body: AsyncIterable<Uint8Array>,
  ): Promise<AuthoritativeTrackDurabilityReceipt> {
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
    const greetingObligation = this.toGreetingObligation(event);
    if (greetingObligation === null) {
      await this.acceptDerivedLifecycle(event);
    } else {
      const obligations = this.dependencies.greetingObligations;
      if (obligations === undefined) {
        throw new Error("durable greeting obligation store is unavailable");
      }
      // This commit is part of HTTP admission: a 202 never acknowledges an
      // effect that can only survive in the live process heap.
      await obligations.accept(greetingObligation);
      if (this.greetingDispatcher === null) {
        throw new Error("durable greeting obligation dispatcher is unavailable");
      }
      await this.greetingDispatcher.deliver(greetingObligation);
    }
    this.dependencies.metrics.recordIngress("accepted", "accepted");
    if (result.kind !== "finalized") {
      return;
    }

    await this.prepareDerivedAuthoritativeFinal(result.recording.recordingId);

    const publicationTargetId = await this.resolvePublicationTarget(result.source);
    if (publicationTargetId === null) {
      throw new MeetingPublicationTargetUnavailableError(
        result.source.scopeId,
        result.source.roomId,
      );
    }
    const recordedMeeting = {
      meetingId: result.recording.recordingId,
      publicationTargetId,
      recording: result.recording,
      source: result.source,
    } as const;
    const meeting = result.actors === null
      ? Meeting.recordLegacy({
          ...recordedMeeting,
          lifecycleGeneration: result.lifecycleGeneration,
        })
      : Meeting.record({
          ...recordedMeeting,
          actors: result.actors,
          identityProvenance: result.identityProvenance,
          lifecycleGeneration: result.lifecycleGeneration,
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

  public dispatchPendingGreetings(): Promise<{
    readonly delivered: number;
    readonly expired: number;
    readonly failed: number;
  }> {
    return this.greetingDispatcher?.dispatchPending() ??
      Promise.resolve({ delivered: 0, expired: 0, failed: 0 });
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
      const derived = this.toDerivedLifecycleEvent(event);
      if (derived === null) {
        return;
      }
      await Promise.resolve(
        this.dependencies.live.acceptLifecycle(derived),
      );
    } catch (error) {
      this.recordDerivedFailure("lifecycle", event.recordingId, error);
    }
  }

  private toGreetingObligation(
    event: RecordingLifecycleCommand,
  ): DerivedGreetingObligation | null {
    if (this.dependencies.live === undefined ||
      event.type !== "participant.joined" || event.schemaVersion === 1 ||
      event.actor.kind !== "human") {
      return null;
    }
    const occurredAtMilliseconds = Date.parse(event.occurredAt);
    if (!Number.isSafeInteger(occurredAtMilliseconds) || occurredAtMilliseconds < 0) {
      throw new Error("greeting obligation occurrence is invalid");
    }
    return {
      eventId: event.eventId,
      ...(event.schemaVersion !== 3
        ? {}
        : { memoryHumanObservation: {
            actorId: event.actor.actorId,
            producerRevision: event.producerRevision,
          } }),
      notAfterMilliseconds: occurredAtMilliseconds + 5_000,
      // The public lifecycle contract may retain precision finer than the
      // runtime clock. The derived ledger uses one canonical millisecond
      // anchor for both columns so valid contract precision cannot create a
      // contradictory obligation.
      occurredAt: new Date(occurredAtMilliseconds).toISOString(),
      participantId: event.actor.actorId,
      recordingId: event.recordingId,
    };
  }

  private toDerivedLifecycleEvent(
    event: RecordingLifecycleCommand,
  ): DerivedLiveLifecycleEvent | null {
    const common = {
      occurredAt: event.occurredAt,
      recordingId: event.recordingId,
    };
    if (event.type === "meeting.started") {
      return {
        ...common,
        // V1 carries identifiers without actor semantics. Proactive V1 voice
        // admission fails closed instead of cohorting an automation as human.
        participantIds: event.schemaVersion === 1
          ? []
          : event.actors
              .filter((actor) => actor.kind === "human")
              .map((actor) => actor.actorId),
        publicationTarget: {
          resolve: () => this.resolvePublicationTarget(event.source),
        },
        roomId: event.source.roomId,
        ...(event.schemaVersion !== 3
          ? {}
          : {
              memoryIdentity: {
                actors: event.actors,
                identityProvenance: {
                  actorObservationState: event.actorObservationState,
                  actorSemanticsVersion: event.actorSemanticsVersion,
                  producerCapabilityId: event.producerCapabilityId,
                  producerRevision: event.producerRevision,
                  rosterState: event.rosterState,
                },
                lifecycleGeneration: 3 as const,
                roomId: event.source.roomId,
                scopeId: event.source.scopeId,
              },
            }),
        type: event.type,
      };
    }
    if (event.type === "participant.joined" || event.type === "participant.left") {
      if (event.schemaVersion === 1 || event.actor.kind !== "human") {
        return null;
      }
      return {
        ...common,
        ...(event.schemaVersion !== 3
          ? {}
          : {
              memoryHumanObservation: {
                actorId: event.actor.actorId,
                producerRevision: event.producerRevision,
              },
            }),
        participantId: event.actor.actorId,
        type: event.type,
      };
    }
    if (event.type === "recording.authoritative_ready") {
      return {
        ...common,
        ...(event.schemaVersion !== 3
          ? {}
          : {
              memoryIdentity: {
                actors: event.actors,
                identityProvenance: {
                  actorObservationState: event.actorObservationState,
                  actorSemanticsVersion: event.actorSemanticsVersion,
                  producerCapabilityId: event.producerCapabilityId,
                  producerRevision: event.producerRevision,
                  rosterState: event.rosterState,
                },
                lifecycleGeneration: 3 as const,
                roomId: event.source.roomId,
                scopeId: event.source.scopeId,
              },
            }),
        type: event.type,
      };
    }
    return { ...common, type: event.type };
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
