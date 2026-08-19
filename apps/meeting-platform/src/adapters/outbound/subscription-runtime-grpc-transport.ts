import { fileURLToPath } from "node:url";

import {
  Client,
  credentials,
  loadPackageDefinition,
  Metadata,
  type CallOptions,
  type ClientUnaryCall,
  type ServiceClientConstructor,
  type ServiceError,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import type {
  SubscriptionRuntimeAgentTaskRequest,
  SubscriptionRuntimeFailureCode,
  SubscriptionRuntimeHealthResult,
  SubscriptionRuntimeTaskResult,
  SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";

import {
  arrayValue,
  booleanValue,
  enumValue,
  integerValue,
  jsonObject,
  optionalString,
  recordValue,
  requiredString,
} from "./grpc-value-readers.js";
import { completeUsage, partialTelemetry } from "./subscription-runtime-telemetry.js";

type UnaryMethod = (
  request: unknown,
  metadata: Metadata,
  options: CallOptions,
  callback: (error: ServiceError | null, response?: unknown) => void,
) => ClientUnaryCall;

interface AgentRuntimeClient extends Client {
  readonly checkHealth: UnaryMethod;
  readonly runAgentTask: UnaryMethod;
}

interface GrpcTransportOptions {
  readonly address: string;
  readonly serviceToken: string;
}

const failureCodes = new Set<SubscriptionRuntimeFailureCode>([
  "backend_unavailable",
  "needs_reconnect",
  "permission_required",
  "provider_output_invalid",
  "provider_session_invalid",
  "quota_limited",
  "stale_generation",
  "task_cancelled",
  "task_mode_unsupported",
  "task_timeout",
  "telemetry_unavailable",
  "unknown_runtime_failure",
]);

export class GrpcSubscriptionRuntimeTransport
  implements SubscriptionRuntimeTransportPort
{
  private readonly client: AgentRuntimeClient;
  private readonly metadata: Metadata;

  public constructor(options: GrpcTransportOptions) {
    if (options.serviceToken.trim().length < 16) {
      throw new Error("Subscription runtime service token is too short");
    }
    const definition = loadSync(
      fileURLToPath(new URL("../../../proto/agent_runtime.proto", import.meta.url)),
      {
        defaults: true,
        enums: String,
        keepCase: false,
        longs: String,
        oneofs: true,
      },
    );
    const root = loadPackageDefinition(definition) as Record<string, unknown>;
    const service = readNestedService(root);
    this.client = new service(
      options.address,
      credentials.createInsecure(),
    ) as unknown as AgentRuntimeClient;
    this.metadata = new Metadata();
    this.metadata.set("authorization", `Bearer ${options.serviceToken}`);
  }

  public async execute(
    request: SubscriptionRuntimeAgentTaskRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SubscriptionRuntimeTaskResult> {
    const response = await callUnary(
      this.client.runAgentTask.bind(this.client),
      toGrpcTaskRequest(request),
      this.metadata,
      request.timeoutMs,
      options.signal,
    );
    return fromGrpcTaskResponse(response);
  }

  public async checkHealth(): Promise<SubscriptionRuntimeHealthResult> {
    const response = recordValue(
      await callUnary(
        this.client.checkHealth.bind(this.client),
        { service: "discord-meeting-summary" },
        this.metadata,
        5_000,
      ),
      "health response",
    );
    const launcherSha256 = optionalString(response.launcherSha256);
    return {
      ...(launcherSha256 === undefined ? {} : { launcherSha256 }),
      runtimeEngine: requiredString(response.runtimeEngine, "runtimeEngine"),
      runtimeVersion: requiredString(response.runtimeVersion, "runtimeVersion"),
      status: healthStatus(response.status),
      warningCodes: arrayValue(response.warnings).map((warning) =>
        requiredString(recordValue(warning, "warning").code, "warning.code"),
      ),
    };
  }

  public close(): void {
    this.client.close();
  }
}

export function toGrpcTaskRequest(request: SubscriptionRuntimeAgentTaskRequest) {
  return {
    schemaVersion: request.protocolVersion,
    requestId: request.runId,
    tenantId: "discord-meeting",
    workspaceId: request.context.metadata.meetingId,
    correlationId: request.context.correlationId,
    provider: "AGENT_RUNTIME_PROVIDER_CODEX",
    providerInstanceId: "discord-meeting-summary-v3",
    purpose: request.context.purpose,
    systemPrompt: request.task.systemPrompt,
    prompt: request.task.prompt,
    outputSchemaJson: JSON.stringify(request.task.controls.outputSchema),
    controlsJson: JSON.stringify(request.task.controls),
    timeoutMs: request.timeoutMs,
    cwd: request.cwd,
    metadata: {
      ...request.task.metadata,
      application: request.context.application,
      ...request.context.metadata,
    },
  };
}

export function fromGrpcTaskResponse(input: unknown): SubscriptionRuntimeTaskResult {
  const response = recordValue(input, "task response");
  const protocolVersion = integerValue(response.schemaVersion, "schemaVersion");
  const status = enumValue(response.status);
  if (status === "AGENT_RUNTIME_TASK_STATUS_FAILED" || status === "2") {
    const failure = recordValue(response.failure, "failure");
    const causeCategory = optionalString(failure.causeCategory);
    const telemetry = partialTelemetry(response.telemetry);
    const usage = completeUsage(response.usage);
    return {
      failure: {
        ...(causeCategory === undefined ? {} : { causeCategory }),
        code: normalizeFailureCode(optionalString(failure.code)),
        reconnectRequired: booleanValue(failure.reconnectRequired),
        retryable: booleanValue(failure.retryable),
        safeMessage:
          optionalString(failure.safeMessage) ?? "Subscription runtime task failed",
      },
      protocolVersion,
      status: "failed",
      ...(telemetry === undefined ? {} : { telemetry }),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (status === "AGENT_RUNTIME_TASK_STATUS_WAITING_FOR_INPUT" || status === "3") {
    return { protocolVersion, status: "waiting_for_input" };
  }
  if (status !== "AGENT_RUNTIME_TASK_STATUS_COMPLETED" && status !== "1") {
    throw new Error("Subscription runtime returned an unknown task status");
  }

  const structuredOutput = jsonObject(response.structuredOutputJson, "structuredOutputJson");
  const attestation = recordValue(response.executionAttestation, "executionAttestation");
  const telemetry = partialTelemetry(response.telemetry);
  const usage = completeUsage(response.usage);
  return {
    executionAttestation: {
      canonicalRequestSha256: requiredString(
        attestation.canonicalRequestSha256,
        "canonicalRequestSha256",
      ),
      launcherSha256: requiredString(attestation.launcherSha256, "launcherSha256"),
      model: requiredString(attestation.model, "model"),
      provider: providerName(attestation.provider),
      purpose: requiredString(attestation.purpose, "purpose"),
      reasoningEffort: requiredString(attestation.reasoningEffort, "reasoningEffort"),
      requestId: requiredString(attestation.requestId, "requestId"),
      runtimeEngine: requiredString(attestation.runtimeEngine, "runtimeEngine"),
      runtimePackageVersion: requiredString(
        attestation.runtimePackageVersion,
        "runtimePackageVersion",
      ),
      schemaVersion: integerValue(attestation.schemaVersion, "attestation.schemaVersion"),
      selectedOutputKind: selectedOutputKind(attestation.selectedOutputKind),
      selectedOutputSha256: requiredString(
        attestation.selectedOutputSha256,
        "selectedOutputSha256",
      ),
    },
    protocolVersion,
    status: "completed",
    structuredOutput,
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function readNestedService(root: Record<string, unknown>): ServiceClientConstructor {
  const socialMonitor = recordValue(root.social_monitor, "social_monitor package");
  const agentRuntime = recordValue(socialMonitor.agent_runtime, "agent_runtime package");
  const version = recordValue(agentRuntime.v1, "agent runtime v1 package");
  if (typeof version.AgentRuntimeService !== "function") {
    throw new Error("Agent runtime gRPC service definition is unavailable");
  }
  return version.AgentRuntimeService as ServiceClientConstructor;
}

async function callUnary(
  method: UnaryMethod,
  request: unknown,
  metadata: Metadata,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    let settled = false;
    let call: ClientUnaryCall | undefined;
    const finish = (outcome: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      outcome();
    };
    const abort = (): void => {
      call?.cancel();
      finish(() => {
        reject(signal?.reason ?? new Error("Subscription runtime task cancelled"));
      });
    };
    call = method(request, metadata, { deadline: Date.now() + timeoutMs }, (error, response) => {
      if (error !== null) {
        finish(() => {
          reject(new Error("Subscription runtime transport failed", { cause: error }));
        });
      } else {
        finish(() => {
          resolve(response);
        });
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
    }
  });
}

function normalizeFailureCode(code: string | undefined): SubscriptionRuntimeFailureCode {
  if (code !== undefined && failureCodes.has(code as SubscriptionRuntimeFailureCode)) {
    return code as SubscriptionRuntimeFailureCode;
  }
  if (code?.includes("timeout") === true) {
    return "task_timeout";
  }
  if (code?.includes("reconnect") === true) {
    return "needs_reconnect";
  }
  if (code?.includes("session") === true) {
    return "provider_session_invalid";
  }
  if (code?.includes("quota") === true) {
    return "quota_limited";
  }
  return "unknown_runtime_failure";
}

function providerName(value: unknown): string {
  const provider = enumValue(value);
  if (provider === "AGENT_RUNTIME_PROVIDER_CODEX" || provider === "1") {
    return "codex";
  }
  throw new Error("Execution attestation provider is not Codex");
}

function selectedOutputKind(value: unknown): string {
  const kind = enumValue(value);
  if (kind === "AGENT_RUNTIME_SELECTED_OUTPUT_KIND_STRUCTURED_OUTPUT" || kind === "1") {
    return "structured_output";
  }
  throw new Error("Execution attestation selected output is not structured output");
}

function healthStatus(value: unknown): SubscriptionRuntimeHealthResult["status"] {
  const status = enumValue(value);
  if (status === "AGENT_RUNTIME_HEALTH_STATUS_SERVING" || status === "1") {
    return "serving";
  }
  if (status === "AGENT_RUNTIME_HEALTH_STATUS_DEGRADED" || status === "2") {
    return "degraded";
  }
  return "not_serving";
}
