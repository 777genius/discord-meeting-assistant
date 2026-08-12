import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

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
    while (true) {
      assertActive(bounded);
      try {
        const status = await lstat(path);
        if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o777) !== 0o600
          || status.size > MAX_ARTIFACT_BYTES) {
          throw new Error(`Unsafe hosted campaign action artifact: ${path}`);
        }
        const parsed = JSON.parse(await readFile(path, "utf8")) as ActionArtifact;
        if (parsed.campaignId !== this.#campaignId || JSON.stringify(parsed.action) !== JSON.stringify(action)
          || typeof parsed.evidence !== "object" || parsed.evidence === null) {
          throw new Error(`Hosted campaign action artifact correlation mismatch: ${path}`);
        }
        return parsed.evidence as HostedCampaignActionEvidence<Action>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await wait(POLL_MILLISECONDS, bounded.signal);
    }
  }

  async writeCreateOnly(path: string, value: unknown): Promise<void> {
    const handle = await open(
      path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export function actionFileName(action: HostedCampaignBarrierAction): string {
  const suffix = action.kind === "capture-retained" ? `-${action.ordinal}`
    : action.kind === "run-verified" ? `-${action.ordinal}-${action.runId}` : "";
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
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}
