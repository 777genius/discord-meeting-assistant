import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FileCraigCampaignCredentialStore,
  craigProjectName,
  planCraigDisposableCampaignStack,
  provisionCraigDisposableCampaignStack,
  teardownSuccessfulCraigCampaignStack,
  verifyCraigCampaignStackReceiptV2,
  type CraigCampaignStackCommandRequest,
  type CraigCampaignStackCommandResult,
  type CraigCampaignStackInput,
  type CraigCampaignStackPorts,
} from "../src/craig-disposable-campaign-stack.js";
import { validateRenderedCraigCompose } from "../src/craig-campaign-compose-validation.js";
import { digestCanonical } from "../src/hosted-campaign-local-admission.js";
import type { HostedCampaignLeaseHandle } from "../src/hosted-campaign-coordinator.js";

const release = {
  releaseBindingSha256: "1".repeat(64), releaseId: "release-42", trustRootSha256: "2".repeat(64),
} as const;
const id = "3".repeat(64);
const image = `sha256:${"4".repeat(64)}`;
const repository = `registry.test/craig@sha256:${"5".repeat(64)}`;
const revision = "6".repeat(40);
const migrationChecksum = "8".repeat(64);
const protocolResponse = '{"kind":"craig-control-ready","version":"v1"}\n';

async function fixture(campaignId = "campaign-42"): Promise<CraigCampaignStackInput> {
  const campaignRoot = await mkdtemp(join(tmpdir(), "craig-campaign-root-"));
  await mkdir(join(campaignRoot, campaignId, "control"), { recursive: true, mode: 0o700 });
  await mkdir(join(campaignRoot, campaignId, "barriers"), { recursive: true, mode: 0o700 });
  const campaignPath = join(campaignRoot, campaignId);
  const leaseContents = `${JSON.stringify({ campaignId, campaignRoot: campaignPath, planSha256: "9".repeat(64) })}\n`;
  await writeFile(join(campaignPath, "barriers", "campaign.lease"), leaseContents, { mode: 0o600 });
  const composeFile = join(campaignRoot, "compose.yaml");
  const composeCanonical = "services: {}\n";
  await writeFile(composeFile, composeCanonical, { mode: 0o600 });
  return {
    campaignId, campaignRoot, composeCanonical,
    composeCanonicalSha256: createHash("sha256").update(composeCanonical).digest("hex"), composeFile,
    credentialFile: join(campaignRoot, campaignId, "control", "craig.env"),
    database: { imageIdentity: { imageId: image, repositoryDigest: `postgres@sha256:${"7".repeat(64)}` },
      migrations: [{ checksum: migrationChecksum, version: "001" }], migrationTable: "migrations", name: "craig",
      password: "fresh-campaign-password-0123456789", schema: "public", service: "database",
      user: "craig", volume: "postgres-data" },
    migrationImageIdentity: { imageId: image, repositoryDigest: repository },
    migrationService: "migrate", readinessTimeoutSeconds: 45, release,
    service: "bot", serviceIdentity: { applicationId: "1533877611258708230", imageId: image,
      protocol: { command: ["/app/bin/craig-control", "readiness", "--format=json"],
        expectedResponseSha256: createHash("sha256").update(protocolResponse).digest("hex"),
        kind: "craig-application", name: "craig-control-readiness", version: "v1" },
      repositoryDigest: repository, sourceRevision: revision },
  };
}

