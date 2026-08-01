import { describe, expect, it } from "vitest";

import { loadPlatformConfig } from "../src/config.js";

const environment = {
  BIND_ADDRESS: "127.0.0.1",
  CRAIG_BEARER_TOKEN_FILE: "/run/secrets/craig",
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
    expect(Object.keys(environment)).not.toContain("OPENAI_API_KEY");
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
  });
});
