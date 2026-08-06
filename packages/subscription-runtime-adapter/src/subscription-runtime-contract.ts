export const subscriptionRuntimeProtocolVersion = 1 as const;
export const subscriptionRuntimePurpose = "discord_meeting.summary.generate" as const;
export const subscriptionRuntimeIncrementalPurpose = "discord_meeting.summary.incremental" as const;
export const subscriptionRuntimeConversationPurpose = "discord_meeting.conversation.answer" as const;
export const subscriptionRuntimeProvider = "codex" as const;
export const subscriptionRuntimeModel = "gpt-5.6-sol" as const;
export const subscriptionRuntimeIncrementalModel = "gpt-5.6-luna" as const;
export const subscriptionRuntimeConversationModel = "gpt-5.6-luna" as const;
export const subscriptionRuntimeReasoningEffort = "medium" as const;
export const subscriptionRuntimeIncrementalReasoningEffort = "low" as const;
export const subscriptionRuntimeConversationReasoningEffort = "low" as const;
export const subscriptionRuntimeSummaryMaxOutputTokens = 2_048 as const;
export const subscriptionRuntimeIncrementalMaxOutputTokens = 2_048 as const;
export const subscriptionRuntimeConversationMaxOutputTokens = 512 as const;
export const subscriptionRuntimeEngine = "subscription-runtime-app-server" as const;
export const subscriptionRuntimeCliEngine = "subscription-runtime-cli" as const;
export type SubscriptionRuntimeEngine =
  | typeof subscriptionRuntimeEngine
  | typeof subscriptionRuntimeCliEngine;
export const auditedSubscriptionRuntimePackageVersion = "0.1.0-main.27" as const;
export const meetingSummaryOutputSchemaName = "discord_meeting_summary_v4" as const;
export const incrementalMeetingSummaryOutputSchemaName = "discord_meeting_incremental_summary_v1" as const;
export const conversationAnswerOutputSchemaName = "discord_meeting_conversation_answer_v1" as const;
export const meetingSummaryPolicyVersion = "meeting-summary.subscription-runtime.v12" as const;
export const incrementalMeetingSummaryPolicyVersion = "meeting-summary.incremental.subscription-runtime.v5" as const;
export const conversationAnswerPolicyVersion = "meeting-conversation.subscription-runtime.v1" as const;

export type SubscriptionRuntimeOutputSchemaName =
  | typeof conversationAnswerOutputSchemaName
  | typeof incrementalMeetingSummaryOutputSchemaName
  | typeof meetingSummaryOutputSchemaName;

export interface SubscriptionRuntimeExecutionProfile {
  readonly maxOutputTokens:
    | typeof subscriptionRuntimeConversationMaxOutputTokens
    | typeof subscriptionRuntimeSummaryMaxOutputTokens;
  readonly model:
    | typeof subscriptionRuntimeIncrementalModel
    | typeof subscriptionRuntimeModel;
  readonly outputSchemaName: SubscriptionRuntimeOutputSchemaName;
  readonly policyVersion:
    | typeof conversationAnswerPolicyVersion
    | typeof incrementalMeetingSummaryPolicyVersion
    | typeof meetingSummaryPolicyVersion;
  readonly purpose:
    | typeof subscriptionRuntimeConversationPurpose
    | typeof subscriptionRuntimeIncrementalPurpose
    | typeof subscriptionRuntimePurpose;
  readonly reasoningEffort:
    | typeof subscriptionRuntimeIncrementalReasoningEffort
    | typeof subscriptionRuntimeReasoningEffort;
}

export const finalSummaryExecutionProfile: SubscriptionRuntimeExecutionProfile = Object.freeze({
  maxOutputTokens: subscriptionRuntimeSummaryMaxOutputTokens,
  model: subscriptionRuntimeModel,
  outputSchemaName: meetingSummaryOutputSchemaName,
  policyVersion: meetingSummaryPolicyVersion,
  purpose: subscriptionRuntimePurpose,
  reasoningEffort: subscriptionRuntimeReasoningEffort,
});

