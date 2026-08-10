import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  subscriptionRuntimeEngine,
} from "@discord-meeting/subscription-runtime-adapter";
import { afterEach, describe, expect, it } from "vitest";

import { SubscriptionAccountPool } from "../src/subscription-account-pool.js";
import {
  SubscriptionRuntimeExecutor,
  type SubscriptionRuntimeExecutorOptions,
} from "../src/subscription-runtime-executor.js";
import type {
  ProcessRunnerPort,
  ProcessRunRequest,
  ProcessRunResult,
  StreamingProcessRunnerPort,
} from "../src/types.js";
import {
  canonicalRequest,
  conversationCanonicalRequest,
  conversationStructuredOutput,
  isolatedCwd,
} from "./fixture.js";
import {
  completedProcess,
  completedProcessWithoutTelemetry,
  installation,
} from "./executor-test-support.js";

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) {
    await rm(root, { force: true, recursive: true });
  }
  root = undefined;
});

describe("subscription runtime account failover", () => {
  it("moves a quota-limited request to the next host-pool slot", async () => {
    const providerInstances: string[] = [];
    const executor = await createExecutor({
      processRunner: runner(async (request) => {
        providerInstances.push(argumentValue(request, "--provider-instance"));
        return providerInstances.length === 1
          ? failedProcess("quota_limited")
          : completedProcess();
      }),
    });

    await expect(executor.execute(canonicalRequest)).resolves.toMatchObject({
      status: "completed",
    });
    expect(providerInstances).toEqual([
      "discord-meeting-summary-v3",
      "discord-meeting-summary-v3-slot-2",
    ]);
  });

  it("does not replay a streamed answer after text reached the caller", async () => {
    let runs = 0;
    const streamingRunner: StreamingProcessRunnerPort = {
      ...runner(async () => {
        throw new Error("unary runner was not expected");
      }),
      runStreaming: async (_request, observer) => {
        runs += 1;
        await observer.onProviderTaskStarted();
        observer.onProviderTextDelta('{"answer":"partial');
        return failedProcess("quota_limited");
      },
    };
    const executor = await createExecutor({
      conversationProcessRunner: streamingRunner,
      conversationStreamingProcessRunner: streamingRunner,
    });
    const deltas: string[] = [];

    await expect(executor.executeStreaming(
      conversationCanonicalRequest,
      {
        onProviderTaskStarted: () => {},
        onProviderTextDelta: (text) => deltas.push(text),
      },
    )).resolves.toMatchObject({
      failure: { code: "quota_limited" },
      status: "failed",
    });
    expect(runs).toBe(1);
    expect(deltas).toEqual(['{"answer":"partial']);
  });

  it("retries one hosted account once when infrastructure fails before text", async () => {
    let runs = 0;
    let providerStarts = 0;
    const streamingRunner: StreamingProcessRunnerPort = {
      ...runner(async () => {
        throw new Error("unary runner was not expected");
      }),
      runStreaming: async (_request, observer) => {
        runs += 1;
        await observer.onProviderTaskStarted();
        if (runs === 1) {
          return failedProcess("backend_unavailable");
        }
        observer.onProviderTextDelta('{"answer":"Слышу.');
        observer.onProviderTextDelta('"}');
        return completedProcessWithoutTelemetry(conversationStructuredOutput);
      },
    };
    const executor = await createExecutor({
      accountPool: new SubscriptionAccountPool([{
        authJsonPath: "/private/slot-1/auth.json",
        id: "slot-1",
        providerInstanceId: "discord-meeting-summary-v3",
      }]),
      conversationProcessRunner: streamingRunner,
      conversationStreamingProcessRunner: streamingRunner,
    });
    const deltas: string[] = [];

    await expect(executor.executeStreaming(
      conversationCanonicalRequest,
      {
        onProviderTaskStarted: () => { providerStarts += 1; },
        onProviderTextDelta: (text) => deltas.push(text),
      },
    )).resolves.toMatchObject({
      status: "completed",
      structuredOutput: conversationStructuredOutput,
    });
    expect(runs).toBe(2);
    expect(providerStarts).toBe(1);
    expect(deltas).toEqual(['{"answer":"Слышу.', '"}']);
  });
});

async function createExecutor(
  override: Partial<SubscriptionRuntimeExecutorOptions>,
): Promise<SubscriptionRuntimeExecutor> {
  root = await mkdtemp(join(tmpdir(), "sidecar-account-failover-test-"));
  const keyFile = join(root, "local-encryption-key");
  await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
  return new SubscriptionRuntimeExecutor({
    accountPool: new SubscriptionAccountPool([
      {
        authJsonPath: "/private/slot-1/auth.json",
        id: "slot-1",
        providerInstanceId: "discord-meeting-summary-v3",
      },
      {
        authJsonPath: "/private/slot-2/auth.json",
        id: "slot-2",
        providerInstanceId: "discord-meeting-summary-v3-slot-2",
      },
    ]),
    childSourceEnvironment: {},
    installationInspector: { inspect: async () => installation() },
    isolatedCwd,
    killGraceMs: 50,
    localEncryptionKeyFile: keyFile,
    maxPromptBytes: 2 * 1024 * 1024,
    maxStderrBytes: 1024,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxTaskTimeoutMs: 600_000,
    processRunner: runner(async () => completedProcess()),
    readinessInspector: { inspect: async () => {} },
    stateRoot: "/private/state",
    ...override,
  });
}

function runner(
  run: (request: ProcessRunRequest) => Promise<ProcessRunResult>,
): ProcessRunnerPort {
  return { run, runtimeEngine: subscriptionRuntimeEngine };
}

function argumentValue(request: ProcessRunRequest, name: string): string {
  const value = request.args[request.args.indexOf(name) + 1];
  if (value === undefined) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function failedProcess(code: string): ProcessRunResult {
  return {
    exitCode: 1,
    outputLimitExceeded: false,
    signal: null,
    stderr: "",
    stdout: JSON.stringify({
      failure: { code, reconnectRequired: false, retryable: true },
      protocolVersion: 1,
      status: "failed",
      warnings: [],
    }),
    timedOut: false,
  };
}
