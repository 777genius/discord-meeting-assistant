import type {
  AcceptedFinalMeetingV1,
  HistoricalReleaseBindingV1,
} from "../../domain/historical-evidence.js";
import type { HistoricalIndexPlanV1 } from "./historical-memory.js";

export type HistoricalSyncOperationV1 = "delete_meeting" | "delete_release" | "index";

export interface HistoricalSyncLeaseV1 {
  readonly attempt: number;
  readonly binding: HistoricalReleaseBindingV1;
  readonly fence: number;
  readonly operation: HistoricalSyncOperationV1;
  readonly plan: HistoricalIndexPlanV1 | null;
  readonly remoteDocumentIds: Readonly<Record<string, string>>;
}

export interface HistoricalAppliedPlanV1 {
  readonly binding: HistoricalReleaseBindingV1;
  readonly plan: HistoricalIndexPlanV1;
  readonly remoteDocumentIds: Readonly<Record<string, string>>;
}

export interface HistoricalCandidateRecordV1 extends HistoricalAppliedPlanV1 {
  readonly ordinal: number;
}

export interface HistoricalSyncClaimOptionsV1 {
  readonly allowIndex: boolean;
  readonly leaseDurationMs: number;
}

export interface HistoricalOperationOptionsV1 {
  readonly signal?: AbortSignal;
}

export interface HistoricalSyncStore {
  claimNext(
    options: HistoricalSyncClaimOptionsV1,
    operationOptions?: HistoricalOperationOptionsV1,
  ): Promise<HistoricalSyncLeaseV1 | null>;

  recordPlan(
    lease: HistoricalSyncLeaseV1,
    plan: HistoricalIndexPlanV1,
    options?: HistoricalOperationOptionsV1,
  ): Promise<void>;

  recordApplied(
    lease: HistoricalSyncLeaseV1,
    plan: HistoricalIndexPlanV1,
    remoteDocumentIds: Readonly<Record<string, string>>,
    options?: HistoricalOperationOptionsV1,
  ): Promise<void>;

  recordRetry(
    lease: HistoricalSyncLeaseV1,
    failure: { readonly code: string; readonly retryAfterMs: number },
    options?: HistoricalOperationOptionsV1,
  ): Promise<void>;

  recordDeadLetter(
    lease: HistoricalSyncLeaseV1,
    code: string,
    options?: HistoricalOperationOptionsV1,
  ): Promise<void>;

  recordDeleted(
    lease: HistoricalSyncLeaseV1,
    options?: HistoricalOperationOptionsV1,
  ): Promise<void>;

  requestMeetingDeletion(
    meetingId: string,
    options?: HistoricalOperationOptionsV1,
  ): Promise<void>;

  findCurrentCandidate(
    scopeId: string,
    roomId: string,
    candidateLocator: string,
    options?: HistoricalOperationOptionsV1,
  ): Promise<HistoricalCandidateRecordV1 | null>;

  listCurrentRoomPlans(
    scopeId: string,
    roomId: string,
    maximumRows: number,
    options?: HistoricalOperationOptionsV1,
  ): Promise<readonly HistoricalAppliedPlanV1[]>;

  listDesiredRoomBindings(
    scopeId: string,
    roomId: string,
    maximumRows: number,
    options?: HistoricalOperationOptionsV1,
  ): Promise<readonly HistoricalReleaseBindingV1[]>;

  /** True only for the exact current, applied plan and its persisted index generation. */
  isCurrentGeneration(
    binding: HistoricalReleaseBindingV1,
    indexGeneration: string,
    options?: HistoricalOperationOptionsV1,
  ): Promise<boolean>;
}

/** Reads only the authoritative local meeting/transcript store. */
export interface HistoricalEvidenceAuthority {
  loadAcceptedFinalMeeting(
    binding: HistoricalReleaseBindingV1,
    options?: HistoricalOperationOptionsV1,
  ): Promise<AcceptedFinalMeetingV1 | null>;
}
