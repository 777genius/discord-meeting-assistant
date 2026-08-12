import { spawn, type ChildProcess } from "node:child_process";

import type {
  BoundedContainerProcessPort,
  BoundedContainerProcessResult,
} from "./hosted-voicetext-canary-container-runner.js";
import { signalHostedChildTree, waitForHostedChildTreeExit } from "./hosted-campaign-process-tree.js";

const defaultTerminationGraceMs = 1_000;

type ExecuteRequest = Parameters<BoundedContainerProcessPort["execute"]>[0];

export interface BoundedContainerProcessAdapterOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly terminationGraceMs?: number;
}

/** Runs one fixed argv command with bounded output and POSIX process-tree cleanup. */
export class BoundedContainerProcessAdapter implements BoundedContainerProcessPort {
  readonly #environment: Readonly<Record<string, string>>;
  readonly #terminationGraceMs: number;

  public constructor(options?: BoundedContainerProcessAdapterOptions) {
    if (process.platform === "win32") {
      throw new Error("Bounded container process adapter requires POSIX process-group semantics");
    }
    this.#environment = options?.environment === undefined ? {} : { ...options.environment };
    this.#terminationGraceMs = options?.terminationGraceMs ?? defaultTerminationGraceMs;
    if (!Number.isSafeInteger(this.#terminationGraceMs) || this.#terminationGraceMs <= 0) {
      throw new Error("Bounded container process termination grace must be a positive integer");
    }
  }

  public async execute(request: ExecuteRequest): Promise<BoundedContainerProcessResult> {
    assertRequest(request);
    const child = spawn(request.executable, [...request.args], {
      detached: true,
      env: { ...this.#environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let termination = Promise.resolve();
    let terminating = false;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const terminate = (): Promise<void> => {
      if (!terminating) {
        terminating = true;
        termination = spawned.then(async () => terminateChildTree(child, this.#terminationGraceMs));
      }
      return termination;
    };

    const capture = (destination: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, request.maximumOutputBytes - capturedBytes);
      if (remaining > 0) {
        destination.push(chunk.subarray(0, remaining));
        capturedBytes += Math.min(chunk.byteLength, remaining);
      }
      if (chunk.byteLength > remaining) { void terminate().catch(() => {}); }
    };
    child.stdout.on("data", (chunk: Buffer) => { capture(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { capture(stderr, chunk); });

    const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (exitCode, signal) => { resolve({ exitCode, signal }); });
      },
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminate().catch(() => {});
    }, request.timeoutMs);
    timeout.unref();
    const abort = (): void => { void terminate().catch(() => {}); };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted === true) { abort(); }

    try {
      await spawned;
      const exit = await closed;
      await termination;
      return {
        ...exit,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        timedOut,
      };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
    }
  }
}

function assertRequest(request: ExecuteRequest): void {
  if (request.executable.length === 0 || request.executable.includes("\0")) {
    throw new Error("Bounded container process executable must be non-empty");
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new Error("Bounded container process timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(request.maximumOutputBytes) || request.maximumOutputBytes <= 0) {
    throw new Error("Bounded container process output cap must be a positive integer");
  }
}

async function terminateChildTree(child: ChildProcess, graceMs: number): Promise<void> {
  signalHostedChildTree(child, "SIGTERM");
  if (await waitForHostedChildTreeExit(child, graceMs)) { return; }
  signalHostedChildTree(child, "SIGKILL");
  if (!await waitForHostedChildTreeExit(child, graceMs)) {
    throw new Error("Bounded container process group survived SIGKILL");
  }
}
