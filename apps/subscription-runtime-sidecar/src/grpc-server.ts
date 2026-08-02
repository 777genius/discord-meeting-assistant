import { timingSafeEqual } from "node:crypto";

import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  status,
  type handleUnaryCall,
  type Metadata,
  type ServiceDefinition,
  type UntypedServiceImplementation,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

import {
  grpcHealthDegraded,
  grpcHealthNotServing,
  grpcHealthServing,
  grpcOutputStructured,
  grpcProviderCodex,
  grpcTaskCompleted,
  grpcTaskFailed,
  grpcTaskWaiting,
  healthServiceName,
} from "./constants.js";
import {
  reconstructCanonicalRequest,
  type RequestPolicyOptions,
} from "./policy.js";
import type { SidecarExecutorPort } from "./types.js";

type RawMessage = Record<string, unknown>;
type UnaryHandler = handleUnaryCall<RawMessage, RawMessage>;

export interface GrpcHandlerOptions extends RequestPolicyOptions {
  readonly serviceToken: string;
}

interface AgentRuntimeGrpcHandlers extends UntypedServiceImplementation {
  readonly checkHealth: UnaryHandler;
  readonly runAgentTask: UnaryHandler;
}

export function createGrpcHandlers(
  executor: SidecarExecutorPort,
  options: GrpcHandlerOptions,
): AgentRuntimeGrpcHandlers {
  return {
    runAgentTask(call, callback): void {
      if (!isAuthorized(call.metadata, options.serviceToken)) {
        callback(grpcError(status.UNAUTHENTICATED, "Unauthorized"));
        return;
      }
      let request;
      try {
        request = reconstructCanonicalRequest(call.request, options);
      } catch {
        callback(
          grpcError(
            status.INVALID_ARGUMENT,
            "Agent task request violates sidecar policy",
          ),
        );
        return;
      }
      void executeTask(executor, request, callback);
    },
    checkHealth(call, callback): void {
      if (!isAuthorized(call.metadata, options.serviceToken)) {
        callback(grpcError(status.UNAUTHENTICATED, "Unauthorized"));
        return;
      }
      if (
        call.request.service !== undefined &&
        call.request.service !== healthServiceName
      ) {
        callback(grpcError(status.INVALID_ARGUMENT, "Unknown health service"));
        return;
      }
      void checkRuntimeHealth(executor, callback);
    },
  };
}

export async function startGrpcServer(input: {
  readonly bindAddress: string;
  readonly executor: SidecarExecutorPort;
  readonly options: GrpcHandlerOptions;
  readonly protoPath: string;
}): Promise<Server> {
  const definition = loadSync(input.protoPath, {
    defaults: true,
    enums: String,
    keepCase: false,
    longs: String,
    oneofs: true,
  });
  const root = loadPackageDefinition(definition) as Record<string, unknown>;
  const service = readServiceDefinition(root);
  const server = new Server();
  server.addService(service, createGrpcHandlers(input.executor, input.options));
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(
      input.bindAddress,
      ServerCredentials.createInsecure(),
      (error) => {
        if (error === null) {
          resolve();
        } else {
          reject(error);
        }
      },
    );
  });
  return server;
}

