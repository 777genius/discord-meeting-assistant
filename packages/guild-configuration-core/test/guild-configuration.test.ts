import { describe, expect, it } from "vitest";

import {
  ConfigureGuild,
  GuildConfiguration,
  ResolveGuildMeetingTarget,
  type GuildConfigurationRepository,
  type GuildConfigurationSnapshot,
  type GuildSetupPublisher,
} from "../src/index.js";

const input = {
  configuredByUserId: "11111111111111111",
  guildId: "22222222222222222",
  resultsChannelId: "33333333333333333",
  voiceChannelId: "44444444444444444",
} as const;

class MemoryRepository implements GuildConfigurationRepository {
  public snapshot: GuildConfigurationSnapshot | null = null;
  public saves = 0;
  public conflictRevision: number | null = null;

  public findByGuildId(guildId: string): Promise<GuildConfigurationSnapshot | null> {
    return Promise.resolve(this.snapshot?.guildId === guildId ? this.snapshot : null);
  }

  public save(snapshot: GuildConfigurationSnapshot, expectedRevision: number | null) {
    this.saves += 1;
    if (this.conflictRevision !== null) {
      return Promise.resolve({ actualRevision: this.conflictRevision, status: "conflict" as const });
    }
    const actual = this.snapshot?.revision ?? null;
    if (actual !== expectedRevision) {
      return Promise.resolve({ actualRevision: actual ?? 0, status: "conflict" as const });
    }
    this.snapshot = snapshot;
    return Promise.resolve({ status: "saved" as const });
  }
}

class MemoryPublisher implements GuildSetupPublisher {
  public calls = 0;
  public failure = false;
  public publish() {
    this.calls += 1;
    return Promise.resolve(this.failure
      ? {
          failure: { code: "setup-publication-failed" as const, message: "failed", retryable: true },
          ok: false as const,
        }
      : { ok: true as const });
  }
}

describe("GuildConfiguration", () => {
  it("creates, restores and materially reconfigures an active guild", () => {
    const initial = GuildConfiguration.configure(input);
    expect(initial.toSnapshot()).toEqual({ ...input, revision: 0, status: "active" });
    expect(GuildConfiguration.restore(initial.toSnapshot()).toSnapshot()).toEqual(
      initial.toSnapshot(),
    );
    const changed = initial.reconfigure({
      ...input,
      configuredByUserId: "55555555555555555",
      resultsChannelId: "66666666666666666",
    });
    expect(changed.toSnapshot()).toMatchObject({
      configuredByUserId: "55555555555555555",
      resultsChannelId: "66666666666666666",
      revision: 1,
    });
  });

  it("reuses the aggregate when channels are unchanged", () => {
    const initial = GuildConfiguration.configure(input);
    expect(initial.reconfigure({ ...input, configuredByUserId: "55555555555555555" }))
      .toBe(initial);
  });

  it("rejects non-Discord identities", () => {
    expect(() => GuildConfiguration.configure({ ...input, guildId: "not-a-guild" }))
      .toThrow("guildId must be a Discord snowflake");
  });
});

describe("ConfigureGuild", () => {
  it("verifies, publishes and saves a new configuration", async () => {
    const repository = new MemoryRepository();
    const publisher = new MemoryPublisher();
    let verified = 0;
    const useCase = new ConfigureGuild(repository, {
      verify: () => {
        verified += 1;
        return Promise.resolve({ ok: true });
      },
    }, publisher);

    const result = await useCase.execute(input);

    expect(result.status).toBe("configured");
    expect(verified).toBe(1);
    expect(publisher.calls).toBe(1);
    expect(repository.saves).toBe(1);
  });

  it("rechecks permissions but reuses channels without publication or persistence", async () => {
    const repository = new MemoryRepository();
    repository.snapshot = GuildConfiguration.configure(input).toSnapshot();
    const publisher = new MemoryPublisher();
    let verified = 0;
    const useCase = new ConfigureGuild(repository, {
      verify: () => {
        verified += 1;
        return Promise.resolve({ ok: true });
      },
    }, publisher);

    expect((await useCase.execute(input)).status).toBe("reused");
    expect(verified).toBe(1);
    expect(publisher.calls).toBe(0);
    expect(repository.saves).toBe(0);
  });

  it("does not persist rejected verification or publication", async () => {
    const repository = new MemoryRepository();
    const publisher = new MemoryPublisher();
    const rejected = new ConfigureGuild(repository, {
      verify: () => Promise.resolve({
        failure: { code: "craig-not-installed", message: "missing", retryable: false },
        ok: false,
      }),
    }, publisher);
    expect((await rejected.execute(input)).status).toBe("rejected");
    expect(repository.saves).toBe(0);

    publisher.failure = true;
    const failedPublish = new ConfigureGuild(repository, {
      verify: () => Promise.resolve({ ok: true }),
    }, publisher);
    expect((await failedPublish.execute(input)).status).toBe("rejected");
    expect(repository.saves).toBe(0);
  });

  it("reports optimistic concurrency conflicts", async () => {
    const repository = new MemoryRepository();
    repository.conflictRevision = 4;
    const result = await new ConfigureGuild(
      repository,
      { verify: () => Promise.resolve({ ok: true }) },
      new MemoryPublisher(),
    ).execute(input);
    expect(result).toEqual({ actualRevision: 4, status: "conflict" });
  });
});

describe("ResolveGuildMeetingTarget", () => {
  it("resolves only the configured guild voice channel", async () => {
    const repository = new MemoryRepository();
    const resolver = new ResolveGuildMeetingTarget(repository);
    expect(await resolver.execute(input)).toEqual({ status: "not-configured" });
    repository.snapshot = GuildConfiguration.configure(input).toSnapshot();
    expect(await resolver.execute(input)).toEqual({
      publicationTargetId: input.resultsChannelId,
      status: "configured",
    });
    expect(await resolver.execute({ ...input, voiceChannelId: "77777777777777777" }))
      .toEqual({ status: "voice-channel-not-configured" });
  });
});
