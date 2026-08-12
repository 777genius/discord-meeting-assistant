import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadSupplementalVoicePlaybackConfig,
  loadVerifiedSupplementalVoiceManifest,
} from "../src/supplemental-voice-playback-config.js";

const baseEnvironment = {
  DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID: "campaign-1",
  DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_ARMED_PATH: "/tmp/speaker-d.connection.armed.json",
  DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_PATH: "/tmp/speaker-d.connection.json",
  DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT: "/tmp/speaker-d.evidence.json",
  DISCORD_E2E_SUPPLEMENTAL_MANIFEST: "/tmp/speaker-d.manifest.json",
  DISCORD_E2E_SUPPLEMENTAL_GATE_TIMEOUT_MS: "30000",
  DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_PATH: "/tmp/speaker-d.playback.json",
  DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_ARMED_PATH: "/tmp/speaker-d.playback.armed.json",
  DISCORD_E2E_SUPPLEMENTAL_PRIVATE_TEST_GUILD: "private-test-guild",
  DISCORD_E2E_SUPPLEMENTAL_RUN_ID: "retained-campaign-speaker-d-1",
} as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

describe("loadSupplementalVoicePlaybackConfig", () => {
  it("requires an acknowledged private target and bounded gate/post timeouts", () => {
    const config = loadSupplementalVoicePlaybackConfig({
      ...baseEnvironment,
      DISCORD_E2E_SUPPLEMENTAL_POST_HOLD_MS: "60000",
    });

    expect(config).toMatchObject({
      keychainAccount: "speaker-d",
      postHoldMilliseconds: 60_000,
      gateTimeoutMilliseconds: 30_000,
      privateTestGuildConfirmed: true,
      runId: "retained-campaign-speaker-d-1",
    });
    expect(() => loadSupplementalVoicePlaybackConfig({
      ...baseEnvironment,
      DISCORD_E2E_SUPPLEMENTAL_POST_HOLD_MS: "60001",
    })).toThrow();
    expect(() => loadSupplementalVoicePlaybackConfig({
      ...baseEnvironment,
      DISCORD_E2E_SUPPLEMENTAL_PRIVATE_TEST_GUILD: "public-guild",
    })).toThrow();
  });

  it("requires four distinct absolute gate/armed paths and explicit campaign correlation", () => {
    expect(() => loadSupplementalVoicePlaybackConfig({
      ...baseEnvironment, DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_PATH: "relative.json",
    })).toThrow();
    expect(() => loadSupplementalVoicePlaybackConfig({
      ...baseEnvironment,
      DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_PATH: baseEnvironment.DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_PATH,
    })).toThrow("must be distinct");
    expect(() => loadSupplementalVoicePlaybackConfig({
      ...baseEnvironment,
      DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_ARMED_PATH:
        baseEnvironment.DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_ARMED_PATH,
    })).toThrow("must be distinct");
    const withoutCampaign = { ...baseEnvironment } as Record<string, string>;
    delete withoutCampaign.DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID;
    expect(() => loadSupplementalVoicePlaybackConfig(withoutCampaign)).toThrow();
    expect(() => loadSupplementalVoicePlaybackConfig({
      ...baseEnvironment, DISCORD_E2E_SUPPLEMENTAL_PRE_HOLD_MS: "1",
    })).toThrow("pre-hold synchronization is forbidden");
  });

  it("rejects every supplemental token environment variable before parsing", () => {
    expect(() => loadSupplementalVoicePlaybackConfig({
      ...baseEnvironment,
      DISCORD_E2E_SUPPLEMENTAL_BOT_TOKEN: "must-not-be-read",
    })).toThrow("does not accept bot tokens through environment variables");
  });

  it("requires absolute secret, manifest, and evidence paths", () => {
    expect(() => loadSupplementalVoicePlaybackConfig({
      ...baseEnvironment,
      DISCORD_E2E_SUPPLEMENTAL_SECRET_DIRECTORY: "relative/secrets",
    })).toThrow();
    expect(() => loadSupplementalVoicePlaybackConfig({
      ...baseEnvironment,
      DISCORD_E2E_SUPPLEMENTAL_MANIFEST: "relative/manifest.json",
    })).toThrow();
    expect(() => loadSupplementalVoicePlaybackConfig({
      ...baseEnvironment,
      DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT: "relative/evidence.json",
    })).toThrow();
  });
});

describe("loadVerifiedSupplementalVoiceManifest", () => {
  it("pins the official application, private target, Ogg SHA-256, duration, and purpose", async () => {
    const manifestPath = resolve("test/fixtures/supplemental-voice-playback.v1.json");

    await expect(loadVerifiedSupplementalVoiceManifest(manifestPath, 60_000)).resolves.toMatchObject({
      applicationId: "1533873978417086474",
      fixture: {
        durationMs: 24_226,
        path: resolve("test/fixtures/supplemental-question-farewell.ru.ogg"),
        sha256: "fa4d4db0e725944e65cacef8dff12172b2fac2456f2cd5ded33eddc86328c608",
      },
      guildId: "1533228590643155034",
      voiceChannelId: "1533228823045214398",
    });
  });

  it("rejects a changed fixture hash and a timeout shorter than the pinned audio", async () => {
    const directory = await mkdtemp(join(tmpdir(), "discord-e2e-supplemental-"));
    temporaryDirectories.push(directory);
    const fixturePath = resolve("test/fixtures/speaker-a.ru-en.ogg");
    const manifestPath = join(directory, "speaker-d.manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      ...manifest(fixturePath),
      fixture: { ...manifest(fixturePath).fixture, sha256: "0".repeat(64) },
    }), "utf8");
    await expect(loadVerifiedSupplementalVoiceManifest(manifestPath, 60_000)).rejects.toThrow(
      "SHA-256",
    );

    await writeFile(manifestPath, JSON.stringify(manifest(fixturePath)), "utf8");
    await expect(loadVerifiedSupplementalVoiceManifest(manifestPath, 20_000)).rejects.toThrow(
      "cannot cover",
    );
  });
});

function manifest(fixturePath: string) {
  return {
    applicationId: "33333333333333333",
    fixture: {
      durationMs: 26_235,
      path: fixturePath,
      purpose: "speaker-d-botik-question-and-later-group-farewell" as const,
      sha256: "8e29a933ef95eaf1f149b150ff123f90a3276847fcd4941ccb6c55b24561b9d8",
    },
    guildId: "11111111111111111",
    privateTestGuildAcknowledgement: "private-test-guild" as const,
    schemaVersion: 1 as const,
    voiceChannelId: "22222222222222222",
  };
}
