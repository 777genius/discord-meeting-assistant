import type { Pool } from "pg";

interface TranscriptionExecutionBindingRow {
  readonly transcription_execution_binding: string | null;
}

const maximumTranscriptionExecutionBindingLength = 128;

function requireTranscriptionExecutionBinding(binding: string): string {
  if (
    binding.length < 1 ||
    binding.length > maximumTranscriptionExecutionBindingLength ||
    !/^[a-z0-9][a-z0-9._:-]*$/u.test(binding)
  ) {
    throw new RangeError("transcription execution binding is invalid");
  }
  return binding;
}

/** Durable opaque binding store; concrete provider values remain in composition. */
export class PostgresTranscriptionExecutionBindingStore {
  public constructor(private readonly pool: Pool) {}

  public async pinTranscriptionExecutionBinding(
    meetingId: string,
    binding: string,
  ): Promise<string> {
    const requiredBinding = requireTranscriptionExecutionBinding(binding);
    const result = await this.pool.query<TranscriptionExecutionBindingRow>(
      `
        UPDATE meeting_core.post_call_outbox
        SET transcription_execution_binding = COALESCE(
          transcription_execution_binding,
          $2
        )
        WHERE meeting_id = $1
          AND processed_at IS NULL
          AND dead_lettered_at IS NULL
        RETURNING transcription_execution_binding
      `,
      [meetingId, requiredBinding],
    );
    const row = result.rows[0];
    if (row?.transcription_execution_binding === null || row === undefined) {
      throw new Error("transcription execution binding does not reference one outbox item");
    }
    return row.transcription_execution_binding;
  }

  public async getTranscriptionExecutionBinding(meetingId: string): Promise<string | undefined> {
    const result = await this.pool.query<TranscriptionExecutionBindingRow>(
      `
        SELECT transcription_execution_binding
        FROM meeting_core.post_call_outbox
        WHERE meeting_id = $1
      `,
      [meetingId],
    );
    const binding = result.rows[0]?.transcription_execution_binding;
    return binding === undefined || binding === null
      ? undefined
      : requireTranscriptionExecutionBinding(binding);
  }

  public async backfillRecoverableUnboundTranscriptionExecutionBindings(
    binding: string,
  ): Promise<number> {
    const result = await this.pool.query(
      `
        UPDATE meeting_core.post_call_outbox
        SET transcription_execution_binding = $1
        WHERE transcription_execution_binding IS NULL
          AND processed_at IS NULL
          AND dead_lettered_at IS NULL
      `,
      [requireTranscriptionExecutionBinding(binding)],
    );
    return result.rowCount ?? 0;
  }
}
