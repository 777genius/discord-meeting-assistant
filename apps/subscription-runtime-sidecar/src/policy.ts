import {
  canonicalJsonSha256,
  subscriptionRuntimeProfileForPurpose,
  subscriptionRuntimeProtocolVersion,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
} from "@discord-meeting/subscription-runtime-adapter";
import { z } from "zod";

import { applicationName } from "./constants.js";
export { RequestPolicyError } from "./policy-error.js";
import { RequestPolicyError } from "./policy-error.js";
import {
  assertCanonicalProfile,
  assertExactOutputSchema,
  reconstructProfileMetadata,
} from "./policy-profile.js";
import {
  canonicalRequestSchema,
  controlsSchema,
  jsonObjectSchema,
  rawGrpcRequestSchema,
} from "./policy-schemas.js";

export interface RequestPolicyOptions {
  readonly isolatedCwd: string;
  readonly maxPromptBytes: number;
  readonly maxTaskTimeoutMs: number;
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
  if (promptByteLength(input.prompt, input.systemPrompt) > options.maxPromptBytes) {
    throw new RequestPolicyError("task prompt exceeds the admitted byte bound");
  }
  const outputSchema = parseJsonObject(input.outputSchemaJson, "output schema");
  const controls = parseWithPolicy(
    controlsSchema,
    parseJsonObject(input.controlsJson, "controls"),
  );
  assertExactOutputSchema(outputSchema, input.purpose);
  if (canonicalJsonSha256(controls.outputSchema) !== canonicalJsonSha256(outputSchema)) {
    throw new RequestPolicyError("controls contain a conflicting output schema");
  }
  const profile = subscriptionRuntimeProfileForPurpose(input.purpose);
  if (
    profile === undefined ||
    controls.model !== profile.model ||
    controls.reasoningEffort !== profile.reasoningEffort ||
    controls.maxOutputTokens !== profile.maxOutputTokens ||
    controls.outputSchemaName !== profile.outputSchemaName
  ) {
    throw new RequestPolicyError("request execution profile is not admitted");
  }
  const profileMetadata = reconstructProfileMetadata(
    input.purpose,
    input.metadata,
    parseWithPolicy,
  );
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
      outputSchemaName: profile.outputSchemaName,
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
    promptByteLength(candidate.task.prompt, candidate.task.systemPrompt) > options.maxPromptBytes
  ) {
    throw new RequestPolicyError("canonical task conflicts with sidecar policy");
  }
  assertCanonicalProfile(candidate, parseWithPolicy);
  assertExactOutputSchema(
    candidate.task.controls.outputSchema,
    candidate.context.purpose,
  );
}

function promptByteLength(prompt: string, systemPrompt: string): number {
  return Buffer.byteLength(prompt, "utf8") + Buffer.byteLength(systemPrompt, "utf8");
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
