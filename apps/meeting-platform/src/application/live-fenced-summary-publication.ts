import type {
  LiveMeetingSnapshot,
  SummaryPublicationPort,
  SummaryPublicationRequest,
} from "@discord-meeting/meeting-core";

interface FinalPublicationBarrier {
  settleBeforeFinalPublication(meetingId: string): Promise<void>;
}

interface SettledLiveProjectionReceiptReader {
  findById(
    meetingId: string,
  ): Promise<
    Pick<LiveMeetingSnapshot, "projectionExternalId" | "publicationTargetId"> | null
  >;
}

export class LiveFencedSummaryPublicationPort implements SummaryPublicationPort {
  public constructor(
    private readonly delegate: SummaryPublicationPort,
    private readonly barrier: FinalPublicationBarrier,
    private readonly liveReceipts: SettledLiveProjectionReceiptReader,
  ) {}

  public async publish(
    request: SummaryPublicationRequest,
  ): ReturnType<SummaryPublicationPort["publish"]> {
    await this.barrier.settleBeforeFinalPublication(request.meetingId);
    const liveProjection = await this.liveReceipts.findById(request.meetingId);
    const currentExternalPublicationId =
      liveProjection?.publicationTargetId === request.publicationTargetId
        ? liveProjection.projectionExternalId
        : undefined;
    return this.delegate.publish({
      ...request,
      ...(currentExternalPublicationId === null || currentExternalPublicationId === undefined
        ? {}
        : { currentExternalPublicationId }),
    });
  }
}
