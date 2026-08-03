import {
  canonicalJsonSha256,
  incrementalMeetingSummaryPolicyVersion,
  meetingSummaryOutputSchemaName,
  meetingSummaryPolicyVersion,
  providerMeetingSummaryJsonSchema,
  subscriptionRuntimeIncrementalModel,
  subscriptionRuntimeIncrementalPurpose,
  subscriptionRuntimeIncrementalReasoningEffort,
  subscriptionRuntimeModel,
  subscriptionRuntimeProtocolVersion,
  subscriptionRuntimeProfileForPurpose,
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
    model: z.union([
      z.literal(subscriptionRuntimeModel),
      z.literal(subscriptionRuntimeIncrementalModel),
    ]),
    outputKind: z.literal("structured_output"),
    outputSchema: jsonObjectSchema,
    outputSchemaName: z.literal(meetingSummaryOutputSchemaName),
    permissionMode: z.literal("read-only"),
    reasoningEffort: z.union([
      z.literal(subscriptionRuntimeReasoningEffort),
      z.literal(subscriptionRuntimeIncrementalReasoningEffort),
    ]),
    responseFormat: z.literal("json"),
    runtimeOutput: z.literal("structured_output"),
    selectedOutputKind: z.literal("structured_output"),
  })
  .strict();

const finalTransportMetadataSchema = z
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

const incrementalTransportMetadataSchema = z
  .object({
    application: z.literal(applicationName),
    executionProfile: z.literal("stateless-completion"),
    meetingId: nonEmptyText,
    model: z.literal(subscriptionRuntimeIncrementalModel),
    policyVersion: z.literal(incrementalMeetingSummaryPolicyVersion),
    reasoningEffort: z.literal(subscriptionRuntimeIncrementalReasoningEffort),
    runtimeOutput: z.literal("structured_output"),
    summaryRevision: nonEmptyText,
    throughTurnCount: nonEmptyText,
    toolsDisabled: z.literal("true"),
  })
  .strict();

const transportMetadataSchema = z.union([
  finalTransportMetadataSchema,
  incrementalTransportMetadataSchema,
]);

const finalContextMetadataSchema = z
  .object({
    meetingId: nonEmptyText,
    policyVersion: z.literal(meetingSummaryPolicyVersion),
    transcriptId: nonEmptyText,
    transcriptVersion: nonEmptyText,
  })
  .strict();

const incrementalContextMetadataSchema = z
  .object({
    meetingId: nonEmptyText,
    policyVersion: z.literal(incrementalMeetingSummaryPolicyVersion),
    summaryRevision: nonEmptyText,
    throughTurnCount: nonEmptyText,
  })
  .strict();

const contextMetadataSchema = z.union([
  finalContextMetadataSchema,
  incrementalContextMetadataSchema,
]);

const canonicalTaskMetadataSchema = z.union([
  finalTransportMetadataSchema.omit({ application: true, meetingId: true, transcriptId: true, transcriptVersion: true }),
  incrementalTransportMetadataSchema.omit({ application: true, meetingId: true, summaryRevision: true, throughTurnCount: true }),
]);