export const incrementalSummaryExecutionProfile: SubscriptionRuntimeExecutionProfile = Object.freeze({
  maxOutputTokens: subscriptionRuntimeIncrementalMaxOutputTokens,
  model: subscriptionRuntimeIncrementalModel,
  outputSchemaName: incrementalMeetingSummaryOutputSchemaName,
  policyVersion: incrementalMeetingSummaryPolicyVersion,
  purpose: subscriptionRuntimeIncrementalPurpose,
  reasoningEffort: subscriptionRuntimeIncrementalReasoningEffort,
});

export const conversationAnswerExecutionProfile: SubscriptionRuntimeExecutionProfile = Object.freeze({
  maxOutputTokens: subscriptionRuntimeConversationMaxOutputTokens,
  model: subscriptionRuntimeConversationModel,
  outputSchemaName: conversationAnswerOutputSchemaName,
  policyVersion: conversationAnswerPolicyVersion,
  purpose: subscriptionRuntimeConversationPurpose,
  reasoningEffort: subscriptionRuntimeConversationReasoningEffort,
});

export const admittedSubscriptionRuntimeExecutionProfiles = Object.freeze([
  conversationAnswerExecutionProfile,
  finalSummaryExecutionProfile,
  incrementalSummaryExecutionProfile,
]);

export const admittedSummaryExecutionProfiles = Object.freeze([
  finalSummaryExecutionProfile,
  incrementalSummaryExecutionProfile,
]);

export function subscriptionRuntimeProfileForPurpose(
  purpose: string,
): SubscriptionRuntimeExecutionProfile | undefined {
  return admittedSubscriptionRuntimeExecutionProfiles.find((profile) => profile.purpose === purpose);
}

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface SubscriptionRuntimeTaskControls extends JsonObject {
  readonly allowedTools: readonly [];
  readonly disableTools: true;
  readonly executionProfile: "stateless-completion";
  readonly interactive: false;
  readonly maxOutputTokens: number;
  readonly maxTurns: 1;
  readonly model: SubscriptionRuntimeExecutionProfile["model"];
  readonly outputKind: "structured_output";
  readonly outputSchema: JsonObject;
  readonly outputSchemaName: SubscriptionRuntimeOutputSchemaName;
  readonly permissionMode: "read-only";
  readonly reasoningEffort: SubscriptionRuntimeExecutionProfile["reasoningEffort"];
  readonly responseFormat: "json";
  readonly runtimeOutput: "structured_output";
  readonly selectedOutputKind: "structured_output";
}

export interface SubscriptionRuntimeAgentTaskRequest extends JsonObject {
  readonly context: {
    readonly application: "discord-meeting";
    readonly correlationId: string;
    readonly metadata: {
      readonly meetingId: string;
      readonly policyVersion: SubscriptionRuntimeExecutionProfile["policyVersion"];
      readonly locale?: string;
      readonly recordingId?: string;
      readonly summaryRevision?: string;
      readonly throughTurnCount?: string;
      readonly transcriptId?: string;
      readonly transcriptVersion?: string;
      readonly turnId?: string;
    } & JsonObject;
    readonly purpose: SubscriptionRuntimeExecutionProfile["purpose"];
  };
  readonly cwd: string;
  readonly protocolVersion: typeof subscriptionRuntimeProtocolVersion;
  readonly runId: string;
  readonly task: {
    readonly controls: SubscriptionRuntimeTaskControls;
    readonly kind: "structured-prompt";
    readonly metadata: {
      readonly executionProfile: "stateless-completion";
      readonly model: SubscriptionRuntimeExecutionProfile["model"];
      readonly policyVersion: SubscriptionRuntimeExecutionProfile["policyVersion"];
      readonly reasoningEffort: SubscriptionRuntimeExecutionProfile["reasoningEffort"];
      readonly runtimeOutput: "structured_output";
      readonly toolsDisabled: "true";
    };
    readonly outputSchemaName: SubscriptionRuntimeOutputSchemaName;
    readonly prompt: string;
    readonly systemPrompt: string;
  };
  readonly timeoutMs: number;
}

export type SubscriptionRuntimeFailureCode =
  | "backend_unavailable"
  | "needs_reconnect"
  | "permission_required"
  | "provider_output_invalid"
  | "provider_session_invalid"
  | "quota_limited"
  | "stale_generation"
  | "task_cancelled"
  | "task_mode_unsupported"
  | "task_timeout"
  | "telemetry_unavailable"
  | "unknown_runtime_failure";

