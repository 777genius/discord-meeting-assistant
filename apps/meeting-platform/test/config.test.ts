import { describe, expect, it } from "vitest";

import { loadPlatformConfig } from "../src/config.js";

const environment = {
  BIND_ADDRESS: "127.0.0.1",
  CRAIG_BEARER_TOKEN_FILE: "/run/secrets/craig",
  DISCORD_APPLICATION_ID: "1533224474609057793",
  DISCORD_CRAIG_APPLICATION_ID: "1533224474609057794",
  DISCORD_LEGACY_GUILD_ID: "1533224474609057795",
  DISCORD_LEGACY_VOICE_CHANNEL_ID: "1533224474609057796",
  DISCORD_RESULTS_CHANNEL_ID: "1533228891827736657",
  DISCORD_TOKEN_FILE: "/run/secrets/discord",
  NODE_ENV: "test",
  PORT: "4310",
  POSTGRES_URL_FILE: "/run/secrets/postgres",
  RECORDING_SPOOL_ROOT: "/var/lib/discord-meeting/spool",
  REDIS_URL_FILE: "/run/secrets/redis",
  S3_ACCESS_KEY_ID_FILE: "/run/secrets/s3-access",
  S3_BUCKET: "discord-meeting",
  S3_ENDPOINT: "http://object-storage:8333",
  S3_PREFIX: "recordings/",
  S3_REGION: "us-east-1",
  S3_SECRET_ACCESS_KEY_FILE: "/run/secrets/s3-secret",
  SPEACHES_BASE_URL: "http://speaches:8000",
  SPEACHES_MODEL: "Systran/faster-whisper-small",
  SUBSCRIPTION_RUNTIME_ADDRESS: "subscription-runtime-sidecar:50052",
  SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256: "a".repeat(64),
  SUBSCRIPTION_RUNTIME_TOKEN_FILE: "/run/secrets/runtime",
  TRANSCRIPTION_PROVIDER: "speaches",
} as const;

describe("platform configuration", () => {
  it("loads every secret through the file reader and never requires an API key", async () => {
    const paths: string[] = [];
    const config = await loadPlatformConfig(environment, async (path) => {
      paths.push(path);
      return `value-for:${path}`;
    });

    expect(paths).toHaveLength(7);
    expect(config.secrets.discordToken).toBe("value-for:/run/secrets/discord");
    expect(config.discordPublicationMode).toBe("message");
    expect(Object.keys(environment)).not.toContain("OPENAI_API_KEY");
  });

  it("uses direct channel publication by default and accepts explicit legacy threads", async () => {
    const direct = await loadPlatformConfig(environment, async () => "value");
    const thread = await loadPlatformConfig(
      { ...environment, DISCORD_PUBLICATION_MODE: "thread" },
      async () => "value",
    );

    expect(direct.discordPublicationMode).toBe("message");
    expect(thread.discordPublicationMode).toBe("thread");
    await expect(loadPlatformConfig(
      { ...environment, DISCORD_PUBLICATION_MODE: "channel" },
      async () => "value",
    )).rejects.toThrow();
  });

  it("accepts only a guild-bound legacy publication fallback", async () => {
    const config = await loadPlatformConfig({
      ...environment,
      DISCORD_LEGACY_GUILD_ID: "1533224474609057795",
      DISCORD_LEGACY_VOICE_CHANNEL_ID: "1533224474609057796",
    }, async () => "value");
    expect(config.discordLegacyRoute).toEqual({
      guildId: "1533224474609057795",
      publicationTargetId: "1533228891827736657",
      voiceChannelId: "1533224474609057796",
    });
    const selfService = await loadPlatformConfig({
      ...environment,
      DISCORD_LEGACY_GUILD_ID: "",
      DISCORD_LEGACY_VOICE_CHANNEL_ID: "",
      DISCORD_RESULTS_CHANNEL_ID: "",
    }, async () => "value");
    expect(selfService.discordLegacyRoute).toBeUndefined();
    await expect(loadPlatformConfig({
      ...environment,
      DISCORD_LEGACY_VOICE_CHANNEL_ID: "",
      DISCORD_RESULTS_CHANNEL_ID: "",
    }, async () => "value")).rejects.toThrow();
  });

  it("loads a Voicetext machine bearer only from a secret file", async () => {
    const config = await loadPlatformConfig(
      {
        ...environment,
        TRANSCRIPTION_PROVIDER: "voicetext",
        VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
        VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        VOICETEXT_BATCH_MAX_CONCURRENCY: "6",
        VOICETEXT_BATCH_MAX_CONCURRENT_MEETINGS: "2",
      },
      async (path) => `value-for:${path}`,
    );

    expect(config.transcriptionProvider).toBe("voicetext");
    expect(config.secrets.voicetextServiceToken).toBe("value-for:/run/secrets/voicetext");
    expect(config.voicetext?.webSocketUrl).toBe(
      "wss://api.voicetext.site/api/v1/transcribe/stream",
    );
    expect(config.voicetext?.batchMaxArtifactBytes).toBe(64 * 1_024 * 1_024);
    expect(config.voicetext?.batchMaxConcurrency).toBe(6);
    expect(config.voicetext?.batchMaxConcurrentMeetings).toBe(2);

    const defaults = await loadPlatformConfig(
      {
        ...environment,
        TRANSCRIPTION_PROVIDER: "voicetext",
        VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
        VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
      },
      async () => "value",
    );
    expect(defaults.voicetext?.batchMaxConcurrentMeetings).toBe(1);
  });

  it("requires secure complete Voicetext configuration", async () => {
    await expect(
      loadPlatformConfig(
        { ...environment, TRANSCRIPTION_PROVIDER: "voicetext" },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_BATCH_MAX_CONCURRENT_MEETINGS: "0",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_BATCH_MAX_CONCURRENT_MEETINGS: "3",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "ws://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
  });

  it("rejects unknown environment input and credential-bearing endpoints", async () => {
    await expect(
      loadPlatformConfig({ ...environment, OPENAI_API_KEY: "forbidden" }, async () => "x"),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        { ...environment, SPEACHES_BASE_URL: "http://user:pass@speaches:8000" },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_BATCH_MAX_ARTIFACT_BYTES: String(64 * 1_024 * 1_024 + 1),
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_BATCH_MAX_CONCURRENCY: "0",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_BATCH_MAX_CONCURRENCY: "11",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
  });
});
