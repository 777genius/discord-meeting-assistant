import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FileCraigCampaignCredentialStore,
  craigProjectName,
  deriveCraigCampaignNetworkPolicy,
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
import { assertCraigFailedStackRetentionAdmission, MAX_UNRECOVERED_CRAIG_STACKS,
  recoverCraigFailedCampaignStack, reverifyExistingCraigFailedStackRecovery } from
  "../src/recover-craig-failed-campaign-stack.js";
import { verifyCraigFailedStackRecoveryReceipt } from "../src/craig-campaign-stack-evidence.js";
import { removeCraigCampaignFirewall } from "../src/craig-campaign-network-lifecycle.js";

const release = {
  releaseBindingSha256: "1".repeat(64), releaseId: "release-42", trustRootSha256: "2".repeat(64),
} as const;
const id = "3".repeat(64);
const databaseId = "2".repeat(64);
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
  const networkPolicy = deriveCraigCampaignNetworkPolicy(campaignId, release, { end: 65_535, start: 1_024 });
  const databaseUrl = "postgresql://craig:fresh-campaign-password-0123456789@database:5432/craig";
  const composeCanonical = `services:
  database:
    image: postgres@sha256:${"7".repeat(64)}
    hostname: database
    environment:
      POSTGRES_DB: craig
      POSTGRES_PASSWORD: fresh-campaign-password-0123456789
      POSTGRES_USER: craig
    networks:
      ${networkPolicy.name}:
        ipv4_address: ${networkPolicy.databaseIpv4}
    volumes:
      - postgres-data:/var/lib/postgresql/data
  migrate:
    image: ${repository}
    depends_on:
      database:
        condition: service_started
        required: true
        restart: true
    environment:
      DATABASE_URL: ${databaseUrl}
    network_mode: service:database
  bot:
    image: ${repository}
    environment:
      DATABASE_URL: ${databaseUrl}
      DISCORD_APPLICATION_ID: '1533877611258708230'
      E2E_CAMPAIGN_ID: ${campaignId}
      E2E_SOURCE_REVISION: '${revision}'
    networks:
      ${networkPolicy.name}:
        ipv4_address: ${networkPolicy.botIpv4}
volumes:
  postgres-data:
networks:
  ${networkPolicy.name}:
    name: ${networkPolicy.name}
    driver: bridge
    driver_opts:
      com.docker.network.bridge.name: ${networkPolicy.bridgeInterface}
    ipam:
      config:
        - subnet: ${networkPolicy.subnet}
`;
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
    migrationService: "migrate", networkPolicy, readinessTimeoutSeconds: 45, release,
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
    networks: { [input.networkPolicy.name]: { driver: "bridge",
      driver_opts: { "com.docker.network.bridge.name": input.networkPolicy.bridgeInterface },
      ipam: { config: [{ subnet: input.networkPolicy.subnet }] }, name: input.networkPolicy.name } },
    name: project,
    services: {
      bot: { command: null, entrypoint: null,
        environment: { DATABASE_URL: url, DISCORD_APPLICATION_ID: input.serviceIdentity.applicationId,
          E2E_CAMPAIGN_ID: input.campaignId, E2E_SOURCE_REVISION: revision }, image: repository,
        networks: { [input.networkPolicy.name]: { ipv4_address: input.networkPolicy.botIpv4 } } },
      database: { command: null, entrypoint: null,
        environment: { POSTGRES_DB: "craig", POSTGRES_PASSWORD: "fresh-campaign-password-0123456789",
        POSTGRES_USER: "craig" }, image: `postgres@sha256:${"7".repeat(64)}`,
        networks: { [input.networkPolicy.name]: { ipv4_address: input.networkPolicy.databaseIpv4 } },
        volumes: [{ source: "postgres-data", target: "/var/lib/postgresql/data", type: "volume", volume: {} }] },
      migrate: { command: null, depends_on: { database: { condition: "service_started", required: true,
        restart: true } }, entrypoint: null, environment: { DATABASE_URL: url }, image: repository,
        network_mode: "service:database" },
    },
    volumes: { "postgres-data": { name: `${project}_postgres-data` } },
  };
}

function serviceConfigHashes(input: CraigCampaignStackInput): Readonly<Record<string, string>> {
  return { [input.service]: "a".repeat(64), [input.database.service]: "b".repeat(64),
    [input.migrationService]: "c".repeat(64) };
}