function rendered(input: CraigCampaignStackInput) {
  const project = craigProjectName(input.campaignId, release);
  const url = "postgresql://craig:fresh-campaign-password-0123456789@database:5432/craig";
  return {
    name: project,
    services: {
      bot: { command: null, entrypoint: null,
        environment: { DATABASE_URL: url, DISCORD_APPLICATION_ID: input.serviceIdentity.applicationId,
          E2E_CAMPAIGN_ID: input.campaignId, E2E_SOURCE_REVISION: revision }, image: repository,
        network_mode: "none" },
      database: { command: null, entrypoint: null,
        environment: { POSTGRES_DB: "craig", POSTGRES_PASSWORD: "fresh-campaign-password-0123456789",
        POSTGRES_USER: "craig" }, image: `postgres@sha256:${"7".repeat(64)}`,
        network_mode: "none",
        volumes: [{ source: "postgres-data", target: "/var/lib/postgresql/data", type: "volume", volume: {} }] },
      migrate: { command: null, depends_on: { database: { condition: "service_started", required: true,
        restart: true } }, entrypoint: null, environment: { DATABASE_URL: url }, image: repository,
        network_mode: "service:database" },
    },
    volumes: { "postgres-data": { name: `${project}_postgres-data` } },
  };
}

class Harness {
  readonly calls: CraigCampaignStackCommandRequest[] = [];
  migrationOutput = `001|${migrationChecksum}\n`;
  protocolOutput = protocolResponse;
  constructor(readonly input: CraigCampaignStackInput) {}
  readonly execute = vi.fn(async (request: CraigCampaignStackCommandRequest): Promise<CraigCampaignStackCommandResult> => {
    this.calls.push(request);
    const args = request.args;
    if (args.includes("config")) { return result(0, JSON.stringify(rendered(this.input))); }
    if (args[0] === "volume" && args[1] === "inspect") { return result(1, "", "No such volume"); }
    if ((args[0] === "volume" || args[0] === "network") && args[1] === "ls") { return result(); }
    if (args[0] === "image" && args[1] === "inspect") {
      const repositoryDigest = args[2]!;
      return result(0, JSON.stringify([{ Id: image, RepoDigests: [repositoryDigest] }]));
    }
    if (args.includes("psql")) {
      return result(0, args.at(-1)?.includes("ORDER BY version") === true
        ? this.migrationOutput : "craig|craig\n");
    }
    if (args.includes("/app/bin/craig-control")) { return result(0, this.protocolOutput); }
    if (args.includes("--quiet") && args.at(-1) === "bot") { return result(0, `${id}\n`); }
    if (args[0] === "inspect") {
      const configDigest = digestCanonical(rendered(this.input));
      return result(0, JSON.stringify([{ Id: id, Image: image, Config: { Image: repository,
        Env: [`E2E_CAMPAIGN_ID=${this.input.campaignId}`, `E2E_SOURCE_REVISION=${revision}`,
          `DISCORD_APPLICATION_ID=${this.input.serviceIdentity.applicationId}`],
        Labels: { "com.docker.compose.project": craigProjectName(this.input.campaignId, release),
          "com.docker.compose.service": "bot", "e2e.compose-config-sha256": configDigest } },
        State: { Health: { Status: "healthy" }, Running: true } }]));
    }
    return result();
  });
  ports(): CraigCampaignStackPorts {
    return { commands: { execute: this.execute }, credentials: new FileCraigCampaignCredentialStore(),
      mutationJournal: { markStarted: vi.fn(async () => {}) },
      now: () => Date.parse("2026-08-26T12:00:00.000Z") };
  }
}

