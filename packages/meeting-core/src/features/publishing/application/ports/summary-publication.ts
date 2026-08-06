import type { EvidenceBackedSummarySnapshot } from "../../../meeting-intelligence/index.js";
import type { FinalTranscriptSnapshot } from "../../../transcription/index.js";
import type { PublicationReceiptSnapshot } from "../../domain/publication.js";

export interface SummaryPublicationFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type SummaryPublicationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly failure: SummaryPublicationFailure; readonly ok: false };

export interface SummaryPublicationRequest {
  /**
   * A durable physical receipt from the settled live projection, when one
   * exists. Publication adapters may use it to preserve the one visible
   * projection even if its human-facing marker was changed externally.
   */
  readonly currentExternalPublicationId?: string | null;
  readonly idempotencyKey: string;
  readonly meetingId: string;
  readonly publicationTargetId: string;
  readonly summary: EvidenceBackedSummarySnapshot;
  /** Authoritative evidence timeline used by publication adapters. */
  readonly transcript: FinalTranscriptSnapshot;
}

export interface SummaryPublicationPort {
  publish(
    request: SummaryPublicationRequest,
  ): Promise<SummaryPublicationResult<Pick<PublicationReceiptSnapshot, "externalPublicationId">>>;
}

export type SummaryPublicationEffectReservation =
  | { readonly status: "acquired" | "pending" }
  | { readonly externalReceipt: string; readonly status: "completed" };

/** Durable fence around a non-transactional external publication create. */
export interface SummaryPublicationEffectLedger {
  reserveSummaryPublicationEffect(input: {
    readonly projectionKey: string;
    readonly publicationTargetId: string;
  }): Promise<SummaryPublicationEffectReservation>;

  completeSummaryPublicationEffect(input: {
    readonly externalReceipt: string;
    readonly projectionKey: string;
    readonly publicationTargetId: string;
  }): Promise<void>;

  replaceSummaryPublicationEffect(input: {
    readonly expectedExternalReceipt: string;
    readonly externalReceipt: string;
    readonly projectionKey: string;
    readonly publicationTargetId: string;
  }): Promise<void>;
}
