export type MeetingLifecycleDomainErrorCode =
  | "CONFLICTING_COMPLETION"
  | "DUPLICATE_IDENTIFIER"
  | "EMPTY_VALUE"
  | "INVALID_EVIDENCE_REFERENCE"
  | "INVALID_LIFECYCLE_STATE"
  | "INVALID_NUMBER"
  | "INVALID_RECORDING_REFERENCE"
  | "INVALID_SNAPSHOT"
  | "STAGE_NOT_RETRYABLE";

export class DomainInvariantError extends Error {
  public constructor(
    public readonly code: MeetingLifecycleDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeetingLifecycleInvariantError";
  }
}

export function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DomainInvariantError("EMPTY_VALUE", `${field} must not be empty`);
  }
  return normalized;
}

export function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainInvariantError(
      "INVALID_NUMBER",
      `${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

export function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainInvariantError(
      "INVALID_NUMBER",
      `${field} must be a positive safe integer`,
    );
  }
  return value;
}
