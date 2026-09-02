import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createHostedCampaignSharedMountReceiptV1,
  HostedCampaignSharedMountProbe,
  type HostedCampaignSharedMountExpectationV1,
  verifyHostedCampaignSharedMountReceiptV1,
} from "../src/hosted-campaign-shared-mount.js";
import { HOSTED_CAMPAIGN_TARGET } from "../src/hosted-campaign-target.js";

const campaignBotikApplicationId = "1533877611258708230";

const expectation: HostedCampaignSharedMountExpectationV1 = {
  campaignId: "campaign-1",
  containerRoot: "/run/e2e-campaign",
  expectedGid: 10_001,
  expectedMode: 0o700,
  expectedUid: 10_001,
  hostRoot: "/srv/e2e/campaign-1",
  maximumAgeMs: 10_000,
};

const nonce = {
  host: "host-nonce-0000001",
  platform: "platform-nonce-001",
  runner: "runner-nonce-00001",
};

function root(requestedPath: string) {
  return { gid: 10_001, mode: 0o700, requestedPath, resolvedPath: requestedPath,
    siblingAccessible: false, symbolicLink: false, uid: 10_001 };
}

function roundTrip() {
  return {
    hostNonce: nonce.host,
    hostObservedPlatformNonce: nonce.platform,
    hostObservedRunnerNonce: nonce.runner,
    platformNonce: nonce.platform,
    platformObservedHostNonce: nonce.host,
    platformObservedRunnerNonce: nonce.runner,
    runnerNonce: nonce.runner,
    runnerObservedHostNonce: nonce.host,
    runnerObservedPlatformNonce: nonce.platform,
  };
}

function receipt(overrides: { roots?: ReturnType<typeof roots>; roundTrip?: ReturnType<typeof roundTrip> } = {}) {
  return createHostedCampaignSharedMountReceiptV1({
    expectation,
    generatedAtEpochMs: 1_000,
    probeId: "probe-1",
    roots: overrides.roots ?? roots(),
    roundTrip: overrides.roundTrip ?? roundTrip(),
  });
}

function roots() {
  return {
    host: root(expectation.hostRoot),
    meetingPlatform: root(expectation.containerRoot),
    runner: root(expectation.containerRoot),
  };
}

describe("hosted campaign shared mount", () => {
  it("collects a fresh three-party bidirectional proof through an injected port", async () => {
    const calls: string[] = [];
    const probe = new HostedCampaignSharedMountProbe({
      expectation, generatedAtEpochMs: () => 1_000, hostNonce: nonce.host,
      platformNonce: nonce.platform, probeId: "probe-1", runnerNonce: nonce.runner,
    }, {
      exchangeNonces: async (input) => { calls.push(input.probeRoot); return roundTrip(); },
      inspectHostRoot: async (path) => { calls.push(`host:${path}`); return root(path); },
      inspectMeetingPlatformRoot: async (path) => { calls.push(`platform:${path}`); return root(path); },
      inspectRunnerRoot: async (path) => { calls.push(`runner:${path}`); return root(path); },
    });
    await expect(probe.collect()).resolves.toMatchObject({ campaignId: "campaign-1", probeId: "probe-1" });
    expect(calls).toEqual([
      "host:/srv/e2e/campaign-1", "platform:/run/e2e-campaign", "runner:/run/e2e-campaign",
      "/run/e2e-campaign/campaign-1/.mount-probes/probe-1",
    ]);
  });

  it.each([
    ["uid", (value: ReturnType<typeof roots>) => { value.runner.uid = 1_000; }],
    ["gid", (value: ReturnType<typeof roots>) => { value.meetingPlatform.gid = 1_000; }],
    ["mode", (value: ReturnType<typeof roots>) => { value.host.mode = 0o755; }],
    ["symlink", (value: ReturnType<typeof roots>) => { value.host.symbolicLink = true; }],
    ["sibling", (value: ReturnType<typeof roots>) => { value.runner.siblingAccessible = true; }],
  ])("rejects unsafe %s evidence", (_name, mutate) => {
    const value = roots();
    mutate(value);
    expect(() => receipt({ roots: value })).toThrow("ownership, mode, or sibling isolation");
  });

  it("rejects stale nonce observations and duplicate nonces", () => {
    const stale = roundTrip();
    stale.hostObservedRunnerNonce = "stale-runner-0001";
    expect(() => receipt({ roundTrip: stale })).toThrow("invalid or stale");
    expect(() => new HostedCampaignSharedMountProbe({
      expectation, generatedAtEpochMs: () => 1_000, hostNonce: nonce.host,
      platformNonce: nonce.host, probeId: "probe-1", runnerNonce: nonce.runner,
    }, {} as never)).toThrow("must be distinct");
  });

  it("rejects expired, future, and replayed receipts", () => {
    const value = receipt();
    expect(verifyHostedCampaignSharedMountReceiptV1(value, expectation, 11_000, "probe-1")).toEqual(value);
    expect(() => verifyHostedCampaignSharedMountReceiptV1(value, expectation, 11_001, "probe-1"))
      .toThrow("stale or from the future");
    expect(() => verifyHostedCampaignSharedMountReceiptV1(value, expectation, 999, "probe-1"))
      .toThrow("stale or from the future");
    expect(() => verifyHostedCampaignSharedMountReceiptV1(value, expectation, 1_001, "probe-replay"))
      .toThrow("replayed or bound");
  });
});

