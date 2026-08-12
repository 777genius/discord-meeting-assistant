import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

const maximumArtifactBytes = 32 * 1024 * 1024;

const absolutePath = z.string().startsWith("/");
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const sourceOutputName = z.enum(["clockAttestations", "database", "meetingPlatformLogs", "s3"]);

export const hostedServiceLevelSourceReportV1Schema = z.discriminatedUnion("status", [
  z.object({
    campaignId: identifier,
    code: z.enum(["CLOCK_PREFLIGHT_MISSING", "SOURCE_CAPTURE_FAILED"]),
    createdOutputs: z.array(sourceOutputName),
    meetingId: identifier,
    message: z.string().min(1),
    outputsCreated: z.literal(false),
    recordingId: identifier,
    reportPath: absolutePath,
    runId: identifier,
    schemaVersion: z.literal(1),
    status: z.literal("blocked"),
  }).strict(),
  z.object({
    campaignId: identifier,
    meetingId: identifier,
    outputs: z.object({
      clockAttestations: absolutePath,
      database: absolutePath,
      meetingPlatformLogs: absolutePath,
      s3: absolutePath,
    }).strict(),
    outputsCreated: z.literal(true),
    recordingId: identifier,
    reportPath: absolutePath,
    runId: identifier,
    schemaVersion: z.literal(1),
    status: z.literal("ready"),
  }).strict(),
]);

export async function readPrivateHostedServiceLevelArtifact(path: string): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    const pathStatus = await lstat(path, { bigint: false });
    assertPrivateRegularFile(pathStatus, path);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    assertPrivateRegularFile(before, path);
    if (before.dev !== pathStatus.dev || before.ino !== pathStatus.ino) {
      throw new Error(`Hosted service-level source changed before read: ${path}`);
    }
    if (before.size < 1 || before.size > maximumArtifactBytes) {
      throw new Error(`Hosted service-level source size is unsafe: ${path}`);
    }
    const bytes = new Uint8Array(before.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    const after = await handle.stat();
    if (
      bytesRead !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`Hosted service-level source changed while reading: ${path}`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await handle?.close();
  }
}

export async function writeCreateOnlyPrivateHostedServiceLevelArtifact(
  path: string,
  contents: string,
): Promise<void> {
  const size = Buffer.byteLength(contents, "utf8");
  if (size < 1 || size > maximumArtifactBytes) {
    throw new Error("Hosted service-level output size is unsafe");
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(await lstat(directory, { bigint: false }));
  const temporaryPath = `${path}.partial-${process.pid}-${Date.now()}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, path);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
  assertPrivateRegularFile(await lstat(path, { bigint: false }), path);
}

export async function privateHostedServiceLevelArtifactExists(path: string): Promise<boolean> {
  try {
    await lstat(path, { bigint: false });
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function assertPrivateDirectory(status: Stats): void {
  if (
    !status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0 ||
    typeof process.getuid === "function" && status.uid !== process.getuid()
  ) {
    throw new Error("Hosted service-level output directory must be a private owned directory");
  }
}

function assertPrivateRegularFile(
  status: Stats,
  path: string,
): void {
  if (
    status.isSymbolicLink() || !status.isFile() || (status.mode & 0o777) !== 0o600 ||
    typeof process.getuid === "function" && status.uid !== process.getuid()
  ) {
    throw new Error(`Expected a regular owned mode-0600 file: ${path}`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
