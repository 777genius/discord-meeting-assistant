import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  FileCraigCampaignCredentialStore,
  craigProjectName,
  deriveCraigCampaignNetworkPolicy,
  planCraigDisposableCampaignStack,
  provisionCraigDisposableCampaignStack,
  teardownSuccessfulCraigCampaignStack,
  type CraigCampaignStackMutationStartV1,
} from "../src/craig-disposable-campaign-stack.js";
import { LocalDockerCommandExecutor } from "../src/craig-campaign-stack-local-adapters.js";
import { recoverCraigFailedCampaignStack } from "../src/recover-craig-failed-campaign-stack.js";
import { digestCanonical } from "../src/hosted-campaign-local-admission.js";
import type { HostedCampaignLeaseHandle } from "../src/hosted-campaign-coordinator.js";

const executeFile = promisify(execFile);
const release = { releaseBindingSha256: "a".repeat(64), releaseId: "local-integration",
  trustRootSha256: "b".repeat(64) } as const;

const docker = process.env.RUN_DOCKER_INTEGRATION === "1" ? await localImages() : undefined;

describe.skipIf(docker === undefined)("Craig disposable stack with local Compose/PostgreSQL", () => {
  it("renders, migrates, verifies, receipts, and tears down a real disposable database", async () => {
    if (docker === undefined) { throw new Error("skip guard failed"); }
    const campaignId = `local-${process.pid}-${Date.now()}`;
    const root = await mkdtemp(join(tmpdir(), "craig-compose-integration-"));
    const control = join(root, campaignId, "control");
    await mkdir(control, { recursive: true, mode: 0o700 });
    await mkdir(join(root, campaignId, "barriers"), { recursive: true, mode: 0o700 });
    const campaignRoot = join(root, campaignId);
    const planSha256 = "d".repeat(64);
    const leaseContents = `${JSON.stringify({ campaignId, campaignRoot, planSha256 })}\n`;
    const leasePath = join(campaignRoot, "barriers", "campaign.lease");
    await writeFile(leasePath, leaseContents, { mode: 0o600 });
    const leaseStatus = await stat(leasePath);
    const lease = { campaignId, campaignRoot, device: leaseStatus.dev, inode: leaseStatus.ino,
      leaseSha256: createHash("sha256").update(leaseContents).digest("hex"), planSha256 } as never;
    const composeFile = join(root, "compose.yaml");
    const credentialFile = join(control, "craig.env");
    const project = craigProjectName(campaignId, release);
    const migrationChecksum = "e".repeat(64);
    const networkPolicy = deriveCraigCampaignNetworkPolicy(campaignId, release, { end: 65_535, start: 1_024 });
    const databaseUrl = "postgresql://craig:local-password-01234567890123456789@database:5432/craig";
    const compose = `services:
  database:
    image: ${docker.postgres.repositoryDigest}
    hostname: database
    environment:
      POSTGRES_DB: craig
      POSTGRES_PASSWORD: local-password-01234567890123456789
      POSTGRES_USER: craig
    healthcheck:
      test: ["CMD-SHELL", "grep -qx postgres /proc/1/comm && psql -U craig -d craig -c 'SELECT 1'"]
      interval: 1s
      timeout: 1s
      retries: 30
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      ${networkPolicy.name}:
        ipv4_address: ${networkPolicy.databaseIpv4}
  migrate:
    image: ${docker.postgres.repositoryDigest}
    depends_on:
      database:
        condition: service_started
        required: true
        restart: true
    network_mode: service:database
    environment:
      DATABASE_URL: ${databaseUrl}
  bot:
    image: ${docker.substitute.repositoryDigest}
    environment:
      DATABASE_URL: ${databaseUrl}
      DISCORD_APPLICATION_ID: '1533877611258708230'
      E2E_CAMPAIGN_ID: ${campaignId}
      E2E_SOURCE_REVISION: ${"c".repeat(40)}
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 1s
      timeout: 1s
      retries: 30
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
    await writeFile(composeFile, compose, { mode: 0o600 });
    const input = {
      campaignId, campaignRoot: root, composeCanonical: compose,
      composeCanonicalSha256: createHash("sha256").update(compose).digest("hex"), composeFile, credentialFile,
      database: { imageIdentity: docker.postgres,
        migrations: [{ checksum: migrationChecksum, version: "001" }], migrationTable: "migrations",
        name: "craig", password: "local-password-01234567890123456789",
        schema: "public", service: "database", user: "craig", volume: "postgres-data" },
      migrationImageIdentity: docker.postgres, migrationService: "migrate", networkPolicy,
      readinessTimeoutSeconds: 60,
      release, service: "bot",
      serviceIdentity: { applicationId: "1533877611258708230", imageId: docker.substitute.imageId,
        protocol: { command: ["redis-cli", "ping"],
          expectedResponseSha256: createHash("sha256").update("PONG\n").digest("hex"),
          kind: "test-port-substitute", name: "disposable-craig-port-substitute", version: "v1" },
        repositoryDigest: docker.substitute.repositoryDigest, sourceRevision: "c".repeat(40) },
    } as const;
    const commands = new LocalDockerCommandExecutor();
    let receipt;
    let retainedProject = project;
    try {
      receipt = await provisionCraigDisposableCampaignStack(input, {
        commands, credentials: new FileCraigCampaignCredentialStore(),
        mutationJournal: { markStarted: async () => {} },
      }, lease);
      expect(receipt).toMatchObject({ database: { name: "craig", schema: "public", user: "craig" },
        projectName: project, serviceHealth: "healthy" });
      await teardownSuccessfulCraigCampaignStack(receipt, input, lease, { commands });
      const recoveryCampaignId = `${campaignId}-recovery`;
      const recoveryPolicy = deriveCraigCampaignNetworkPolicy(recoveryCampaignId, release,
        { end: 65_535, start: 1_024 });
      const recoveryRoot = join(root, recoveryCampaignId);
      await mkdir(join(recoveryRoot, "control"), { recursive: true, mode: 0o700 });
      await mkdir(join(recoveryRoot, "barriers"), { recursive: true, mode: 0o700 });
      const recoveryPlanSha256 = "f".repeat(64);
      const recoveryLeaseContents = `${JSON.stringify({ campaignId: recoveryCampaignId,
        campaignRoot: recoveryRoot, planSha256: recoveryPlanSha256 })}\n`;
      const recoveryLeasePath = join(recoveryRoot, "barriers", "campaign.lease");
      await writeFile(recoveryLeasePath, recoveryLeaseContents, { mode: 0o600 });
      const recoveryLeaseStatus = await stat(recoveryLeasePath);
      const recoveryLease = { campaignId: recoveryCampaignId, campaignRoot: recoveryRoot,
        device: recoveryLeaseStatus.dev, inode: recoveryLeaseStatus.ino,
        leaseSha256: createHash("sha256").update(recoveryLeaseContents).digest("hex"),
        planSha256: recoveryPlanSha256 } as HostedCampaignLeaseHandle;
      const recoveryCompose = compose.replaceAll(campaignId, recoveryCampaignId)
        .replaceAll(networkPolicy.name, recoveryPolicy.name)
        .replaceAll(networkPolicy.databaseIpv4, recoveryPolicy.databaseIpv4)
        .replaceAll(networkPolicy.botIpv4, recoveryPolicy.botIpv4)
        .replaceAll(networkPolicy.bridgeInterface, recoveryPolicy.bridgeInterface)
        .replaceAll(networkPolicy.subnet, recoveryPolicy.subnet);
      const recoveryInput = { ...input, campaignId: recoveryCampaignId, composeCanonical: recoveryCompose,
        composeCanonicalSha256: createHash("sha256").update(recoveryCompose).digest("hex"),
        credentialFile: join(recoveryRoot, "control", "craig.env"), networkPolicy: recoveryPolicy };
      const recoveryPlan = planCraigDisposableCampaignStack(recoveryInput);
      retainedProject = recoveryPlan.projectName;
      let recoveryMutationStart: CraigCampaignStackMutationStartV1 | undefined;
      await provisionCraigDisposableCampaignStack(recoveryInput, {
        commands, credentials: new FileCraigCampaignCredentialStore(),
        mutationJournal: { markStarted: async (value) => { recoveryMutationStart = value; } },
      }, recoveryLease);
      if (recoveryMutationStart === undefined) { throw new Error("missing recovery mutation custody"); }
      const mutationContent = { ...recoveryMutationStart,
        startedAt: "2026-08-26T12:00:00.000Z" };
      const mutation = { ...mutationContent, receiptSha256: digestCanonical(mutationContent) };
      const failureContent = { campaignId: recoveryCampaignId,
        campaignLeaseSha256: recoveryLease.leaseSha256, campaignRoot: recoveryRoot,
        failedAt: "2026-08-26T12:00:01.000Z", failureClass: "Error", failureSha256: "e".repeat(64),
        hostedPlanSha256: recoveryLease.planSha256, kind: "craig-failed-stack" as const,
        mutationReceiptSha256: mutation.receiptSha256, planSha256: recoveryPlan.planSha256,
        projectName: recoveryPlan.projectName, release, schemaVersion: 1 as const };
      const failure = { ...failureContent, receiptSha256: digestCanonical(failureContent) };
      await expect(recoverCraigFailedCampaignStack(recoveryInput, mutation, failure, commands))
        .resolves.toMatchObject({ campaignId: recoveryCampaignId, campaignLeaseRemoved: true });
    } catch (error) {
      // Failed infrastructure is deliberately retained. Emit its exact project
      // for local diagnosis; never clean it through the failure path.
      process.stderr.write(`Retained failed disposable Craig project ${retainedProject}\n`);
      throw error;
    }
  }, 120_000);
});

type ImageIdentity = { imageId: string; repositoryDigest: string };
async function localImages(): Promise<{ postgres: ImageIdentity; substitute: ImageIdentity } | undefined> {
  try {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) { return undefined; }
    await Promise.all([executeFile("/usr/sbin/iptables", ["--version"], { timeout: 5_000 }),
      executeFile("/usr/sbin/iptables-save", ["--version"], { timeout: 5_000 })]);
    await executeFile("/usr/bin/docker", ["version"], { timeout: 5_000 });
    const inspect = async (name: string): Promise<ImageIdentity> => {
      const result = await executeFile("/usr/bin/docker", ["image", "inspect", name], { timeout: 5_000 });
      const value = JSON.parse(result.stdout) as readonly [{ Id?: string; RepoDigests?: readonly string[] }];
      const imageId = value[0].Id;
      const repositoryDigest = value[0].RepoDigests?.[0];
      if (imageId?.startsWith("sha256:") !== true || repositoryDigest?.includes("@sha256:") !== true) {
        throw new Error("local image lacks immutable identity");
      }
      return { imageId, repositoryDigest };
    };
    return { postgres: await inspect("postgres:16-alpine"), substitute: await inspect("redis:7-alpine") };
  } catch { return undefined; }
}
