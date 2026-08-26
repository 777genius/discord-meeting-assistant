import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

import type {
  HostedCampaignActionEvidence,
  HostedCampaignBarrierAction,
  HostedCampaignBoundedSignal,
  HostedCampaignLeaseHandle,
} from "./hosted-campaign-coordinator.js";

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const POLL_MILLISECONDS = 25;

interface ActionArtifact {
  readonly action: HostedCampaignBarrierAction;
  readonly campaignId: string;
  readonly evidence: unknown;
}

export class HostedCampaignArtifactStore {
  readonly #campaignId: string;
  readonly #rootPath: string;

  constructor(rootPath: string, campaignId: string) {
    this.#rootPath = rootPath;
    this.#campaignId = campaignId;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#rootPath, { mode: 0o700 });
    await assertSafeRoot(this.#rootPath);
    await syncDirectory(dirname(this.#rootPath));
  }

  async initializeFreshCampaignLayout(controlFilePaths: readonly string[] = []): Promise<void> {
    if (basename(this.#rootPath) !== "barriers") {
      throw new Error("Hosted campaign barrier root must be named barriers");
    }
    const campaignRoot = dirname(this.#rootPath);
    let precreatedControlLayout: PrecreatedControlLayout | undefined;
    try {
      await mkdir(campaignRoot, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST" || controlFilePaths.length === 0) {
        throw error;
      }
      precreatedControlLayout = await inspectPrecreatedControlLayout(campaignRoot, controlFilePaths);
    }
    await assertSafeRoot(campaignRoot);
    await syncDirectory(dirname(campaignRoot));
    for (const path of [this.#rootPath, ...[1, 2, 3].map((ordinal) => join(campaignRoot, `run-${ordinal}`))]) {
      await mkdir(path, { mode: 0o700, recursive: true });
      await assertSafeRoot(path);
    }
    await syncDirectory(campaignRoot);
    if (precreatedControlLayout !== undefined) {
      await assertPrecreatedControlLayoutUnchanged(precreatedControlLayout);
    }
  }

  async acquireLease(bounded: HostedCampaignBoundedSignal): Promise<HostedCampaignLeaseHandle> {
    assertActive(bounded);
    await assertSafeRoot(this.#rootPath);
    const handle = await open(
      join(this.#rootPath, "campaign.lease"),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${this.#campaignId}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { campaignId: this.#campaignId } as HostedCampaignLeaseHandle;
  }

  async releaseLease(expected: HostedCampaignLeaseHandle): Promise<Readonly<{
    campaignId: string; campaignRoot: string; deleted: true; device: number; inode: number;
    leasePath: string; leaseSha256: string; planSha256: string;
  }>> {
    const leasePath = join(this.#rootPath, "campaign.lease");
    if (expected.campaignId !== this.#campaignId || expected.campaignRoot !== dirname(this.#rootPath)
      || expected.planSha256 !== this.#planSha256) {
      throw new Error("Hosted campaign lease cleanup handle does not match its exact path and plan");
    }
    const handle = await open(leasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      const contents = await handle.readFile();
      const after = await handle.stat();
      const digest = createHash("sha256").update(contents).digest("hex");
      if (!before.isFile() || before.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || after.dev !== expected.device || after.ino !== expected.inode || digest !== expected.leaseSha256) {
        throw new Error("Hosted campaign lease cleanup identity changed before deletion");
      }
      await rm(leasePath);
      const deleted = await handle.stat();
      if (deleted.dev !== expected.device || deleted.ino !== expected.inode || deleted.nlink !== 0) {
        throw new Error("Hosted campaign lease deletion did not unlink the exact opened identity");
      }
      try {
        await lstat(leasePath);
        throw new Error("Hosted campaign lease remained present after deletion");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") { throw error; }
      }
    } finally { await handle.close(); }
    await syncDirectory(this.#rootPath);
    return Object.freeze({ campaignId: expected.campaignId, campaignRoot: expected.campaignRoot,
      deleted: true as const, device: expected.device, inode: expected.inode, leasePath,
      leaseSha256: expected.leaseSha256, planSha256: expected.planSha256 });
  }

  async awaitAction<Action extends HostedCampaignBarrierAction>(
    action: Action,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignActionEvidence<Action>> {
    const path = join(this.#rootPath, actionFileName(action));
    for (;;) {
      assertActive(bounded);
      try {
        const parsed = await readActionArtifact(path);
        if (parsed.campaignId !== this.#campaignId || JSON.stringify(parsed.action) !== JSON.stringify(action)
          || typeof parsed.evidence !== "object" || parsed.evidence === null) {
          throw new Error(`Hosted campaign action artifact correlation mismatch: ${path}`);
        }
        return parsed.evidence as HostedCampaignActionEvidence<Action>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
          throw new Error(`Unsafe hosted campaign action artifact: ${path}`, { cause: error });
        }
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await wait(POLL_MILLISECONDS, bounded.signal);
    }
  }

  async writeCreateOnly(path: string, value: unknown): Promise<void> {
    const parentPath = dirname(path);
    await assertSafeRoot(parentPath);
    const temporaryPath = join(parentPath, `.${basename(path)}.partial-${randomUUID()}`);
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporaryPath, path);
      await syncDirectory(parentPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async publishAction<Action extends HostedCampaignBarrierAction>(
    action: Action,
    evidence: HostedCampaignActionEvidence<Action>,
  ): Promise<void> {
    await this.writeCreateOnly(join(this.#rootPath, actionFileName(action)), {
      action,
      campaignId: this.#campaignId,
      evidence,
    });
  }
}

interface PrecreatedControlLayout {
  readonly campaignRoot: string;
  readonly campaignRootStatus: Stats;
  readonly controlFilePaths: readonly string[];
  readonly controlFileStatuses: readonly Stats[];
  readonly controlPath: string;
  readonly controlStatus: Stats;
  readonly readinessPaths: readonly string[];
  readonly readinessStatuses: readonly Stats[];
}

async function inspectPrecreatedControlLayout(
  campaignRoot: string,
  controlFilePaths: readonly string[],
): Promise<PrecreatedControlLayout> {
  const controlPath = join(campaignRoot, "control");
  const normalizedPaths = controlFilePaths.map((path) => resolvePath(path));
  if (new Set(normalizedPaths).size !== normalizedPaths.length
    || normalizedPaths.some((path) => dirname(path) !== controlPath)) {
    throw new Error("Pre-created hosted campaign control files must be unique direct children of control");
  }
  const campaignRootStatus = await lstat(campaignRoot);
  await assertSafeRoot(campaignRoot);
  const rootEntries = (await readdir(campaignRoot)).toSorted();
  const hasReadinessRoot = JSON.stringify(rootEntries) === JSON.stringify(["control", "run-3"]);
  if (!hasReadinessRoot && JSON.stringify(rootEntries) !== JSON.stringify(["control"])) {
    throw new Error("Fresh hosted campaign root may contain only control and the pinned run-3 readiness roots");
  }
  const controlStatus = await lstat(controlPath);
  await assertSafeRoot(controlPath);
  const expectedNames = normalizedPaths.map((path) => basename(path)).toSorted();
  const actualNames = (await readdir(controlPath)).toSorted();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Hosted campaign control directory must contain exactly the declared private files");
  }
  const controlFileStatuses = await Promise.all(normalizedPaths.map(assertSafeControlFile));
  const readinessPaths = hasReadinessRoot
    ? [
        join(campaignRoot, "run-3"),
        join(campaignRoot, "run-3", "answer-handshakes"),
        join(campaignRoot, "run-3", "greeting-handshakes"),
      ]
    : [];
  if (hasReadinessRoot && JSON.stringify((await readdir(readinessPaths[0]!)).toSorted())
    !== JSON.stringify(["answer-handshakes", "greeting-handshakes"])) {
    throw new Error("Pre-created run-3 may contain only the pinned empty readiness roots");
  }
  const readinessStatuses = await Promise.all(readinessPaths.map(async (path) => {
    await assertSafeRoot(path);
    if ((await readdir(path)).length !== (path === readinessPaths[0] ? 2 : 0)) {
      throw new Error("Pre-created playback readiness roots must be empty");
    }
    return lstat(path);
  }));
  return Object.freeze({
    campaignRoot, campaignRootStatus, controlFilePaths: Object.freeze(normalizedPaths),
    controlFileStatuses: Object.freeze(controlFileStatuses), readinessPaths: Object.freeze(readinessPaths),
    readinessStatuses: Object.freeze(readinessStatuses),
    controlPath, controlStatus,
  });
}

async function assertPrecreatedControlLayoutUnchanged(layout: PrecreatedControlLayout): Promise<void> {
  const campaignRootStatus = await lstat(layout.campaignRoot);
  const controlStatus = await lstat(layout.controlPath);
  if (!sameFileIdentity(layout.campaignRootStatus, campaignRootStatus)
    || !sameFileIdentity(layout.controlStatus, controlStatus)) {
    throw new Error("Hosted campaign control layout changed during initialization");
  }
  await assertSafeRoot(layout.campaignRoot);
  await assertSafeRoot(layout.controlPath);
  const rootEntries = (await readdir(layout.campaignRoot)).toSorted();
  if (JSON.stringify(rootEntries) !== JSON.stringify(["barriers", "control", "run-1", "run-2", "run-3"])) {
    throw new Error("Hosted campaign root changed during initialization");
  }
  const expectedNames = layout.controlFilePaths.map((path) => basename(path)).toSorted();
  const actualNames = (await readdir(layout.controlPath)).toSorted();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Hosted campaign control layout changed during initialization");
  }
  const fileStatuses = await Promise.all(layout.controlFilePaths.map(assertSafeControlFile));
  if (fileStatuses.some((status, index) => !sameFileSnapshot(layout.controlFileStatuses[index]!, status))) {
    throw new Error("Hosted campaign control input changed during initialization");
  }
  const readinessStatuses = await Promise.all(layout.readinessPaths.map(async (path) => {
    await assertSafeRoot(path);
    return lstat(path);
  }));
  if (readinessStatuses.some((status, index) => !sameFileIdentity(layout.readinessStatuses[index]!, status))) {
    throw new Error("Hosted campaign readiness layout changed during initialization");
  }
}

async function assertSafeControlFile(path: string): Promise<Stats> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
      || before.size < 2 || before.size > MAX_ARTIFACT_BYTES) {
      throw new Error("Hosted campaign control input must be a single-link mode-0600 regular file");
    }
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      throw new Error("Hosted campaign control input must be owned by the current user");
    }
    const after = await handle.stat();
    if (!sameFileSnapshot(before, after)) {
      throw new Error("Hosted campaign control input changed during initialization");
    }
    return after;
  } finally {
    await handle?.close();
  }
}

function sameFileIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

function sameFileSnapshot(before: Stats, after: Stats): boolean {
  return sameFileIdentity(before, after) && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function readActionArtifact(path: string): Promise<ActionArtifact> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    assertSafeArtifact(before, path);
    const contents = await handle.readFile("utf8");
    const after = await handle.stat();
    assertSafeArtifact(after, path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || Buffer.byteLength(contents, "utf8") !== before.size) {
      throw new Error(`Hosted campaign action artifact changed while reading: ${path}`);
    }
    const value: unknown = JSON.parse(contents);
    if (!isActionArtifact(value)) {
      throw new Error(`Hosted campaign action artifact has an invalid envelope: ${path}`);
    }
    return value;
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
}

function assertSafeArtifact(status: Awaited<ReturnType<FileHandle["stat"]>> & { readonly mode: number }, path: string): void {
  if (!status.isFile() || (status.mode & 0o777) !== 0o600 || status.size < 2 || status.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`Unsafe hosted campaign action artifact: ${path}`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`Hosted campaign action artifact is not owned by the current user: ${path}`);
  }
}

function isActionArtifact(value: unknown): value is ActionArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3
    && Object.hasOwn(record, "action") && Object.hasOwn(record, "campaignId") && Object.hasOwn(record, "evidence")
    && typeof record.campaignId === "string"
    && typeof record.action === "object" && record.action !== null && !Array.isArray(record.action)
    && typeof record.evidence === "object" && record.evidence !== null && !Array.isArray(record.evidence);
}

export function actionFileName(action: HostedCampaignBarrierAction): string {
  const suffix = action.kind === "capture-retained" ? `-${action.ordinal}`
    : "ordinal" in action && "runId" in action ? `-${action.ordinal}-${action.runId}` : "";
  const name = `${action.kind}${suffix}.json`;
  if (!/^[a-z0-9][a-z0-9.-]{0,255}$/u.test(name)) {
    throw new Error("Hosted campaign action produces an unsafe artifact name");
  }
  return name;
}

async function assertSafeRoot(path: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory() || (status.mode & 0o777) !== 0o700) {
    throw new Error("Hosted campaign artifact root must be a real mode-0700 directory");
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error("Hosted campaign artifact root must be owned by the current user");
  }
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

function assertActive(bounded: HostedCampaignBoundedSignal): void {
  if (bounded.signal.aborted) {
    throw bounded.signal.reason ?? new Error("Hosted campaign cancelled");
  }
  if (Date.now() >= bounded.deadlineEpochMilliseconds) {
    throw new Error("Hosted campaign deadline expired");
  }
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Hosted campaign cancelled"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Hosted campaign cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
