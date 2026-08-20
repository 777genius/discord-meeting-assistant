import type { AcceptedFinalMeetingV1 } from "../../domain/historical-evidence.js";
import type { HistoricalEvidenceBlockPolicyV1 } from "../historical-index-plan.js";

export interface HistoricalPreparedSegmentV1 {
  readonly sourceEndCodePoint: number;
  readonly sourceStartCodePoint: number;
  readonly text: string;
  readonly turnId: string;
}

export interface HistoricalPreparedWindowV1 {
  readonly segments: readonly HistoricalPreparedSegmentV1[];
  readonly tokenCount: number;
}

export interface HistoricalReceiptDigestPort {
  digestUtf8(value: string): `sha256:${string}`;
}

export interface HistoricalIndexPlannerReceiptV1 {
  readonly requestSha256: `sha256:${string}`;
  readonly resultSha256: `sha256:${string}`;
  readonly schemaVersion: "meeting-knowledge.historical-index-planner-receipt.v1";
  readonly workerRevision: "meeting-knowledge.exact-window-planner.v1";
}

export interface HistoricalWindowPlanningProfileV1 {
  readonly digestSha256: `sha256:${string}`;
  readonly identity: string;
  readonly maximumInputTokens: number;
  readonly schemaVersion: "meeting-knowledge.window-planning-profile.v1";
}

export interface HistoricalIndexPlannerResultV1 {
  readonly effectiveTurnOverlap: number;
  readonly planningProfile: HistoricalWindowPlanningProfileV1;
  readonly receipt: HistoricalIndexPlannerReceiptV1;
  readonly windows: readonly HistoricalPreparedWindowV1[];
}

export interface HistoricalIndexPlannerOptionsV1 {
  readonly signal?: AbortSignal;
}

export class HistoricalIndexPlannerUnavailableError extends Error {
  public override readonly name = "HistoricalIndexPlannerUnavailableError";
}

/** Provider-neutral async boundary for CPU-heavy exact token partitioning. */
export interface HistoricalIndexPlannerPort {
  prepareWindows(
    meeting: AcceptedFinalMeetingV1,
    policy: HistoricalEvidenceBlockPolicyV1,
    options?: HistoricalIndexPlannerOptionsV1,
  ): Promise<HistoricalIndexPlannerResultV1>;
}
