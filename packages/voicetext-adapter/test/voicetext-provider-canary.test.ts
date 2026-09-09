import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildGatewayRunningIdentity,
  buildProviderCanaryReceipt,
  parseGatewayRunningIdentity,
  validateProviderCanaryReceipt,
  writeCreateOnlyReceipt,
  type GatewayIdentityExpectation,
  type GatewayRunningIdentityV1,
  type ProviderCanaryReceiptV1,
} from "./voicetext-provider-canary-evidence.js";
import { extractOggOpusSpeechPackets } from "./voicetext-provider-canary-ogg.js";

const fixtureUrl = new URL(
  "../../../apps/discord-e2e-actors/test/fixtures/speaker-a.ru-en.ogg",
  import.meta.url,
);
const fixtureSha256 = "8e29a933ef95eaf1f149b150ff123f90a3276847fcd4941ccb6c55b24561b9d8";
const packetBytesSha256 = "c08882f0e25e3b8c5e06137fa546ac3d3a9a0172a872a1eab6758eac20da23fa";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("real pinned speech fixture packet extraction", () => {
  it("extracts the exact audio packet sequence and timing without container headers", async () => {
    const fixture = await readFile(fixtureUrl);
    expect(sha256(fixture)).toBe(fixtureSha256);
    const extracted = extractOggOpusSpeechPackets(fixture);
    expect(extracted).toMatchObject({
      durationMs: 26_228,
      preSkipSamples48Khz: 312,
    });
    expect(extracted.packets).toHaveLength(1_312);
    expect(extracted.packets[0]).toMatchObject({
      durationSamples48Khz: 960,
      relativeTimeMs: 0,
    });
    expect(extracted.packets.at(-1)).toMatchObject({
      durationSamples48Khz: 960,
      relativeTimeMs: 26_220,
    });
    expect(Buffer.from(extracted.packets[0]?.opus ?? []).subarray(0, 8).toString("ascii"))
      .not.toBe("OpusHead");
    expect(sha256(Buffer.concat(extracted.packets.map(({ opus }) => Buffer.from(opus)))))
      .toBe(packetBytesSha256);
  });

  it.each(["capture", "truncation"] as const)("rejects deterministic %s corruption", async (kind) => {
    const fixture = new Uint8Array(await readFile(fixtureUrl));
    const corrupted = kind === "capture"
      ? Uint8Array.from(fixture, (value, index) => index === 0 ? value ^ 0xff : value)
      : fixture.slice(0, -1);
    expect(() => extractOggOpusSpeechPackets(corrupted)).toThrow(/Ogg Opus fixture/u);
  });
});

describe("running gateway identity fence", () => {
  it("accepts only the exact commit, tree, image digest, origins, run, and identity digest", () => {
    const identity = gatewayIdentity();
    expect(parseGatewayRunningIdentity(identity, identityExpectation(identity))).toEqual(identity);
  });

  it.each([
    ["commit", { sourceCommit: "0".repeat(40) }],
    ["tree", { sourceTree: "1".repeat(40) }],
    ["image digest", { imageDigest: `registry.example/voice@sha256:${"2".repeat(64)}` }],
    ["identity digest", { identitySha256: "3".repeat(64) }],
    ["run", { runId: "another-run" }],
    ["HTTP origin", { httpOrigin: "https://other.example" }],
    ["WebSocket origin", { wsOrigin: "wss://other.example" }],
  ] as const)("rejects a mismatched %s before qualification", (_label, difference) => {
    const identity = gatewayIdentity();
    expect(() => parseGatewayRunningIdentity(identity, {
      ...identityExpectation(identity),
      ...difference,
    })).toThrow("Running gateway identity does not match");
  });

  it("rejects a self-digest that does not cover the running identity", () => {
    const identity = gatewayIdentity();
    expect(() => parseGatewayRunningIdentity(
      { ...identity, containerId: "4".repeat(64) },
      identityExpectation(identity),
    )).toThrow("identity digest is invalid");
  });
});