class Harness {
  readonly calls: CraigCampaignStackCommandRequest[] = [];
  migrationOutput = `001|${migrationChecksum}\n`;
  protocolOutput = protocolResponse;
  databaseUp = false;
  botStopped = false;
  resourcesDown = false;
  firewallRemoved = false;
  constructor(readonly input: CraigCampaignStackInput) {}
  readonly execute = vi.fn(async (request: CraigCampaignStackCommandRequest): Promise<CraigCampaignStackCommandResult> => {
    this.calls.push(request);
    const args = request.args;
    const firewallResult = this.#handleFirewall(request);
    if (firewallResult !== undefined) { return firewallResult; }
    const custodyResult = this.#handleCustody(args);
    if (custodyResult !== undefined) { return custodyResult; }
    const lifecycleResult = this.#handleLifecycle(args);
    if (lifecycleResult !== undefined) { return lifecycleResult; }
    if (args.includes("config") && args.includes("--hash")) {
      return result(0, Object.entries(serviceConfigHashes(this.input))
        .map(([service, hash]) => `${service} ${hash}`).join("\n") + "\n");
    }
    if (args.includes("config")) { return result(0, JSON.stringify(rendered(this.input))); }
    if (args.includes("psql")) {
      return result(0, args.at(-1)?.includes("ORDER BY version") === true
        ? this.migrationOutput : "craig|craig\n");
    }
    if (args.includes("/app/bin/craig-control")) { return result(0, this.protocolOutput); }
    if (args.includes("--quiet") && args.at(-1) === "database") { return result(0, `${databaseId}\n`); }
    if (args.includes("--quiet") && args.at(-1) === "bot") {
      return result(0, this.botStopped ? "" : `${id}\n`);
    }
    if ((args[0] === "inspect") || (args[0] === "container" && args[1] === "inspect")) {
      const inspectedId = args[0] === "inspect" ? args[1] : args[2];
      if (this.resourcesDown) { return result(1, "", "No such container"); }
      const project = craigProjectName(this.input.campaignId, release);
      if (inspectedId === databaseId) { return result(0, JSON.stringify([{ Id: databaseId, Image: image,
        Name: `/${project}-${this.input.database.service}-1`,
        Config: { Env: ["POSTGRES_DB=craig", "POSTGRES_PASSWORD=fresh-campaign-password-0123456789",
          "POSTGRES_USER=craig"], Image: this.input.database.imageIdentity.repositoryDigest, Labels: {
          "com.docker.compose.container-number": "1", "com.docker.compose.image": image,
          "com.docker.compose.config-hash": serviceConfigHashes(this.input)[this.input.database.service],
          "com.docker.compose.oneoff": "False", "com.docker.compose.project": project,
          "com.docker.compose.project.config_files": "-", "com.docker.compose.project.working_dir": "/",
          "com.docker.compose.service": this.input.database.service,
        } },
        Mounts: [{ Destination: "/var/lib/postgresql/data", Driver: "local",
          Name: `${project}_${this.input.database.volume}`, Type: "volume" }],
        NetworkSettings: { Networks: { [this.input.networkPolicy.name]: {
          IPAddress: this.input.networkPolicy.databaseIpv4, NetworkID: "a".repeat(64),
        } } } }])); }
      const configDigest = digestCanonical(rendered(this.input));
      return result(0, JSON.stringify([{ Id: id, Image: image, Config: { Image: repository,
        Env: [`E2E_CAMPAIGN_ID=${this.input.campaignId}`, `E2E_SOURCE_REVISION=${revision}`,
          `DISCORD_APPLICATION_ID=${this.input.serviceIdentity.applicationId}`,
          "DATABASE_URL=postgresql://craig:fresh-campaign-password-0123456789@database:5432/craig"],
        Labels: { "com.docker.compose.container-number": "1", "com.docker.compose.image": image,
          "com.docker.compose.config-hash": serviceConfigHashes(this.input)[this.input.service],
          "com.docker.compose.oneoff": "False", "com.docker.compose.project": project,
          "com.docker.compose.project.config_files": "-", "com.docker.compose.project.working_dir": "/",
          "com.docker.compose.service": "bot", "e2e.compose-config-sha256": configDigest } },
        Mounts: [], Name: `/${project}-${this.input.service}-1`,
        NetworkSettings: { Networks: { [this.input.networkPolicy.name]: {
          IPAddress: this.input.networkPolicy.botIpv4, NetworkID: "a".repeat(64),
        } } }, State: { Health: { Status: "healthy" }, Running: true } }]));
    }
    return result();
  });
  #handleCustody(args: readonly string[]): CraigCampaignStackCommandResult | undefined {
    const project = craigProjectName(this.input.campaignId, release);
    if (args[0] === "volume" && args[1] === "inspect") {
      if (!this.databaseUp || this.resourcesDown) { return result(1, "", "No such volume"); }
      return result(0, JSON.stringify([{ Driver: "local", Labels: {
        "com.docker.compose.project": project, "com.docker.compose.volume": this.input.database.volume,
      }, Name: `${project}_${this.input.database.volume}` }]));
    }
    if ((args[0] === "volume" || args[0] === "network") && args[1] === "ls") {
      if (!this.databaseUp || this.resourcesDown) { return result(); }
      return result(0, args[0] === "volume" ? `${project}_${this.input.database.volume}\n` : `${"a".repeat(64)}\n`);
    }
    if (args[0] === "container" && args[1] === "ls") {
      return !this.databaseUp || this.resourcesDown ? result() : result(0, `${databaseId}\n${id}\n`);
    }
    if (args[0] === "network" && args[1] === "inspect") {
      if (!this.databaseUp || this.resourcesDown) { return result(1, "", "No such network"); }
      return result(0, JSON.stringify([{ Driver: "bridge", Id: "a".repeat(64), Internal: false,
        IPAM: { Config: [{ Subnet: this.input.networkPolicy.subnet }] },
        Labels: { "com.docker.compose.network": this.input.networkPolicy.name,
          "com.docker.compose.project": project }, Name: this.input.networkPolicy.name,
        Options: { "com.docker.network.bridge.name": this.input.networkPolicy.bridgeInterface } }]));
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const repositoryDigest = args[2]!;
      return result(0, JSON.stringify([{ Config: { Volumes: repositoryDigest.startsWith("postgres@")
        ? { "/var/lib/postgresql/data": {} } : {} }, Id: image, RepoDigests: [repositoryDigest] }]));
    }
    return undefined;
  }
  #handleLifecycle(args: readonly string[]): CraigCampaignStackCommandResult | undefined {
    if (args.includes("up") && args.at(-1) === "database") { this.databaseUp = true; return result(); }
    if (args.includes("stop") && args.at(-1) === "bot") { this.botStopped = true; return result(); }
    if (args.includes("down")) { this.resourcesDown = true; return result(); }
    if (args.includes("ps") && args.includes("--all") && args.includes("--quiet")) {
      return result(0, this.databaseUp && !this.resourcesDown ? `${databaseId}\n${id}\n` : "");
    }
    return undefined;
  }
  #handleFirewall(request: CraigCampaignStackCommandRequest): CraigCampaignStackCommandResult | undefined {
    if (request.executable === "/usr/sbin/iptables-save") {
      return result(0, this.firewallRemoved ? "*filter\n:FORWARD DROP [0:0]\nCOMMIT\n" : firewall(this.input));
    }
    if (request.executable !== "/usr/sbin/iptables") { return undefined; }
    if (request.args[0] === "-X") { this.firewallRemoved = true; }
    return result();
  }
  ports(): CraigCampaignStackPorts {
    return { commands: { execute: this.execute }, credentials: new FileCraigCampaignCredentialStore(),
      mutationJournal: { markStarted: vi.fn(async () => {}) },
      now: () => Date.parse("2026-08-26T12:00:00.000Z") };
  }
}

