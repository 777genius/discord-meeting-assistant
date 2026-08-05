import type { PostCallObserver } from "@discord-meeting/bullmq-adapter";
import type { Logger, PrometheusMetrics } from "@discord-meeting/observability-adapter";
import { RecordingIngressError } from "@discord-meeting/recording-ingress-adapter";

import type { RecordingIngressRejection } from "../application/recording-ingress.js";

export function classifyPlatformError(
  error: unknown,
): Readonly<Record<string, unknown>> {
  if (error instanceof RecordingIngressError) {
    return {
      errorCode: error.code,
      failure: error.failure,
    };
  }
  if (error instanceof Error) {
    const errorWithCode = error as Error & { readonly code?: unknown };
    return {
      errorCode:
        typeof errorWithCode.code === "string"
          ? errorWithCode.code
          : "UNEXPECTED_ERROR",
      errorName: error.name,
    };
  }
  return { errorCode: "UNEXPECTED_THROWABLE" };
}

export function classifyRecordingIngressRejection(
  error: unknown,
): RecordingIngressRejection | null {
  if (!(error instanceof RecordingIngressError)) {
    return null;
  }
  switch (error.failure) {
    case "invalid-input":
    case "path-policy":
    case "unsupported-event":
      return "invalid-request";
    case "conflicting-duplicate":
    case "invalid-state":
      return "conflict";
    case "limit-exceeded":
      return "limit-exceeded";
    case "aborted":
    case "artifact-write-mismatch":
    case "corrupt-spool":
      return null;
  }
}

export function createQueueObserver(
  logger: Logger,
  metrics: PrometheusMetrics,
): PostCallObserver {
  return (event) => {
    if (event.kind === "job-requeued") {
      logger.info("Post-call job requeued after cancellation", {
        jobRef: event.jobRef,
      });
    }
    if (event.kind === "job-failed" && event.retryable === true) {
      metrics.recordQueueRetry("transient");
    }
    if (event.kind === "dead-letter-recorded") {
      metrics.recordDeadLetter("attempts-exhausted");
    }
    if (event.kind === "runtime-error") {
      logger.warn("Post-call queue runtime error", {
        component: event.component,
      });
    }
  };
}
