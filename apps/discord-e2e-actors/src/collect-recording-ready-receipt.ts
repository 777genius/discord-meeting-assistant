import { chmod, link, lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { z } from "zod";

import { deploymentRevisionExpectationSchema } from "./e2e-evidence.js";
import { waitForStableRecordingReadyReceipt } from "./recording-ready-poller.js";
import { SshDeploymentEvidenceProbe } from "./ssh-deployment-probe.js";
import { EvidenceProbeInterruptedError } from "./ssh-deployment-probe-commands.js";

const absolutePath = z.string().refine(isAbsolute);
const sourceRevision = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const environmentSchema = z.object({
  DISCORD_E2E_ACTOR_RUN_INPUT: absolutePath,
  DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION: sourceRevision,
  DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION: sourceRevision,
  DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION: sourceRevision,
  DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION: sourceRevision,
  DISCORD_E2E_MUTATION_TARGET: z.literal("test-only"),
  DISCORD_E2E_READY_RECEIPT_OUTPUT: absolutePath,
  DISCORD_E2E_READY_RECEIPT_POLL_INTERVAL_MS: z.coerce.number().int().positive().max(60_000),
  DISCORD_E2E_READY_RECEIPT_TIMEOUT_MS: z.coerce.number().int().positive().max(900_000),
  DISCORD_E2E_REMOTE_ATTESTATION_FILE: z.string().regex(
    /^\/tmp\/discord-e2e-attestations\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u,
  ),
  DISCORD_E2E_REMOTE_COMPOSE_FILE: absolutePath,
  DISCORD_E2E_REMOTE_CRAIG_PROJECT: z.literal("craig-meeting-e2e"),
  DISCORD_E2E_REMOTE_CRAIG_SERVICE: z.literal("bot"),
  DISCORD_E2E_REMOTE_ENV_FILE: absolutePath,
  DISCORD_E2E_REMOTE_HOST: z.string().min(1),
  DISCORD_E2E_REMOTE_PROJECT: z.literal("discord-meeting-assistant"),
  DISCORD_E2E_REMOTE_SOURCE_ROOT: absolutePath,
});

async function main(): Promise<void> {
  const config = environmentSchema.parse(process.env);
  await assertOutputMissing(config.DISCORD_E2E_READY_RECEIPT_OUTPUT);
  const actorRun = JSON.parse(await readFile(config.DISCORD_E2E_ACTOR_RUN_INPUT, "utf8")) as unknown;
  const deployment = new SshDeploymentEvidenceProbe({
    attestationFile: config.DISCORD_E2E_REMOTE_ATTESTATION_FILE,
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
  const provenance = await deployment.collectProvenance();
  const controller = new AbortController();
  const stop = (): void => controller.abort(new Error("Recording-ready collection interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const receipt = await waitForStableRecordingReadyReceipt({
    actorRun,
    clock: { nowEpochMs: () => Date.now() },
    delay: { wait: waitWithAbort },
    expectedRevisions: deploymentRevisionExpectationSchema.parse({
      craig: config.DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION,
      meetingPlatform: config.DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION,
      pipecat: config.DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION,
      subscriptionRuntime: config.DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION,
    }),
    policy: {
      pollIntervalMs: config.DISCORD_E2E_READY_RECEIPT_POLL_INTERVAL_MS,
      timeoutMs: config.DISCORD_E2E_READY_RECEIPT_TIMEOUT_MS,
    },
    probe: deployment,
    provenance,
    signal: controller.signal,
  });
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await writeCreateOnlyJson(config.DISCORD_E2E_READY_RECEIPT_OUTPUT, receipt);
  process.stdout.write(`${JSON.stringify({
    kind: "recording-ready-completion",
    outputPath: config.DISCORD_E2E_READY_RECEIPT_OUTPUT,
    recordingId: receipt.recordingId,
    runId: receipt.runId,
    status: "ready",
  })}\n`);
}

async function waitWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    const abort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => {
      if (signal.aborted) {
        abort();
      }
    });
  });
}

async function assertOutputMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new Error("Recording-ready receipt already exists and will not be replaced");
}

async function writeCreateOnlyJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let handle: FileHandle | undefined;
  let published = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await link(temporaryPath, path);
    published = true;
    await unlink(temporaryPath).catch(() => {});
  } catch (error) {
    await handle?.close();
    if (!published) {
      await unlink(temporaryPath).catch(() => {});
    }
    if (isErrno(error, "EEXIST")) {
      throw new Error("Recording-ready receipt already exists and will not be replaced", { cause: error });
    }
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown recording readiness failure";
  process.stderr.write(`Recording-ready receipt collection failed: ${message}\n`);
  process.exitCode = error instanceof EvidenceProbeInterruptedError ? error.exitCode : 1;
});
