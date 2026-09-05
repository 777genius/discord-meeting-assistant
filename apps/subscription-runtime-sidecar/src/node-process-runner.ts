import { spawn } from "node:child_process";

import { subscriptionRuntimeCliEngine } from "@discord-meeting/subscription-runtime-adapter";

import type {
  ProcessRunnerPort,
  ProcessRunRequest,
  ProcessRunResult,
} from "./types.js";

export class NodeProcessRunner implements ProcessRunnerPort {
  public readonly runtimeEngine = subscriptionRuntimeCliEngine;

  public async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    if (request.signal?.aborted === true) {
      return cancelledResult();
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        detached: process.platform !== "win32",
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputLimitExceeded = false;
      let cancelled = false;
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const terminate = (): void => {
        signalProcessTree(child.pid, child.kill.bind(child), "SIGTERM");
        killTimer ??= setTimeout(() => {
          signalProcessTree(child.pid, child.kill.bind(child), "SIGKILL");
        }, request.killGraceMs);
        killTimer.unref();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, request.timeoutMs);
      timeout.unref();
      const cancel = (): void => {
        cancelled = true;
        terminate();
      };
      request.signal?.addEventListener("abort", cancel, { once: true });
      if (request.signal?.aborted === true) {
        cancel();
      }

      child.stdout.on("data", (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const appended = appendBounded(
          stdout,
          stdoutBytes,
          chunk,
          request.maxStdoutBytes,
        );
        stdoutBytes = appended.bytes;
        if (appended.exceeded) {
          outputLimitExceeded = true;
          terminate();
        }
      });
      child.stderr.on("data", (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const appended = appendBounded(
          stderr,
          stderrBytes,
          chunk,
          request.maxStderrBytes,
        );
        stderrBytes = appended.bytes;
        if (appended.exceeded) {
          outputLimitExceeded = true;
          terminate();
        }
      });
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", cancel);
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", cancel);
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        resolve({
          exitCode,
          cancelled,
          outputLimitExceeded,
          signal,
          ...serviceTierEvidence(request.args),
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
          timedOut,
        });
      });
    });
  }
}

function serviceTierEvidence(
  args: readonly string[],
): { readonly serviceTier?: string } {
  const indexes = args.flatMap((value, index) =>
    value === "--service-tier" ? [index] : []);
  if (indexes.length === 0) {
    return {};
  }
  const values = indexes.map((index) => args[index + 1]);
  if (
    values.length !== 1 ||
    values[0] === undefined ||
    values[0].startsWith("--")
  ) {
    return {};
  }
  return { serviceTier: values[0] };
}

function cancelledResult(): ProcessRunResult {
  return {
    cancelled: true,
    exitCode: null,
    outputLimitExceeded: false,
    signal: null,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}

function appendBounded(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
  maximumBytes: number,
): { readonly bytes: number; readonly exceeded: boolean } {
  const remaining = Math.max(0, maximumBytes - currentBytes);
  if (remaining > 0) {
    chunks.push(chunk.subarray(0, remaining));
  }
  return {
    bytes: currentBytes + Math.min(chunk.length, remaining),
    exceeded: chunk.length > remaining,
  };
}

function signalProcessTree(
  pid: number | undefined,
  kill: (signal?: NodeJS.Signals | number) => boolean,
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform !== "win32" && pid !== undefined) {
      process.kill(-pid, signal);
      return;
    }
    kill(signal);
  } catch {
    try {
      kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}
