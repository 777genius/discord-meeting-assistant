import {
  subscriptionRuntimeEngine,
  type JsonObject,
} from "@discord-meeting/subscription-runtime-adapter";

import { SubscriptionAccountPool } from "../src/subscription-account-pool.js";
import type { SubscriptionRuntimeExecutorOptions } from "../src/subscription-runtime-executor.js";
import type {
  InstallationIdentity,
  ProcessRunnerPort,
  ProcessRunResult,
} from "../src/types.js";
import { isolatedCwd, structuredOutput } from "./fixture.js";

type ExecutorTestOverrides = Omit<
  Partial<SubscriptionRuntimeExecutorOptions>,
  "processRunner"
> & {
  readonly processRunner?: Pick<ProcessRunnerPort, "run"> &
    Partial<Pick<ProcessRunnerPort, "runtimeEngine">>;
};

export function executorOptions(
  keyFile: string,
  override: ExecutorTestOverrides = {},
): SubscriptionRuntimeExecutorOptions {
  const { processRunner, ...otherOverrides } = override;
  return {
    accountPool: new SubscriptionAccountPool([{
      authJsonPath: "/private/auth.json",
      id: "slot-1",
      providerInstanceId: "discord-meeting-summary-v3",
    }]),
    childSourceEnvironment: {},
    installationInspector: { inspect: async () => installation() },
    isolatedCwd,
    killGraceMs: 50,
    localEncryptionKeyFile: keyFile,
    maxPromptBytes: 2 * 1024 * 1024,
    maxStderrBytes: 1024,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxTaskTimeoutMs: 600_000,
    processRunner:
      processRunner === undefined
        ? {
            run: async () => completedProcess(),
            runtimeEngine: subscriptionRuntimeEngine,
          }
        : {
            runtimeEngine:
              processRunner.runtimeEngine ?? subscriptionRuntimeEngine,
            run: processRunner.run,
          },
    readinessInspector: { inspect: async () => {} },
    stateRoot: "/private/state",
    ...otherOverrides,
  };
}

export function installation(): InstallationIdentity {
  return {
    executableRealpath: "/audited/runtime-launcher",
    launcherSha256: "a".repeat(64),
    packageManifestRealpath: "/audited/package/package.json",
    packageRootRealpath: "/audited/package",
    runtimePackageVersion: "0.1.0-main.27",
  };
}

export function completedProcess(
  telemetry: Record<string, unknown> = {
    usage: {
      cacheWriteInputTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 100,
      outputTokens: 20,
      reasoningOutputTokens: 0,
      totalTokens: 120,
    },
  },
  output: JsonObject = structuredOutput,
): ProcessRunResult {
  return {
    exitCode: 0,
    outputLimitExceeded: false,
    signal: null,
    stderr: "",
    stdout: JSON.stringify({
      outputText: JSON.stringify(output),
      protocolVersion: 1,
      status: "completed",
      structuredOutput: output,
      telemetry,
      warnings: [],
    }),
    timedOut: false,
  };
}

export function completedProcessWithoutTelemetry(
  output: JsonObject = structuredOutput,
): ProcessRunResult {
  const completed = completedProcess(undefined, output);
  return {
    ...completed,
    stdout: JSON.stringify({
      outputText: JSON.stringify(output),
      protocolVersion: 1,
      status: "completed",
      structuredOutput: output,
      warnings: [],
    }),
  };
}

export function failedProcess(
  telemetry?: Record<string, unknown>,
): ProcessRunResult {
  return {
    exitCode: 1,
    outputLimitExceeded: false,
    signal: null,
    stderr: "",
    stdout: JSON.stringify({
      failure: {
        code: "task_timeout",
        reconnectRequired: false,
        retryable: true,
      },
      protocolVersion: 1,
      status: "failed",
      ...(telemetry === undefined ? {} : { telemetry }),
      warnings: [],
    }),
    timedOut: false,
  };
}

export function codexJsonlTelemetry(input: {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}): Record<string, unknown> {
  return {
    source: "codex_exec_jsonl",
    cacheWriteInputTokens: { availability: "unavailable" },
    cachedInputTokens: {
      availability: "measured",
      value: input.cachedInputTokens,
    },
    inputTokens: { availability: "measured", value: input.inputTokens },
    outputTokens: { availability: "measured", value: input.outputTokens },
    reasoningOutputTokens: {
      availability: "measured",
      value: input.reasoningOutputTokens,
    },
    totalTokens: {
      availability: "derived",
      derivedFrom: ["inputTokens", "outputTokens"],
      value: input.inputTokens + input.outputTokens,
    },
  };
}
