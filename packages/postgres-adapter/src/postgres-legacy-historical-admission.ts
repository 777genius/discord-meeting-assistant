import { createHash } from "node:crypto";
import { legacyHistoricalCanonicalJson, type LegacyHistoricalAdmissionStorePort,
  type LegacyHistoricalReceiptVerifierPort } from "@discord-meeting/meeting-core/meeting-knowledge";
import type { Pool } from "pg";
import { lockMeetingKnowledgeSource } from "./postgres-answer-source-withdrawal.js";
import { legacyHistoricalSha256, resolveAcceptedHistoricalMeeting } from "./postgres-accepted-historical-meeting.js";
import { acceptHistoricalReleaseInTransaction } from "./postgres-historical-release-acceptance.js";
import { withHistoricalPostgresTransaction } from "./postgres-historical-query.js";

export async function acceptLegacyHistoricalAdmission(input: {
  readonly pool: Pool;
  readonly verifier: LegacyHistoricalReceiptVerifierPort;
  readonly receipt: unknown;
  readonly savedSourceJson: string;
}): Promise<"accepted" | "replayed"> {
  const receipt = input.verifier.verify(input.receipt);
  const { binding } = receipt.payload;
  // The saved source is exact UTF-8 JSON of the accepted transcript, never evidence of identity.
  if (createHash("sha256").update(input.savedSourceJson, "utf8").digest("hex") !==
      receipt.payload.savedSourceSha256 ||
    legacyHistoricalSha256(JSON.parse(input.savedSourceJson)) !== receipt.payload.transcriptSha256) {
    throw new Error("legacy saved source does not match the signed accepted transcript");
  }
  const receiptJson = legacyHistoricalCanonicalJson(receipt);
  return withHistoricalPostgresTransaction(input.pool, undefined, async (client) => {
    await lockMeetingKnowledgeSource(client, binding.meetingId);
    const result = await client.query<{ readonly revision: number; readonly snapshot: unknown }>(
      `SELECT revision::float8 AS revision, snapshot FROM meeting_core.meetings
       WHERE meeting_id = $1 FOR UPDATE`, [binding.meetingId]);
    const row = result.rows[0];
    if (row === undefined || resolveAcceptedHistoricalMeeting({ ...row, binding, receipt,
      verifier: input.verifier })?.admission !== "signed_legacy_v1") {
      throw new Error("legacy admission does not match the current accepted database snapshot");
    }
    const existing = await client.query<{ readonly receipt_json: string }>(
      `SELECT receipt_json FROM meeting_core.legacy_historical_admissions WHERE release_id = $1`,
      [binding.releaseId]);
    if (existing.rows[0] !== undefined && existing.rows[0].receipt_json !== receiptJson) {
      throw new Error("legacy admission replay conflicts with its immutable signed receipt");
    }
    if (existing.rows[0] === undefined) {
      await client.query(`INSERT INTO meeting_core.legacy_historical_admissions
        (release_id, meeting_id, receipt_json, snapshot_sha256, transcript_sha256,
         saved_source_sha256, identity_evidence_sha256, scope_room_evidence_sha256, duration_evidence_sha256)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [binding.releaseId, binding.meetingId, receiptJson, receipt.payload.snapshotSha256,
        receipt.payload.transcriptSha256, receipt.payload.savedSourceSha256,
        receipt.payload.identityEvidenceSha256, receipt.payload.scopeRoomEvidenceSha256,
        receipt.payload.durationEvidenceSha256]);
    }
    return acceptHistoricalReleaseInTransaction(client, binding);
  });
}

export class PostgresLegacyHistoricalAdmissionStore implements LegacyHistoricalAdmissionStorePort {
  public constructor(private readonly pool: Pool, private readonly verifier: LegacyHistoricalReceiptVerifierPort) {}
  public accept(input: Parameters<LegacyHistoricalAdmissionStorePort["accept"]>[0]) {
    return acceptLegacyHistoricalAdmission({ ...input, pool: this.pool, verifier: this.verifier });
  }
}
