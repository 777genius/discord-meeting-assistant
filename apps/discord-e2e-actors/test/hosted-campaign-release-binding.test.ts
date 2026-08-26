import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  assertCraigStackInputMatchesCompiledTrustRoot,
  createHostedCampaignReleaseConfig,
  digestHostedCampaignReleaseTrustRootV1,
  hostedCampaignReleaseBindingV1Schema,
  hostedCampaignReleaseTrustRootV1Schema,
  resolveCompiledHostedCampaignReleaseTrustRoot,
} from "../src/hosted-campaign-release-binding.js";
import type { CraigCampaignStackInput } from "../src/craig-disposable-campaign-stack.js";
import { HOSTED_VOICETEXT_CANARY_BINDING_V1 } from "../src/hosted-voicetext-canary-binding.js";

const services = [
  ["craig", "craig-meeting-e2e", "bot", "a"],
  ["meetingPlatform", "discord-meeting-assistant", "meeting-platform", "b"],
  ["pipecat", "discord-meeting-assistant", "pipecat-runtime", "c"],
  ["subscriptionRuntime", "discord-meeting-assistant", "subscription-runtime-sidecar", "d"],
] as const;
const pinnedCanary = HOSTED_VOICETEXT_CANARY_BINDING_V1;
const endpoint = pinnedCanary.endpoint;
const stackCompose = "services:\n  database: {}\n  migrate: {}\n  bot: {}\n";
const stackMigrations = [{ checksum: "e".repeat(64), version: "001" }];
const trust = hostedCampaignReleaseTrustRootV1Schema.parse({
  allowedNetworks: ["discord-meeting-e2e"],
  campaignRoot: "/srv/e2e/campaigns", campaignRootOwnerGid: 10_001, campaignRootOwnerUid: 10_001,
  canary: { endpoint, expectedSegments: pinnedCanary.transcriptExpectation.segments,
    fixturePath: pinnedCanary.fixture.audioPath, fixtureSha256: pinnedCanary.fixture.audioSha256,
    ...pinnedCanary.fixtureExpectation, profiles: pinnedCanary.profiles,
    requiredTerms: pinnedCanary.requiredTerms,
    transcriptExpectationSha256: pinnedCanary.transcriptExpectation.sha256 },
  clockMaximumSkewMs: 250, deployRoot: "/srv/e2e", discordReceiptTtlMs: 30_000,
  craigNetworkPolicy: { bridgeInterface: "br-craige2e", chain: "CRAIG_E2E",
    networkName: "discord-meeting-e2e", tcpDestinationPort: 443,
    udpDestinationPorts: { end: 65_535, start: 1_024 } },
  craigStack: {
    applicationId: "1533877611258708230", composeCanonical: stackCompose,
    composeCanonicalSha256: createHash("sha256").update(stackCompose).digest("hex"),
    databaseImageIdentity: { imageId: `sha256:${"f".repeat(64)}`,
      repositoryDigest: `registry.test/postgres@sha256:${"f".repeat(64)}` }, databaseService: "database",
    migrationImageIdentity: { imageId: `sha256:${"e".repeat(64)}`,
      repositoryDigest: `registry.test/migrate@sha256:${"e".repeat(64)}` },
    migrations: stackMigrations, migrationService: "migrate",
    migrationSetSha256: createHash("sha256").update(JSON.stringify(stackMigrations)).digest("hex"),
    protocol: { command: ["/app/bin/craig-control", "readiness", "--format=json"],
      expectedResponseSha256: "9".repeat(64), kind: "craig-application",
      name: "craig-control-readiness", version: "v1" }, service: "bot",
    serviceImageIdentity: { imageId: `sha256:${"a".repeat(64)}`,
      repositoryDigest: `registry.test/craig@sha256:${"a".repeat(64)}` }, sourceRevision: "a".repeat(40),
  },
  environmentFile: "/srv/e2e/source.env", host: "codex-workers-eu-01",
  remoteComposeFile: "/srv/e2e/source/compose.yaml", schemaVersion: 4,
  secretDirectory: "/run/secrets/discord-e2e",
  services: services.map(([component, composeProject, composeService, digit]) => ({
    component, composeProject, composeService, imageId: `sha256:${digit.repeat(64)}`,
    repositoryDigest: `registry.test/${component}@sha256:${digit.repeat(64)}`, sourceRevision: digit.repeat(40),
  })),
  sourceRoot: "/srv/e2e/source", voicetextReceiptTtlMs: 30_000, voicetextTimeoutMs: 60_000,
});
const priorSerializedV2TrustRoot = JSON.stringify({
  ...trust,
  craigNetworkPolicy: undefined,
  schemaVersion: 2,
});
const release = {
  canary: { endpoint, fixturePath: pinnedCanary.fixture.audioPath,
    fixtureSha256: pinnedCanary.fixture.audioSha256, profiles: pinnedCanary.profiles,
    requiredTerms: pinnedCanary.requiredTerms },
  releaseId: "release-1", schemaVersion: 1,
  services: trust.services.map((entry, index) => ({ ...entry, containerId: String(index + 1).repeat(64) })),
  trustRootSha256: digestHostedCampaignReleaseTrustRootV1(trust),
} as const;
const campaign = {
  bindings: {}, campaignId: "campaign-1",
  definition: { campaignRoot: "/srv/e2e/campaigns", remote: { composeFile: trust.remoteComposeFile,
    environmentFile: trust.environmentFile, sourceRoot: trust.sourceRoot },
  revisions: { craig: "a".repeat(40), meetingPlatform: "b".repeat(40), pipecat: "c".repeat(40), subscriptionRuntime: "d".repeat(40) },
  runIds: ["campaign-1-sequential", "campaign-1-overlap", "campaign-1-reconnect"],
  secretDirectory: trust.secretDirectory },
  meetingPlatformRevision: "b".repeat(40), plan: {}, planSha256: "9".repeat(64),
} as const;
const executeFile = promisify(execFile);

