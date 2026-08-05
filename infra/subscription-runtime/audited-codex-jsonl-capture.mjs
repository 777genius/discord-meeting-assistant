import { spawn } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  isAdmittedCodexExecution,
  isRecord,
  isTokenCount,
  pinnedCodexTaskArgv,
} from "./audited-xhigh-policy.mjs";

const captureDirectoryPrefix = ".codex-jsonl-";
const staleCaptureAgeMs = 30 * 60 * 1000;
const processStartedAtMs = Math.max(
  0,
  Math.floor(Date.now() - process.uptime() * 1000),
);
const tokenNames = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
]);

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

async function persistCapturedUsage(captureUsage, lastUsage, usagePath) {
  if (!captureUsage || lastUsage === undefined) {
    return;
  }
  try {
    await writeFile(usagePath, JSON.stringify(lastUsage), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    // Missing telemetry remains unavailable; it never invalidates provider output.
  }
}

export function codexExecJsonlCompatibilityAgentMessage(line) {
  try {
    const event = JSON.parse(line);
    if (
      !isRecord(event) ||
      event.type !== "item.completed" ||
      !isRecord(event.item) ||
      event.item.type !== "agent_message" ||
      typeof event.item.text !== "string"
    ) {
      return;
    }
    return {
      type: "agent_message",
      role: "assistant",
      text: event.item.text,
    };
  } catch {
    return;
  }
}

export function codexExecJsonlUsage(line) {
  try {
    const event = JSON.parse(line);
    if (!isRecord(event) || event.type !== "turn.completed" || !isRecord(event.usage)) {
      return;
    }
    if (!tokenNames.every((name) => isTokenCount(event.usage[name]))) {
      return;
    }
    return {
      cachedInputTokens: event.usage.cached_input_tokens,
      inputTokens: event.usage.input_tokens,
      outputTokens: event.usage.output_tokens,
      reasoningOutputTokens: event.usage.reasoning_output_tokens,
    };
  } catch {
    return;
  }
}

export function attachCodexJsonlTelemetry(result, usage) {
  if (!isRecord(result)) {
    return;
  }
  const currentTelemetry = result.telemetry;
  if (currentTelemetry !== undefined && !isRecord(currentTelemetry)) {
    return;
  }
  if (isCompleteBridgeUsage(currentTelemetry?.usage)) {
    return result;
  }
  const telemetry = codexJsonlTelemetry(usage);
  if (telemetry === undefined) {
    return;
  }
  return {
    ...result,
    telemetry: {
      ...currentTelemetry,
      usage: telemetry,
    },
  };
}

export function parseBridgeResultJson(output) {
  try {
    const result = JSON.parse(output);
    if (!isRecord(result) || result.protocolVersion !== 1 || !Array.isArray(result.warnings)) {
      return;
    }
    if (result.status === "completed") {
      if (typeof result.outputText === "string" && isRecord(result.structuredOutput)) {
        return result;
      }
      return;
    }
    if (result.status === "failed" && isRecord(result.failure)) {
      return result;
    }
    return;
  } catch {
    return;
  }
}

export function codexJsonlTelemetry(usage) {
  if (
    !isRecord(usage) ||
    !isTokenCount(usage.inputTokens) ||
    !isTokenCount(usage.cachedInputTokens) ||
    !isTokenCount(usage.outputTokens) ||
    !isTokenCount(usage.reasoningOutputTokens)
  ) {
    return;
  }
  const totalTokens = usage.inputTokens + usage.outputTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    return;
  }
  return {
    source: "codex_exec_jsonl",
    cacheWriteInputTokens: { availability: "unavailable" },
    cachedInputTokens: {
      availability: "measured",
      value: usage.cachedInputTokens,
    },
    inputTokens: { availability: "measured", value: usage.inputTokens },
    outputTokens: { availability: "measured", value: usage.outputTokens },
    reasoningOutputTokens: {
      availability: "measured",
      value: usage.reasoningOutputTokens,
    },
    totalTokens: {
      availability: "derived",
      derivedFrom: ["inputTokens", "outputTokens"],
      value: totalTokens,
    },
  };
}

