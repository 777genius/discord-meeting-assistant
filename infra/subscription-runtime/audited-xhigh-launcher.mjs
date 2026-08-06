#!/usr/bin/env node

import { accessSync, constants, realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  attachCodexJsonlTelemetry,
  captureBridgeOutput,
  createCodexJsonlCapture,
  parseBridgeResultJson,
  readCapturedCodexUsage,
} from "./audited-codex-jsonl-capture.mjs";
import {
  admitMeetingSummaryRequest,
  optionalArgument,
  requiredArgument,
  subscriptionRuntimeChildEnvironment,
  withExactModel,
} from "./audited-xhigh-policy.mjs";

export {
  attachCodexJsonlTelemetry,
  codexExecJsonlCompatibilityAgentMessage,
  codexExecJsonlUsage,
  codexJsonlTelemetry,
  isPinnedCodexTaskInvocation,
  parseBridgeResultJson,
  runCodexJsonlCapture,
} from "./audited-codex-jsonl-capture.mjs";
export { admitMeetingSummaryRequest } from "./audited-xhigh-policy.mjs";

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
  const profile = admitMeetingSummaryRequest({
    model: requestedModel,
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
    const createStrictCodexWorker = createStrictWorkerFactory({
      FileBackendCodexWorker,
      capture,
      profile,
    });
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

function createStrictWorkerFactory({ FileBackendCodexWorker, capture, profile }) {
  return (input) => {
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
    capture.configure(admittedCodexBinaryPath, profile);
    return new FileBackendCodexWorker({
      codexBinaryPath: capture.wrapperPath,
      encryptionKey: input.encryptionKey,
      executionEngine: "packaged-exec",
      model,
      providerInstanceId: input.providerInstanceId,
      reasoningEffort: profile.reasoningEffort,
      sourceEnv: subscriptionRuntimeChildEnvironment(input.env),
      stateRootDir: input.stateRootDir,
      workspacePath: input.cwd,
      ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
    });
  };
}

async function runtimeDependencies(overrides) {
  const workerModuleSpecifier = [
    "@vioxen",
    "subscription-runtime",
    "worker-codex",
  ].join("/");
  const runnerModuleSpecifier = [
    "/opt/subscription-runtime/node_modules",
    "@vioxen/subscription-runtime/dist/worker-local/agent-task-runner-cli.js",
  ].join("/");
  const FileBackendCodexWorker = overrides.FileBackendCodexWorker ?? (
    await import(workerModuleSpecifier)
  ).FileBackendCodexWorker;
  const runSubscriptionAgentTaskCli = overrides.runSubscriptionAgentTaskCli ?? (
    await import(runnerModuleSpecifier)
  ).runSubscriptionAgentTaskCli;
  return { FileBackendCodexWorker, runSubscriptionAgentTaskCli };
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
