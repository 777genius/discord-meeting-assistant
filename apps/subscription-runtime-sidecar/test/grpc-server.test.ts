import { EventEmitter } from "node:events";

import { Metadata, status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";

import { createGrpcHandlers } from "../src/grpc-server.js";
import type {
  SidecarExecutorPort,
  SidecarStreamingExecutorPort,
} from "../src/types.js";
import {
  grpcRequest,
  incrementalCanonicalRequest,
  isolatedCwd,
  structuredOutput,
} from "./fixture.js";

const serviceToken = "test-service-token-long-enough";
const handlerOptions = {
  isolatedCwd,
  maxPromptBytes: 2 * 1_024 * 1_024,
  maxTaskTimeoutMs: 600_000,
  serviceToken,
};

describe("authenticated agent runtime gRPC handlers", () => {
  it("rejects RunAgentTask and CheckHealth without the service-file token", async () => {
    const executor = new CountingExecutor();
    const handlers = createGrpcHandlers(executor, handlerOptions);

    const task = await invoke(handlers.runAgentTask, grpcRequest(), new Metadata());
    const health = await invoke(
      handlers.checkHealth,
      { service: "discord-meeting-summary" },
      new Metadata(),
    );

    expect(task.error).toMatchObject({ code: status.UNAUTHENTICATED });
    expect(health.error).toMatchObject({ code: status.UNAUTHENTICATED });
    expect(executor.executions).toBe(0);
    expect(executor.healthChecks).toBe(0);
  });

  it("admits the exact bearer token and rejects policy conflicts", async () => {
    const executor = new CountingExecutor();
    const handlers = createGrpcHandlers(executor, handlerOptions);
    const metadata = new Metadata();
    metadata.set("authorization", `Bearer ${serviceToken}`);

    const accepted = await invoke(handlers.runAgentTask, grpcRequest(), metadata);
    const rejected = await invoke(
      handlers.runAgentTask,
      { ...grpcRequest(), purpose: "unknown" },
      metadata,
    );

    expect(accepted.error).toBeNull();
    expect(accepted.value).toMatchObject({
      status: "AGENT_RUNTIME_TASK_STATUS_FAILED",
      failure: { code: "backend_unavailable" },
    });
    expect(rejected.error).toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(executor.executions).toBe(1);
  });

  it("forwards complete token classes with an explicit presence marker", async () => {
    const handlers = createGrpcHandlers(new CompletedExecutor(), handlerOptions);
    const metadata = new Metadata();
    metadata.set("authorization", `Bearer ${serviceToken}`);

    const response = await invoke(
      handlers.runAgentTask,
      grpcRequest(incrementalCanonicalRequest),
      metadata,
    );

    expect(response.error).toBeNull();
    expect(response.value).toMatchObject({
      status: "AGENT_RUNTIME_TASK_STATUS_COMPLETED",
      usage: {
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        complete: true,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    });
  });

  it("forwards complete token classes when the provider task fails", async () => {
    const handlers = createGrpcHandlers(new FailedWithUsageExecutor(), handlerOptions);
    const metadata = new Metadata();
    metadata.set("authorization", `Bearer ${serviceToken}`);

    const response = await invoke(
      handlers.runAgentTask,
      grpcRequest(incrementalCanonicalRequest),
      metadata,
    );

    expect(response.error).toBeNull();
    expect(response.value).toMatchObject({
      failure: { code: "task_timeout" },
      status: "AGENT_RUNTIME_TASK_STATUS_FAILED",
      usage: {
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        complete: true,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    });
  });

  it("forwards partial token availability, derived total, and cost range", async () => {
    const handlers = createGrpcHandlers(new PartialTelemetryExecutor(), handlerOptions);
    const metadata = new Metadata();
    metadata.set("authorization", `Bearer ${serviceToken}`);

    const response = await invoke(
      handlers.runAgentTask,
      grpcRequest(incrementalCanonicalRequest),
      metadata,
    );

    expect(response.error).toBeNull();
    expect(response.value).toMatchObject({
      status: "AGENT_RUNTIME_TASK_STATUS_COMPLETED",
      telemetry: {
        source: "codex_exec_jsonl",
        cacheWriteInputTokens: {
          availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE",
        },
        inputTokens: {
          availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_MEASURED",
          value: "1000",
        },
        totalTokens: {
          availability: "AGENT_RUNTIME_TOKEN_AVAILABILITY_DERIVED",
          derivedFrom: [
            "AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_INPUT",
            "AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_OUTPUT",
          ],
          value: "1300",
        },
        cost: {
          hasExactUsd: false,
          maximumUsd: 0.000_564,
          minimumUsd: 0.000_524,
          priceCardId: "openai-standard-2026-08-02",
        },
      },
    });
  });

  it("propagates gRPC cancellation to the executor AbortSignal", async () => {
    const receivedSignal = deferred<AbortSignal>();
    const executionFinished = deferred<void>();
    const executor: SidecarExecutorPort = {
      checkHealth: async () => ({
        runtimeEngine: "subscription-runtime-app-server",
        runtimeVersion: "0.1.0-main.27",
        status: "serving",
        warningCodes: [],
      }),
      execute: async (_request, signal) => {
        if (signal === undefined) {
          throw new Error("gRPC handler did not supply a cancellation signal");
        }
        receivedSignal.resolve(signal);
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
        executionFinished.resolve();
        return {
          failure: {
            code: "task_cancelled",
            reconnectRequired: false,
            retryable: true,
            safeMessage: "Subscription runtime task is temporarily unavailable",
          },
          protocolVersion: 1,
          status: "failed",
        };
      },
    };
    const handlers = createGrpcHandlers(executor, handlerOptions);
    const metadata = new Metadata();
    metadata.set("authorization", `Bearer ${serviceToken}`);
    const call = createTestCall(grpcRequest(), metadata);
    let callbacks = 0;

    handlers.runAgentTask(
      call as Parameters<typeof handlers.runAgentTask>[0],
      () => {
        callbacks += 1;
      },
    );

    const signal = await receivedSignal.promise;
    expect(signal.aborted).toBe(false);
    call.emit("cancelled");
    await executionFinished.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(signal.aborted).toBe(true);
    expect(callbacks).toBe(0);
  });

  it("streams provider start and text deltas before the terminal response", async () => {
    const executor = new CompletedExecutor();
    const streamingExecutor: SidecarStreamingExecutorPort = {
      executeStreaming: async (_request, observer) => {
        await observer.onProviderTaskStarted();
        observer.onProviderTextDelta('{"answer":"Привет, ');
        observer.onProviderTextDelta('Ботик!"}');
        return await executor.execute();
      },
    };
    const handlers = createGrpcHandlers(
      executor,
      handlerOptions,
      streamingExecutor,
    );
    const metadata = new Metadata();
    metadata.set("authorization", `Bearer ${serviceToken}`);

    const result = await invokeStream(
      handlers.streamAgentTask,
      { task: grpcRequest(incrementalCanonicalRequest) },
      metadata,
    );

    expect(result.error).toBeNull();
    expect(result.events).toMatchObject([
      { schemaVersion: 1, sequence: "1", started: {} },
      {
        schemaVersion: 1,
        sequence: "2",
        textDelta: { text: '{"answer":"Привет, ' },
      },
      {
        schemaVersion: 1,
        sequence: "3",
        textDelta: { text: 'Ботик!"}' },
      },
      {
        schemaVersion: 1,
        sequence: "4",
        completed: { status: "AGENT_RUNTIME_TASK_STATUS_COMPLETED" },
      },
    ]);
  });

  it("allows the full 256-delta contract before the terminal event", async () => {
    const executor = new CompletedExecutor();
    const streamingExecutor: SidecarStreamingExecutorPort = {
      executeStreaming: async (_request, observer) => {
        await observer.onProviderTaskStarted();
        for (let index = 0; index < 256; index += 1) {
          observer.onProviderTextDelta("a");
        }
        return await executor.execute();
      },
    };
    const handlers = createGrpcHandlers(
      executor,
      handlerOptions,
      streamingExecutor,
    );
    const metadata = new Metadata();
    metadata.set("authorization", `Bearer ${serviceToken}`);

    const result = await invokeStream(
      handlers.streamAgentTask,
      { task: grpcRequest(incrementalCanonicalRequest) },
      metadata,
    );

    expect(result.error).toBeNull();
    expect(result.events).toHaveLength(258);
    expect(result.events.at(-1)).toMatchObject({
      sequence: "258",
      completed: { status: "AGENT_RUNTIME_TASK_STATUS_COMPLETED" },
    });
  });
});

class CompletedExecutor implements SidecarExecutorPort {
  public async execute() {
    return {
      executionAttestation: {
        canonicalRequestSha256: "a".repeat(64),
        launcherSha256: "b".repeat(64),
        model: "gpt-5.6-luna",
        provider: "codex",
        purpose: "discord_meeting.summary.incremental",
        reasoningEffort: "low",
        requestId: incrementalCanonicalRequest.runId,
        runtimeEngine: "subscription-runtime-app-server",
        runtimePackageVersion: "0.1.0-main.27",
        schemaVersion: 1,
        selectedOutputKind: "structured_output",
        selectedOutputSha256: "c".repeat(64),
      },
      protocolVersion: 1 as const,
      status: "completed" as const,
      structuredOutput,
      usage: {
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    };
  }

  public async checkHealth() {
    return {
      runtimeEngine: "subscription-runtime-app-server",
      runtimeVersion: "0.1.0-main.27",
      status: "serving" as const,
      warningCodes: [],
    };
  }
}

class FailedWithUsageExecutor implements SidecarExecutorPort {
  public async execute() {
    return {
      failure: {
        code: "task_timeout" as const,
        reconnectRequired: false,
        retryable: true,
        safeMessage: "Subscription runtime task timed out",
      },
      protocolVersion: 1 as const,
      status: "failed" as const,
      usage: {
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    };
  }

  public async checkHealth() {
    return {
      runtimeEngine: "subscription-runtime-app-server",
      runtimeVersion: "0.1.0-main.27",
      status: "serving" as const,
      warningCodes: [],
    };
  }
}

class PartialTelemetryExecutor implements SidecarExecutorPort {
  public async execute() {
    return {
      executionAttestation: {
        canonicalRequestSha256: "a".repeat(64),
        launcherSha256: "b".repeat(64),
        model: "gpt-5.6-luna",
        provider: "codex" as const,
        purpose: "discord_meeting.summary.incremental",
        reasoningEffort: "low",
        requestId: incrementalCanonicalRequest.runId,
        runtimeEngine: "subscription-runtime-app-server",
        runtimePackageVersion: "0.1.0-main.27",
        schemaVersion: 1,
        selectedOutputKind: "structured_output",
        selectedOutputSha256: "c".repeat(64),
      },
      protocolVersion: 1 as const,
      status: "completed" as const,
      structuredOutput,
      telemetry: {
        source: "codex_exec_jsonl" as const,
        cacheWriteInputTokens: { availability: "unavailable" as const },
        cachedInputTokens: { availability: "measured" as const, value: 200 },
        inputTokens: { availability: "measured" as const, value: 1_000 },
        outputTokens: { availability: "measured" as const, value: 300 },
        reasoningOutputTokens: { availability: "measured" as const, value: 100 },
        totalTokens: {
          availability: "derived" as const,
          derivedFrom: ["inputTokens", "outputTokens"] as const,
          value: 1_300,
        },
        cost: {
          maximumUsd: 0.000_564,
          minimumUsd: 0.000_524,
          priceCardId: "openai-standard-2026-08-02",
          priceCardSource: "https://developers.openai.com/api/docs/pricing#text-tokens",
        },
      },
    };
  }

  public async checkHealth() {
    return {
      runtimeEngine: "subscription-runtime-app-server",
      runtimeVersion: "0.1.0-main.27",
      status: "serving" as const,
      warningCodes: [],
    };
  }
}

class CountingExecutor implements SidecarExecutorPort {
  public executions = 0;
  public healthChecks = 0;

  public async execute() {
    this.executions += 1;
    return {
      protocolVersion: 1 as const,
      status: "failed" as const,
      failure: {
        code: "backend_unavailable" as const,
        reconnectRequired: false,
        retryable: true,
        safeMessage: "Subscription runtime task is temporarily unavailable",
      },
    };
  }

  public async checkHealth() {
    this.healthChecks += 1;
    return {
      runtimeEngine: "subscription-runtime-app-server",
      runtimeVersion: "0.1.0-main.27",
      status: "serving" as const,
      warningCodes: [],
    };
  }
}

async function invoke(
  handler: ReturnType<typeof createGrpcHandlers>["runAgentTask"],
  request: Record<string, unknown>,
  metadata: Metadata,
): Promise<{
  readonly error: (Error & { readonly code?: status }) | null;
  readonly value?: Record<string, unknown>;
}> {
  return await new Promise((resolve) => {
    handler(
      createTestCall(request, metadata) as Parameters<typeof handler>[0],
      (error, value) => {
        resolve({
          error: error as (Error & { readonly code?: status }) | null,
          ...(value === null || value === undefined ? {} : { value }),
        });
      },
    );
  });
}

function createTestCall(request: Record<string, unknown>, metadata: Metadata): EventEmitter {
  return Object.assign(new EventEmitter(), { metadata, request });
}

async function invokeStream(
  handler: ReturnType<typeof createGrpcHandlers>["streamAgentTask"],
  request: Record<string, unknown>,
  metadata: Metadata,
): Promise<{
  readonly error: (Error & { readonly code?: status }) | null;
  readonly events: readonly Record<string, unknown>[];
}> {
  const finished = deferred<void>();
  const events: Record<string, unknown>[] = [];
  const call = Object.assign(new EventEmitter(), {
    metadata,
    request,
    write: (event: Record<string, unknown>) => {
      events.push(event);
      return true;
    },
    end: () => {
      finished.resolve();
    },
    destroy: (error: Error) => {
      call.emit("error", error);
    },
  });
  let streamError: (Error & { readonly code?: status }) | null = null;
  call.once("error", (error) => {
    streamError = error as Error & { readonly code?: status };
    finished.resolve();
  });
  handler(call as Parameters<typeof handler>[0]);
  await finished.promise;
  return { error: streamError, events };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolver: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  if (resolver === undefined) {
    throw new Error("Promise resolver was not initialized");
  }
  return { promise, resolve: resolver };
}
