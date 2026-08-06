import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import { captureBridgeOutput } from "./audited-codex-jsonl-bridge-output.mjs";
import {
  attachCodexJsonlTelemetry,
  codexExecJsonlCompatibilityAgentMessage,
  codexExecJsonlUsage,
  codexJsonlTelemetry,
  parseBridgeResultJson,
} from "./audited-codex-jsonl-events.mjs";
import {
  captureConfiguration,
  createCodexJsonlCapture as createCodexJsonlCaptureStore,
  isPinnedCodexTaskInvocation,
  persistCapturedUsage,
  readCapturedCodexUsage,
} from "./audited-codex-jsonl-capture-store.mjs";

export {
  attachCodexJsonlTelemetry,
  captureBridgeOutput,
  codexExecJsonlCompatibilityAgentMessage,
  codexExecJsonlUsage,
  codexJsonlTelemetry,
  isPinnedCodexTaskInvocation,
  parseBridgeResultJson,
  readCapturedCodexUsage,
};

/**
 * Called by the per-task executable shim. It forwards every byte from Codex
 * stdout while retaining only the final documented `turn.completed` usage.
 * A compatible legacy agent-message event is appended only for an admitted
 * pinned task invocation.
 */
export async function runCodexJsonlCapture(
  argv,
  configuration,
  environment = process.env,
) {
  const { model, reasoningEffort, target, usagePath } = captureConfiguration(configuration);
  const captureUsage = isPinnedCodexTaskInvocation(argv, model, reasoningEffort);
  await rm(usagePath, { force: true });
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let lastUsage;
  const inspectLine = (line, requiresLeadingNewline = false) => {
    const usage = captureUsage ? codexExecJsonlUsage(line) : undefined;
    if (usage !== undefined) {
      lastUsage = usage;
    }
    const compatibilityEvent = captureUsage
      ? codexExecJsonlCompatibilityAgentMessage(line)
      : undefined;
    if (compatibilityEvent !== undefined) {
      process.stdout.write(
        `${requiresLeadingNewline ? "\n" : ""}${JSON.stringify(compatibilityEvent)}\n`,
      );
    }
  };
  const observe = (text, flush = false) => {
    buffered += text;
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      inspectLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
    if (flush && buffered.length > 0) {
      inspectLine(buffered, true);
      buffered = "";
    }
  };
  const forward = (chunk) => {
    let start = 0;
    let newline;
    while ((newline = chunk.indexOf(0x0a, start)) !== -1) {
      const segment = chunk.subarray(start, newline + 1);
      process.stdout.write(segment);
      observe(decoder.write(segment));
      start = newline + 1;
    }
    if (start < chunk.length) {
      const segment = chunk.subarray(start);
      process.stdout.write(segment);
      observe(decoder.write(segment));
    }
  };
  const completion = await new Promise((resolve, reject) => {
    const child = spawn(target, argv, {
      env: environment,
      shell: false,
      stdio: ["inherit", "pipe", "inherit"],
    });
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      forward(chunk);
    });
    child.once("close", (code, signal) => {
      observe(decoder.end(), true);
      resolve({ code, signal });
    });
  });
  await persistCapturedUsage(captureUsage, lastUsage, usagePath);
  if (completion.signal !== null) {
    try {
      process.kill(process.pid, completion.signal);
    } catch {
      return 1;
    }
    return 1;
  }
  return completion.code ?? 1;
}

export async function createCodexJsonlCapture(stateRoot) {
  return await createCodexJsonlCaptureStore(stateRoot, import.meta.url);
}
