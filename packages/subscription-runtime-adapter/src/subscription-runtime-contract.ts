export const subscriptionRuntimeProtocolVersion = 1 as const;
export const subscriptionRuntimePurpose = "discord_meeting.summary.generate" as const;
export const subscriptionRuntimeProvider = "codex" as const;
export const subscriptionRuntimeModel = "gpt-5.6-sol" as const;
export const subscriptionRuntimeReasoningEffort = "xhigh" as const;
export const subscriptionRuntimeEngine = "subscription-runtime-cli" as const;
export const auditedSubscriptionRuntimePackageVersion = "0.1.0-main.2" as const;
export const meetingSummaryOutputSchemaName = "discord_meeting_summary_v3" as const;
export const meetingSummaryPolicyVersion = "meeting-summary.subscription-runtime.v3" as const;

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
  readonly model: typeof subscriptionRuntimeModel;
  readonly outputKind: "structured_output";
  readonly outputSchema: JsonObject;
  readonly outputSchemaName: typeof meetingSummaryOutputSchemaName;
  readonly permissionMode: "read-only";
  readonly reasoningEffort: typeof subscriptionRuntimeReasoningEffort;
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
      readonly policyVersion: typeof meetingSummaryPolicyVersion;
      readonly transcriptId: string;
      readonly transcriptVersion: string;
    };
    readonly purpose: typeof subscriptionRuntimePurpose;
  };
  readonly cwd: string;
  readonly protocolVersion: typeof subscriptionRuntimeProtocolVersion;
  readonly runId: string;
  readonly task: {
    readonly controls: SubscriptionRuntimeTaskControls;
    readonly kind: "structured-prompt";
    readonly metadata: {
      readonly executionProfile: "stateless-completion";
      readonly model: typeof subscriptionRuntimeModel;
      readonly policyVersion: typeof meetingSummaryPolicyVersion;
      readonly reasoningEffort: typeof subscriptionRuntimeReasoningEffort;
      readonly runtimeOutput: "structured_output";
      readonly toolsDisabled: "true";
    };
    readonly outputSchemaName: typeof meetingSummaryOutputSchemaName;
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

export type SubscriptionRuntimeTaskResult =
  | {
      readonly executionAttestation: SubscriptionRuntimeExecutionAttestation;
      readonly outputText?: string;
      readonly protocolVersion: number;
      readonly status: "completed";
      readonly structuredOutput: JsonObject;
    }
  | {
      readonly failure: SubscriptionRuntimeFailure;
      readonly protocolVersion: number;
      readonly status: "failed";
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
