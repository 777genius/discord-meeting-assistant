import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, unlink, watch } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { z } from "zod";

import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";

const maximumGateBytes = 4 * 1024;
const maximumArmedReceiptAgeMilliseconds = 120_000;
const permissionMask = 0o777;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const phaseSchema = z.enum(["connection", "playback"]);
const gateSchema = z.object({
  campaignId: identifier,
  phase: phaseSchema,
  releasedAtEpochMs: z.number().int().nonnegative(),
  runId: identifier,
  schemaVersion: z.literal(1),
  target: z.object({
    guildId: z.literal(HOSTED_CAMPAIGN_TARGET.guildId),
    voiceChannelId: z.literal(HOSTED_CAMPAIGN_TARGET.voiceChannelId),
  }).strict(),
}).strict();
const armedReceiptSchema = z.object({
  armedAtEpochMs: z.number().int().nonnegative(),
  campaignId: identifier,
  gatePath: z.string().min(1),
  phase: phaseSchema,
  runId: identifier,
  schemaVersion: z.literal(1),
  target: z.object({
    guildId: z.literal(HOSTED_CAMPAIGN_TARGET.guildId),
    voiceChannelId: z.literal(HOSTED_CAMPAIGN_TARGET.voiceChannelId),
  }).strict(),
}).strict();

export interface SupplementalPlaybackGateExpectation {
  readonly armedPath: string;
  readonly campaignId: string;
  readonly guildId: string;
  readonly path: string;
  readonly phase: "connection" | "playback";
  readonly runId: string;
  readonly voiceChannelId: string;
}

export interface SupplementalPlaybackGate extends SupplementalPlaybackGateExpectation {
  readonly releasedAtEpochMs: number;
  readonly schemaVersion: 1;
}

type GateWaiter = (
  expected: SupplementalPlaybackGateExpectation,
  signal: AbortSignal,
) => Promise<void>;

export async function runSupplementalPlaybackAfterGates<Connection, Result>(
  input: {
    readonly connectionGate: SupplementalPlaybackGateExpectation;
    readonly connect: () => Promise<Connection>;
    readonly play: (connection: Connection) => Promise<Result>;
    readonly playbackGate: SupplementalPlaybackGateExpectation;
    readonly timeoutMilliseconds: number;
  },
  waitForGate: GateWaiter = waitForSupplementalPlaybackGate,
): Promise<Result> {
  await waitForGate(input.connectionGate, AbortSignal.timeout(input.timeoutMilliseconds));
  const connection = await input.connect();
  await waitForGate(input.playbackGate, AbortSignal.timeout(input.timeoutMilliseconds));
  return input.play(connection);
}

export async function waitForSupplementalPlaybackGate(
  expected: SupplementalPlaybackGateExpectation,
  signal: AbortSignal,
): Promise<void> {
  const waitStartedAtEpochMs = Date.now();
  await assertAbsent(expected.path);
  await publishArmedReceipt(expected, waitStartedAtEpochMs);
  const changes = watch(dirname(expected.path), { signal });
  try {
    if (await tryRead(expected, waitStartedAtEpochMs)) {return;}
    for await (const change of changes) {
      if ((change.filename === null || change.filename === basename(expected.path))
        && await tryRead(expected, waitStartedAtEpochMs)) {return;}
    }
  } catch (error: unknown) {
    if (signal.aborted) {
      throw new Error(`Timed out or aborted waiting for supplemental ${expected.phase} gate`, { cause: error });
    }
    throw error;
  }
  throw new Error(`Supplemental ${expected.phase} gate watch ended before release`);
}

async function publishArmedReceipt(
  expected: SupplementalPlaybackGateExpectation,
  armedAtEpochMs: number,
): Promise<void> {
  await mkdir(dirname(expected.armedPath), { mode: 0o700, recursive: true });
  const temporaryPath = `${expected.armedPath}.tmp-${randomUUID()}`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify({
      armedAtEpochMs,
      campaignId: expected.campaignId,
      gatePath: expected.path,
      phase: expected.phase,
      runId: expected.runId,
      schemaVersion: 1,
      target: { guildId: expected.guildId, voiceChannelId: expected.voiceChannelId },
    })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await link(temporaryPath, expected.armedPath);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
}

export async function waitForSupplementalGateArmed(
  expected: SupplementalPlaybackGateExpectation,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    if (signal.aborted) {
      throw new Error(`Timed out or aborted waiting for supplemental ${expected.phase} gate readiness`);
    }
    try {
      await readArmedReceipt(expected);
      return;
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) {throw error;}
    }
    await waitForRetry(signal, expected.phase);
  }
}