describe("test-only campaign compose override", () => {
  it("keeps the production compose free of a broad readiness mount", async () => {
    const base = await readFile(new URL("../../../infra/deployment/compose.yaml", import.meta.url), "utf8");
    expect(base).not.toContain("data/e2e-playback-readiness");
    expect(base).not.toContain("discord-e2e-campaign-runner:");
    expect(base).toContain(
      "DISCORD_BOTIK_APPLICATION_ID: ${DISCORD_PUBLICATION_APPLICATION_ID:?set the publication bot application ID}",
    );
  });

  it("pins one fixed private-guild Botik identity across overlay, target, and fixture", async () => {
    const overlay = await readFile(
      new URL("../../../infra/deployment/compose.e2e-campaign.yaml", import.meta.url), "utf8",
    );
    const fixture = JSON.parse(await readFile(
      new URL("./fixtures/manifest.v1.json", import.meta.url), "utf8",
    )) as { allowedBotSpeakerIds: string[]; conversationVoiceExpectation: { botSpeakerId: string } };

    expect(campaignBotikApplicationId).not.toBe("1534231284467896512");
    expect(HOSTED_CAMPAIGN_TARGET.botikApplicationId).toBe(campaignBotikApplicationId);
    expect(fixture.conversationVoiceExpectation.botSpeakerId).toBe(campaignBotikApplicationId);
    expect(fixture.allowedBotSpeakerIds).toContain(campaignBotikApplicationId);
    expect(overlay.match(/^\s+DISCORD_BOTIK_APPLICATION_ID: "\d+"$/gmu)).toEqual([
      `      DISCORD_BOTIK_APPLICATION_ID: "${campaignBotikApplicationId}"`,
    ]);
  });

  it("mounts only the exact campaign root into Meeting Platform and keeps the coordinator host-side", async () => {
    const overlay = await readFile(new URL("../../../infra/deployment/compose.e2e-campaign.yaml", import.meta.url), "utf8");
    expect(overlay).toContain("${E2E_CAMPAIGN_HOST_ROOT:?set fresh private per-campaign host root}:/run/e2e-campaign");
    expect(overlay).toContain("CONVERSATION_E2E_GREETING_PLAYBACK_READINESS_ROOT: /run/e2e-campaign/${E2E_CAMPAIGN_ID:?set fresh campaign ID}/run-3/greeting-handshakes");
    expect(overlay.match(/e2e\.test-only: "true"/gu)).toHaveLength(3);
    expect(overlay.match(/DISCORD_E2E_CAMPAIGN_SHARED_ROOT_ACKNOWLEDGED: "true"/gu)).toHaveLength(1);
    expect(overlay).not.toContain("discord-e2e-campaign-runner:");
    expect(overlay).not.toContain("/run/secrets:ro");
    expect(overlay).not.toContain("/var/run/docker.sock");
    expect(overlay).not.toContain("/mnt/volume_");
  });
});
