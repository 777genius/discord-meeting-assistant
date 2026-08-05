-- Stop-first expand/contract migration. The migration runner owns the outer
-- transaction and writes its ledger receipt in the same transaction.
--
-- Do not run an old live-meeting binary while this migration is applied. Once
-- the legacy keys are removed, the final constraint intentionally rejects an
-- old binary attempting to write embedded arrays back into the compact row.

CREATE TABLE IF NOT EXISTS meeting_core.live_meeting_turns (
  meeting_id text NOT NULL
    REFERENCES meeting_core.live_meetings(meeting_id) ON DELETE CASCADE,
  turn_id text NOT NULL,
  start_ms bigint NOT NULL
    CHECK (start_ms BETWEEN 0 AND 9007199254740991),
  end_ms bigint NOT NULL
    CHECK (end_ms BETWEEN 0 AND 9007199254740991 AND end_ms > start_ms),
  speaker_id text NOT NULL,
  turn jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (meeting_id, turn_id),
  CONSTRAINT live_meeting_turn_is_object
    CHECK ((jsonb_typeof(turn) = 'object') IS TRUE),
  CONSTRAINT live_meeting_turn_identity_matches
    CHECK ((
      jsonb_typeof(turn -> 'turnId') = 'string' AND
      turn ->> 'turnId' = turn_id
    ) IS TRUE),
  CONSTRAINT live_meeting_turn_timing_matches
    CHECK ((
      jsonb_typeof(turn -> 'startMs') = 'number' AND
      jsonb_typeof(turn -> 'endMs') = 'number' AND
      turn ->> 'startMs' ~ '^(0|[1-9][0-9]*)$' AND
      turn ->> 'endMs' ~ '^(0|[1-9][0-9]*)$' AND
      (turn ->> 'startMs')::bigint = start_ms AND
      (turn ->> 'endMs')::bigint = end_ms
    ) IS TRUE),
  CONSTRAINT live_meeting_turn_speaker_matches
    CHECK ((
      jsonb_typeof(turn -> 'speakerId') = 'string' AND
      turn ->> 'speakerId' = speaker_id
    ) IS TRUE),
  CONSTRAINT live_meeting_turn_text_is_string
    CHECK ((jsonb_typeof(turn -> 'text') = 'string') IS TRUE)
);

CREATE INDEX IF NOT EXISTS live_meeting_turns_timeline_idx
  ON meeting_core.live_meeting_turns (meeting_id, start_ms, end_ms, speaker_id, turn_id);