describe("Craig disposable private-campaign stack", () => {
  it("creates a one-way plan and hardened credential under the canonical campaign root", async () => {
    const input = await fixture();
    const plan = planCraigDisposableCampaignStack(input);
    const harness = new Harness(input);
    const receipt = await provisionCraigDisposableCampaignStack(input, harness.ports(), await leaseFor(input), {
      DOCKER_HOST: "tcp://wrong.example:2375", PATH: "/hostile", POSTGRES_PASSWORD: "stale",
    });
    const credentials = await readFile(input.credentialFile, "utf8");
    const status = await stat(input.credentialFile);

    expect(receipt).toMatchObject({ campaignId: input.campaignId, containerId: id,
      planSha256: plan.planSha256, projectName: plan.projectName, schemaVersion: 2, serviceHealth: "healthy" });
    expect(status.mode & 0o777).toBe(0o600);
    expect(credentials).toContain("POSTGRES_PASSWORD=fresh-campaign-password-0123456789");
    expect(harness.calls.every(({ environment, executable }) => executable === "/usr/bin/docker"
      && environment.PATH === "/usr/bin:/bin" && environment.DOCKER_HOST === undefined)).toBe(true);
    expect(harness.calls.every(({ workingDirectory }) => workingDirectory === "/")).toBe(true);
    expect(harness.calls.filter(({ args }) => args.includes("up") || args.includes("run"))
      .every(({ args }) => args.includes("--no-deps"))).toBe(true);
    const { receiptSha256: _ignored, ...receiptContent } = receipt;
    expect(receipt.receiptSha256).toBe(digestCanonical(receiptContent));
  });

  it("rejects rendered bind mounts and conflicting Compose environment before up", async () => {
    const input = await fixture("campaign-unsafe");
    const harness = new Harness(input);
    harness.execute.mockImplementationOnce(async (request) => {
      harness.calls.push(request);
      const config = rendered(input);
      config.services.database.volumes = [{ source: "/stale", target: "/var/lib/postgresql/data",
        type: "bind", volume: {} }] as never;
      return result(0, JSON.stringify(config));
    });
    await expect(provisionCraigDisposableCampaignStack(input, harness.ports(), await leaseFor(input)))
      .rejects.toThrow();
    expect(harness.calls.some(({ args }) => args.includes("up"))).toBe(false);
  });

  it("retains failed resources and permits bounded teardown only from an intact success receipt", async () => {
    const input = await fixture("campaign-teardown");
    const harness = new Harness(input);
    const lease = await leaseFor(input);
    const receipt = await provisionCraigDisposableCampaignStack(input, harness.ports(), lease);
    const teardownCallStart = harness.calls.length;
    await teardownSuccessfulCraigCampaignStack(receipt, input, lease, harness.ports());
    const teardownCalls = harness.calls.slice(teardownCallStart);
    expect(teardownCalls.filter(({ args }) => args[0] === "image" && args[1] === "inspect")).toHaveLength(3);
    expect(teardownCalls.at(-2)?.args).toContain("config");
    expect(teardownCalls.at(-1)?.args).toContain("--volumes");
    await expect(teardownSuccessfulCraigCampaignStack(
      { ...receipt, receiptSha256: "0".repeat(64) }, input, lease, harness.ports()))
      .rejects.toThrow(/digest is invalid/u);
  });

  it("rejects a second credential reservation for a reused campaign", async () => {
    const input = await fixture("campaign-reuse");
    const harness = new Harness(input);
    const lease = await leaseFor(input);
    await provisionCraigDisposableCampaignStack(input, harness.ports(), lease);
    await expect(provisionCraigDisposableCampaignStack(input, harness.ports(), lease))
      .rejects.toMatchObject({ code: "EEXIST" });
  });

  it("feeds retained immutable bytes to mutation and teardown despite a Compose path swap", async () => {
    const input = await fixture("campaign-compose-swap");
    const harness = new Harness(input);
    const lease = await leaseFor(input);
    const receipt = await provisionCraigDisposableCampaignStack(input, harness.ports(), lease);
    await writeFile(input.composeFile, "services:\n  attacker: {}\n", { mode: 0o600 });
    await teardownSuccessfulCraigCampaignStack(receipt, input, lease, harness.ports());
    expect(harness.calls.filter(({ args }) => args[0] === "compose").every((request) =>
      request.args.includes("--file") && request.args.includes("-")
      && request.standardInput === input.composeCanonical
      && request.environment.POSTGRES_PASSWORD === "fresh-campaign-password-0123456789")).toBe(true);
    expect(harness.calls.some(({ args }) => args.includes("down"))).toBe(true);
  });

  it("rejects extra services and dependencies before any targeted up or run", async () => {
    const cases = [
      ["extra", (config: ReturnType<typeof rendered>) => { Object.assign(config.services,
        { attacker: { environment: {}, image: repository } }); }],
      (config: ReturnType<typeof rendered>) => { Object.assign(config.services.bot, { depends_on: ["database"] }); },
    ] as const;
    for (const [caseName, mutate] of [cases[0], ["dependency", cases[1]]] as const) {
      const input = await fixture(`campaign-closed-compose-${caseName}`);
      const harness = new Harness(input);
      harness.execute.mockImplementationOnce(async (request) => {
        harness.calls.push(request);
        const config = rendered(input);
        mutate(config);
        return result(0, JSON.stringify(config));
      });
      await expect(provisionCraigDisposableCampaignStack(input, harness.ports(), await leaseFor(input)))
        .rejects.toThrow();
      expect(harness.calls.some(({ args }) => args.includes("up") || args.includes("run"))).toBe(false);
    }
  });

  it("rejects every unbound dangerous or unknown Compose field under the exact closed schemas", async () => {
    const input = await fixture("campaign-dangerous-compose");
    const project = craigProjectName(input.campaignId, release);
    const databaseVolume = `${project}_${input.database.volume}`;
    const cases: readonly [string, (value: ReturnType<typeof rendered>) => void][] = [
      ["top-level unknown", (value) => { Object.assign(value, { unknown: true }); }],
      ["top-level configs", (value) => { Object.assign(value, { configs: { x: { external: true } } }); }],
      ["top-level secrets", (value) => { Object.assign(value, { secrets: { x: { file: "../secret" } } }); }],
      ["top-level networks", (value) => { Object.assign(value, { networks: { x: { external: true } } }); }],
      ["extra volume", (value) => { Object.assign(value.volumes, { attacker: { name: "external" } }); }],
      ["external volume", (value) => { Object.assign(value.volumes["postgres-data"], { external: true }); }],
      ["custom volume", (value) => { value.volumes["postgres-data"].name = "shared"; }],
      ["database unknown", (value) => { Object.assign(value.services.database, { unknown: true }); }],
      ["migration unknown", (value) => { Object.assign(value.services.migrate, { unknown: true }); }],
      ["bot unknown", (value) => { Object.assign(value.services.bot, { unknown: true }); }],
      ["command", (value) => { Object.assign(value.services.bot, { command: ["sh", "-c", "id"] }); }],
      ["entrypoint", (value) => { Object.assign(value.services.bot, { entrypoint: ["/bin/sh"] }); }],
      ["build", (value) => { Object.assign(value.services.bot, { build: { context: "../outside" } }); }],
      ["service configs", (value) => { Object.assign(value.services.bot, { configs: ["external"] }); }],
      ["service secrets", (value) => { Object.assign(value.services.bot, { secrets: ["external"] }); }],
      ["service networks", (value) => { Object.assign(value.services.bot, { networks: ["external"] }); }],
      ["volumes_from", (value) => { Object.assign(value.services.bot, { volumes_from: ["external"] }); }],
      ["ipc", (value) => { Object.assign(value.services.bot, { ipc: "host" }); }],
      ["pid", (value) => { Object.assign(value.services.bot, { pid: "host" }); }],
      ["host network_mode", (value) => { value.services.bot.network_mode = "host"; }],
      ["bridge network_mode", (value) => { value.services.bot.network_mode = "bridge"; }],
      ["runtime", (value) => { Object.assign(value.services.bot, { runtime: "runc" }); }],
      ["env_file", (value) => { Object.assign(value.services.bot, { env_file: "../host.env" }); }],
      ["device", (value) => { Object.assign(value.services.bot, { devices: ["/dev/null"] }); }],
      ["privileged", (value) => { Object.assign(value.services.bot, { privileged: true }); }],
      ["capability", (value) => { Object.assign(value.services.bot, { cap_add: ["SYS_ADMIN"] }); }],
      ["bot mount", (value) => { Object.assign(value.services.bot, { volumes: ["../outside:/data"] }); }],
      ["relative bind", (value) => { Object.assign(value.services.database, { volumes: [{
        source: "../outside", target: "/var/lib/postgresql/data", type: "bind", volume: {},
      }] }); }],
    ];
    expect(validateRenderedCraigCompose(JSON.stringify(rendered(input)), input, project, databaseVolume))
      .toBeDefined();
    for (const [name, mutate] of cases) {
      const value = rendered(input);
      mutate(value);
      expect(() => validateRenderedCraigCompose(JSON.stringify(value), input, project, databaseVolume), name)
        .toThrow();
    }
  });

  it("eliminates caller-selected resolution context and rejects a working-directory input", async () => {
    const input = await fixture("campaign-resolution-context");
    expect(() => planCraigDisposableCampaignStack({ ...input, workingDirectory: "/tmp/swapped" })).toThrow();
    expect(() => planCraigDisposableCampaignStack({ ...input, workingDirectory: "../relative" })).toThrow();
  });

  it("rejects a stack root that differs from the acquired plan lease, including concurrent roots", async () => {
    const first = await fixture("campaign-concurrent");
    const second = await fixture("campaign-concurrent");
    expect(craigProjectName(first.campaignId, release)).toBe(craigProjectName(second.campaignId, release));
    await expect(provisionCraigDisposableCampaignStack(second, new Harness(second).ports(), await leaseFor(first)))
      .rejects.toThrow(/root does not match/u);
  });

  it("rejects a partial migration ledger and an unhealthy Craig protocol endpoint", async () => {
    const partial = await fixture("campaign-partial-migration");
    const partialHarness = new Harness(partial);
    partialHarness.migrationOutput = "";
    await expect(provisionCraigDisposableCampaignStack(partial, partialHarness.ports(), await leaseFor(partial)))
      .rejects.toThrow(/complete migration/u);

    const unhealthy = await fixture("campaign-endpoint-unhealthy");
    const unhealthyHarness = new Harness(unhealthy);
    unhealthyHarness.protocolOutput = '{"kind":"database-ready"}\n';
    await expect(provisionCraigDisposableCampaignStack(unhealthy, unhealthyHarness.ports(), await leaseFor(unhealthy)))
      .rejects.toThrow(/protocol response identity/u);
  });

  it("rejects a replayed stack receipt even when its schema remains valid", async () => {
    const input = await fixture("campaign-replayed-receipt");
    const lease = await leaseFor(input);
    const receipt = await provisionCraigDisposableCampaignStack(input, new Harness(input).ports(), lease);
    const expectation = { campaignId: input.campaignId, campaignRoot: lease.campaignRoot,
      hostedPlanSha256: lease.planSha256, maximumAgeMs: 60_000,
      nowEpochMs: Date.parse("2026-08-26T12:00:30.000Z"), projectName: receipt.projectName, release };
    expect(verifyCraigCampaignStackReceiptV2(receipt, expectation)).toEqual(receipt);
    expect(() => verifyCraigCampaignStackReceiptV2(receipt, {
      ...expectation, nowEpochMs: Date.parse("2026-08-26T12:02:00.000Z"),
    })).toThrow(/stale, replayed/u);
  });
});

async function leaseFor(input: CraigCampaignStackInput): Promise<HostedCampaignLeaseHandle> {
  const campaignRoot = join(input.campaignRoot, input.campaignId);
  const path = join(campaignRoot, "barriers", "campaign.lease");
  const [contents, status] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  return { campaignId: input.campaignId, campaignRoot, device: status.dev, inode: status.ino,
    leaseSha256: createHash("sha256").update(contents).digest("hex"),
    planSha256: "9".repeat(64) } as HostedCampaignLeaseHandle;
}

function result(exitCode = 0, stdout = "", stderr = ""): CraigCampaignStackCommandResult {
  return { exitCode, stderr, stdout };
}