function firewall(input: CraigCampaignStackInput): string {
  const policy = input.networkPolicy;
  return `*filter
:FORWARD DROP [0:0]
:INPUT ACCEPT [0:0]
:${policy.chain} - [0:0]
:${policy.inputChain} - [0:0]
-A INPUT -i ${policy.bridgeInterface} -s ${policy.botIpv4}/32 -j ${policy.inputChain}
-A FORWARD -i ${policy.bridgeInterface} -s ${policy.botIpv4}/32 -j ${policy.chain}
-A FORWARD -o ${policy.bridgeInterface} -d ${policy.botIpv4}/32 -j ${policy.chain}
-A ${policy.chain} -i ${policy.bridgeInterface} -s ${policy.botIpv4}/32 -d ${policy.databaseIpv4}/32 -p tcp -m conntrack --ctstate NEW,ESTABLISHED --dport 5432 -j ACCEPT
-A ${policy.chain} -i ${policy.bridgeInterface} -s ${policy.botIpv4}/32 -p tcp -m conntrack --ctstate NEW,ESTABLISHED --dport 443 -j ACCEPT
-A ${policy.chain} -i ${policy.bridgeInterface} -s ${policy.botIpv4}/32 -p udp -m conntrack --ctstate NEW,ESTABLISHED --dport ${policy.udpDestinationPorts.start}:${policy.udpDestinationPorts.end} -j ACCEPT
-A ${policy.chain} -o ${policy.bridgeInterface} -d ${policy.botIpv4}/32 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A ${policy.chain} -j DROP
-A ${policy.inputChain} -j DROP
COMMIT
`;
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
    expect(harness.calls.every(({ environment, executable }) =>
      ["/usr/bin/docker", "/usr/sbin/iptables", "/usr/sbin/iptables-save"].includes(executable)
      && environment.PATH?.endsWith("/usr/bin:/bin") === true && environment.DOCKER_HOST === undefined)).toBe(true);
    expect(harness.calls.every(({ workingDirectory }) => workingDirectory === "/")).toBe(true);
    expect(harness.calls.filter(({ args }) => args.includes("up") || args.includes("run"))
      .every(({ args }) => args.includes("--no-deps"))).toBe(true);
    const databaseUp = harness.calls.findIndex(({ args }) => args.includes("up") && args.at(-1) === "database");
    const firewallInstall = harness.calls.findIndex(({ executable, args }) =>
      executable === "/usr/sbin/iptables" && args[0] === "-N");
    const botUp = harness.calls.findIndex(({ args }) => args.includes("up") && args.at(-1) === "bot");
    expect(databaseUp).toBeGreaterThan(-1);
    expect(firewallInstall).toBeGreaterThan(databaseUp);
    expect(botUp).toBeGreaterThan(firewallInstall);
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

  it("rejects source preprocessing and external-resolution surfaces with zero effects", async () => {
    const baseline = await fixture("campaign-source-adversarial");
    const insertBot = (line: string): string => baseline.composeCanonical.replace(
      `  bot:\n    image: ${repository}\n`, `  bot:\n    ${line}\n    image: ${repository}\n`);
    const cases = [
      insertBot("env_file: /etc/os-release"),
      `include: /etc/os-release\n${baseline.composeCanonical}`,
      insertBot("extends:\n      file: /etc/os-release\n      service: bot"),
      insertBot("build: https://attacker.invalid/context.git"),
      `configs:\n  host:\n    file: /etc/os-release\n${baseline.composeCanonical}`,
      `secrets:\n  host:\n    file: /etc/os-release\n${baseline.composeCanonical}`,
      insertBot("profiles: [unsafe]"),
      baseline.composeCanonical.replace("POSTGRES_DB: craig", "POSTGRES_DB: ${HOST_DATABASE}"),
      baseline.composeCanonical.replace("- postgres-data:/var/lib/postgresql/data",
        "- /etc/os-release:/var/lib/postgresql/data"),
      baseline.composeCanonical.replace("environment:\n      POSTGRES_DB", "environment: &host\n      POSTGRES_DB")
        .replace("environment:\n      DATABASE_URL", "environment: *host\n      # DATABASE_URL"),
      baseline.composeCanonical.replace("POSTGRES_DB: craig", "<<: &host { POSTGRES_DB: craig }"),
      baseline.composeCanonical.replace("POSTGRES_DB: craig", "POSTGRES_DB: !include /etc/os-release"),
      baseline.composeCanonical.replace("environment:\n      POSTGRES_DB", "environment:\n      nested: &host value\n      POSTGRES_DB"),
    ];
    for (const [index, composeCanonical] of cases.entries()) {
      const input = { ...baseline, composeCanonical,
        composeCanonicalSha256: createHash("sha256").update(composeCanonical).digest("hex") };
      const commands = vi.fn(async () => result());
      const credentials = vi.fn(async () => { throw new Error("credential effect must remain unreachable"); });
      const mutation = vi.fn(async () => { throw new Error("mutation effect must remain unreachable"); });
      await expect(provisionCraigDisposableCampaignStack(input, {
        commands: { execute: commands }, credentials: { reserveCreateOnly: credentials },
        mutationJournal: { markStarted: mutation },
      }, await leaseFor(baseline)), `source case ${index}`).rejects.toThrow();
      expect(commands, `source case ${index} commands`).not.toHaveBeenCalled();
      expect(credentials, `source case ${index} credentials`).not.toHaveBeenCalled();
      expect(mutation, `source case ${index} mutation`).not.toHaveBeenCalled();
    }
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
    expect(teardownCalls.findIndex(({ args }) => args.includes("stop")))
      .toBeLessThan(teardownCalls.findIndex(({ executable, args }) =>
        executable === "/usr/sbin/iptables" && args[0] === "-D"));
    expect(teardownCalls.some(({ args }) => args.includes("down") && args.includes("--volumes"))).toBe(true);
    expect(teardownCalls.at(-1)?.args).toEqual(["volume", "inspect", receipt.databaseVolume]);
    await expect(teardownSuccessfulCraigCampaignStack(
      { ...receipt, receiptSha256: "0".repeat(64) }, input, lease, harness.ports()))
      .rejects.toThrow(/digest is invalid/u);
  });
});

