import {
  canonicalJsonSha256,
  meetingSummaryOutputSchemaName,
  meetingSummaryPolicyVersion,
  providerMeetingSummaryJsonSchema,
  subscriptionRuntimeModel,
  subscriptionRuntimeProtocolVersion,
  subscriptionRuntimePurpose,
  subscriptionRuntimeReasoningEffort,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
} from "@discord-meeting/subscription-runtime-adapter";
import { z } from "zod";

import {
  applicationName,
  grpcProviderCodex,
  providerInstanceId,
  tenantId,
} from "./constants.js";

const nonEmptyText = z.string().trim().min(1).max(1_024);
const jsonObjectSchema = z.record(z.string(), z.unknown());

const controlsSchema = z
  .object({
    allowedTools: z.array(z.never()).length(0),
    disableTools: z.literal(true),
    executionProfile: z.literal("stateless-completion"),
    interactive: z.literal(false),
    maxOutputTokens: z.number().int().min(256).max(32_768),
    maxTurns: z.literal(1),
    model: z.literal(subscriptionRuntimeModel),
    outputKind: z.literal("structured_output"),
    outputSchema: jsonObjectSchema,
    outputSchemaName: z.literal(meetingSummaryOutputSchemaName),
    permissionMode: z.literal("read-only"),
    reasoningEffort: z.literal(subscriptionRuntimeReasoningEffort),
    responseFormat: z.literal("json"),
    runtimeOutput: z.literal("structured_output"),
    selectedOutputKind: z.literal("structured_output"),
  })
  .strict();

const transportMetadataSchema = z
  .object({
    application: z.literal(applicationName),
    executionProfile: z.literal("stateless-completion"),
    meetingId: nonEmptyText,
    model: z.literal(subscriptionRuntimeModel),
    policyVersion: z.literal(meetingSummaryPolicyVersion),
    reasoningEffort: z.literal(subscriptionRuntimeReasoningEffort),
    runtimeOutput: z.literal("structured_output"),
    toolsDisabled: z.literal("true"),
    transcriptId: nonEmptyText,
    transcriptVersion: nonEmptyText,
  })
  .strict();

const canonicalTaskMetadataSchema = z
  .object({
    executionProfile: z.literal("stateless-completion"),
    model: z.literal(subscriptionRuntimeModel),
    policyVersion: z.literal(meetingSummaryPolicyVersion),
    reasoningEffort: z.literal(subscriptionRuntimeReasoningEffort),
    runtimeOutput: z.literal("structured_output"),
    toolsDisabled: z.literal("true"),
  })
  .strict();

const canonicalRequestSchema = z
  .object({
    context: z
      .object({
        application: z.literal(applicationName),
        correlationId: nonEmptyText,
        metadata: z
          .object({
            meetingId: nonEmptyText,
            policyVersion: z.literal(meetingSummaryPolicyVersion),
            transcriptId: nonEmptyText,
            transcriptVersion: nonEmptyText,
          })
          .strict(),
        purpose: z.literal(subscriptionRuntimePurpose),
      })
      .strict(),
    cwd: z.string().min(1),
    protocolVersion: z.literal(subscriptionRuntimeProtocolVersion),
    runId: nonEmptyText,
    task: z
      .object({
        controls: controlsSchema,
        kind: z.literal("structured-prompt"),
        metadata: canonicalTaskMetadataSchema,
        outputSchemaName: z.literal(meetingSummaryOutputSchemaName),
        prompt: z.string().min(1),
        systemPrompt: z.string().min(1),
      })
      .strict(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();

const rawGrpcRequestSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(subscriptionRuntimeProtocolVersion),
      z.literal(String(subscriptionRuntimeProtocolVersion)),
    ]),
    requestId: nonEmptyText,
    tenantId: z.literal(tenantId),
    workspaceId: nonEmptyText,
    correlationId: nonEmptyText,
    provider: z.union([z.literal(grpcProviderCodex), z.literal("1"), z.literal(1)]),
    providerInstanceId: z.literal(providerInstanceId),
    purpose: z.literal(subscriptionRuntimePurpose),
    systemPrompt: z.string().min(1),
    prompt: z.string().min(1),
    outputSchemaJson: z.string().min(2),
    controlsJson: z.string().min(2),
    timeoutMs: z.number().int().positive(),
    cwd: z.string().min(1),
    metadata: transportMetadataSchema,
  })
  .strict();

