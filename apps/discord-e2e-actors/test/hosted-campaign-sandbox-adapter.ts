import { constants } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { writeCreateOnlyBarrier } from "../src/campaign-barrier.js";
import type {
  HostedCampaignActionEvidence,
  HostedCampaignBarrierAction,
  HostedCampaignBoundedSignal,
  HostedCampaignChildHandle,
  HostedCampaignExecutableSpec,
  HostedCampaignLeaseHandle,
  HostedCampaignPorts,
} from "../src/hosted-campaign-coordinator.js";

interface SandboxRunFile {
  readonly outputPath: string;
  readonly sourcePath: string;
}

export interface SandboxAdapterOptions {
  readonly fixturePath: string;
  readonly rootPath: string;
  readonly runFiles: readonly [SandboxRunFile, SandboxRunFile, SandboxRunFile];
  readonly verifyCampaign: (outputs: readonly unknown[]) => boolean;
}

interface ChildState {
  readonly child: ChildProcess;
  exited: boolean;
}

const POLL_MILLISECONDS = 5;

export class HostedCampaignSandboxAdapter implements HostedCampaignPorts {
  readonly actionLog: string[] = [];
  readonly stoppedChildren: string[] = [];
  readonly #children = new Map<string, ChildState>();
  readonly #options: SandboxAdapterOptions;
  #commandOrdinal = 0;
  #leasePath: string | undefined;

  constructor(options: SandboxAdapterOptions) {
    this.#options = options;
  }

