-- Existing Discord installation identities become opaque meeting source
-- identities. The migration runner owns the outer transaction and ledger
-- receipt, so schema, snapshot, and constraint changes commit atomically.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM guild_configuration.guild_installations
    WHERE jsonb_typeof(snapshot -> 'configuredByUserId') IS DISTINCT FROM 'string'
      OR length(snapshot ->> 'configuredByUserId') NOT BETWEEN 1 AND 256
      OR jsonb_typeof(snapshot -> 'voiceChannelId') IS DISTINCT FROM 'string'
      OR length(snapshot ->> 'voiceChannelId') NOT BETWEEN 1 AND 256
      OR jsonb_typeof(snapshot -> 'resultsChannelId') IS DISTINCT FROM 'string'
      OR length(snapshot ->> 'resultsChannelId') NOT BETWEEN 1 AND 256
      OR snapshot ->> 'status' IS DISTINCT FROM 'active'
  ) THEN
    RAISE EXCEPTION '0030 cannot migrate an invalid meeting source route snapshot';
  END IF;
END;
$$;

ALTER TABLE guild_configuration.guild_installations
  DROP CONSTRAINT guild_installations_snapshot_is_object,
  DROP CONSTRAINT guild_installations_snapshot_identity_matches,
  DROP CONSTRAINT guild_installations_snapshot_revision_matches;

CREATE SCHEMA IF NOT EXISTS meeting_routing;

ALTER TABLE guild_configuration.guild_installations
  SET SCHEMA meeting_routing;

ALTER TABLE meeting_routing.guild_installations
  RENAME TO source_configurations;

ALTER TABLE meeting_routing.source_configurations
  RENAME COLUMN guild_id TO source_id;

ALTER TABLE meeting_routing.source_configurations
  RENAME CONSTRAINT guild_installations_pkey TO source_configurations_pkey;

UPDATE meeting_routing.source_configurations
SET snapshot = snapshot
  - 'configuredByUserId'
  - 'guildId'
  - 'resultsChannelId'
  - 'voiceChannelId'
  || jsonb_build_object(
    'configuredByActorId', snapshot -> 'configuredByUserId',
    'publicationTargetId', snapshot -> 'resultsChannelId',
    'roomId', snapshot -> 'voiceChannelId',
    'sourceId', snapshot -> 'guildId'
  );

ALTER TABLE meeting_routing.source_configurations
  ADD CONSTRAINT source_configurations_snapshot_is_object
    CHECK ((jsonb_typeof(snapshot) = 'object') IS TRUE),
  ADD CONSTRAINT source_configurations_snapshot_identity_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'sourceId') = 'string' AND
      snapshot ->> 'sourceId' = source_id
    ) IS TRUE),
  ADD CONSTRAINT source_configurations_snapshot_revision_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'revision') = 'number' AND
      snapshot ->> 'revision' ~ '^(0|[1-9][0-9]*)$' AND
      (snapshot ->> 'revision')::bigint = revision
    ) IS TRUE),
  ADD CONSTRAINT source_configurations_snapshot_route_is_valid
    CHECK ((
      jsonb_typeof(snapshot -> 'configuredByActorId') = 'string' AND
      length(snapshot ->> 'configuredByActorId') BETWEEN 1 AND 256 AND
      jsonb_typeof(snapshot -> 'roomId') = 'string' AND
      length(snapshot ->> 'roomId') BETWEEN 1 AND 256 AND
      jsonb_typeof(snapshot -> 'publicationTargetId') = 'string' AND
      length(snapshot ->> 'publicationTargetId') BETWEEN 1 AND 256 AND
      snapshot ->> 'status' = 'active'
    ) IS TRUE);

COMMENT ON TABLE meeting_routing.source_configurations IS
  'Administrator-approved provider-neutral meeting source to publication target routing.';
COMMENT ON COLUMN meeting_routing.source_configurations.snapshot IS
  'Complete Meeting Source Routing aggregate snapshot.';

DROP SCHEMA guild_configuration;