const canonicalRequestSchema = z
  .object({
    context: z
      .object({
        application: z.literal(applicationName),
        correlationId: nonEmptyText,
        metadata: contextMetadataSchema,
        purpose: z.union([
          z.literal(subscriptionRuntimePurpose),
          z.literal(subscriptionRuntimeIncrementalPurpose),
        ]),
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
    purpose: z.union([
      z.literal(subscriptionRuntimePurpose),
      z.literal(subscriptionRuntimeIncrementalPurpose),
    ]),
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

  const profile = subscriptionRuntimeProfileForPurpose(input.purpose);
  if (
    profile === undefined ||
    valuesDiffer(controls.model, profile.model) ||
    valuesDiffer(controls.reasoningEffort, profile.reasoningEffort)
  ) {
    throw new RequestPolicyError("request execution profile is not admitted");
  }
  const profileMetadata = reconstructProfileMetadata(input.purpose, input.metadata);

  const request: SubscriptionRuntimeAgentTaskRequest = {
    context: {
      application: applicationName,
      correlationId: input.correlationId,
      metadata: profileMetadata.context,
      purpose: profile.purpose,
    },
    cwd: input.cwd,
    protocolVersion: subscriptionRuntimeProtocolVersion,
    runId: input.requestId,
    task: {
      controls: controls as unknown as SubscriptionRuntimeAgentTaskRequest["task"]["controls"],
      kind: "structured-prompt",
      metadata: profileMetadata.task,
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
  assertCanonicalProfile(candidate);
  assertExactOutputSchema(candidate.task.controls.outputSchema);
}

function reconstructProfileMetadata(
  purpose: string,
  metadata: unknown,
): {
  readonly context: SubscriptionRuntimeAgentTaskRequest["context"]["metadata"];
  readonly task: SubscriptionRuntimeAgentTaskRequest["task"]["metadata"];
} {
  if (purpose === subscriptionRuntimePurpose) {
    const parsed = parseWithPolicy(finalTransportMetadataSchema, metadata);
    return {
      context: {
        meetingId: parsed.meetingId,
        policyVersion: meetingSummaryPolicyVersion,
        transcriptId: parsed.transcriptId,
        transcriptVersion: parsed.transcriptVersion,
      },
      task: {
        executionProfile: "stateless-completion",
        model: subscriptionRuntimeModel,
        policyVersion: meetingSummaryPolicyVersion,
        reasoningEffort: subscriptionRuntimeReasoningEffort,
        runtimeOutput: "structured_output",
        toolsDisabled: "true",
      },
    };
  }
  if (purpose === subscriptionRuntimeIncrementalPurpose) {
    const parsed = parseWithPolicy(incrementalTransportMetadataSchema, metadata);
    return {
      context: {
        meetingId: parsed.meetingId,
        policyVersion: incrementalMeetingSummaryPolicyVersion,
        summaryRevision: parsed.summaryRevision,
        throughTurnCount: parsed.throughTurnCount,
      },
      task: {
        executionProfile: "stateless-completion",
        model: subscriptionRuntimeIncrementalModel,
        policyVersion: incrementalMeetingSummaryPolicyVersion,
        reasoningEffort: subscriptionRuntimeIncrementalReasoningEffort,
        runtimeOutput: "structured_output",
        toolsDisabled: "true",
      },
    };
  }
  throw new RequestPolicyError("request purpose is not admitted");
}

function assertCanonicalProfile(
  request: z.infer<typeof canonicalRequestSchema>,
): void {
  const profile = subscriptionRuntimeProfileForPurpose(request.context.purpose);
  if (
    profile === undefined ||
    request.context.metadata.policyVersion !== profile.policyVersion ||
    valuesDiffer(request.task.controls.model, profile.model) ||
    valuesDiffer(request.task.controls.reasoningEffort, profile.reasoningEffort) ||
    valuesDiffer(request.task.metadata.model, profile.model) ||
    request.task.metadata.policyVersion !== profile.policyVersion ||
    valuesDiffer(request.task.metadata.reasoningEffort, profile.reasoningEffort)
  ) {
    throw new RequestPolicyError("canonical request profile is not admitted");
  }
  const commonMetadata = {
    application: applicationName,
    executionProfile: request.task.metadata.executionProfile,
    meetingId: request.context.metadata.meetingId,
    model: request.task.metadata.model,
    policyVersion: request.task.metadata.policyVersion,
    reasoningEffort: request.task.metadata.reasoningEffort,
    runtimeOutput: request.task.metadata.runtimeOutput,
    toolsDisabled: request.task.metadata.toolsDisabled,
  };
  if (request.context.purpose === subscriptionRuntimePurpose) {
    const metadata = parseWithPolicy(finalContextMetadataSchema, request.context.metadata);
    reconstructProfileMetadata(request.context.purpose, {
      ...commonMetadata,
      transcriptId: metadata.transcriptId,
      transcriptVersion: metadata.transcriptVersion,
    });
    return;
  }
  const metadata = parseWithPolicy(incrementalContextMetadataSchema, request.context.metadata);
  reconstructProfileMetadata(request.context.purpose, {
    ...commonMetadata,
    summaryRevision: metadata.summaryRevision,
    throughTurnCount: metadata.throughTurnCount,
  });
}

function valuesDiffer(actual: string, expected: string): boolean {
  return actual !== expected;
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
