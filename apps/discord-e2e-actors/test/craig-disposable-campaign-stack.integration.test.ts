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
  provisionCraigDisposableCampaignStack,
  teardownSuccessfulCraigCampaignStack,
} from "../src/craig-disposable-campaign-stack.js";
import { LocalDockerCommandExecutor } from "../src/craig-campaign-stack-local-adapters.js";

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
    const compose = `services:
  database:
    image: ${docker.postgres.repositoryDigest}
    hostname: database
    network_mode: none
    environment:
      POSTGRES_DB: \${POSTGRES_DB}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_USER: \${POSTGRES_USER}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER} -d \${POSTGRES_DB}"]
      interval: 1s
      timeout: 1s
      retries: 30
    volumes:
      - postgres-data:/var/lib/postgresql/data
  migrate:
    image: ${docker.postgres.repositoryDigest}
    network_mode: service:database
    environment:
      DATABASE_URL: \${DATABASE_URL}
  bot:
    image: ${docker.substitute.repositoryDigest}
    network_mode: none
    environment:
      DATABASE_URL: \${DATABASE_URL}
      DISCORD_APPLICATION_ID: '1533877611258708230'
      E2E_CAMPAIGN_ID: \${E2E_CAMPAIGN_ID}
      E2E_SOURCE_REVISION: ${"c".repeat(40)}
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 1s
      timeout: 1s
      retries: 30
volumes:
  postgres-data:
`;
    await writeFile(composeFile, compose, { mode: 0o600 });
    const input = {
      campaignId, campaignRoot: root, composeCanonical: compose,
      composeCanonicalSha256: createHash("sha256").update(compose).digest("hex"), composeFile, credentialFile,
      database: { imageIdentity: docker.postgres,
        migrations: [{ checksum: migrationChecksum, version: "001" }], migrationTable: "migrations",
        name: "craig", password: "local-password-01234567890123456789",
        schema: "public", service: "database", user: "craig", volume: "postgres-data" },
      migrationImageIdentity: docker.postgres, migrationService: "migrate", readinessTimeoutSeconds: 60,
      release, service: "bot",
      serviceIdentity: { applicationId: "1533877611258708230", imageId: docker.substitute.imageId,
        protocol: { command: ["redis-cli", "ping"],
          expectedResponseSha256: createHash("sha256").update("PONG\n").digest("hex"),
          kind: "test-port-substitute", name: "disposable-craig-port-substitute", version: "v1" },
        repositoryDigest: docker.substitute.repositoryDigest, sourceRevision: "c".repeat(40) },
    } as const;
    const commands = new LocalDockerCommandExecutor();
    let receipt;
    try {
      receipt = await provisionCraigDisposableCampaignStack(input, {
        commands, credentials: new FileCraigCampaignCredentialStore(),
        mutationJournal: { markStarted: async () => {} },
      }, lease);
      expect(receipt).toMatchObject({ database: { name: "craig", schema: "public", user: "craig" },
        projectName: project, serviceHealth: "healthy" });
      await teardownSuccessfulCraigCampaignStack(receipt, input, lease, { commands });
    } catch (error) {
      // Failed infrastructure is deliberately retained. Emit its exact project
      // for local diagnosis; never clean it through the failure path.
      process.stderr.write(`Retained failed disposable Craig project ${project}\n`);
      throw error;
    }
  }, 120_000);
});

type ImageIdentity = { imageId: string; repositoryDigest: string };
async function localImages(): Promise<{ postgres: ImageIdentity; substitute: ImageIdentity } | undefined> {
  try {
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