async function readArmedReceipt(expected: SupplementalPlaybackGateExpectation): Promise<void> {
  const status = await lstat(expected.armedPath);
  if (!isPrivateOwnedFile(status)) {
    throw new Error(`Unsafe supplemental ${expected.phase} armed receipt: ${expected.armedPath}`);
  }
  const handle = await open(expected.armedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== status.dev || opened.ino !== status.ino || !isPrivateOwnedFile(opened, false)) {
      throw new Error(`Supplemental ${expected.phase} armed receipt changed while opening`);
    }
    const receipt = armedReceiptSchema.parse(JSON.parse(await handle.readFile("utf8")) as unknown);
    if (receipt.campaignId !== expected.campaignId || receipt.runId !== expected.runId
      || receipt.phase !== expected.phase || receipt.gatePath !== expected.path
      || receipt.target.guildId !== expected.guildId
      || receipt.target.voiceChannelId !== expected.voiceChannelId) {
      throw new Error(`Supplemental ${expected.phase} armed receipt correlation mismatch`);
    }
    const readAtEpochMs = Date.now();
    if (receipt.armedAtEpochMs > readAtEpochMs
      || readAtEpochMs - receipt.armedAtEpochMs > maximumArmedReceiptAgeMilliseconds) {
      throw new Error(`Supplemental ${expected.phase} armed receipt is not fresh`);
    }
  } finally {
    await handle.close();
  }
}

function isPrivateOwnedFile(
  status: {
    readonly isFile: () => boolean;
    readonly isSymbolicLink: () => boolean;
    readonly mode: number;
    readonly size: number;
    readonly uid: number;
  },
  checkSize = true,
): boolean {
  return !status.isSymbolicLink() && status.isFile() && (status.mode & permissionMask) === 0o600
    && (!checkSize || status.size <= maximumGateBytes)
    && (typeof process.getuid !== "function" || status.uid === process.getuid());
}

async function waitForRetry(signal: AbortSignal, phase: "connection" | "playback"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, 25);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error(`Timed out or aborted waiting for supplemental ${phase} gate readiness`));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function writeSupplementalPlaybackGate(
  gate: SupplementalPlaybackGate,
): Promise<void> {
  const parsed = gateSchema.parse({
    campaignId: gate.campaignId,
    phase: gate.phase,
    releasedAtEpochMs: gate.releasedAtEpochMs,
    runId: gate.runId,
    schemaVersion: gate.schemaVersion,
    target: { guildId: gate.guildId, voiceChannelId: gate.voiceChannelId },
  });
  await mkdir(dirname(gate.path), { mode: 0o700, recursive: true });
  const temporaryPath = `${gate.path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await link(temporaryPath, gate.path);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {return;}
    throw error;
  }
  throw new Error(`Supplemental playback gate must be create-only and absent before waiting: ${path}`);
}

async function tryRead(
  expected: SupplementalPlaybackGateExpectation,
  waitStartedAtEpochMs: number,
): Promise<boolean> {
  let status;
  try {
    status = await lstat(expected.path);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {return false;}
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile() || (status.mode & permissionMask) !== 0o600
    || status.size > maximumGateBytes
    || (typeof process.getuid === "function" && status.uid !== process.getuid())) {
    throw new Error(`Unsafe supplemental ${expected.phase} gate: ${expected.path}`);
  }
  const handle = await open(expected.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (opened.dev !== status.dev || opened.ino !== status.ino || !opened.isFile()
      || (opened.mode & permissionMask) !== 0o600) {
      throw new Error(`Supplemental ${expected.phase} gate changed while opening`);
    }
    const parsed = gateSchema.parse(JSON.parse(await handle.readFile("utf8")) as unknown);
    if (parsed.campaignId !== expected.campaignId || parsed.runId !== expected.runId
      || parsed.phase !== expected.phase || parsed.target.guildId !== expected.guildId
      || parsed.target.voiceChannelId !== expected.voiceChannelId) {
      throw new Error(`Supplemental ${expected.phase} gate correlation mismatch`);
    }
    const readAtEpochMs = Date.now();
    if (parsed.releasedAtEpochMs < waitStartedAtEpochMs || parsed.releasedAtEpochMs > readAtEpochMs) {
      throw new Error(`Supplemental ${expected.phase} gate is not fresh for this wait`);
    }
    return true;
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
