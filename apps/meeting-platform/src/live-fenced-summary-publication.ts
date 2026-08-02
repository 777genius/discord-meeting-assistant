import type {
  SummaryPublicationPort,
  SummaryPublicationRequest,
} from "@discord-meeting/meeting-core";

interface FinalPublicationBarrier {
  settleBeforeFinalPublication(meetingId: string): Promise<void>;
}

export class LiveFencedSummaryPublicationPort implements SummaryPublicationPort {
  public constructor(
    private readonly delegate: SummaryPublicationPort,
    private readonly barrier: FinalPublicationBarrier,
  ) {}

  public async publish(
    request: SummaryPublicationRequest,
  ): ReturnType<SummaryPublicationPort["publish"]> {
    await this.barrier.settleBeforeFinalPublication(request.meetingId);
    return this.delegate.publish(request);
  }
}