describe("Craig failed-stack recovery evidence", () => {
  it("recovers an exact retained failed stack and rejects mutated recovery evidence", async () => {
    const input = await fixture("campaign-failed-recovery");
    const harness = new Harness(input);
    const lease = await leaseFor(input);
    await provisionCraigDisposableCampaignStack(input, harness.ports(), lease);
    const { failure, mutation, plan } = failedStackEvidence(input, lease);
    const recovery = await recoverCraigFailedCampaignStack(input, mutation, failure,
      { execute: harness.execute }, () => Date.parse("2026-08-26T12:00:02.000Z"));
    expect(recovery).toMatchObject({ campaignId: input.campaignId, campaignLeaseRemoved: true,
      kind: "craig-failed-stack-recovery", projectName: plan.projectName });
    await expect(stat(join(lease.campaignRoot, "barriers", "campaign.lease")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const { receiptSha256: _receiptSha256, ...recoveryContent } = recovery;
    const mutatedRecovery = { ...recoveryContent, unexpected: true };
    expect(() => verifyCraigFailedStackRecoveryReceipt({ ...mutatedRecovery,
      receiptSha256: digestCanonical(mutatedRecovery) }, failure, mutation)).toThrow();
    const foreignAbsenceContent = { ...recoveryContent, absenceProof: {
      ...recovery.absenceProof, absentNetworkName: "foreign-network",
    } };
    expect(() => verifyCraigFailedStackRecoveryReceipt({ ...foreignAbsenceContent,
      receiptSha256: digestCanonical(foreignAbsenceContent) }, failure, mutation))
      .toThrow(/retained failure custody/u);

    const idempotentStart = harness.calls.length;
    await expect(reverifyExistingCraigFailedStackRecovery(input, mutation, failure, recovery,
      { execute: harness.execute })).resolves.toEqual(recovery);
    const idempotentCalls = harness.calls.slice(idempotentStart);
    expect(idempotentCalls.some(({ executable, args }) => executable === "/usr/bin/docker"
      && (args.includes("stop") || args.includes("down")))).toBe(false);
    expect(idempotentCalls.some(({ executable, args }) => executable === "/usr/sbin/iptables"
      && ["-D", "-F", "-X"].includes(args[0] ?? ""))).toBe(false);
  });

  it("rejects forged existing recovery custody and resources that reappear after a valid receipt", async () => {
    const input = await fixture("campaign-existing-receipt");
    const harness = new Harness(input);
    const lease = await leaseFor(input);
    await provisionCraigDisposableCampaignStack(input, harness.ports(), lease);
    const evidence = failedStackEvidence(input, lease);
    const recovery = await recoverCraigFailedCampaignStack(input, evidence.mutation, evidence.failure,
      { execute: harness.execute });

    const foreignInput = await fixture("campaign-foreign-existing-receipt");
    const beforeForeign = harness.calls.length;
    await expect(reverifyExistingCraigFailedStackRecovery(foreignInput, evidence.mutation,
      evidence.failure, recovery, { execute: harness.execute })).rejects.toThrow(/exact retained/u);
    expect(harness.calls).toHaveLength(beforeForeign);

    const { receiptSha256: _mutationDigest, ...mutationContent } = evidence.mutation;
    const forgedMutationContent = { ...mutationContent, composeServiceConfigHashes: {
      ...mutationContent.composeServiceConfigHashes, bot: "f".repeat(64),
    } };
    const forgedMutation = { ...forgedMutationContent,
      receiptSha256: digestCanonical(forgedMutationContent) };
    const { receiptSha256: _failureDigest, ...failureContent } = evidence.failure;
    const forgedFailureContent = { ...failureContent, mutationReceiptSha256: forgedMutation.receiptSha256 };
    const forgedFailure = { ...forgedFailureContent, receiptSha256: digestCanonical(forgedFailureContent) };
    const { receiptSha256: _recoveryDigest, ...forgedRecoveryBase } = recovery;
    const forgedRecoveryContent = { ...forgedRecoveryBase, failureReceiptSha256: forgedFailure.receiptSha256,
      mutationReceiptSha256: forgedMutation.receiptSha256 };
    const forgedRecovery = { ...forgedRecoveryContent,
      receiptSha256: digestCanonical(forgedRecoveryContent) };
    const beforeForgedHash = harness.calls.length;
    await expect(reverifyExistingCraigFailedStackRecovery(input, forgedMutation, forgedFailure,
      forgedRecovery, { execute: harness.execute })).rejects.toThrow(/changed from mutation custody/u);
    expect(harness.calls.slice(beforeForgedHash).some(({ executable, args }) =>
      executable === "/usr/bin/docker" && (args.includes("stop") || args.includes("down")))).toBe(false);

    const base = harness.execute.getMockImplementation();
    if (base === undefined) { throw new Error("missing harness implementation"); }
    const callsBeforeReappearance = harness.calls.length;
    harness.execute.mockImplementation(async (request) => {
      if (request.executable === "/usr/bin/docker" && request.args.includes("ps")
        && request.args.includes("--all")) { return result(0, `${id}\n`); }
      return base(request);
    });
    await expect(reverifyExistingCraigFailedStackRecovery(input, evidence.mutation,
      evidence.failure, recovery, { execute: harness.execute })).rejects.toThrow(/left Compose containers/u);
    const reappearanceCalls = harness.calls.slice(callsBeforeReappearance);
    expect(reappearanceCalls.some(({ executable, args }) => executable === "/usr/bin/docker"
      && (args.includes("stop") || args.includes("down")))).toBe(false);
    expect(reappearanceCalls.some(({ executable, args }) => executable === "/usr/sbin/iptables"
      && ["-D", "-F", "-X"].includes(args[0] ?? ""))).toBe(false);
  });

  it("refuses partial firewall custody after an exact dispatch was already deleted", async () => {
    const input = await fixture("campaign-firewall-retry");
    let saves = 0;
    const calls: string[][] = [];
    const execute = vi.fn(async (request: CraigCampaignStackCommandRequest) => {
      calls.push([...request.args]);
      if (request.executable === "/usr/sbin/iptables-save") {
        saves += 1;
        return result(0, saves === 1 ? firewall(input).replace(
          `-A INPUT -i ${input.networkPolicy.bridgeInterface} -s ${input.networkPolicy.botIpv4}/32 -j ${input.networkPolicy.inputChain}\n`,
          "") : "*filter\n:INPUT ACCEPT [0:0]\n:FORWARD DROP [0:0]\nCOMMIT\n");
      }
      if (request.args[0] === "-C" && request.args[1] === "INPUT") {
        return result(1, "", "Bad rule (does a matching rule exist in that chain?).");
      }
      return result();
    });
    await expect(removeCraigCampaignFirewall(input, execute, { botStopped: true }))
      .rejects.toThrow(/complete exact installed policy or complete absence/u);
    expect(calls.some((args) => ["-D", "-F", "-X"].includes(args[0] ?? ""))).toBe(false);
  });

  it("refuses an unsupported owned-chain rule without flushing or deleting evidence", async () => {
    const input = await fixture("campaign-firewall-unsupported");
    const calls: string[][] = [];
    const altered = `*filter\n:INPUT ACCEPT [0:0]\n:FORWARD DROP [0:0]\n:${input.networkPolicy.chain} - [0:0]\n-A ${input.networkPolicy.chain} -m owner --uid-owner 1000 -j DROP\nCOMMIT\n`;
    const execute = vi.fn(async (request: CraigCampaignStackCommandRequest) => {
      calls.push([...request.args]);
      return request.executable === "/usr/sbin/iptables-save" ? result(0, altered) : result();
    });
    await expect(removeCraigCampaignFirewall(input, execute, { botStopped: true }))
      .rejects.toThrow(/complete exact installed policy or complete absence/u);
    expect(calls.some((args) => ["-D", "-F", "-X"].includes(args[0] ?? ""))).toBe(false);
  });

  it("accepts complete firewall absence as an idempotent retry without delete commands", async () => {
    const input = await fixture("campaign-firewall-absent");
    const calls: string[][] = [];
    const execute = vi.fn(async (request: CraigCampaignStackCommandRequest) => {
      calls.push([...request.args]);
      if (request.executable === "/usr/sbin/iptables-save") {
        return result(0, "*filter\n:INPUT ACCEPT [0:0]\n:FORWARD DROP [0:0]\nCOMMIT\n");
      }
      return request.args[0] === "-C" || request.args[0] === "-S"
        ? result(1, "", "No such rule or chain") : result();
    });
    await expect(removeCraigCampaignFirewall(input, execute, { botStopped: true })).resolves.toBeUndefined();
    expect(calls.some((args) => ["-D", "-F", "-X"].includes(args[0] ?? ""))).toBe(false);
  });

  it("counts every mutation-only remnant and fails closed on foreign custody without deleting evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "craig-mutation-retention-"));
    const receipts: string[] = [];
    for (let index = 0; index < MAX_UNRECOVERED_CRAIG_STACKS + 1; index += 1) {
      const campaignId = `crash-${index}`;
      const control = join(root, campaignId, "control");
      await mkdir(control, { recursive: true, mode: 0o700 });
      const networkPolicy = deriveCraigCampaignNetworkPolicy(campaignId, release,
        { end: 65_535, start: 1_024 });
      const content = { campaignId, campaignLeaseSha256: "3".repeat(64),
        composeCanonicalSha256: "4".repeat(64), composeServiceConfigHashes: {
          bot: "a".repeat(64), database: "b".repeat(64), migrate: "c".repeat(64),
        }, hostedPlanSha256: "5".repeat(64),
        kind: "craig-stack-mutation-start" as const, networkPolicy, planSha256: "6".repeat(64),
        projectName: craigProjectName(campaignId, release), release, schemaVersion: 1 as const,
        startedAt: "2026-08-26T12:00:00.000Z" };
      const path = join(control, "craig-stack-mutation-start.json");
      await writeFile(path, `${JSON.stringify({ ...content, receiptSha256: digestCanonical(content) })}\n`,
        { mode: 0o600 });
      receipts.push(path);
    }
    await expect(assertCraigFailedStackRetentionAdmission(root)).rejects.toThrow(/9 unrecovered/u);
    await expect(Promise.all(receipts.map((path) => stat(path)))).resolves.toHaveLength(9);

    const foreign = JSON.parse(await readFile(receipts[0]!, "utf8")) as Record<string, unknown>;
    foreign.campaignId = "foreign-campaign";
    const { receiptSha256: _receiptSha256, ...foreignContent } = foreign;
    await writeFile(receipts[0]!, `${JSON.stringify({ ...foreignContent,
      receiptSha256: digestCanonical(foreignContent) })}\n`, { mode: 0o600 });
    await expect(assertCraigFailedStackRetentionAdmission(root)).rejects.toThrow(/foreign campaign root/u);
    await expect(stat(receipts[0]!)).resolves.toBeDefined();
  });
});

describe("Craig failed-stack Docker custody", () => {
  it("rejects every foreign Docker custody mutation before stop, firewall removal, or down", async () => {
    const cases: readonly [string, (request: CraigCampaignStackCommandRequest,
      value: unknown) => unknown][] = [
      ["container image", (request, value) => request.args[0] === "container"
        && request.args[1] === "inspect" && request.args[2] === id
        ? mutateInspection(value, (item) => { item.Image = `sha256:${"f".repeat(64)}`; }) : value],
      ["container repository", (request, value) => request.args[0] === "container"
        && request.args[1] === "inspect" && request.args[2] === id
        ? mutateInspection(value, (item) => { item.Config!.Image = "evil.invalid/foreign@sha256:"
          + "e".repeat(64); }) : value],
      ["missing Compose config hash", (request, value) => request.args[0] === "container"
        && request.args[1] === "inspect" && request.args[2] === id
        ? mutateInspection(value, (item) => { delete item.Config?.Labels?.["com.docker.compose.config-hash"]; })
        : value],
      ["foreign Compose config hash", (request, value) => request.args[0] === "container"
        && request.args[1] === "inspect" && request.args[2] === id
        ? mutateInspection(value, (item) => { if (item.Config?.Labels !== undefined) {
          item.Config.Labels["com.docker.compose.config-hash"] = "f".repeat(64);
        } }) : value],
      ["mixed Compose config hash", (request, value) => request.args[0] === "container"
        && request.args[1] === "inspect" && request.args[2] === databaseId
        ? mutateInspection(value, (item) => { if (item.Config?.Labels !== undefined) {
          item.Config.Labels["com.docker.compose.config-hash"] = "e".repeat(64);
        } }) : value],
      ["host network", (request, value) => request.args[0] === "network" && request.args[1] === "inspect"
        ? mutateInspection(value, (item) => { item.Driver = "host"; }) : value],
      ["altered subnet", (request, value) => request.args[0] === "network" && request.args[1] === "inspect"
        ? mutateInspection(value, (item) => { item.IPAM!.Config = [{ Subnet: "192.0.2.0/24" }]; }) : value],
      ["altered bridge", (request, value) => request.args[0] === "network" && request.args[1] === "inspect"
        ? mutateInspection(value, (item) => { item.Options = {
          "com.docker.network.bridge.name": "foreign0",
        }; }) : value],
      ["network label collision", (request, value) => request.args[0] === "network"
        && request.args[1] === "inspect" ? mutateInspection(value, (item) => {
          item.Labels!["com.docker.compose.network"] = "foreign";
        }) : value],
      ["foreign volume driver", (request, value) => request.args[0] === "volume"
        && request.args[1] === "inspect" ? mutateInspection(value, (item) => { item.Driver = "foreign"; }) : value],
      ["volume label collision", (request, value) => request.args[0] === "volume"
        && request.args[1] === "inspect" ? mutateInspection(value, (item) => {
          item.Labels!["com.docker.compose.volume"] = "foreign";
        }) : value],
    ];
    for (const [name, mutate] of cases) {
      const input = await fixture(`campaign-foreign-${name.replaceAll(" ", "-")}`);
      const harness = new Harness(input);
      const lease = await leaseFor(input);
      await provisionCraigDisposableCampaignStack(input, harness.ports(), lease);
      const evidence = failedStackEvidence(input, lease);
      const base = harness.execute.getMockImplementation();
      if (base === undefined) { throw new Error("missing harness implementation"); }
      const destructiveStart = harness.calls.length;
      harness.execute.mockImplementation(async (request) => {
        const response = await base(request);
        const inspection = request.args[0] === "container" && request.args[1] === "inspect"
          || request.args[0] === "network" && request.args[1] === "inspect"
          || request.args[0] === "volume" && request.args[1] === "inspect";
        if (!inspection || response.exitCode !== 0 || response.stdout === "") { return response; }
        const changed = mutate(request, JSON.parse(response.stdout));
        return changed === undefined ? response : result(0, JSON.stringify(changed));
      });
      await expect(recoverCraigFailedCampaignStack(input, evidence.mutation, evidence.failure,
        { execute: harness.execute }), name).rejects.toThrow(/custody|exact/u);
      const recoveryCalls = harness.calls.slice(destructiveStart);
      expect(recoveryCalls.some(({ executable, args }) => executable === "/usr/bin/docker"
        && (args.includes("stop") || args.includes("down"))), name).toBe(false);
      expect(recoveryCalls.some(({ executable, args }) => executable === "/usr/sbin/iptables"
        && ["-D", "-F", "-X"].includes(args[0] ?? "")), name).toBe(false);
    }
  }, 20_000);

});

describe("Craig disposable stack closed-input and custody continuation", () => {

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
    expect(harness.calls.filter(({ args, executable }) => executable === "/usr/bin/docker"
      && args[0] === "compose").filter((request) =>
      !request.args.includes("--file") || !request.args.includes("-")
      || request.standardInput !== input.composeCanonical
      || request.environment.POSTGRES_PASSWORD !== "fresh-campaign-password-0123456789")
      .map(({ args, standardInput, environment }) => ({ args, standardInput,
        password: environment.POSTGRES_PASSWORD }))).toEqual([]);
    expect(harness.calls.some(({ args }) => args.includes("down"))).toBe(true);
  });

  it("rejects unsafe retained source before teardown can invoke Compose external resolution", async () => {
    const input = await fixture("campaign-unsafe-teardown-source");
    const harness = new Harness(input);
    const lease = await leaseFor(input);
    const receipt = await provisionCraigDisposableCampaignStack(input, harness.ports(), lease);
    const composeCanonical = input.composeCanonical.replace(
      `  bot:\n    image: ${repository}\n`,
      `  bot:\n    env_file: /etc/os-release\n    image: ${repository}\n`,
    );
    const unsafe = { ...input, composeCanonical,
      composeCanonicalSha256: createHash("sha256").update(composeCanonical).digest("hex") };
    const callCount = harness.calls.length;
    await expect(teardownSuccessfulCraigCampaignStack(receipt, unsafe, lease, harness.ports()))
      .rejects.toThrow();
    expect(harness.calls).toHaveLength(callCount);
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
      ["host network_mode", (value) => { Object.assign(value.services.bot, { network_mode: "host" }); }],
      ["bridge network_mode", (value) => { Object.assign(value.services.bot, { network_mode: "bridge" }); }],
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

function failedStackEvidence(input: CraigCampaignStackInput, lease: HostedCampaignLeaseHandle) {
  const plan = planCraigDisposableCampaignStack(input);
  const mutationContent = { campaignId: input.campaignId, campaignLeaseSha256: lease.leaseSha256,
    composeCanonicalSha256: input.composeCanonicalSha256,
    composeServiceConfigHashes: serviceConfigHashes(input), hostedPlanSha256: lease.planSha256,
    kind: "craig-stack-mutation-start" as const, networkPolicy: input.networkPolicy,
    planSha256: plan.planSha256, projectName: plan.projectName, release: input.release,
    schemaVersion: 1 as const, startedAt: "2026-08-26T12:00:00.000Z" };
  const mutation = { ...mutationContent, receiptSha256: digestCanonical(mutationContent) };
  const failureContent = { campaignId: input.campaignId, campaignLeaseSha256: lease.leaseSha256,
    campaignRoot: lease.campaignRoot, failedAt: "2026-08-26T12:00:01.000Z", failureClass: "Error",
    failureSha256: "7".repeat(64), hostedPlanSha256: lease.planSha256,
    kind: "craig-failed-stack" as const, mutationReceiptSha256: mutation.receiptSha256,
    planSha256: plan.planSha256, projectName: plan.projectName, release: input.release,
    schemaVersion: 1 as const };
  return { failure: { ...failureContent, receiptSha256: digestCanonical(failureContent) }, mutation, plan };
}

type MutableInspection = {
  Config?: { Image?: string; Labels?: Record<string, string> };
  Driver?: string;
  Image?: string;
  IPAM?: { Config?: { Subnet?: string }[] };
  Labels?: Record<string, string>;
  Options?: Record<string, string>;
};

function mutateInspection(value: unknown, mutate: (item: MutableInspection) => void): unknown {
  const clone = structuredClone(value) as [MutableInspection];
  mutate(clone[0]);
  return clone;
}

function result(exitCode = 0, stdout = "", stderr = ""): CraigCampaignStackCommandResult {
  return { exitCode, stderr, stdout };
}
