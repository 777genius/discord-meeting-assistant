import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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

  async initializeFreshCampaignLayout(): Promise<void> {
    if (basename(this.#rootPath) !== "barriers") {
      throw new Error("Hosted campaign barrier root must be named barriers");
    }
    const campaignRoot = dirname(this.#rootPath);
    await mkdir(campaignRoot, { mode: 0o700 });
    await assertSafeRoot(campaignRoot);
    await syncDirectory(dirname(campaignRoot));
    for (const path of [this.#rootPath, ...[1, 2, 3].map((ordinal) => join(campaignRoot, `run-${ordinal}`))]) {
      await mkdir(path, { mode: 0o700 });
      await assertSafeRoot(path);
    }
    await syncDirectory(campaignRoot);
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

  async releaseLease(): Promise<void> {
    await rm(join(this.#rootPath, "campaign.lease"));
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
    await handle?.close();
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
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
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
