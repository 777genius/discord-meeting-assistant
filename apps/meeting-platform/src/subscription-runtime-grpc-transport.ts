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
  JsonObject,
  SubscriptionRuntimeAgentTaskRequest,
  SubscriptionRuntimeFailureCode,
  SubscriptionRuntimeHealthResult,
  SubscriptionRuntimeTaskResult,
  SubscriptionRuntimeTelemetry,
  SubscriptionRuntimeTokenAvailability,
  SubscriptionRuntimeTransportPort,
  SubscriptionRuntimeUsage,
} from "@discord-meeting/subscription-runtime-adapter";

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
      fileURLToPath(new URL("../proto/agent_runtime.proto", import.meta.url)),
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
  ): Promise<SubscriptionRuntimeTaskResult> {
    const response = await callUnary(
      this.client.runAgentTask.bind(this.client),
      toGrpcTaskRequest(request),
      this.metadata,
      request.timeoutMs,
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

function completeUsage(value: unknown): SubscriptionRuntimeUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  if (usage.complete !== true) {
    return undefined;
  }
  const parsed: SubscriptionRuntimeUsage = {
    cacheWriteInputTokens: integerValue(
      usage.cacheWriteInputTokens,
      "usage.cacheWriteInputTokens",
    ),
    cachedInputTokens: integerValue(
      usage.cachedInputTokens,
      "usage.cachedInputTokens",
    ),
    inputTokens: integerValue(usage.inputTokens, "usage.inputTokens"),
    outputTokens: integerValue(usage.outputTokens, "usage.outputTokens"),
    reasoningOutputTokens: integerValue(
      usage.reasoningOutputTokens,
      "usage.reasoningOutputTokens",
    ),
    totalTokens: integerValue(usage.totalTokens, "usage.totalTokens"),
  };
  if (
    parsed.cachedInputTokens + parsed.cacheWriteInputTokens > parsed.inputTokens ||
    parsed.reasoningOutputTokens > parsed.outputTokens ||
    parsed.totalTokens < parsed.inputTokens + parsed.outputTokens
  ) {
    throw new Error("Subscription runtime usage totals are inconsistent");
  }
  return parsed;
}

function partialTelemetry(value: unknown): SubscriptionRuntimeTelemetry | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const telemetry = recordValue(value, "telemetry");
  const source = telemetrySource(telemetry.source);
  const parsed: SubscriptionRuntimeTelemetry = {
    cacheWriteInputTokens: tokenClass(
      telemetry.cacheWriteInputTokens,
      "telemetry.cacheWriteInputTokens",
      false,
    ),
    cachedInputTokens: tokenClass(
      telemetry.cachedInputTokens,
      "telemetry.cachedInputTokens",
      false,
    ),
    ...(telemetry.cost === undefined || telemetry.cost === null
      ? {}
      : { cost: costRange(telemetry.cost) }),
    inputTokens: tokenClass(telemetry.inputTokens, "telemetry.inputTokens", false),
    outputTokens: tokenClass(telemetry.outputTokens, "telemetry.outputTokens", false),
    reasoningOutputTokens: tokenClass(
      telemetry.reasoningOutputTokens,
      "telemetry.reasoningOutputTokens",
      false,
    ),
    source,
    totalTokens: tokenClass(telemetry.totalTokens, "telemetry.totalTokens", true),
  };
  validatePartialTelemetry(parsed);
  return parsed;
}

function telemetrySource(
  value: unknown,
): SubscriptionRuntimeTelemetry["source"] {
  const source = requiredString(value, "telemetry.source");
  if (source !== "codex_exec_jsonl" && source !== "runtime_bridge") {
    throw new Error("telemetry.source is unsupported");
  }
  return source;
}

function tokenClass(
  value: unknown,
  field: string,
  allowDerived: boolean,
): SubscriptionRuntimeTokenAvailability {
  const token = recordValue(value, field);
  const availability = enumValue(token.availability);
  if (
    availability === "AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE" ||
    availability === "3"
  ) {
    return { availability: "unavailable" };
  }
  if (
    availability === "AGENT_RUNTIME_TOKEN_AVAILABILITY_MEASURED" ||
    availability === "1"
  ) {
    return {
      availability: "measured",
      value: integerValue(token.value, `${field}.value`),
    };
  }
  if (
    !allowDerived ||
    (availability !== "AGENT_RUNTIME_TOKEN_AVAILABILITY_DERIVED" &&
      availability !== "2")
  ) {
    throw new Error(`${field}.availability is invalid`);
  }
  const derivedFrom = arrayValue(token.derivedFrom).map(enumValue);
  if (
    derivedFrom.length !== 2 ||
    !isInputTokenSource(derivedFrom[0]) ||
    !isOutputTokenSource(derivedFrom[1])
  ) {
    throw new Error(`${field}.derivedFrom is invalid`);
  }
  return {
    availability: "derived",
    derivedFrom: ["inputTokens", "outputTokens"],
    value: integerValue(token.value, `${field}.value`),
  };
}

