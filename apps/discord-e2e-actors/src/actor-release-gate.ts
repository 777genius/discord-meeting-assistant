import { constants } from "node:fs";
import { link, lstat, open, rm, watch, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
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
  phase: z.enum(["connection", "speaker-b", "playback", "end"]),
  target: targetSchema,
}).strict();
const armedReceiptSchema = z.object({
  armedAtEpochMs: z.number().int().safe().nonnegative(), campaignId: identifier,
  phase: z.enum(["connection", "speaker-b", "playback", "end"]), runId: identifier,
  scenario: z.enum(["overlap", "sequential", "reconnect"]), schemaVersion: z.literal(1),
}).strict();

export interface ActorReleaseGateExpectation {
  readonly armedPath: string;
  readonly campaignId: string;
  readonly path: string;
  readonly runId: string;
  readonly scenario: "overlap" | "sequential" | "reconnect";
  readonly phase: "connection" | "speaker-b" | "playback" | "end";
}

export interface ActorConnectionAdmission {
  readonly releaseGate: {
    readonly campaignId: string;
    readonly armedPath: string;
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
      armedPath: admission.releaseGate.armedPath,
      campaignId: admission.releaseGate.campaignId,
      path: admission.releaseGate.path,
      runId: admission.releaseGate.runId,
      scenario: admission.scenario,
      phase: "connection",
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
  await publishArmedReceipt(expected, waitStartedAtEpochMs);
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
  assertGatePathMetadata(pathStatus, expected.path);

  const handle = await open(
    expected.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const raw = await readStablePrivateFile(handle, pathStatus, expected.path, "release gate");
    const gate = releaseGateSchema.parse(JSON.parse(raw) as unknown);
    assertGateCorrelation(gate, expected);
    assertGateFreshness(gate.releasedAtEpochMs, waitStartedAtEpochMs);
    return true;
  } finally {
    await handle.close();
  }
}

export async function waitForStagedActorGate(
  input: ActorConnectionAdmission,
  gate: { readonly armedPath: string; readonly path: string },
  phase: "speaker-b" | "playback" | "end",
): Promise<void> {
  if (input.releaseGate === undefined) {
    throw new Error(`Hosted ${phase} gate requires the correlated connection gate`);
  }
  await waitForActorReleaseGate({
    armedPath: gate.armedPath,
    campaignId: input.releaseGate.campaignId,
    path: gate.path,
    phase,
    runId: input.releaseGate.runId,
    scenario: input.scenario,
  }, AbortSignal.timeout(input.releaseGate.timeoutMilliseconds));
}

async function publishArmedReceipt(expected: ActorReleaseGateExpectation, armedAtEpochMs: number): Promise<void> {
  const temporaryPath = `${expected.armedPath}.partial-${randomUUID()}`;
  const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify({
        armedAtEpochMs, campaignId: expected.campaignId, phase: expected.phase,
        runId: expected.runId, scenario: expected.scenario, schemaVersion: 1,
      })}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await link(temporaryPath, expected.armedPath);
  } finally { await rm(temporaryPath, { force: true }); }
}

export async function waitForActorGateArmed(
  expected: ActorReleaseGateExpectation,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    if (signal.aborted) { throw new Error(`Timed out or aborted waiting for actor ${expected.phase} gate readiness`); }
    try {
      const status = await lstat(expected.armedPath);
      assertArmedReceiptMetadata(status, expected.armedPath);
      const handle = await open(expected.armedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const raw = await readStablePrivateFile(handle, status, expected.armedPath, "armed receipt");
        const receipt = armedReceiptSchema.parse(JSON.parse(raw) as unknown);
        assertArmedReceiptCorrelation(receipt, expected);
        return;
      } finally { await handle.close(); }
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) { throw error; }
    }
    await waitForRetry(signal, expected.phase);
  }
}

function assertGatePathMetadata(status: Stats, path: string): void {
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`Hosted actor release gate must be a regular non-symlink file: ${path}`);
  }
  assertPrivateOwner(status, path, "release gate");
  if (status.size > maximumGateBytes) {
    throw new Error(`Hosted actor release gate exceeds ${maximumGateBytes} bytes: ${path}`);
  }
}

function assertArmedReceiptMetadata(status: Stats, path: string): void {
  if (status.isSymbolicLink() || !status.isFile() || (status.mode & permissionMask) !== 0o600) {
    throw new Error(`Hosted actor armed receipt must be a private regular file: ${path}`);
  }
  assertPrivateOwner(status, path, "armed receipt");
  if (status.size < 2 || status.size > maximumGateBytes) {
    throw new Error(`Hosted actor armed receipt has an invalid size: ${path}`);
  }
}

function assertPrivateOwner(status: Stats, path: string, kind: "armed receipt" | "release gate"): void {
  if ((status.mode & permissionMask) !== 0o600) {
    throw new Error(`Hosted actor ${kind} must have mode 0600: ${path}`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`Hosted actor ${kind} must be owned by the current user: ${path}`);
  }
}

async function readStablePrivateFile(
  handle: FileHandle, pathStatus: Stats, path: string, kind: "armed receipt" | "release gate",
): Promise<string> {
  const opened = await handle.stat();
  assertSameFile(pathStatus, opened, path, kind);
  assertPrivateOwner(opened, path, kind);
  const raw = await handle.readFile("utf8");
  const after = await handle.stat();
  if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
    || Buffer.byteLength(raw, "utf8") !== opened.size) {
    throw new Error(`Hosted actor ${kind} changed while reading: ${path}`);
  }
  return raw;
}

function assertSameFile(pathStatus: Stats, opened: Stats, path: string, kind: string): void {
  if (opened.dev !== pathStatus.dev || opened.ino !== pathStatus.ino) {
    throw new Error(`Hosted actor ${kind} changed while opening: ${path}`);
  }
  if (!opened.isFile()) { throw new Error(`Hosted actor ${kind} changed security metadata: ${path}`); }
}

function assertGateCorrelation(gate: z.infer<typeof releaseGateSchema>, expected: ActorReleaseGateExpectation): void {
  if (gate.campaignId !== expected.campaignId || gate.runId !== expected.runId
    || gate.scenario !== expected.scenario || gate.phase !== expected.phase) {
    throw new Error("Hosted actor release gate correlation does not match this actor run");
  }
}

function assertGateFreshness(releasedAtEpochMs: number, waitStartedAtEpochMs: number): void {
  if (releasedAtEpochMs < waitStartedAtEpochMs || releasedAtEpochMs > Date.now()) {
    throw new Error("Hosted actor release gate is not fresh for this wait");
  }
}

function assertArmedReceiptCorrelation(
  receipt: z.infer<typeof armedReceiptSchema>, expected: ActorReleaseGateExpectation,
): void {
  if (receipt.campaignId !== expected.campaignId || receipt.runId !== expected.runId
    || receipt.scenario !== expected.scenario || receipt.phase !== expected.phase) {
    throw new Error("Hosted actor armed receipt correlation does not match the gate");
  }
}

async function waitForRetry(signal: AbortSignal, phase: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const finish = (): void => { cleanup(); resolve(); };
    const abort = (): void => { cleanup(); reject(new Error(`Timed out or aborted waiting for actor ${phase} gate readiness`)); };
    const timer = setTimeout(finish, 25);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
