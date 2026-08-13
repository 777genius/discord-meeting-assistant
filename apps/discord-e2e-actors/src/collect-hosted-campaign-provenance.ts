import { constants } from "node:fs";
import { link, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { z } from "zod";

import { deploymentRevisionExpectationSchema } from "./e2e-evidence.js";
import {
  collectHostedCampaignProvenanceAfter,
  collectHostedCampaignProvenanceBefore,
  hostedCampaignProvenanceSnapshotV1Schema,
  provenanceBeforeCompletion,
} from "./hosted-campaign-provenance.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";
import { SshDeploymentEvidenceProbe } from "./ssh-deployment-probe.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const sourceRevision = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const absolutePath = z.string().refine(isAbsolute);
const environmentSchema = z.object({
  DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION: sourceRevision,
  DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION: sourceRevision,
  DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION: sourceRevision,
  DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION: sourceRevision,
  DISCORD_E2E_MUTATION_TARGET: z.literal(HOSTED_CAMPAIGN_TARGET.mutationTarget),
  DISCORD_E2E_PROVENANCE_CAMPAIGN_ID: identifier,
  DISCORD_E2E_PROVENANCE_PHASE: z.enum(["before", "after"]),
  DISCORD_E2E_PROVENANCE_RUN_IDS_JSON: z.string(),
  DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH: absolutePath,
  DISCORD_E2E_REMOTE_COMPOSE_FILE: absolutePath,
  DISCORD_E2E_REMOTE_CRAIG_PROJECT: z.literal(HOSTED_CAMPAIGN_TARGET.craigProject),
  DISCORD_E2E_REMOTE_CRAIG_SERVICE: z.literal("bot"),
  DISCORD_E2E_REMOTE_ENV_FILE: absolutePath,
  DISCORD_E2E_REMOTE_HOST: z.literal(HOSTED_CAMPAIGN_TARGET.host),
  DISCORD_E2E_REMOTE_PROJECT: z.literal(HOSTED_CAMPAIGN_TARGET.project),
  DISCORD_E2E_REMOTE_SOURCE_ROOT: absolutePath,
});
const runIdsSchema = z.tuple([identifier, identifier, identifier]);

async function main(): Promise<void> {
  const config = environmentSchema.parse(process.env);
  const runIds = runIdsSchema.parse(JSON.parse(config.DISCORD_E2E_PROVENANCE_RUN_IDS_JSON));
  const expectedRevisions = deploymentRevisionExpectationSchema.parse({
    craig: config.DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION,
    meetingPlatform: config.DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION,
    pipecat: config.DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION,
    subscriptionRuntime: config.DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION,
  });
  const collector = new SshDeploymentEvidenceProbe({
    composeFile: config.DISCORD_E2E_REMOTE_COMPOSE_FILE,
    craigProjectName: config.DISCORD_E2E_REMOTE_CRAIG_PROJECT,
    craigServiceName: config.DISCORD_E2E_REMOTE_CRAIG_SERVICE,
    envFile: config.DISCORD_E2E_REMOTE_ENV_FILE,
    host: config.DISCORD_E2E_REMOTE_HOST,
    includePipecatProvenance: true,
    mutationTarget: config.DISCORD_E2E_MUTATION_TARGET,
    projectName: config.DISCORD_E2E_REMOTE_PROJECT,
    sourceRoot: config.DISCORD_E2E_REMOTE_SOURCE_ROOT,
  });
  const correlation = { campaignId: config.DISCORD_E2E_PROVENANCE_CAMPAIGN_ID, expectedRevisions, runIds };
  if (config.DISCORD_E2E_PROVENANCE_PHASE === "before") {
    const snapshot = await collectHostedCampaignProvenanceBefore(correlation, collector);
    await writeCreateOnlyJson(config.DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH, snapshot);
    process.stdout.write(`${JSON.stringify(provenanceBeforeCompletion(snapshot))}\n`);
    return;
  }
  const baseline = await readPrivateJson(config.DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH);
  const completion = await collectHostedCampaignProvenanceAfter({ ...correlation, baseline }, collector);
  process.stdout.write(`${JSON.stringify(completion)}\n`);
}

async function readPrivateJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.size < 2 || before.size > 1024 * 1024
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
      throw new Error("Hosted campaign provenance snapshot is unsafe");
    }
    const contents = await handle.readFile("utf8");
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || Buffer.byteLength(contents) !== before.size) {
      throw new Error("Hosted campaign provenance snapshot changed while reading");
    }
    return hostedCampaignProvenanceSnapshotV1Schema.parse(JSON.parse(contents));
  } finally {
    await handle.close();
  }
}

async function writeCreateOnlyJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, path);
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch(() => {});
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`Hosted campaign provenance collection failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
