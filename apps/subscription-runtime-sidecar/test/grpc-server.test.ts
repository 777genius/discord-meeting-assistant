import { Metadata, status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";

import { createGrpcHandlers } from "../src/grpc-server.js";
import type { SidecarExecutorPort } from "../src/types.js";
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
        reasoningEffort: "medium",
        requestId: incrementalCanonicalRequest.runId,
        runtimeEngine: "subscription-runtime-cli",
        runtimePackageVersion: "0.1.0-main.2",
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
      runtimeEngine: "subscription-runtime-cli",
      runtimeVersion: "0.1.0-main.2",
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
      runtimeEngine: "subscription-runtime-cli",
      runtimeVersion: "0.1.0-main.2",
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
      runtimeEngine: "subscription-runtime-cli",
      runtimeVersion: "0.1.0-main.2",
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
      { metadata, request } as Parameters<typeof handler>[0],
      (error, value) => {
        resolve({
          error: error as (Error & { readonly code?: status }) | null,
          ...(value === null || value === undefined ? {} : { value }),
        });
      },
    );
  });
}
