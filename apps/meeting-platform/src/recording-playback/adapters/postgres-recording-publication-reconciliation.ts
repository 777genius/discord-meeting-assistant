import type { SummaryPublicationRequest } from "@discord-meeting/meeting-core/publishing";
import type { Pool } from "pg";

export interface PendingRecordingPublicationReconciliation {
  readonly externalPublicationId: string;
  readonly leaseOwner: string;
  readonly meetingId: string;
  readonly request: SummaryPublicationRequest;
}

export class PostgresRecordingPublicationReconciliation {
  public constructor(private readonly pool: Pool) {}

  public async enqueue(input: {
    readonly externalPublicationId: string;
    readonly request: SummaryPublicationRequest;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO meeting_core.recording_publication_reconciliations
         (meeting_id, external_publication_id, request_payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (meeting_id) DO UPDATE
       SET external_publication_id = EXCLUDED.external_publication_id,
           request_payload = EXCLUDED.request_payload
       WHERE recording_publication_reconciliations.state = 'pending'`,
      [input.request.meetingId, input.externalPublicationId, JSON.stringify(input.request)],
    );
  }

  public async claim(input: {
    readonly leaseOwner: string;
    readonly leaseSeconds?: number;
    readonly limit?: number;
  }): Promise<readonly PendingRecordingPublicationReconciliation[]> {
    const limit = input.limit ?? 16;
    const leaseSeconds = input.leaseSeconds ?? 120;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("recording reconciliation batch limit is invalid");
    }
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) {
      throw new RangeError("recording reconciliation lease is invalid");
    }
    if (input.leaseOwner.length < 1 || input.leaseOwner.length > 1_024) {
      throw new RangeError("recording reconciliation lease owner is invalid");
    }
    const result = await this.pool.query<{
      readonly external_publication_id: string;
      readonly meeting_id: string;
      readonly request_payload: SummaryPublicationRequest;
    }>(`WITH candidates AS (
          SELECT meeting_id
          FROM meeting_core.recording_publication_reconciliations
          WHERE state = 'pending'
            AND (lease_expires_at IS NULL OR lease_expires_at <= transaction_timestamp())
          ORDER BY created_at, meeting_id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE meeting_core.recording_publication_reconciliations AS obligation
        SET lease_owner = $2,
            lease_expires_at = transaction_timestamp() + make_interval(secs => $3)
        FROM candidates
        WHERE obligation.meeting_id = candidates.meeting_id
        RETURNING obligation.meeting_id,
                  obligation.external_publication_id,
                  obligation.request_payload`, [limit, input.leaseOwner, leaseSeconds]);
    return result.rows.map((row) => ({
      externalPublicationId: row.external_publication_id,
      leaseOwner: input.leaseOwner,
      meetingId: row.meeting_id,
      request: row.request_payload,
    }));
  }

  public async complete(
    meetingId: string,
    leaseOwner: string,
    outcome: "edited" | "unavailable",
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE meeting_core.recording_publication_reconciliations
       SET state = $3,
           completed_at = transaction_timestamp(),
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE meeting_id = $1 AND state = 'pending' AND lease_owner = $2`,
      [meetingId, leaseOwner, outcome],
    );
    return result.rowCount === 1;
  }

  public async release(meetingId: string, leaseOwner: string): Promise<void> {
    await this.pool.query(
      `UPDATE meeting_core.recording_publication_reconciliations
       SET lease_owner = NULL, lease_expires_at = NULL
       WHERE meeting_id = $1 AND state = 'pending' AND lease_owner = $2`,
      [meetingId, leaseOwner],
    );
  }
}