export async function createCodexJsonlCapture(stateRoot) {
  await removeStaleCodexJsonlCaptures(stateRoot);
  const root = await mkdtemp(
    join(stateRoot, `${captureDirectoryPrefix}${process.pid}-${processStartedAtMs}-`),
  );
  const usagePath = join(root, "usage.json");
  const wrapperPath = join(root, "codex-jsonl-capture.mjs");
  let configuredModel;
  let configuredTarget;
  let configuredReasoningEffort;
  return {
    configure: (target, profile) => {
      const verifiedTarget = realpathSync(target);
      const { model, reasoningEffort } = profile;
      if (configuredTarget !== undefined) {
        if (
          configuredTarget !== verifiedTarget ||
          configuredModel !== model ||
          configuredReasoningEffort !== reasoningEffort
        ) {
          throw new Error("Codex capture configuration changed after admission");
        }
        return;
      }
      writeFileSync(
        wrapperPath,
        [
          "#!/usr/bin/env node",
          `import { runCodexJsonlCapture } from ${JSON.stringify(import.meta.url)};`,
          `const configuration = Object.freeze(${JSON.stringify({
            model,
            reasoningEffort,
            target: verifiedTarget,
            usagePath,
          })});`,
          "process.exitCode = await runCodexJsonlCapture(process.argv.slice(2), configuration);",
          "",
        ].join("\n"),
        { encoding: "utf8", flag: "wx", mode: 0o700 },
      );
      configuredModel = model;
      configuredTarget = verifiedTarget;
      configuredReasoningEffort = reasoningEffort;
    },
    dispose: async () => rm(root, { force: true, recursive: true }),
    usagePath,
    wrapperPath,
  };
}

async function removeStaleCodexJsonlCaptures(stateRoot, nowMs = Date.now()) {
  let entries;
  try {
    entries = await readdir(stateRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      !entry.name.startsWith(captureDirectoryPrefix) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      continue;
    }
    const candidate = join(stateRoot, entry.name);
    try {
      const metadata = await lstat(candidate);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        nowMs - metadata.mtimeMs <= staleCaptureAgeMs ||
        captureOwnerIsAlive(entry.name)
      ) {
        continue;
      }
      await rm(candidate, { force: true, recursive: true });
    } catch {
      // Cleanup is best-effort and must not make a healthy runtime unavailable.
    }
  }
}

function captureOwnerIsAlive(name) {
  const match = /^\.codex-jsonl-(\d+)-(\d+)-/.exec(name);
  if (match === null) {
    return false;
  }
  const pid = Number(match[1]);
  const startedAtMs = Number(match[2]);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(startedAtMs) ||
    startedAtMs < 0
  ) {
    return false;
  }
  if (pid === process.pid) {
    return startedAtMs === processStartedAtMs;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function isPinnedCodexTaskInvocation(argv, model, reasoningEffort) {
  const expected = pinnedCodexTaskArgv(model, reasoningEffort);
  return (
    Array.isArray(argv) &&
    argv.length === expected.length &&
    argv.every((value, index) => value === expected[index])
  );
}

function captureConfiguration(value) {
  if (!isRecord(value)) {
    throw new Error("Codex capture configuration must be an object");
  }
  const { model, reasoningEffort, target, usagePath } = value;
  if (
    !isAdmittedCodexExecution(model, reasoningEffort) ||
    typeof target !== "string" ||
    !isAbsolute(target) ||
    typeof usagePath !== "string" ||
    !isAbsolute(usagePath)
  ) {
    throw new Error("Codex capture configuration paths must be absolute");
  }
  return { model, reasoningEffort, target, usagePath };
}

export async function readCapturedCodexUsage(usagePath) {
  try {
    const value = JSON.parse(await readFile(usagePath, "utf8"));
    if (isCodexUsage(value)) {
      return value;
    }
    return;
  } catch {
    return;
  }
}

function isCodexUsage(value) {
  return (
    isRecord(value) &&
    isTokenCount(value.inputTokens) &&
    isTokenCount(value.cachedInputTokens) &&
    isTokenCount(value.outputTokens) &&
    isTokenCount(value.reasoningOutputTokens)
  );
}

export async function captureBridgeOutput(run) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    chunks.push(toBuffer(chunk, encoding));
    const completion = typeof encoding === "function" ? encoding : callback;
    if (typeof completion === "function") {
      queueMicrotask(completion);
    }
    return true;
  };
  try {
    return {
      exitCode: await run(),
      output: Buffer.concat(chunks).toString("utf8"),
    };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8");
}

function isCompleteBridgeUsage(value) {
  if (!isRecord(value)) {
    return false;
  }
  const completeTokenNames = [
    "cacheWriteInputTokens",
    "cachedInputTokens",
    "inputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ];
  return completeTokenNames.every((name) => isTokenCount(value[name]));
}