function toGrpcTaskResponse(
  result: Awaited<ReturnType<SidecarExecutorPort["execute"]>>,
): RawMessage {
  if (result.status === "failed") {
    return {
      schemaVersion: result.protocolVersion,
      status: grpcTaskFailed,
      outputText: "",
      structuredOutputJson: "",
      warnings: [],
      failure: {
        code: result.failure.code,
        safeMessage: result.failure.safeMessage,
        retryable: result.failure.retryable,
        reconnectRequired: result.failure.reconnectRequired,
        causeCategory: result.failure.causeCategory ?? "subscription_runtime",
        details: {},
      },
      ...(result.usage === undefined ? {} : { usage: toGrpcUsage(result.usage) }),
    };
  }
  if (result.status === "waiting_for_input") {
    return {
      schemaVersion: result.protocolVersion,
      status: grpcTaskWaiting,
      outputText: "",
      structuredOutputJson: "",
      warnings: [],
    };
  }
  return {
    schemaVersion: result.protocolVersion,
    status: grpcTaskCompleted,
    outputText: "",
    structuredOutputJson: JSON.stringify(result.structuredOutput),
    warnings: [],
    ...(result.usage === undefined
      ? {}
      : {
          usage: toGrpcUsage(result.usage),
        }),
    executionAttestation: {
      schemaVersion: result.executionAttestation.schemaVersion,
      requestId: result.executionAttestation.requestId,
      purpose: result.executionAttestation.purpose,
      canonicalRequestSha256:
        result.executionAttestation.canonicalRequestSha256,
      provider: grpcProviderCodex,
      model: result.executionAttestation.model,
      reasoningEffort: result.executionAttestation.reasoningEffort,
      runtimeEngine: result.executionAttestation.runtimeEngine,
      runtimePackageVersion:
        result.executionAttestation.runtimePackageVersion,
      launcherSha256: result.executionAttestation.launcherSha256,
      selectedOutputKind: grpcOutputStructured,
      selectedOutputSha256:
        result.executionAttestation.selectedOutputSha256,
    },
  };
}

function toGrpcUsage(usage: {
  readonly cacheWriteInputTokens: number;
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}): RawMessage {
  return {
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    complete: true,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
  };
}

function toGrpcHealthStatus(
  value: Awaited<ReturnType<SidecarExecutorPort["checkHealth"]>>["status"],
): string {
  if (value === "serving") {
    return grpcHealthServing;
  }
  if (value === "degraded") {
    return grpcHealthDegraded;
  }
  return grpcHealthNotServing;
}

function isAuthorized(metadata: Metadata, serviceToken: string): boolean {
  const values = metadata.get("authorization");
  if (values.length !== 1 || typeof values[0] !== "string") {
    return false;
  }
  const supplied = Buffer.from(values[0], "utf8");
  const expected = Buffer.from(`Bearer ${serviceToken}`, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function executeTask(
  executor: SidecarExecutorPort,
  request: Parameters<SidecarExecutorPort["execute"]>[0],
  callback: Parameters<UnaryHandler>[1],
): Promise<void> {
  try {
    callback(null, toGrpcTaskResponse(await executor.execute(request)));
  } catch {
    callback(
      grpcError(status.UNAVAILABLE, "Subscription runtime is unavailable"),
    );
  }
}

async function checkRuntimeHealth(
  executor: SidecarExecutorPort,
  callback: Parameters<UnaryHandler>[1],
): Promise<void> {
  try {
    const health = await executor.checkHealth();
    callback(null, {
      status: toGrpcHealthStatus(health.status),
      runtimeEngine: health.runtimeEngine,
      runtimeVersion: health.runtimeVersion,
      launcherSha256: health.launcherSha256 ?? "",
      warnings: health.warningCodes.map((code) => ({
        code,
        message: "Subscription runtime health warning",
      })),
    });
  } catch {
    callback(null, {
      status: grpcHealthNotServing,
      runtimeEngine: "subscription-runtime-cli",
      runtimeVersion: "unknown",
      launcherSha256: "",
      warnings: [
        {
          code: "subscription_runtime.health_failed",
          message: "Subscription runtime health check failed",
        },
      ],
    });
  }
}

function grpcError(code: status, message: string): Error & { readonly code: status } {
  return Object.assign(new Error(message), { code });
}

function readServiceDefinition(
  root: Record<string, unknown>,
): ServiceDefinition {
  const socialMonitor = record(root.social_monitor);
  const agentRuntime = record(socialMonitor.agent_runtime);
  const version = record(agentRuntime.v1);
  const constructor = version.AgentRuntimeService;
  if (
    typeof constructor !== "function" ||
    !("service" in constructor) ||
    typeof constructor.service !== "object"
  ) {
    throw new Error("AgentRuntimeService proto definition is unavailable");
  }
  return constructor.service as ServiceDefinition;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent runtime proto package is malformed");
  }
  return value as Record<string, unknown>;
}
