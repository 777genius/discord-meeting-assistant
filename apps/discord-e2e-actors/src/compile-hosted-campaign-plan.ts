import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { buildResolvedHostedCampaignPlanV1 } from "./hosted-campaign-plan-builder.js";

const MAX_PRIVATE_INPUT_BYTES = 1024 * 1024;

export type HostedCampaignPlanCompilerArguments = Readonly<{
  bindingsPath: string;
  definitionPath: string;
  outputPath: string;
}>;

export function parseHostedCampaignPlanCompilerArguments(
  arguments_: readonly string[],
): HostedCampaignPlanCompilerArguments {
  const expected = ["--bindings", "--definition", "--output"] as const;
  if (arguments_.length !== expected.length * 2) {
    throw new Error("Expected --definition PATH --bindings PATH --output PATH");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || !expected.includes(name as typeof expected[number])
      || values.has(name) || !isAbsolute(value)) {
      throw new Error("Expected unique absolute --definition, --bindings, and --output paths");
    }
    values.set(name, value);
  }
  return Object.freeze({
    bindingsPath: values.get("--bindings")!,
    definitionPath: values.get("--definition")!,
    outputPath: values.get("--output")!,
  });
}

export async function readStablePrivateJson(path: string): Promise<unknown> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    assertPrivateInput(before);
    const contents = await handle.readFile("utf8");
    const after = await handle.stat();
    assertPrivateInput(after);
    if (!sameFileSnapshot(before, after) || Buffer.byteLength(contents, "utf8") !== before.size) {
      throw new Error("Private campaign compiler input changed while reading");
    }
    try {
      return JSON.parse(contents) as unknown;
    } catch {
      throw new Error("Private campaign compiler input is not valid JSON");
    }
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
}

export async function writeCreateOnlyPrivatePlan(path: string, value: unknown): Promise<void> {
  const parentPath = dirname(path);
  await mkdir(parentPath, { mode: 0o700, recursive: true });
  assertPrivateOutputDirectory(await lstat(parentPath));
  const temporaryPath = join(parentPath, `.${basename(path)}.partial-${randomUUID()}`);
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, path);
    await syncDirectory(parentPath);
  } finally {
    await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true });
    await syncDirectory(parentPath);
  }
}

export async function compileHostedCampaignPlanCli(arguments_: readonly string[]): Promise<void> {
  const config = parseHostedCampaignPlanCompilerArguments(arguments_);
  const [definition, bindings] = await Promise.all([
    readStablePrivateJson(config.definitionPath),
    readStablePrivateJson(config.bindingsPath),
  ]);
  const plan = buildResolvedHostedCampaignPlanV1(definition, bindings);
  await writeCreateOnlyPrivatePlan(config.outputPath, plan);
}

function assertPrivateInput(status: Stats): void {
  if (!status.isFile() || status.nlink !== 1 || (status.mode & 0o777) !== 0o600
    || status.size < 2 || status.size > MAX_PRIVATE_INPUT_BYTES) {
    throw new Error("Campaign compiler inputs must be single-link regular owned mode-0600 files of at most 1 MiB");
  }
  assertOwnedByCurrentUser(status, "Campaign compiler input");
}

function assertPrivateOutputDirectory(status: Stats): void {
  if (!status.isDirectory() || (status.mode & 0o777) !== 0o700) {
    throw new Error("Campaign compiler output parent must be a real mode-0700 directory");
  }
  assertOwnedByCurrentUser(status, "Campaign compiler output parent");
}

function assertOwnedByCurrentUser(status: Stats, description: string): void {
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`${description} must be owned by the current user`);
  }
}

function sameFileSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/compile-hosted-campaign-plan.js") === true) {
  void compileHostedCampaignPlanCli(process.argv.slice(2)).catch(() => {
    process.stderr.write("Hosted campaign plan compilation failed\n");
    process.exitCode = 1;
  });
}
