import {
  GuildConfiguration,
  type GuildConfigurationRepository,
  type GuildConfigurationSaveResult,
  type GuildConfigurationSnapshot,
} from "@discord-meeting/guild-configuration-core";
import type { Pool } from "pg";

import { CorruptMeetingSnapshotError } from "./errors.js";

interface StoredGuildConfigurationRow {
  readonly revision: number;
  readonly snapshot: unknown;
}

function normalize(snapshot: GuildConfigurationSnapshot): GuildConfigurationSnapshot {
  return GuildConfiguration.restore(snapshot).toSnapshot();
}

function restore(
  row: StoredGuildConfigurationRow,
  guildId: string,
): GuildConfigurationSnapshot {
  try {
    const snapshot = GuildConfiguration.restore(
      row.snapshot as GuildConfigurationSnapshot,
    ).toSnapshot();
    if (snapshot.guildId !== guildId || snapshot.revision !== row.revision) {
      throw new Error("stored guild configuration metadata does not match its snapshot");
    }
    return snapshot;
  } catch (error) {
    throw new CorruptMeetingSnapshotError(`guild:${guildId}`, { cause: error });
  }
}

export class PostgresGuildConfigurationRepository implements GuildConfigurationRepository {
  public constructor(private readonly pool: Pool) {}

  public async findByGuildId(guildId: string): Promise<GuildConfigurationSnapshot | null> {
    const result = await this.pool.query<StoredGuildConfigurationRow>(
      `
        SELECT revision::float8 AS revision, snapshot
        FROM guild_configuration.guild_installations
        WHERE guild_id = $1
      `,
      [guildId],
    );
    const row = result.rows[0];
    return row === undefined ? null : restore(row, guildId);
  }

  public async save(
    snapshot: GuildConfigurationSnapshot,
    expectedRevision: number | null,
  ): Promise<GuildConfigurationSaveResult> {
    const normalized = normalize(snapshot);
    if (expectedRevision === null) {
      if (normalized.revision !== 0) {
        throw new RangeError("a new guild configuration must have revision zero");
      }
      const inserted = await this.pool.query(
        `
          INSERT INTO guild_configuration.guild_installations (guild_id, revision, snapshot)
          VALUES ($1, $2, $3::jsonb)
          ON CONFLICT (guild_id) DO NOTHING
          RETURNING guild_id
        `,
        [normalized.guildId, normalized.revision, normalized],
      );
      if (inserted.rowCount === 1) {
        return { status: "saved" };
      }
      return this.conflict(normalized.guildId);
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new RangeError("expectedRevision must be a non-negative safe integer or null");
    }
    if (normalized.revision !== expectedRevision + 1) {
      throw new RangeError("updated guild configuration must advance one revision");
    }
    const updated = await this.pool.query(
      `
        UPDATE guild_configuration.guild_installations
        SET revision = $2,
            snapshot = $3::jsonb,
            updated_at = transaction_timestamp()
        WHERE guild_id = $1
          AND revision = $4
        RETURNING guild_id
      `,
      [normalized.guildId, normalized.revision, normalized, expectedRevision],
    );
    return updated.rowCount === 1 ? { status: "saved" } : this.conflict(normalized.guildId);
  }

  private async conflict(guildId: string): Promise<GuildConfigurationSaveResult> {
    const result = await this.pool.query<{ readonly revision: number }>(
      `
        SELECT revision::float8 AS revision
        FROM guild_configuration.guild_installations
        WHERE guild_id = $1
      `,
      [guildId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("guild configuration disappeared during compare-and-swap");
    }
    return { actualRevision: row.revision, status: "conflict" };
  }
}
