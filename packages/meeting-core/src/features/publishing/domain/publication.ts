import type { ExternalPublicationId } from "./identifiers.js";

export interface PublicationReceiptSnapshot {
  readonly externalPublicationId: string;
  readonly idempotencyKey: string;
  /** Opaque authenticated identity that performed the external publication. */
  readonly publisherIdentity?: string;
}

export interface PublicationReceipt {
  readonly externalPublicationId: ExternalPublicationId;
  readonly idempotencyKey: string;
  readonly publisherIdentity: string;
}