CREATE TABLE IF NOT EXISTS meeting_core.live_meeting_summary_coverage (
  meeting_id text NOT NULL,
  turn_id text NOT NULL,
  first_summary_revision bigint NOT NULL CHECK (first_summary_revision >= 1),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (meeting_id, turn_id),
  FOREIGN KEY (meeting_id, turn_id)
    REFERENCES meeting_core.live_meeting_turns(meeting_id, turn_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meeting_core.live_meeting_generation_usage (
  meeting_id text NOT NULL
    REFERENCES meeting_core.live_meetings(meeting_id) ON DELETE CASCADE,
  run_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (meeting_id, run_id),
  CONSTRAINT live_meeting_generation_usage_payload_is_object
    CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  CONSTRAINT live_meeting_generation_usage_identity_matches
    CHECK ((
      jsonb_typeof(payload -> 'runId') = 'string' AND
      payload ->> 'runId' = run_id
    ) IS TRUE)
);

CREATE TABLE IF NOT EXISTS meeting_core.live_meeting_generation_telemetry (
  meeting_id text NOT NULL
    REFERENCES meeting_core.live_meetings(meeting_id) ON DELETE CASCADE,
  run_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (meeting_id, run_id),
  CONSTRAINT live_meeting_generation_telemetry_payload_is_object
    CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  CONSTRAINT live_meeting_generation_telemetry_identity_matches
    CHECK ((
      jsonb_typeof(payload -> 'runId') = 'string' AND
      payload ->> 'runId' = run_id
    ) IS TRUE)
);

-- Validate every legacy shape and every potential key collision before any
-- write. An exact replay is safe; differing evidence always aborts the whole
-- transaction instead of using a silent ON CONFLICT DO NOTHING.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM meeting_core.live_meetings
    WHERE snapshot ? 'turns'
      AND jsonb_typeof(snapshot -> 'turns') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION '0005 cannot backfill non-array legacy turns';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meeting_core.live_meetings
    WHERE snapshot ? 'generationUsage'
      AND jsonb_typeof(snapshot -> 'generationUsage') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION '0005 cannot backfill non-array legacy generationUsage';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meeting_core.live_meetings
    WHERE snapshot ? 'generationTelemetry'
      AND jsonb_typeof(snapshot -> 'generationTelemetry') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION '0005 cannot backfill non-array legacy generationTelemetry';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meeting_core.live_meetings
    WHERE snapshot ? 'summarizedTurnIds'
      AND jsonb_typeof(snapshot -> 'summarizedTurnIds') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION '0005 cannot backfill non-array legacy summarizedTurnIds';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meeting_core.live_meetings AS live
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN live.snapshot ? 'summarizedTurnIds'
        THEN live.snapshot -> 'summarizedTurnIds' ELSE '[]'::jsonb END
    ) AS item(value)
    WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string'
  ) THEN
    RAISE EXCEPTION '0005 cannot backfill non-string legacy summarizedTurnIds';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meeting_core.live_meetings
    WHERE snapshot ? 'summarizedTurnIds'
      AND jsonb_array_length(snapshot -> 'summarizedTurnIds') > 0
      AND NOT (
        jsonb_typeof(snapshot -> 'draftSummary') = 'object' AND
        jsonb_typeof(snapshot -> 'draftSummary' -> 'revision') = 'number' AND
        snapshot -> 'draftSummary' ->> 'revision' ~ '^[1-9][0-9]*$'
      )
  ) THEN
    RAISE EXCEPTION '0005 cannot backfill summary coverage without a positive draft summary revision';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meeting_core.live_meetings AS live
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN live.snapshot ? 'turns' THEN live.snapshot -> 'turns' ELSE '[]'::jsonb END
    ) AS item(turn)
    JOIN meeting_core.live_meeting_turns AS stored
      ON stored.meeting_id = live.meeting_id
      AND stored.turn_id = item.turn ->> 'turnId'
    WHERE stored.turn IS DISTINCT FROM item.turn
      OR stored.start_ms IS DISTINCT FROM (item.turn ->> 'startMs')::bigint
      OR stored.end_ms IS DISTINCT FROM (item.turn ->> 'endMs')::bigint
      OR stored.speaker_id IS DISTINCT FROM item.turn ->> 'speakerId'
  ) THEN
    RAISE EXCEPTION '0005 found conflicting existing live transcript evidence';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meeting_core.live_meetings AS live
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN live.snapshot ? 'generationUsage'
        THEN live.snapshot -> 'generationUsage' ELSE '[]'::jsonb END
    ) AS item(payload)
    JOIN meeting_core.live_meeting_generation_usage AS stored
      ON stored.meeting_id = live.meeting_id
      AND stored.run_id = item.payload ->> 'runId'
    WHERE stored.payload IS DISTINCT FROM item.payload
  ) THEN
    RAISE EXCEPTION '0005 found conflicting existing live generation usage';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meeting_core.live_meetings AS live
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN live.snapshot ? 'generationTelemetry'
        THEN live.snapshot -> 'generationTelemetry' ELSE '[]'::jsonb END
    ) AS item(payload)
    JOIN meeting_core.live_meeting_generation_telemetry AS stored
      ON stored.meeting_id = live.meeting_id
      AND stored.run_id = item.payload ->> 'runId'
    WHERE stored.payload IS DISTINCT FROM item.payload
  ) THEN
    RAISE EXCEPTION '0005 found conflicting existing live generation telemetry';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meeting_core.live_meetings AS live
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN live.snapshot ? 'summarizedTurnIds'
        THEN live.snapshot -> 'summarizedTurnIds' ELSE '[]'::jsonb END
    ) AS item(turn_id)
    JOIN meeting_core.live_meeting_summary_coverage AS stored
      ON stored.meeting_id = live.meeting_id
      AND stored.turn_id = item.turn_id
    WHERE stored.first_summary_revision IS DISTINCT FROM
      (live.snapshot -> 'draftSummary' ->> 'revision')::bigint
  ) THEN
    RAISE EXCEPTION '0005 found conflicting existing live summary coverage';
  END IF;
END;
$$;

INSERT INTO meeting_core.live_meeting_turns
  (meeting_id, turn_id, start_ms, end_ms, speaker_id, turn)
SELECT live.meeting_id,
       item.turn ->> 'turnId',
       (item.turn ->> 'startMs')::bigint,
       (item.turn ->> 'endMs')::bigint,
       item.turn ->> 'speakerId',
       item.turn
