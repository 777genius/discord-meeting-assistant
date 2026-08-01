#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const profile = Object.freeze({
  model: "gpt-5.6-sol",
  outputKind: "structured_output",
  provider: "codex",
  purpose: "discord_meeting.summary.generate",
  reasoningEffort: "xhigh",
  responseFormat: "json",
});

const argv = process.argv.slice(2);
const provider = requiredArgument(argv, "--provider");
const inputPath = requiredArgument(argv, "--input");
const requestedModel = optionalArgument(argv, "--model");
const requestedReasoningEffort =
  process.env.AGENT_RUNTIME_REASONING_EFFORT?.trim();
const request = JSON.parse(await readFile(inputPath, "utf8"));
admitRequest({
  model: requestedModel,
  provider,
  reasoningEffort: requestedReasoningEffort,
  request,
});

const { FileBackendCodexWorker } = await import(
  "@vioxen/subscription-runtime/worker-codex"
);
const { runSubscriptionAgentTaskCli } = await import(
  "/opt/subscription-runtime/node_modules/@vioxen/subscription-runtime/dist/worker-local/agent-task-runner-cli.js"
);

const createStrictCodexWorker = (input) => {
  if (input.provider !== profile.provider) {
    throw new Error("Provider conflicts with the admitted meeting policy");
  }
  const model = input.model?.trim() || profile.model;
  if (model !== profile.model) {
    throw new Error("Model conflicts with the admitted meeting policy");
  }
  return new FileBackendCodexWorker({
    codexBinaryPath: input.codexBinaryPath ?? "codex",
    encryptionKey: input.encryptionKey,
    model,
    providerInstanceId: input.providerInstanceId,
    reasoningEffort: profile.reasoningEffort,
    sourceEnv: subscriptionOnlyEnvironment(input.env),
    stateRootDir: input.stateRootDir,
    workspacePath: input.cwd,
    ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
  });
};

process.exitCode = await runSubscriptionAgentTaskCli(
  withExactModel(argv, profile.model),
  undefined,
  createStrictCodexWorker,
);

function admitRequest(input) {
  const requestRecord = record(input.request, "request");
  const context = record(requestRecord.context, "request.context");
  const task = record(requestRecord.task, "request.task");
  const controls = record(task.controls, "request.task.controls");
  const metadata = record(task.metadata, "request.task.metadata");

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
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}
