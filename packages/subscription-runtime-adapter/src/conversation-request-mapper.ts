import { SubscriptionRuntimeAdapterError } from "./errors.js";
import { providerConversationAnswerJsonSchema } from "./provider-conversation-schema.js";
import { stableSubscriptionRuntimeId } from "./stable-id.js";
import {
  conversationAnswerOutputSchemaName,
  conversationAnswerPolicyVersion,
  subscriptionRuntimeConversationMaxOutputTokens,
  subscriptionRuntimeConversationModel,
  subscriptionRuntimeConversationPurpose,
  subscriptionRuntimeConversationReasoningEffort,
  subscriptionRuntimeProtocolVersion,
  type SubscriptionRuntimeAgentTaskRequest,
} from "./subscription-runtime-contract.js";

export interface SubscriptionRuntimeConversationRequest {
  readonly idempotencyKey: string;
  readonly locale: string;
  readonly meetingId: string;
  readonly prompt: string;
  readonly recordingId: string;
  readonly systemPrompt: string;
  readonly turnId: string;
}

export interface SubscriptionRuntimeConversationRequestOptions {
  readonly isolatedCwd: string;
  readonly maxOutputTokens: number;
  readonly maxPromptBytes: number;
  readonly timeoutMs: number;
}

export function buildSubscriptionRuntimeConversationRequest(
  request: SubscriptionRuntimeConversationRequest,
  options: SubscriptionRuntimeConversationRequestOptions,
): SubscriptionRuntimeAgentTaskRequest {
  validateRequest(request, options);
  const runId = stableSubscriptionRuntimeId(
    "conversation-answer-request",
    request.idempotencyKey,
    request.meetingId,
    request.recordingId,
    request.turnId,
    conversationAnswerPolicyVersion,
  );
  return {
    context: {
      application: "discord-meeting",
      correlationId: runId,
      metadata: {
        locale: request.locale,
        meetingId: request.meetingId,
        policyVersion: conversationAnswerPolicyVersion,
        recordingId: request.recordingId,
        turnId: request.turnId,
      },
      purpose: subscriptionRuntimeConversationPurpose,
    },
    cwd: options.isolatedCwd,
    protocolVersion: subscriptionRuntimeProtocolVersion,
    runId,
    task: {
      controls: {
        allowedTools: [],
        disableTools: true,
        executionProfile: "stateless-completion",
        interactive: false,
        maxOutputTokens: subscriptionRuntimeConversationMaxOutputTokens,
        maxTurns: 1,
        model: subscriptionRuntimeConversationModel,
        outputKind: "structured_output",
        outputSchema: providerConversationAnswerJsonSchema,
        outputSchemaName: conversationAnswerOutputSchemaName,
        permissionMode: "read-only",
        reasoningEffort: subscriptionRuntimeConversationReasoningEffort,
        responseFormat: "json",
        runtimeOutput: "structured_output",
        selectedOutputKind: "structured_output",
      },
      kind: "structured-prompt",
      metadata: {
        executionProfile: "stateless-completion",
        model: subscriptionRuntimeConversationModel,
        policyVersion: conversationAnswerPolicyVersion,
        reasoningEffort: subscriptionRuntimeConversationReasoningEffort,
        runtimeOutput: "structured_output",
        toolsDisabled: "true",
      },
      outputSchemaName: conversationAnswerOutputSchemaName,
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
    },
    timeoutMs: options.timeoutMs,
  };
}

function validateRequest(
  request: SubscriptionRuntimeConversationRequest,
  options: SubscriptionRuntimeConversationRequestOptions,
): void {
  if (options.maxOutputTokens !== subscriptionRuntimeConversationMaxOutputTokens) {
    throw invalidInput(
      `maxOutputTokens must match the admitted conversation profile value ${subscriptionRuntimeConversationMaxOutputTokens}`,
    );
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw invalidInput("timeoutMs must be a positive safe integer");
  }
  for (const [field, value, maximum] of [
    ["idempotencyKey", request.idempotencyKey, 128],
    ["locale", request.locale, 35],
    ["meetingId", request.meetingId, 128],
    ["recordingId", request.recordingId, 128],
    ["turnId", request.turnId, 128],
  ] as const) {
    const normalized = value.trim();
    if (normalized.length < 1 || normalized.length > maximum) {
      throw invalidInput(`${field} is invalid`);
    }
  }
  if (
    request.systemPrompt.trim().length < 1 ||
    request.systemPrompt.length > 16_000 ||
    request.prompt.trim().length < 1 ||
    request.prompt.length > 8_000
  ) {
    throw invalidInput("conversation prompt is invalid");
  }
  const promptBytes = new TextEncoder().encode(
    request.systemPrompt + request.prompt,
  ).byteLength;
  if (promptBytes > options.maxPromptBytes) {
    throw invalidInput("conversation prompt exceeds the configured byte limit");
  }
}

function invalidInput(message: string): SubscriptionRuntimeAdapterError {
  return new SubscriptionRuntimeAdapterError("invalid_input", message);
}