function costRange(value: unknown): NonNullable<SubscriptionRuntimeTelemetry["cost"]> {
  const cost = recordValue(value, "telemetry.cost");
  const minimumUsd = nonNegativeFiniteNumber(cost.minimumUsd, "telemetry.cost.minimumUsd");
  const maximumUsd = nonNegativeFiniteNumber(cost.maximumUsd, "telemetry.cost.maximumUsd");
  if (minimumUsd > maximumUsd) {
    throw new Error("telemetry cost range is inverted");
  }
  const hasExactUsd = booleanValue(cost.hasExactUsd);
  const exactUsd = hasExactUsd
    ? nonNegativeFiniteNumber(cost.exactUsd, "telemetry.cost.exactUsd")
    : undefined;
  if (
    exactUsd !== undefined &&
    (exactUsd !== minimumUsd || exactUsd !== maximumUsd)
  ) {
    throw new Error("telemetry exact cost must collapse the range");
  }
  return {
    ...(exactUsd === undefined ? {} : { exactUsd }),
    maximumUsd,
    minimumUsd,
    priceCardId: requiredString(cost.priceCardId, "telemetry.cost.priceCardId"),
    priceCardSource: requiredString(
      cost.priceCardSource,
      "telemetry.cost.priceCardSource",
    ),
  };
}

function validatePartialTelemetry(telemetry: SubscriptionRuntimeTelemetry): void {
  const inputTokens = measuredTokenValue(telemetry.inputTokens);
  const cachedInputTokens = measuredTokenValue(telemetry.cachedInputTokens);
  const cacheWriteInputTokens = measuredTokenValue(telemetry.cacheWriteInputTokens);
  const outputTokens = measuredTokenValue(telemetry.outputTokens);
  const reasoningOutputTokens = measuredTokenValue(telemetry.reasoningOutputTokens);
  if (
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    cachedInputTokens > inputTokens
  ) {
    throw new Error("telemetry cached input exceeds input");
  }
  if (
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    cacheWriteInputTokens !== undefined &&
    cachedInputTokens + cacheWriteInputTokens > inputTokens
  ) {
    throw new Error("telemetry cache-write input exceeds input");
  }
  if (
    outputTokens !== undefined &&
    reasoningOutputTokens !== undefined &&
    reasoningOutputTokens > outputTokens
  ) {
    throw new Error("telemetry reasoning output exceeds output");
  }
  if (telemetry.totalTokens.availability === "derived") {
    if (
      inputTokens === undefined ||
      outputTokens === undefined ||
      !Number.isSafeInteger(inputTokens + outputTokens) ||
      telemetry.totalTokens.value !== inputTokens + outputTokens
    ) {
      throw new Error("telemetry derived total is inconsistent");
    }
  }
  if (
    telemetry.totalTokens.availability === "measured" &&
    inputTokens !== undefined &&
    outputTokens !== undefined &&
    telemetry.totalTokens.value < inputTokens + outputTokens
  ) {
    throw new Error("telemetry total is inconsistent");
  }
  if (
    telemetry.cost !== undefined &&
    (inputTokens === undefined ||
      cachedInputTokens === undefined ||
      outputTokens === undefined ||
      (telemetry.cost.exactUsd !== undefined &&
        cacheWriteInputTokens === undefined))
  ) {
    throw new Error("telemetry cost does not match available token classes");
  }
}

function measuredTokenValue(
  token: SubscriptionRuntimeTokenAvailability,
): number | undefined {
  return token.availability === "measured" ? token.value : undefined;
}

function isInputTokenSource(value: string | undefined): boolean {
  return (
    value === "AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_INPUT" ||
    value === "1"
  );
}

function isOutputTokenSource(value: string | undefined): boolean {
  return (
    value === "AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_OUTPUT" ||
    value === "2"
  );
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
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    method(request, metadata, { deadline: Date.now() + timeoutMs }, (error, response) => {
      if (error !== null) {
        reject(new Error("Subscription runtime transport failed", { cause: error }));
      } else {
        resolve(response);
      }
    });
  });
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (parsed === undefined) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function integerValue(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be an integer`);
  }
  return parsed;
}

function nonNegativeFiniteNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return parsed;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function enumValue(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function jsonObject(value: unknown, field: string): JsonObject {
  const text = requiredString(value, field);
  return recordValue(JSON.parse(text) as unknown, field) as JsonObject;
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
