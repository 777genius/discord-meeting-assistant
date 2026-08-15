import {
  admitAcceptedFinalMeeting,
  validateHistoricalReleaseBinding,
  type AcceptedFinalMeetingV1,
  type HistoricalEvidenceAuthority,
  type HistoricalOperationOptionsV1,
  type HistoricalReleaseBindingV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  Meeting,
  type MeetingSnapshot,
} from "@discord-meeting/meeting-core/meeting-lifecycle";
import type { Pool } from "pg";

import { CorruptMeetingSnapshotError } from "./errors.js";
import {
  queryHistoricalPostgres,
  type HistoricalPostgresCancellationPort,
} from "./postgres-historical-query.js";

interface MeetingRow {
  readonly revision: number;
  readonly snapshot: unknown;
}

export class PostgresHistoricalEvidenceAuthority implements HistoricalEvidenceAuthority {
  public constructor(
    private readonly pool: Pool,
    private readonly cancellation?: HistoricalPostgresCancellationPort,
  ) {}

  public async loadAcceptedFinalMeeting(
    candidate: HistoricalReleaseBindingV1,
    options: HistoricalOperationOptionsV1 = {},
  ): Promise<AcceptedFinalMeetingV1 | null> {
    const binding = validateHistoricalReleaseBinding(candidate);
    const result = await queryHistoricalPostgres<MeetingRow>(this.pool, {
      text: `
        SELECT revision::float8 AS revision, snapshot
        FROM meeting_core.meetings
        WHERE meeting_id = $1
      `,
      values: [binding.meetingId],
    }, options.signal, this.cancellation);
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    let snapshot: MeetingSnapshot;
    try {
      snapshot = Meeting.restore(row.snapshot as MeetingSnapshot).toSnapshot();
      if (snapshot.revision !== row.revision || snapshot.meetingId !== binding.meetingId) {
        throw new Error("meeting row identity does not match its snapshot");
      }
    } catch (error) {
      throw new CorruptMeetingSnapshotError(binding.meetingId, { cause: error });
    }
    if (snapshot.transcriptionStage.status !== "succeeded") {
      return null;
    }
    return admitAcceptedFinalMeeting({
      actors: snapshot.actors,
      binding,
      identityProvenance: snapshot.identityProvenance,
      lifecycleGeneration: snapshot.lifecycleGeneration,
      meetingRevision: snapshot.revision,
      roomId: snapshot.source?.roomId ?? null,
      scopeId: snapshot.source?.scopeId ?? null,
      transcriptId: snapshot.transcript?.transcriptId ?? null,
      transcriptVersion: snapshot.transcript?.version ?? null,
      turns: snapshot.transcript?.turns ?? null,
    });
  }
}