export interface SubscriptionRuntimeFailure {
  readonly causeCategory?: string;
  readonly code: SubscriptionRuntimeFailureCode;
  readonly reconnectRequired: boolean;
  readonly retryable: boolean;
  readonly safeMessage: string;
}

export interface SubscriptionRuntimeExecutionAttestation {
  readonly canonicalRequestSha256: string;
  readonly launcherSha256: string;
  readonly model: string;
  readonly provider: string;
  readonly purpose: string;
  readonly reasoningEffort: string;
  readonly requestId: string;
  readonly runtimeEngine: string;
  readonly runtimePackageVersion: string;
  readonly schemaVersion: number;
  readonly selectedOutputKind: string;
  readonly selectedOutputSha256: string;
}

export interface SubscriptionRuntimeUsage {
  readonly cacheWriteInputTokens: number;
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

/**
 * A token class is never represented by a synthetic zero. `derived` is only
 * used when the runtime documents the relationship used to calculate it.
 */
export type SubscriptionRuntimeTokenAvailability =
  | {
      readonly availability: "measured";
      readonly value: number;
    }
  | {
      readonly availability: "derived";
      readonly derivedFrom: readonly ["inputTokens", "outputTokens"];
      readonly value: number;
    }
  | {
      readonly availability: "unavailable";
    };

export interface SubscriptionRuntimeCostRange {
  readonly exactUsd?: number;
  readonly maximumUsd: number;
  readonly minimumUsd: number;
  readonly priceCardId: string;
  readonly priceCardSource: string;
}

/**
 * Lossless telemetry for runtimes that report only a subset of token classes.
 * `usage` remains available only for fully measured legacy consumers.
 */
export interface SubscriptionRuntimeTelemetry {
  readonly cacheWriteInputTokens: SubscriptionRuntimeTokenAvailability;
  readonly cachedInputTokens: SubscriptionRuntimeTokenAvailability;
  readonly cost?: SubscriptionRuntimeCostRange;
  readonly inputTokens: SubscriptionRuntimeTokenAvailability;
  readonly outputTokens: SubscriptionRuntimeTokenAvailability;
  readonly reasoningOutputTokens: SubscriptionRuntimeTokenAvailability;
  readonly source: "codex_exec_jsonl" | "runtime_bridge";
  readonly totalTokens: SubscriptionRuntimeTokenAvailability;
}

export type SubscriptionRuntimeTaskResult =
  | {
      readonly executionAttestation: SubscriptionRuntimeExecutionAttestation;
      readonly outputText?: string;
      readonly protocolVersion: number;
      readonly status: "completed";
      readonly structuredOutput: JsonObject;
      /** Includes measured, derived, and unavailable token classes. */
      readonly telemetry?: SubscriptionRuntimeTelemetry;
      /** Present only when every token class was measured by the runtime. */
      readonly usage?: SubscriptionRuntimeUsage;
    }
  | {
      readonly failure: SubscriptionRuntimeFailure;
      readonly protocolVersion: number;
      readonly status: "failed";
      /** Includes measured, derived, and unavailable token classes. */
      readonly telemetry?: SubscriptionRuntimeTelemetry;
      /** Present only when every provider token class was reported. */
      readonly usage?: SubscriptionRuntimeUsage;
    }
  | {
      readonly protocolVersion: number;
      readonly status: "waiting_for_input";
    };

export type SubscriptionRuntimeHealthStatus =
  | "degraded"
  | "not_serving"
  | "serving";

export interface SubscriptionRuntimeHealthResult {
  readonly launcherSha256?: string;
  readonly runtimeEngine: string;
  readonly runtimeVersion: string;
  readonly status: SubscriptionRuntimeHealthStatus;
  readonly warningCodes: readonly string[];
}

export interface SubscriptionRuntimeTransportPort {
  checkHealth(): Promise<SubscriptionRuntimeHealthResult>;

  execute(
    request: SubscriptionRuntimeAgentTaskRequest,
  ): Promise<SubscriptionRuntimeTaskResult>;
}