export interface RequestPolicyOptions {
  readonly isolatedCwd: string;
  readonly maxPromptBytes: number;
  readonly maxTaskTimeoutMs: number;
}

export class RequestPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RequestPolicyError";
  }
}

export function reconstructCanonicalRequest(
  value: unknown,
  options: RequestPolicyOptions,
): SubscriptionRuntimeAgentTaskRequest {
  const input = parseWithPolicy(rawGrpcRequestSchema, value);
  if (input.workspaceId !== input.metadata.meetingId) {
    throw new RequestPolicyError("workspace_id conflicts with meeting metadata");
  }
  if (input.cwd !== options.isolatedCwd) {
    throw new RequestPolicyError("task cwd conflicts with the isolated workspace");
  }
  if (input.timeoutMs > options.maxTaskTimeoutMs) {
    throw new RequestPolicyError("task timeout exceeds the admitted bound");
  }
  if (
    Buffer.byteLength(input.prompt, "utf8") +
      Buffer.byteLength(input.systemPrompt, "utf8") >
    options.maxPromptBytes
  ) {
    throw new RequestPolicyError("task prompt exceeds the admitted byte bound");
  }

  const outputSchema = parseJsonObject(input.outputSchemaJson, "output schema");
  const controls = parseWithPolicy(
    controlsSchema,
    parseJsonObject(input.controlsJson, "controls"),
  );
  assertExactOutputSchema(outputSchema);
  if (
    canonicalJsonSha256(controls.outputSchema) !==
    canonicalJsonSha256(outputSchema)
  ) {
    throw new RequestPolicyError("controls contain a conflicting output schema");
  }

  const request: SubscriptionRuntimeAgentTaskRequest = {
    context: {
      application: applicationName,
      correlationId: input.correlationId,
      metadata: {
        meetingId: input.metadata.meetingId,
        policyVersion: meetingSummaryPolicyVersion,
        transcriptId: input.metadata.transcriptId,
        transcriptVersion: input.metadata.transcriptVersion,
      },
      purpose: subscriptionRuntimePurpose,
    },
    cwd: input.cwd,
    protocolVersion: subscriptionRuntimeProtocolVersion,
    runId: input.requestId,
    task: {
      controls: controls as unknown as SubscriptionRuntimeAgentTaskRequest["task"]["controls"],
      kind: "structured-prompt",
      metadata: {
        executionProfile: "stateless-completion",
        model: subscriptionRuntimeModel,
        policyVersion: meetingSummaryPolicyVersion,
        reasoningEffort: subscriptionRuntimeReasoningEffort,
        runtimeOutput: "structured_output",
        toolsDisabled: "true",
      },
      outputSchemaName: meetingSummaryOutputSchemaName,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
    },
    timeoutMs: input.timeoutMs,
  };
  assertCanonicalRequestPolicy(request, options);
  return request;
}

export function assertCanonicalRequestPolicy(
  request: SubscriptionRuntimeAgentTaskRequest,
  options: RequestPolicyOptions,
): void {
  const candidate = parseWithPolicy(canonicalRequestSchema, request);
  if (
    candidate.cwd !== options.isolatedCwd ||
    candidate.timeoutMs > options.maxTaskTimeoutMs ||
    Buffer.byteLength(candidate.task.prompt, "utf8") +
      Buffer.byteLength(candidate.task.systemPrompt, "utf8") >
      options.maxPromptBytes
  ) {
    throw new RequestPolicyError("canonical task conflicts with sidecar policy");
  }
  assertExactOutputSchema(candidate.task.controls.outputSchema);
}

function assertExactOutputSchema(value: Record<string, unknown>): void {
  if (
    canonicalJsonSha256(value) !==
    canonicalJsonSha256(providerMeetingSummaryJsonSchema)
  ) {
    throw new RequestPolicyError("task output schema is not admitted");
  }
}

function parseJsonObject(text: string, label: string): JsonObject {
  try {
    return parseWithPolicy(jsonObjectSchema, JSON.parse(text)) as JsonObject;
  } catch (error: unknown) {
    if (error instanceof RequestPolicyError) {
      throw error;
    }
    throw new RequestPolicyError(`${label} must be a JSON object`);
  }
}

function parseWithPolicy<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RequestPolicyError("agent task request conflicts with sidecar policy");
  }
  return parsed.data;
}
