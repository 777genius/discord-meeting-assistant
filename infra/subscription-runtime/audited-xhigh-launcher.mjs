#!/usr/bin/env node

import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const profiles = Object.freeze({
  "discord_meeting.summary.generate": Object.freeze({
    model: "gpt-5.6-luna",
    outputKind: "structured_output",
    provider: "codex",
    purpose: "discord_meeting.summary.generate",
    reasoningEffort: "medium",
    responseFormat: "json",
  }),
  "discord_meeting.summary.incremental": Object.freeze({
    model: "gpt-5.6-luna",
    outputKind: "structured_output",
    provider: "codex",
    purpose: "discord_meeting.summary.incremental",
    reasoningEffort: "medium",
    responseFormat: "json",
  }),
});

const tokenNames = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
]);

/**
 * Runs the private bridge while preserving its existing worker policy. The
 * injected executable is only a transparent Codex JSONL observer; it does not
 * construct a second client or take custody of auth material.
 */
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const provider = requiredArgument(argv, "--provider");
  const inputPath = requiredArgument(argv, "--input");
  const stateRoot = requiredArgument(argv, "--state-root");
  const requestedModel = optionalArgument(argv, "--model");
  const requestedReasoningEffort =
    process.env.AGENT_RUNTIME_REASONING_EFFORT?.trim();
  const request = JSON.parse(await readFile(inputPath, "utf8"));
  const profile = profileForRequest(request);
  admitRequest({
    model: requestedModel,
    profile,
    provider,
    reasoningEffort: requestedReasoningEffort,
    request,
  });

  const { FileBackendCodexWorker, runSubscriptionAgentTaskCli } =
    await runtimeDependencies(dependencies);
  const capture = await (dependencies.createCodexJsonlCapture ?? createCodexJsonlCapture)(
    stateRoot,
  );
  try {
    const createStrictCodexWorker = (input) => {
      if (input.provider !== profile.provider) {
        throw new Error("Provider conflicts with the admitted meeting policy");
      }
      const model = input.model?.trim() || profile.model;
      if (model !== profile.model) {
        throw new Error("Model conflicts with the admitted meeting policy");
      }
      const admittedCodexBinaryPath = resolveAdmittedExecutable(
        input.codexBinaryPath,
        input.env,
      );
      return new FileBackendCodexWorker({
        // The wrapper delegates only to the admitted Codex executable and passes
        // stdout through unchanged, so the private worker retains its tool and
        // auth-custody controls.
        codexBinaryPath: capture.wrapperPath,
        encryptionKey: input.encryptionKey,
        model,
        providerInstanceId: input.providerInstanceId,
        reasoningEffort: profile.reasoningEffort,
        sourceEnv: {
          ...subscriptionOnlyEnvironment(input.env),
          SUBSCRIPTION_RUNTIME_CODEX_CAPTURE_PATH: capture.usagePath,
          SUBSCRIPTION_RUNTIME_CODEX_CAPTURE_TARGET: admittedCodexBinaryPath,
        },
        stateRootDir: input.stateRootDir,
        workspacePath: input.cwd,
        ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
      });
    };

    const bridge = await captureBridgeOutput(() =>
      runSubscriptionAgentTaskCli(
        withExactModel(argv, profile.model),
        undefined,
        createStrictCodexWorker,
      ),
    );
    const bridgeResult = parseBridgeResultJson(bridge.output);
    if (bridgeResult === undefined) {
      throw new Error("Subscription runtime bridge did not return one valid result JSON object");
    }
    const codexUsage = await readCapturedCodexUsage(capture.usagePath);
    const enriched = codexUsage === undefined
      ? bridgeResult
      : attachCodexJsonlTelemetry(bridgeResult, codexUsage);
    if (enriched === undefined) {
      throw new Error("Subscription runtime bridge telemetry could not be normalized");
    }
    process.stdout.write(`${JSON.stringify(enriched)}\n`);
    return bridge.exitCode;
  } finally {
    await capture.dispose();
  }
}

async function runtimeDependencies(overrides) {
  const FileBackendCodexWorker = overrides.FileBackendCodexWorker ?? (
    await import("@vioxen/subscription-runtime/worker-codex")
  ).FileBackendCodexWorker;
  const runSubscriptionAgentTaskCli = overrides.runSubscriptionAgentTaskCli ?? (
    await import(
      "/opt/subscription-runtime/node_modules/@vioxen/subscription-runtime/dist/worker-local/agent-task-runner-cli.js"
    )
  ).runSubscriptionAgentTaskCli;
  return { FileBackendCodexWorker, runSubscriptionAgentTaskCli };
}

/**
 * Called by the per-task executable shim. It forwards every byte from Codex
 * stdout while retaining only the final documented `turn.completed` usage.
 */
