CREATE SCHEMA IF NOT EXISTS guild_configuration;

CREATE TABLE IF NOT EXISTS guild_configuration.guild_installations (
  guild_id text PRIMARY KEY,
  revision bigint NOT NULL
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT guild_installations_snapshot_is_object
    CHECK ((jsonb_typeof(snapshot) = 'object') IS TRUE),
  CONSTRAINT guild_installations_snapshot_identity_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'guildId') = 'string' AND
      snapshot ->> 'guildId' = guild_id
    ) IS TRUE),
  CONSTRAINT guild_installations_snapshot_revision_matches
    CHECK ((
      jsonb_typeof(snapshot -> 'revision') = 'number' AND
      snapshot ->> 'revision' ~ '^(0|[1-9][0-9]*)$' AND
      (snapshot ->> 'revision')::bigint = revision
    ) IS TRUE)
);

COMMENT ON TABLE guild_configuration.guild_installations IS
  'Administrator-approved Discord voice-to-results routing configuration.';
COMMENT ON COLUMN guild_configuration.guild_installations.snapshot IS
  'Complete Guild Installation & Configuration aggregate snapshot.';
