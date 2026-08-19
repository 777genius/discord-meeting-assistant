import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadPlatformConfig } from "../src/config.js";
import { decodeBuildProvenance } from "../src/config/build-provenance.js";
import {
  loadTwoHourHistoricalQualification,
  TWO_HOUR_QUALIFICATION_MANIFEST_SCHEMA,
} from "../src/config/two-hour-qualification.js";

const environment = {
  BIND_ADDRESS: "127.0.0.1",
  CRAIG_BEARER_TOKEN_FILE: "/run/secrets/craig",
  DISCORD_APPLICATION_ID: "1533224474609057793",
  DISCORD_BOTIK_APPLICATION_ID: "1533224474609057798",
  DISCORD_CRAIG_APPLICATION_ID: "1533224474609057794",
  DISCORD_LEGACY_GUILD_ID: "1533224474609057795",
  DISCORD_LEGACY_VOICE_CHANNEL_ID: "1533224474609057796",
  DISCORD_RESULTS_CHANNEL_ID: "1533228891827736657",
  DISCORD_TOKEN_FILE: "/run/secrets/discord",
  MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE:
    "/run/secrets/meeting-knowledge-principal-key",
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

function buildProvenance() {
  return {
    releaseRevision: "c".repeat(40),
    schemaVersion: 1 as const,
    sourceTree: "d".repeat(40),
    sourceTreeSha256: "e".repeat(64),
  };
}

function qualificationFixture() {
  const provenance = buildProvenance();
  const manifest = {
    evidenceSha256: "a".repeat(64),
    releaseRevision: provenance.releaseRevision,
    rolloutEpoch: "meeting-knowledge-r1",
    schemaVersion: TWO_HOUR_QUALIFICATION_MANIFEST_SCHEMA,
    sourceTreeSha256: provenance.sourceTreeSha256,
  };
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  return {
    accepted: {
      evidenceSha256: manifest.evidenceSha256,
      manifestSha256: createHash("sha256").update(bytes).digest("hex"),
      releaseRevision: manifest.releaseRevision,
      rolloutEpoch: manifest.rolloutEpoch,
      sourceTreeSha256: manifest.sourceTreeSha256,
    },
    bytes,
    manifest,
    provenance,
  };
}

describe("immutable release evidence configuration", () => {
  it("decodes only complete immutable commit and tree provenance", () => {
    const provenance = buildProvenance();
    expect(decodeBuildProvenance(provenance)).toEqual(provenance);
    expect(() => decodeBuildProvenance({
      ...provenance,
      sourceTreeSha256: "operator-value",
    })).toThrow("missing or invalid");
    expect(() => decodeBuildProvenance({
      ...provenance,
      runtimeOverride: "a".repeat(40),
    })).toThrow("missing or invalid");
  });

  it("loads two-hour qualification only from the retained digest and exact running tree", async () => {
    const { accepted, bytes, manifest, provenance } = qualificationFixture();
    await expect(loadTwoHourHistoricalQualification(
      "/immutable/two-hour.json",
      provenance,
      async () => bytes,
      accepted,
    )).resolves.toEqual({
      evidenceSha256: manifest.evidenceSha256,
      releaseRevision: manifest.releaseRevision,
      rolloutEpoch: manifest.rolloutEpoch,
      schemaVersion: 1,
    });
    await expect(loadTwoHourHistoricalQualification(
      "/immutable/two-hour.json",
      { ...provenance, sourceTreeSha256: "f".repeat(64) },
      async () => bytes,
      accepted,
    )).rejects.toThrow("running source tree");
    await expect(loadTwoHourHistoricalQualification(
      "/immutable/two-hour.json",
      provenance,
      async () => Buffer.from(`${bytes.toString("utf8")}\n`, "utf8"),
      accepted,
    )).rejects.toThrow("digest is not retained");
    await expect(loadTwoHourHistoricalQualification(
      "/immutable/two-hour.json",
      provenance,
      async () => bytes,
      null,
    )).rejects.toThrow("no retained two-hour qualification");
  });

  it("wires an accepted two-hour manifest through the production config loader", async () => {
    const { accepted, bytes, manifest, provenance } = qualificationFixture();
    const config = await loadPlatformConfig({
      ...environment,
      MEETING_KNOWLEDGE_TWO_HOUR_QUALIFICATION_FILE: "/immutable/two-hour.json",
      NODE_ENV: "production",
    }, async () => "value", async () => provenance, async () => bytes, accepted);

    expect(config.meetingKnowledge?.twoHourHistoricalQualification)
      .toEqual(expect.objectContaining({ rolloutEpoch: manifest.rolloutEpoch }));
    expect(config.sourceTreeSha256).toBe(provenance.sourceTreeSha256);
  });
});