export async function runCodexJsonlCapture(argv, environment = process.env) {
  const target = requiredEnvironment(
    environment,
    "SUBSCRIPTION_RUNTIME_CODEX_CAPTURE_TARGET",
  );
  const usagePath = requiredEnvironment(
    environment,
    "SUBSCRIPTION_RUNTIME_CODEX_CAPTURE_PATH",
  );
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let lastUsage;
  const observe = (text, flush = false) => {
    buffered += text;
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const usage = codexExecJsonlUsage(buffered.slice(0, newline));
      if (usage !== undefined) {
        lastUsage = usage;
      }
      buffered = buffered.slice(newline + 1);
    }
    if (flush && buffered.length > 0) {
      const usage = codexExecJsonlUsage(buffered);
      if (usage !== undefined) {
        lastUsage = usage;
      }
      buffered = "";
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
      process.stdout.write(chunk);
      observe(decoder.write(chunk));
    });
    child.once("close", (code, signal) => {
      observe(decoder.end(), true);
      resolve({ code, signal });
    });
  });
  if (lastUsage !== undefined) {
    try {
      await writeFile(usagePath, JSON.stringify(lastUsage), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      // The provider result remains valid; the absence of this file is reported
      // as unavailable telemetry rather than a synthetic token value.
    }
  }
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

/**
 * Parses the public `codex exec --json` turn completion event. Codex 0.143
 * reports exactly these four measured fields; cache-write input is not present.
 */
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

/**
 * Keeps the bridge's duration/finish-reason telemetry while adding the
 * normalized Codex JSONL contract. A complete bridge usage remains preferred.
 */
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
    if (result.status === "failed") {
      if (isRecord(result.failure)) {
        return result;
      }
      return;
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

async function createCodexJsonlCapture(stateRoot) {
  const root = await mkdtemp(join(stateRoot, ".codex-jsonl-"));
  const usagePath = join(root, "usage.json");
  const wrapperPath = join(root, "codex-jsonl-capture.mjs");
  await writeFile(
    wrapperPath,
    [
      "#!/usr/bin/env node",
      `import { runCodexJsonlCapture } from ${JSON.stringify(import.meta.url)};`,
      "process.exitCode = await runCodexJsonlCapture(process.argv.slice(2));",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  return {
    dispose: async () => rm(root, { force: true, recursive: true }),
    usagePath,
    wrapperPath,
  };
}

async function readCapturedCodexUsage(usagePath) {
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

async function captureBridgeOutput(run) {
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

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function admitRequest(input) {
  const requestRecord = record(input.request, "request");
  const context = record(requestRecord.context, "request.context");
  const task = record(requestRecord.task, "request.task");
  const controls = record(task.controls, "request.task.controls");
  const metadata = record(task.metadata, "request.task.metadata");

  const { profile } = input;
  assertExact(context.purpose, profile.purpose, "purpose");
  assertExact(input.provider, profile.provider, "provider");
  assertExact(input.model, profile.model, "CLI model");
  assertExact(input.reasoningEffort, profile.reasoningEffort, "runtime reasoning effort");
  assertExact(controls.model, profile.model, "controls.model");
  assertExact(controls.reasoningEffort, profile.reasoningEffort, "controls.reasoningEffort");
  assertExact(controls.responseFormat, profile.responseFormat, "controls.responseFormat");
  assertExact(controls.selectedOutputKind, profile.outputKind, "controls.selectedOutputKind");
  assertExact(metadata.model, profile.model, "metadata.model");
  assertExact(metadata.reasoningEffort, profile.reasoningEffort, "metadata.reasoningEffort");
  assertExact(metadata.runtimeOutput, profile.outputKind, "metadata.runtimeOutput");
  if (controls.disableTools !== true || controls.interactive !== false) {
    throw new Error("Interactive or tool-enabled execution is not admitted");
  }
  record(controls.outputSchema, "request.task.controls.outputSchema");
}

function profileForRequest(requestValue) {
  const requestRecord = record(requestValue, "request");
  const context = record(requestRecord.context, "request.context");
  const purpose = typeof context.purpose === "string" ? context.purpose.trim() : "";
  const selected = profiles[purpose];
  if (selected === undefined) {
    throw new Error("Purpose conflicts with the admitted meeting policy");
  }
  return selected;
}

function subscriptionOnlyEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.toUpperCase().endsWith("_API_KEY") &&
        !key.toUpperCase().endsWith("_API_KEY_FILE"),
    ),
  );
}

function resolveAdmittedExecutable(configuredValue, environment) {
  const configured = typeof configuredValue === "string" && configuredValue.trim().length > 0
    ? configuredValue.trim()
    : "codex";
  const candidates = isAbsolute(configured)
    ? [configured]
    : configured.includes("/") || configured.includes("\\")
      ? []
      : String(environment?.PATH ?? process.env.PATH ?? "")
        .split(delimiter)
        .filter((entry) => entry.length > 0)
        .map((entry) => join(entry, configured));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue until the exact configured executable is resolved.
    }
  }
  throw new Error("The admitted Codex executable could not be resolved");
}

function withExactModel(args, model) {
  return optionalArgument(args, "--model") === undefined
    ? [...args, "--model", model]
    : args;
}

function requiredArgument(args, name) {
  const value = optionalArgument(args, name);
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalArgument(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      values.push(value);
      index += 1;
    }
  }
  if (new Set(values).size > 1) {
    throw new Error(`${name} contains conflicting values`);
  }
  return values[0];
}

function assertExact(value, expected, label) {
  if (typeof value !== "string" || value.trim() !== expected) {
    throw new Error(`${label} conflicts with the admitted meeting policy`);
  }
}

function record(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTokenCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function isInvokedDirectly() {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }
  try {
    const [invokedRealpath, moduleRealpath] = await Promise.all([
      realpath(invokedPath),
      realpath(fileURLToPath(import.meta.url)),
    ]);
    return invokedRealpath === moduleRealpath;
  } catch {
    return false;
  }
}

if (await isInvokedDirectly()) {
  try {
    process.exitCode = await main();
  } catch {
    process.stderr.write("Subscription runtime launcher failed\n");
    process.exitCode = 1;
  }
}
