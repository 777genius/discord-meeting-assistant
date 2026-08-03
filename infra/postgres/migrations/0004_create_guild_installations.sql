BEGIN;

CREATE SCHEMA IF NOT EXISTS guild_configuration;

CREATE TABLE IF NOT EXISTS guild_configuration.guild_installations (
  guild_id text PRIMARY KEY,
  revision bigint NOT NULL
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT guild_installations_snapshot_is_object
    CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT guild_installations_snapshot_identity_matches
    CHECK (snapshot ->> 'guildId' = guild_id),
  CONSTRAINT guild_installations_snapshot_revision_matches
    CHECK ((snapshot ->> 'revision')::bigint = revision)
);

COMMENT ON TABLE guild_configuration.guild_installations IS
  'Administrator-approved Discord voice-to-results routing configuration.';
COMMENT ON COLUMN guild_configuration.guild_installations.snapshot IS
  'Complete Guild Installation & Configuration aggregate snapshot.';

COMMIT;