  async acquireCampaignLease(
    campaignId: string,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignLeaseHandle> {
    this.#assertActive(bounded);
    const leasePath = join(this.#options.rootPath, "campaign-lease");
    const handle = await open(
      leasePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${campaignId}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#leasePath = leasePath;
    return { campaignId } as HostedCampaignLeaseHandle;
  }

  async releaseCampaignLease(): Promise<void> {
    if (this.#leasePath !== undefined) {
      await rm(this.#leasePath);
      this.#leasePath = undefined;
    }
  }

  async startChild(
    executable: HostedCampaignExecutableSpec,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignChildHandle> {
    this.#assertActive(bounded);
    const behavior = executable.environment.FIXTURE_BEHAVIOR ?? "ack";
    if (!new Set(["ack", "exit", "hang"]).has(behavior)) {
      throw new Error(`Unsupported sandbox fixture behavior: ${behavior}`);
    }
    const child = spawn(
      process.execPath,
      [this.#options.fixturePath, this.#options.rootPath, executable.childId, behavior],
      { env: {}, stdio: "ignore" },
    );
    const state: ChildState = { child, exited: false };
    child.once("exit", () => { state.exited = true; });
    this.#children.set(executable.childId, state);
    try {
      await this.#waitForPath(join(this.#options.rootPath, `ready-${executable.childId}`), state, bounded);
    } catch (error) {
      await this.stopChild({ childId: executable.childId } as HostedCampaignChildHandle);
      throw error;
    }
    return { childId: executable.childId } as HostedCampaignChildHandle;
  }

  async stopChild(handle: HostedCampaignChildHandle): Promise<void> {
    const state = this.#children.get(handle.childId);
    if (state === undefined) {
      return;
    }
    if (!state.exited) {
      state.child.kill("SIGTERM");
      await this.#waitForExit(state);
    }
    this.stoppedChildren.push(handle.childId);
    this.#children.delete(handle.childId);
  }

  async awaitBarrier<Action extends HostedCampaignBarrierAction>(
    action: Action,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<HostedCampaignActionEvidence<Action>> {
    const targetChild = this.#targetChild(action);
    const runFile = action.kind === "run-verified" ? this.#options.runFiles[action.ordinal - 1] : undefined;
    await this.#send(targetChild, action, runFile, bounded);
    this.actionLog.push(this.#actionLabel(action));

    if (action.kind === "campaign-verified") {
      const outputs = await Promise.all(this.#options.runFiles.map(async ({ outputPath }) =>
        JSON.parse(await readFile(outputPath, "utf8")) as unknown
      ));
      if (!this.#options.verifyCampaign(outputs)) {
        throw new Error("Sandbox campaign verifier rejected outputs");
      }
    }
    return this.#evidence(action) as HostedCampaignActionEvidence<Action>;
  }

  async #send(
    childId: string,
    action: HostedCampaignBarrierAction,
    runFile: SandboxRunFile | undefined,
    bounded: HostedCampaignBoundedSignal,
  ): Promise<void> {
    this.#assertActive(bounded);
    const state = this.#children.get(childId);
    if (state === undefined) {
      throw new Error(`Sandbox child is not running: ${childId}`);
    }
    const prefix = `c${String(++this.#commandOrdinal).padStart(6, "0")}-${childId}`;
    const command = {
      action: this.#actionLabel(action),
      ...(runFile === undefined ? {} : runFile),
    };
    await writeCreateOnlyBarrier(this.#options.rootPath, `${prefix}-command`, JSON.stringify(command));
    await this.#waitForPath(join(this.#options.rootPath, `${prefix}-ack`), state, bounded);
  }

  #targetChild(action: HostedCampaignBarrierAction): string {
    if (action.kind === "observer-subscribed" || action.kind.startsWith("provenance")
      || action.kind === "campaign-verified" || action.kind === "answer-observer-ready"
      || action.kind === "answer-first-packet") {
      return "observer";
    }
    if (action.kind === "run-verified") {
      return action.ordinal === 1 ? "speaker-a" : action.ordinal === 2 ? "speaker-b" : "observer";
    }
    if (action.kind === "capture-retained") {
      return action.ordinal % 2 === 1 ? "speaker-a" : "speaker-b";
    }
    return "speaker-b";
  }

  #actionLabel(action: HostedCampaignBarrierAction): string {
    if (action.kind === "run-verified") {
      return `${action.kind}:${action.ordinal}:${action.runId}`;
    }
    if (action.kind === "capture-retained") {
      return `${action.kind}:${action.ordinal}`;
    }
    return action.kind;
  }

  #evidence(action: HostedCampaignBarrierAction): unknown {
    if (action.kind === "capture-retained") {
      return {
        ordinal: action.ordinal,
        outputPath: join(this.#options.rootPath, `capture-${action.ordinal}.json`),
        retained: true,
      };
    }
    if (action.kind === "run-verified") {
      return { ordinal: action.ordinal, runId: action.runId, verified: true };
    }
    if (action.kind === "observer-subscribed") {
      return { authenticatedObserverBotId: "sandbox-observer" };
    }
    if (action.kind === "reconnect-left" || action.kind === "reconnect-ready") {
      return { observedAtEpochMilliseconds: this.#commandOrdinal, participantId: "sandbox-speaker-b" };
    }
    if (action.kind === "answer-intent" || action.kind === "answer-observer-ready") {
      return { observedAtEpochMilliseconds: this.#commandOrdinal, turnId: "sandbox-turn" };
    }
    if (action.kind === "answer-first-packet") {
      return {
        answerLatencyMilliseconds: 1,
        observedAtEpochMilliseconds: this.#commandOrdinal,
        turnId: "sandbox-turn",
      };
    }
    if (action.kind === "campaign-verified") {
      return { campaignId: "campaign-sandbox" };
    }
    return { digestSha256: "a".repeat(64) };
  }

  async #waitForPath(path: string, state: ChildState, bounded: HostedCampaignBoundedSignal): Promise<void> {
    while (true) {
      this.#assertActive(bounded);
      if (state.exited) {
        throw new Error("Sandbox fixture child exited before acknowledgement");
      }
      try {
        const status = await lstat(path);
        if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o600) {
          throw new Error(`Unsafe sandbox barrier: ${path}`);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await new Promise((resolve) => { setTimeout(resolve, POLL_MILLISECONDS); });
    }
  }

  async #waitForExit(state: ChildState): Promise<void> {
    if (state.exited) {
      return;
    }
    await new Promise<void>((resolve) => { state.child.once("exit", () => resolve()); });
  }

  #assertActive(bounded: HostedCampaignBoundedSignal): void {
    if (bounded.signal.aborted) {
      throw bounded.signal.reason ?? new Error("Sandbox campaign aborted");
    }
    if (Date.now() >= bounded.deadlineEpochMilliseconds) {
      throw new Error("Sandbox campaign deadline expired");
    }
  }
}
