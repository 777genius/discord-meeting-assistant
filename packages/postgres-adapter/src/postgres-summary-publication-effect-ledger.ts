import type {
  SummaryPublicationEffectLedger,
  SummaryPublicationEffectReservation,
} from "@discord-meeting/meeting-core";
import type { Pool } from "pg";

interface StoredEffectRow {
  readonly external_receipt: string | null;
  readonly publication_target_id: string;
}

export class PostgresSummaryPublicationEffectLedger
  implements SummaryPublicationEffectLedger
{
  public constructor(private readonly pool: Pool) {}

  public async reserveSummaryPublicationEffect(input: {
    readonly projectionKey: string;
    readonly publicationTargetId: string;
  }): Promise<SummaryPublicationEffectReservation> {
    validateInput(input);
    const inserted = await this.pool.query(
      `
        INSERT INTO meeting_core.summary_publication_effects
          (projection_key, publication_target_id)
        VALUES ($1, $2)
        ON CONFLICT (projection_key) DO NOTHING
        RETURNING projection_key
      `,
      [input.projectionKey, input.publicationTargetId],
    );
    if (inserted.rowCount === 1) {
      return Object.freeze({ status: "acquired" });
    }
    const existing = await this.find(input.projectionKey);
    if (existing === null) {
      throw new Error("summary publication reservation disappeared during reconciliation");
    }
    if (existing.publication_target_id !== input.publicationTargetId) {
      throw new Error("summary publication reservation conflicts with its target");
    }
    return existing.external_receipt === null
      ? Object.freeze({ status: "pending" })
      : Object.freeze({
        externalReceipt: existing.external_receipt,
        status: "completed",
      });
  }

  public async completeSummaryPublicationEffect(input: {
    readonly externalReceipt: string;
    readonly projectionKey: string;
    readonly publicationTargetId: string;
  }): Promise<void> {
    validateInput(input);
    if (input.externalReceipt.length < 1 || input.externalReceipt.length > 1_024) {
      throw new RangeError("summary publication external receipt is invalid");
    }
    const result = await this.pool.query<StoredEffectRow>(
      `
        UPDATE meeting_core.summary_publication_effects
        SET external_receipt = COALESCE(external_receipt, $3),
            completed_at = COALESCE(completed_at, transaction_timestamp())
        WHERE projection_key = $1
          AND publication_target_id = $2
          AND (external_receipt IS NULL OR external_receipt = $3)
        RETURNING publication_target_id, external_receipt
      `,
      [input.projectionKey, input.publicationTargetId, input.externalReceipt],
    );
    if (result.rowCount !== 1) {
      throw new Error("summary publication completion conflicts with its reservation");
    }
  }

  public async replaceSummaryPublicationEffect(input: {
    readonly expectedExternalReceipt: string;
    readonly externalReceipt: string;
    readonly projectionKey: string;
    readonly publicationTargetId: string;
  }): Promise<void> {
    validateInput(input);
    const result = await this.pool.query(
      `
        UPDATE meeting_core.summary_publication_effects
        SET external_receipt = $4,
            completed_at = transaction_timestamp()
        WHERE projection_key = $1
          AND publication_target_id = $2
          AND external_receipt = $3
      `,
      [
        input.projectionKey,
        input.publicationTargetId,
        input.expectedExternalReceipt,
        input.externalReceipt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("summary publication replacement lost its confirmed receipt");
    }
  }

  private async find(projectionKey: string): Promise<StoredEffectRow | null> {
    const result = await this.pool.query<StoredEffectRow>(
      `
        SELECT publication_target_id, external_receipt
        FROM meeting_core.summary_publication_effects
        WHERE projection_key = $1
      `,
      [projectionKey],
    );
    return result.rows[0] ?? null;
  }
}

function validateInput(input: {
  readonly projectionKey: string;
  readonly publicationTargetId: string;
}): void {
  if (input.projectionKey.length < 1 || input.projectionKey.length > 512) {
    throw new RangeError("summary publication projection key is invalid");
  }
  if (
    input.publicationTargetId.length < 1
    || input.publicationTargetId.length > 256
  ) {
    throw new RangeError("summary publication target is invalid");
  }
}
