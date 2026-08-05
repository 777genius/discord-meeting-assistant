import type {
  SubscriptionRuntimeFailureCode,
  SubscriptionRuntimeTaskResult,
  SubscriptionRuntimeTelemetry,
  SubscriptionRuntimeUsage,
} from "@discord-meeting/subscription-runtime-adapter";

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

interface FailurePolicy {
  readonly causeCategory: string;
  readonly reconnectRequired: boolean;
  readonly retryable: boolean;
  readonly safeMessage: string;
}

export function normalizeFailureCode(
  code: string,
): SubscriptionRuntimeFailureCode {
  return failureCodes.has(code as SubscriptionRuntimeFailureCode)
    ? (code as SubscriptionRuntimeFailureCode)
    : "unknown_runtime_failure";
}

export function failedResult(
  code: SubscriptionRuntimeFailureCode,
  usage?: SubscriptionRuntimeUsage,
  telemetry?: SubscriptionRuntimeTelemetry,
): Extract<SubscriptionRuntimeTaskResult, { readonly status: "failed" }> {
  const policy = failurePolicy(code);
  return {
    failure: {
      causeCategory: policy.causeCategory,
      code,
      reconnectRequired: policy.reconnectRequired,
      retryable: policy.retryable,
      safeMessage: policy.safeMessage,
    },
    protocolVersion: 1,
    status: "failed",
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function failurePolicy(code: SubscriptionRuntimeFailureCode): FailurePolicy {
  switch (code) {
    case "task_timeout":
      return {
        causeCategory: "deadline",
        reconnectRequired: false,
        retryable: true,
        safeMessage: "Subscription runtime task timed out",
      };
    case "needs_reconnect":
    case "provider_session_invalid":
      return {
        causeCategory: "subscription_session",
        reconnectRequired: true,
        retryable: true,
        safeMessage: "Subscription runtime session requires recovery",
      };
    case "quota_limited":
      return {
        causeCategory: "capacity",
        reconnectRequired: false,
        retryable: true,
        safeMessage: "Subscription runtime capacity is temporarily limited",
      };
    case "provider_output_invalid":
    case "task_mode_unsupported":
    case "permission_required":
      return {
        causeCategory: "policy",
        reconnectRequired: false,
        retryable: false,
        safeMessage: "Subscription runtime rejected an unsafe or invalid task result",
      };
    case "telemetry_unavailable":
      return {
        causeCategory: "telemetry",
        reconnectRequired: false,
        retryable: false,
        safeMessage: "Subscription runtime did not return generation telemetry",
      };
    case "task_cancelled":
    case "stale_generation":
    case "backend_unavailable":
    case "unknown_runtime_failure":
      return {
        causeCategory: "subscription_runtime",
        reconnectRequired: false,
        retryable: true,
        safeMessage: "Subscription runtime task is temporarily unavailable",
      };
  }
}
