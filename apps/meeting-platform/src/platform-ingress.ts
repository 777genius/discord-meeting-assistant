import type {
  CraigLifecycleEvent,
  VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";
import {
  Meeting,
  type MeetingRepository,
} from "@discord-meeting/meeting-core";
import type { Metrics, Logger } from "@discord-meeting/observability-adapter";
import type {
  LifecycleIngressResult,
  PacketBatchIngressResult,
} from "@discord-meeting/recording-ingress-adapter";

interface PostCallEnqueuer {
  enqueue(payload: { readonly meetingId: string; readonly schemaVersion: 1 }): Promise<unknown>;
}

interface RecordingIngressPort {
  ingestLifecycleEvent(event: CraigLifecycleEvent): Promise<LifecycleIngressResult>;
  ingestPacketBatch(batch: VoicePacketBatch): Promise<PacketBatchIngressResult>;
}

export interface PlatformCraigIngressDependencies {
  readonly enqueuer: PostCallEnqueuer;
  readonly ingress: RecordingIngressPort;
  readonly logger: Logger;
  readonly meetings: MeetingRepository;
  readonly metrics: Metrics;
  readonly publicationTargetId: string;
}

export class PlatformCraigIngress {
  public constructor(private readonly dependencies: PlatformCraigIngressDependencies) {}

  public async ingestVoiceBatch(batch: VoicePacketBatch): Promise<void> {
    const result = await this.dependencies.ingress.ingestPacketBatch(batch);
    this.dependencies.metrics.recordIngress("accepted", "accepted");
    this.dependencies.logger.debug("Craig packet batch accepted", {
      acceptedPackets: result.acceptedPackets,
      duplicatePackets: result.duplicatePackets,
      recordingId: result.recordingId,
    });
  }

  public async ingestLifecycle(event: CraigLifecycleEvent): Promise<void> {
    const result = await this.dependencies.ingress.ingestLifecycleEvent(event);
    this.dependencies.metrics.recordIngress("accepted", "accepted");
    if (result.kind !== "finalized") {
      return;
    }

    const meeting = Meeting.record({
      meetingId: result.recording.recordingId,
      publicationTargetId: this.dependencies.publicationTargetId,
      recording: result.recording,
    });
    await this.dependencies.meetings.save(meeting.toSnapshot(), 0);
    await this.dependencies.enqueuer.enqueue({
      meetingId: meeting.meetingId,
      schemaVersion: 1,
    });
    this.dependencies.logger.info("Finalized recording queued for post-call processing", {
      meetingId: meeting.meetingId,
      replayed: result.replayed,
    });
  }
}
