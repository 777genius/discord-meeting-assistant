import type { FinalReplyMaintenancePort } from "./ports/final-reply.js";

/** Runs bounded durable cleanup independently from final-reply serving. */
export class MaintainFinalReplies {
  public constructor(
    private readonly maintenance: FinalReplyMaintenancePort,
    private readonly servingEnabled: boolean,
  ) {}

  public execute(maximumJobs: number): Promise<{
    readonly cancelled: number;
    readonly expired: number;
  }> {
    return this.maintenance.maintain({
      maximumJobs,
      servingEnabled: this.servingEnabled,
    });
  }
}
