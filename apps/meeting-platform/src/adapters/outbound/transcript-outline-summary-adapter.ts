import { createHash } from "node:crypto";

import type {
  GeneratedSummary,
  SummaryGenerationPort,
  SummaryGenerationRequest,
  SummaryGenerationResult,
} from "@discord-meeting/meeting-core/meeting-intelligence";

export interface SummaryProviderHealth {
  readonly status: "degraded" | "not_serving" | "serving";
}

/**
 * Providerless final-summary policy for the self-hosted OSS topology.
 * It deliberately does not infer decisions or actions: the authoritative
 * transcript remains the evidence and the outline only reports its size.
 */
export class TranscriptOutlineSummaryAdapter implements SummaryGenerationPort {
  public async generate(
    request: SummaryGenerationRequest,
  ): Promise<SummaryGenerationResult<GeneratedSummary>> {
    const turnCount = request.transcript.turns.length;
    return {
      ok: true,
      value: {
        actionItems: [],
        decisions: [],
        openQuestions: [],
        overview: `Authoritative transcript finalized with ${turnCount} turn${turnCount === 1 ? "" : "s"}. See the attached transcript for complete evidence.`,
        summaryId: stableSummaryId(request),
        title: "Meeting transcript",
        topics: [],
        version: 1,
      },
    };
  }

  public async checkHealth(): Promise<SummaryProviderHealth> {
    return { status: "serving" };
  }
}

function stableSummaryId(request: SummaryGenerationRequest): string {
  return `outline-${createHash("sha256")
    .update(`${request.meetingId}\0${request.idempotencyKey}\0${request.transcript.transcriptId}`)
    .digest("hex")
    .slice(0, 32)}`;
}
