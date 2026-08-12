import { constants } from "node:fs";
import { lstat, open, watch } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { z } from "zod";

import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";

const maximumGateBytes = 16 * 1024;
const permissionMask = 0o777;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const targetSchema = z.object({
  guildId: z.literal(HOSTED_CAMPAIGN_TARGET.guildId),
  mutationTarget: z.literal(HOSTED_CAMPAIGN_TARGET.mutationTarget),
  voiceChannelId: z.literal(HOSTED_CAMPAIGN_TARGET.voiceChannelId),
}).strict();
const releaseGateSchema = z.object({
  campaignId: identifier,
  releasedAtEpochMs: z.number().int().safe().nonnegative(),
  runId: identifier,
  scenario: z.enum(["overlap", "sequential", "reconnect"]),
  schemaVersion: z.literal(1),
  target: targetSchema,
}).strict();

export interface ActorReleaseGateExpectation {
  readonly campaignId: string;
  readonly path: string;
  readonly runId: string;
  readonly scenario: "overlap" | "sequential" | "reconnect";
}

export interface ActorConnectionAdmission {
  readonly releaseGate: {
    readonly campaignId: string;
    readonly path: string;
    readonly runId: string;
    readonly timeoutMilliseconds: number;
  } | undefined;
  readonly scenario: "overlap" | "sequential" | "reconnect";
}

type ReleaseGateWaiter = (
  expected: ActorReleaseGateExpectation,
  signal: AbortSignal,
) => Promise<void>;

export async function connectActorsAfterReleaseGate<T>(
  admission: ActorConnectionAdmission,
  connect: () => Promise<T>,
  waitForRelease: ReleaseGateWaiter = waitForActorReleaseGate,
): Promise<T> {
  if (admission.releaseGate !== undefined) {
    await waitForRelease({
      campaignId: admission.releaseGate.campaignId,
      path: admission.releaseGate.path,
      runId: admission.releaseGate.runId,
      scenario: admission.scenario,
    }, AbortSignal.timeout(admission.releaseGate.timeoutMilliseconds));
  }
  return connect();
}

export async function waitForActorReleaseGate(
  expected: ActorReleaseGateExpectation,
  signal: AbortSignal,
): Promise<void> {
  const waitStartedAtEpochMs = Date.now();
  await assertGateDoesNotExist(expected.path);
  const changes = watch(dirname(expected.path), { signal });

  try {
    if (await tryReadValidGate(expected, waitStartedAtEpochMs)) {
      return;
    }
    for await (const change of changes) {
      if (change.filename === null || change.filename === basename(expected.path)) {
        if (await tryReadValidGate(expected, waitStartedAtEpochMs)) {
          return;
        }
      }
    }
  } catch (error: unknown) {
    if (signal.aborted) {
      throw new Error(`Timed out or aborted waiting for hosted actor release gate: ${expected.path}`, {
        cause: error,
      });
    }
    throw error;
  }
  throw new Error(`Hosted actor release gate watch ended before release: ${expected.path}`);
}

async function assertGateDoesNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new Error(`Hosted actor release gate must be create-only and absent before waiting: ${path}`);
}

async function tryReadValidGate(
  expected: ActorReleaseGateExpectation,
  waitStartedAtEpochMs: number,
): Promise<boolean> {
  let pathStatus;
  try {
    pathStatus = await lstat(expected.path);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  if (pathStatus.isSymbolicLink() || !pathStatus.isFile()) {
    throw new Error(`Hosted actor release gate must be a regular non-symlink file: ${expected.path}`);
  }
  if ((pathStatus.mode & permissionMask) !== 0o600) {
    throw new Error(`Hosted actor release gate must have mode 0600: ${expected.path}`);
  }
  if (typeof process.getuid === "function" && pathStatus.uid !== process.getuid()) {
    throw new Error(`Hosted actor release gate must be owned by the current user: ${expected.path}`);
  }
  if (pathStatus.size > maximumGateBytes) {
    throw new Error(`Hosted actor release gate exceeds ${maximumGateBytes} bytes: ${expected.path}`);
  }

  const handle = await open(
    expected.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const openedStatus = await handle.stat();
    if (openedStatus.dev !== pathStatus.dev || openedStatus.ino !== pathStatus.ino) {
      throw new Error(`Hosted actor release gate changed while opening: ${expected.path}`);
    }
    if (!openedStatus.isFile() || (openedStatus.mode & permissionMask) !== 0o600) {
      throw new Error(`Hosted actor release gate changed security metadata: ${expected.path}`);
    }
    if (typeof process.getuid === "function" && openedStatus.uid !== process.getuid()) {
      throw new Error(`Hosted actor release gate changed owner while opening: ${expected.path}`);
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const gate = releaseGateSchema.parse(JSON.parse(raw) as unknown);
    if (
      gate.campaignId !== expected.campaignId
      || gate.runId !== expected.runId
      || gate.scenario !== expected.scenario
    ) {
      throw new Error("Hosted actor release gate correlation does not match this actor run");
    }
    const readAtEpochMs = Date.now();
    if (gate.releasedAtEpochMs < waitStartedAtEpochMs || gate.releasedAtEpochMs > readAtEpochMs) {
      throw new Error("Hosted actor release gate is not fresh for this wait");
    }
    return true;
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
