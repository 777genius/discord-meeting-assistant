import {
  DomainInvariantError,
  requireNonEmpty,
  requirePositiveInteger,
} from "./errors.js";

export type ProcessingStage = "publication" | "summary" | "transcription";

export interface StageFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type StageState =
  | { readonly attempts: 0; readonly status: "pending" }
  | { readonly attempts: number; readonly status: "running" }
  | {
      readonly attempts: number;
      readonly failure: StageFailure;
      readonly status: "failed";
    }
  | { readonly attempts: number; readonly status: "succeeded" };

export type StageStateSnapshot =
  | { readonly attempts: number; readonly status: "pending" }
  | { readonly attempts: number; readonly status: "running" }
  | {
      readonly attempts: number;
      readonly failure: StageFailure;
      readonly status: "failed";
    }
  | { readonly attempts: number; readonly status: "succeeded" };

export type BeginStageDisposition =
  | "already-running"
  | "already-succeeded"
  | "started";

export function validateStageFailure(failure: StageFailure): StageFailure {
  return Object.freeze({
    code: requireNonEmpty(failure.code, "stageFailure.code"),
    message: requireNonEmpty(failure.message, "stageFailure.message"),
    retryable: failure.retryable,
  });
}

export function validateStageState(
  stage: StageStateSnapshot,
  field: string,
): StageState {
  if (stage.status === "pending") {
    if (stage.attempts !== 0) {
      throw new DomainInvariantError(
        "INVALID_SNAPSHOT",
        `${field} pending state must have zero attempts`,
      );
    }
    return Object.freeze({ attempts: 0, status: "pending" });
  }

  const attempts = requirePositiveInteger(stage.attempts, `${field}.attempts`);
  if (stage.status === "failed") {
    return Object.freeze({
      attempts,
      failure: validateStageFailure(stage.failure),
      status: "failed",
    });
  }
  return Object.freeze({ attempts, status: stage.status });
}

export function sameStageFailure(
  left: StageFailure,
  right: StageFailure,
): boolean {
  return left.code === right.code &&
    left.message === right.message &&
    left.retryable === right.retryable;
}