describe("identity-bound provider canary receipt", () => {
  it("validates its exact evidence binding and rejects changed content", () => {
    const receipt = providerReceipt();
    expect(validateProviderCanaryReceipt(receipt, receiptExpectation(receipt))).toEqual(receipt);
    expect(() => validateProviderCanaryReceipt(
      { ...receipt, runId: "substituted-run" },
      receiptExpectation(receipt),
    )).toThrow("receipt digest is invalid");
  });

  it("rejects a correctly digested receipt bound to another gateway identity", () => {
    const receipt = providerReceipt();
    const otherIdentity = gatewayIdentity({ containerId: "5".repeat(64) });
    const changed = buildProviderCanaryReceipt({
      ...withoutReceiptDigest(receipt),
      gatewayIdentity: otherIdentity,
      gatewayIdentitySha256: otherIdentity.identitySha256,
    });
    expect(() => validateProviderCanaryReceipt(changed, receiptExpectation(receipt)))
      .toThrow("does not match its exact evidence binding");
  });

  it("writes one mode-0600 receipt and never overwrites an existing path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voicetext-provider-receipt-"));
    directories.push(directory);
    const path = join(directory, "receipt.json");
    const receipt = providerReceipt();
    await writeCreateOnlyReceipt(path, receipt);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt);
    await expect(writeCreateOnlyReceipt(path, receipt)).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt);
  });
});

function gatewayIdentity(
  override: Partial<Omit<GatewayRunningIdentityV1, "identitySha256">> = {},
): GatewayRunningIdentityV1 {
  return buildGatewayRunningIdentity({
    containerId: "a".repeat(64),
    httpOrigin: "https://voice.example",
    imageDigest: `registry.example/voice@sha256:${"b".repeat(64)}`,
    imageId: `sha256:${"c".repeat(64)}`,
    kind: "voicetext-gateway-running-identity",
    observedAt: "2026-09-02T12:00:00.000Z",
    runId: "canary-run-1",
    schemaVersion: 1,
    sourceCommit: "d".repeat(40),
    sourceRepository: "https://github.com/777genius/voicetext-gateway",
    sourceTree: "e".repeat(40),
    wsOrigin: "wss://voice.example",
    ...override,
  });
}

function identityExpectation(identity: GatewayRunningIdentityV1): GatewayIdentityExpectation {
  return {
    httpOrigin: identity.httpOrigin,
    identitySha256: identity.identitySha256,
    imageDigest: identity.imageDigest,
    runId: identity.runId,
    sourceCommit: identity.sourceCommit,
    sourceTree: identity.sourceTree,
    wsOrigin: identity.wsOrigin,
  };
}

function providerReceipt(): ProviderCanaryReceiptV1 {
  const identity = gatewayIdentity();
  return buildProviderCanaryReceipt({
    batch: {
      firstStartMs: 0,
      jobId: "batch-job-1",
      lastEndMs: 26_200,
      segmentCount: 2,
      textSha256: "1".repeat(64),
    },
    createdAt: "2026-09-02T12:01:00.000Z",
    expectedTermsSha256: "2".repeat(64),
    fixture: { durationMs: 26_228, packetCount: 1_312, sha256: fixtureSha256 },
    gatewayIdentity: identity,
    gatewayIdentitySha256: identity.identitySha256,
    kind: "voicetext-gateway-provider-canary-receipt",
    live: {
      acknowledgedPacketCount: 1_312,
      finalizeComplete: true,
      firstStartMs: 0,
      lastEndMs: 26_220,
      segmentCount: 3,
      textSha256: "3".repeat(64),
    },
    profile: {
      batch: "deepgram-nova-3",
      live: "deepgram-nova-3",
      provider: "deepgram",
    },
    runId: identity.runId,
    schemaVersion: 1,
  });
}

function receiptExpectation(receipt: ProviderCanaryReceiptV1) {
  return {
    expectedTermsSha256: receipt.expectedTermsSha256,
    fixtureSha256: receipt.fixture.sha256,
    gatewayIdentitySha256: receipt.gatewayIdentitySha256,
    profile: receipt.profile.provider,
    runId: receipt.runId,
  };
}

function withoutReceiptDigest(
  receipt: ProviderCanaryReceiptV1,
): Omit<ProviderCanaryReceiptV1, "receiptSha256"> {
  const { receiptSha256: _receiptSha256, ...content } = receipt;
  return content;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
