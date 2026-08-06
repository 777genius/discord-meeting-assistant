import type { ExternalPublicationId } from "./identifiers.js";

export interface PublicationReceiptSnapshot {
  readonly externalPublicationId: string;
  readonly idempotencyKey: string;
}

export interface PublicationReceipt {
  readonly externalPublicationId: ExternalPublicationId;
  readonly idempotencyKey: string;
}