describe("hosted campaign release binding", () => {
  it("rejects an operator-selected stack mismatch at pre-mutation admission", () => {
    const stack = trust.craigStack;
    const input = {
      campaignId: "campaign-1", campaignRoot: trust.campaignRoot,
      composeCanonical: stack.composeCanonical, composeCanonicalSha256: stack.composeCanonicalSha256,
      composeFile: "/srv/e2e/source/craig-compose.yaml",
      credentialFile: "/srv/e2e/campaigns/campaign-1/control/craig.env",
      database: { imageIdentity: stack.databaseImageIdentity, migrations: stack.migrations,
        migrationTable: "migrations", name: "craig", password: "password-012345678901234567890123",
        schema: "public", service: stack.databaseService, user: "craig", volume: "postgres-data" },
      migrationImageIdentity: stack.migrationImageIdentity, migrationService: stack.migrationService,
      readinessTimeoutSeconds: 45, release: { releaseBindingSha256: "1".repeat(64),
        releaseId: "release-1", trustRootSha256: digestHostedCampaignReleaseTrustRootV1(trust) },
      service: stack.service, serviceIdentity: { applicationId: stack.applicationId,
        imageId: stack.serviceImageIdentity.imageId, protocol: stack.protocol,
        repositoryDigest: stack.serviceImageIdentity.repositoryDigest, sourceRevision: stack.sourceRevision },
    } as CraigCampaignStackInput;
    const dockerCalls: string[] = [];
    expect(() => { assertCraigStackInputMatchesCompiledTrustRoot({ ...input,
      migrationImageIdentity: { ...input.migrationImageIdentity,
        repositoryDigest: `registry.test/other@sha256:${"0".repeat(64)}` },
    }, input.release, trust); }).toThrow("does not match the compiled release trust root");
    expect(() => { assertCraigStackInputMatchesCompiledTrustRoot({ ...input,
      serviceIdentity: { ...input.serviceIdentity, protocol: {
        command: ["redis-cli", "ping"], expectedResponseSha256: "9".repeat(64),
        kind: "test-port-substitute", name: "substitute", version: "v1",
      } },
    }, input.release, trust); }).toThrow("does not match the compiled release trust root");
    expect(() => {
      assertCraigStackInputMatchesCompiledTrustRoot({ ...input, release: {
        ...input.release, releaseId: "operator-selected-release",
      } }, input.release, trust);
      dockerCalls.push("executor-created");
    }).toThrow("does not match the compiled release trust root");
    expect(dockerCalls).toEqual([]);
  });

  it("rejects the serialized v2 trust root from before Craig policy binding", () => {
    const priorTrustRoot: unknown = JSON.parse(priorSerializedV2TrustRoot);
    expect(priorTrustRoot).not.toHaveProperty("craigNetworkPolicy");
    expect(() => hostedCampaignReleaseTrustRootV1Schema.parse(priorTrustRoot)).toThrow();
    expect(() => resolveCompiledHostedCampaignReleaseTrustRoot({
      generatorVersion: 3,
      schemaVersion: 3,
      status: "admitted",
      trustRoot: priorTrustRoot,
      trustRootSha256: "0".repeat(64),
    })).toThrow();
    expect(() => resolveCompiledHostedCampaignReleaseTrustRoot({
      generatorVersion: 1,
      schemaVersion: 1,
      status: "unadmitted",
    })).toThrow("metadata is malformed");
  });

  it("requires one exact service identity for every release component", () => {
    expect(() => hostedCampaignReleaseBindingV1Schema.parse({ ...release,
      services: [release.services[0], release.services[0], release.services[2], release.services[3]] }))
      .toThrow("each service exactly once");
  });

  it("does not let operator release data self-authorize a different digest", () => {
    const changed = { ...release, services: release.services.map((entry, index) => index === 1
      ? { ...entry, repositoryDigest: `registry.test/meetingPlatform@sha256:${"e".repeat(64)}` }
      : entry) };
    expect(() => createHostedCampaignReleaseConfig(changed, trust, campaign)).toThrow("not allowed");
  });

  it("rejects operator-authored expected text instead of deriving its digest", () => {
    const changed = { ...release, canary: { ...release.canary,
      expectedSegments: [{ endMs: 1_000, startMs: 0, text: "operator substituted transcript" }] } };
    expect(() => createHostedCampaignReleaseConfig(changed, trust, campaign)).toThrow();
  });

  it("rejects a trust root whose transcript differs from the committed canary", () => {
    expect(() => hostedCampaignReleaseTrustRootV1Schema.parse({ ...trust, canary: { ...trust.canary,
      expectedSegments: [{ ...trust.canary.expectedSegments[0], text: "altered trusted transcript" }] } }))
      .toThrow("must match the committed Voicetext canary binding");
  });

  it("assembles host-side wiring after the exact release matches the trust root", () => {
    expect(createHostedCampaignReleaseConfig(release, trust, campaign)).toMatchObject({
      campaignId: campaign.campaignId,
      deployment: { producer: { expectation: {
        campaignRoot: "/srv/e2e/campaigns",
        craigNetworkPolicy: trust.craigNetworkPolicy,
        greeting: {
          campaignSiblingPath: "/srv/e2e/campaigns-sibling",
          destinationPath: "/run/e2e-campaign",
          environmentRoot: "/run/e2e-campaign/campaign-1/run-3/greeting-handshakes",
          observerRoot: "/srv/e2e/campaigns/campaign-1/run-3/greeting-handshakes",
          runRoot: "/srv/e2e/campaigns/campaign-1/run-3",
          runSiblingPath: "/srv/e2e/campaigns/campaign-1/run-2",
          sourcePath: "/srv/e2e/campaigns",
        },
        services: release.services,
      } } },
      meetingPlatformRevision: campaign.meetingPlatformRevision,
      planSha256: campaign.planSha256,
      voicetext: { input: { binding: { transcriptExpectationSha256: pinnedCanary.transcriptExpectation.sha256 },
        expectedSegments: pinnedCanary.transcriptExpectation.segments,
        profiles: pinnedCanary.profiles } },
    });
  });

  it("admits an allowlisted ElevenLabs pair only when release and trust root match", () => {
    const profiles = { batch: "elevenlabs-scribe-v2", live: "elevenlabs-scribe-v2-realtime" } as const;
    const elevenTrust = hostedCampaignReleaseTrustRootV1Schema.parse({
      ...trust, canary: { ...trust.canary, profiles },
    });
    const elevenRelease = {
      ...release,
      canary: { ...release.canary, profiles },
      trustRootSha256: digestHostedCampaignReleaseTrustRootV1(elevenTrust),
    };

    expect(createHostedCampaignReleaseConfig(elevenRelease, elevenTrust, campaign).voicetext.input.profiles)
      .toEqual(profiles);
    expect(() => createHostedCampaignReleaseConfig({
      ...elevenRelease, canary: { ...elevenRelease.canary, profiles: pinnedCanary.profiles },
    }, elevenTrust, campaign)).toThrow("Release canary is not allowed");
  });

  it("binds operator declaration to the exact compiled trust root digest", () => {
    expect(() => createHostedCampaignReleaseConfig({ ...release, trustRootSha256: "0".repeat(64) }, trust, campaign))
      .toThrow("does not select the compiled trust root");
  });

  it("rejects an operator-selected campaign wrapper outside the compiled trust root", () => {
    const changed = { ...campaign, definition: { ...campaign.definition, campaignRoot: "/srv/e2e/other-campaigns" } };
    expect(() => createHostedCampaignReleaseConfig(release, trust, changed))
      .toThrow("does not match the compiled release paths");
  });

  it("keeps the checked-in build unadmitted and rejects tampered generated trust", () => {
    expect(resolveCompiledHostedCampaignReleaseTrustRoot({
      generatorVersion: 3,
      schemaVersion: 3,
      status: "unadmitted",
    })).toBeUndefined();
    expect(() => resolveCompiledHostedCampaignReleaseTrustRoot({
      generatorVersion: 3,
      schemaVersion: 3,
      status: "admitted",
      trustRoot: trust,
      trustRootSha256: "0".repeat(64),
    })).toThrow("digest is invalid");
    expect(resolveCompiledHostedCampaignReleaseTrustRoot({
      generatorVersion: 3,
      schemaVersion: 3,
      status: "admitted",
      trustRoot: trust,
      trustRootSha256: digestHostedCampaignReleaseTrustRootV1(trust),
    })).toEqual(trust);
  });

  it("reproducibly generates admitted source only for the reviewed input digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "compiled-hosted-release-"));
    const trustRootPath = join(root, "trust-root.json");
    const firstOutput = join(root, "first.ts");
    const secondOutput = join(root, "second.ts");
    const sourceTrust = { z: 1, a: { y: 2, x: 3 } };
    const expectedDigest = createHash("sha256").update(
      JSON.stringify({ a: { x: 3, y: 2 }, z: 1 }),
    ).digest("hex");
    await writeFile(trustRootPath, JSON.stringify(sourceTrust), { mode: 0o600 });
    const generator = fileURLToPath(new URL(
      "../scripts/generate-hosted-campaign-compiled-release.ts",
      import.meta.url,
    ));

    for (const output of [firstOutput, secondOutput]) {
      await executeFile(process.execPath, [
        generator,
        "--trust-root", trustRootPath,
        "--expected-sha256", expectedDigest,
        "--output", output,
      ]);
    }
    expect(await readFile(firstOutput, "utf8")).toBe(await readFile(secondOutput, "utf8"));
    expect(await readFile(firstOutput, "utf8")).toContain('"generatorVersion": 3');
    expect(await readFile(firstOutput, "utf8")).toContain('"schemaVersion": 3');
    expect(await readFile(firstOutput, "utf8")).toContain(`"trustRootSha256": "${expectedDigest}"`);
    await expect(executeFile(process.execPath, [
      generator,
      "--trust-root", trustRootPath,
      "--expected-sha256", "0".repeat(64),
      "--output", join(root, "rejected.ts"),
    ])).rejects.toThrow("Reviewed trust-root digest");
  }, 15_000);
});
