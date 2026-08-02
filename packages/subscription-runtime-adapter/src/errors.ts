import type { StageFailure } from "@discord-meeting/meeting-core";

import type { SubscriptionRuntimeFailure } from "./subscription-runtime-contract.js";

export type SubscriptionRuntimeAdapterErrorCode =
  | "invalid_attestation"
  | "invalid_evidence"
  | "invalid_input"
  | "invalid_provider_response"
  | "telemetry_unavailable";

export class SubscriptionRuntimeAdapterError extends Error {
  public constructor(
    public readonly code: SubscriptionRuntimeAdapterErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "SubscriptionRuntimeAdapterError";
  }
}

export type SubscriptionRuntimeTransportErrorCode =
  | "deadline_exceeded"
  | "invalid_response"
  | "unauthenticated"
  | "unavailable";

export class SubscriptionRuntimeTransportError extends Error {
  public constructor(
    public readonly code: SubscriptionRuntimeTransportErrorCode,
    public readonly retryable: boolean,
    options: ErrorOptions = {},
  ) {
    super("Subscription runtime transport failed", options);
    this.name = "SubscriptionRuntimeTransportError";
  }
}

export function toSubscriptionRuntimePortFailure(error: unknown): StageFailure {
  if (error instanceof SubscriptionRuntimeAdapterError) {
    return {
      code: `SUBSCRIPTION_RUNTIME_SUMMARY_${error.code.toUpperCase()}`,
      message: error.message,
      retryable: false,
    };
  }

  if (error instanceof RuntimeTaskFailureError) {
    return mapRuntimeFailure(error.failure);
  }

  if (error instanceof SubscriptionRuntimeTransportError) {
    return {
      code: `SUBSCRIPTION_RUNTIME_SUMMARY_TRANSPORT_${error.code.toUpperCase()}`,
      message: "Subscription runtime summary transport failed",
      retryable: error.retryable,
    };
  }

  return {
    code: "SUBSCRIPTION_RUNTIME_SUMMARY_TRANSPORT_FAILED",
    message: "Subscription runtime summary transport failed",
    retryable: true,
  };
}

export class RuntimeTaskFailureError extends Error {
  public constructor(public readonly failure: SubscriptionRuntimeFailure) {
    super("Subscription runtime summary task failed");
    this.name = "RuntimeTaskFailureError";
  }
}

function mapRuntimeFailure(failure: SubscriptionRuntimeFailure): StageFailure {
  const retryableByCode = new Set<SubscriptionRuntimeFailure["code"]>([
    "backend_unavailable",
    "needs_reconnect",
    "provider_session_invalid",
    "quota_limited",
    "stale_generation",
    "task_timeout",
  ]);
  const retryable =
    retryableByCode.has(failure.code) ||
    failure.retryable ||
    failure.reconnectRequired;

  return {
    code: `SUBSCRIPTION_RUNTIME_SUMMARY_${failure.code.toUpperCase()}`,
    message: runtimeFailureMessage(failure.code),
    retryable,
  };
}

function runtimeFailureMessage(
  code: SubscriptionRuntimeFailure["code"],
): string {
  switch (code) {
    case "quota_limited":
      return "Subscription runtime account capacity is temporarily limited";
    case "needs_reconnect":
    case "provider_session_invalid":
      return "Subscription runtime account session requires recovery";
    case "task_timeout":
      return "Subscription runtime summary task timed out";
    case "backend_unavailable":
      return "Subscription runtime summary backend is unavailable";
    case "stale_generation":
      return "Subscription runtime session generation changed during execution";
    case "permission_required":
      return "Subscription runtime requested a forbidden permission";
    case "provider_output_invalid":
      return "Subscription runtime returned invalid summary output";
    case "task_mode_unsupported":
      return "Subscription runtime rejected the summary execution profile";
    case "telemetry_unavailable":
      return "Subscription runtime did not return complete generation telemetry";
    case "task_cancelled":
      return "Subscription runtime summary task was cancelled";
    case "unknown_runtime_failure":
      return "Subscription runtime summary task failed";
  }
}