FROM meeting_core.live_meetings AS live
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN live.snapshot ? 'turns' THEN live.snapshot -> 'turns' ELSE '[]'::jsonb END
) AS item(turn)
ON CONFLICT (meeting_id, turn_id) DO UPDATE
  SET turn = EXCLUDED.turn
  WHERE meeting_core.live_meeting_turns.turn = EXCLUDED.turn
    AND meeting_core.live_meeting_turns.start_ms = EXCLUDED.start_ms
    AND meeting_core.live_meeting_turns.end_ms = EXCLUDED.end_ms
    AND meeting_core.live_meeting_turns.speaker_id = EXCLUDED.speaker_id;

INSERT INTO meeting_core.live_meeting_generation_usage (meeting_id, run_id, payload)
SELECT live.meeting_id,
       item.payload ->> 'runId',
       item.payload
FROM meeting_core.live_meetings AS live
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN live.snapshot ? 'generationUsage' THEN live.snapshot -> 'generationUsage'
    ELSE '[]'::jsonb
  END
) AS item(payload)
ON CONFLICT (meeting_id, run_id) DO UPDATE
  SET payload = EXCLUDED.payload
  WHERE meeting_core.live_meeting_generation_usage.payload = EXCLUDED.payload;

INSERT INTO meeting_core.live_meeting_generation_telemetry (meeting_id, run_id, payload)
SELECT live.meeting_id,
       item.payload ->> 'runId',
       item.payload
FROM meeting_core.live_meetings AS live
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN live.snapshot ? 'generationTelemetry' THEN live.snapshot -> 'generationTelemetry'
    ELSE '[]'::jsonb
  END
) AS item(payload)
ON CONFLICT (meeting_id, run_id) DO UPDATE
  SET payload = EXCLUDED.payload
  WHERE meeting_core.live_meeting_generation_telemetry.payload = EXCLUDED.payload;

INSERT INTO meeting_core.live_meeting_summary_coverage
  (meeting_id, turn_id, first_summary_revision)
SELECT live.meeting_id,
       item.turn_id,
       (live.snapshot -> 'draftSummary' ->> 'revision')::bigint
FROM meeting_core.live_meetings AS live
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE
    WHEN live.snapshot ? 'summarizedTurnIds' THEN live.snapshot -> 'summarizedTurnIds'
    ELSE '[]'::jsonb
  END
) AS item(turn_id)
ON CONFLICT (meeting_id, turn_id) DO UPDATE
  SET first_summary_revision = EXCLUDED.first_summary_revision
  WHERE meeting_core.live_meeting_summary_coverage.first_summary_revision =
    EXCLUDED.first_summary_revision;

UPDATE meeting_core.live_meetings
SET snapshot = snapshot
  - 'turns'
  - 'summarizedTurnIds'
  - 'generationUsage'
  - 'generationTelemetry',
    updated_at = transaction_timestamp()
WHERE snapshot ?| ARRAY[
  'turns',
  'summarizedTurnIds',
  'generationUsage',
  'generationTelemetry'
];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'meeting_core.live_meetings'::regclass
      AND conname = 'live_meetings_snapshot_excludes_legacy_records'
  ) THEN
    ALTER TABLE meeting_core.live_meetings
      ADD CONSTRAINT live_meetings_snapshot_excludes_legacy_records
      CHECK ((NOT (snapshot ?| ARRAY[
        'turns',
        'summarizedTurnIds',
        'generationUsage',
        'generationTelemetry'
      ])) IS TRUE);
  END IF;
END;
$$;

COMMENT ON TABLE meeting_core.live_meetings IS
  'Compact CAS lifecycle, live-summary and projection state; timeline and operational generation data are append-only tables.';
COMMENT ON TABLE meeting_core.live_meeting_turns IS
  'Append-only finalized derived live transcript turns. Craig original recording remains authoritative evidence.';
COMMENT ON TABLE meeting_core.live_meeting_summary_coverage IS
  'Immutable first accepted incremental-summary coverage for each finalized live turn.';
COMMENT ON TABLE meeting_core.live_meeting_generation_usage IS
  'Append-only provider generation usage ledger keyed by stable run ID; not business aggregate state.';
COMMENT ON TABLE meeting_core.live_meeting_generation_telemetry IS
  'Append-only provider generation telemetry ledger keyed by stable run ID; not business aggregate state.';
