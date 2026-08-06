export type MeetingIntelligenceDomainErrorCode =
  | "DUPLICATE_IDENTIFIER"
  | "EMPTY_VALUE"
  | "EVIDENCE_REQUIRED"
  | "INVALID_EVIDENCE_REFERENCE"
  | "INVALID_NUMBER"
  | "INVALID_OWNER_REFERENCE"
  | "INVALID_SNAPSHOT";

export class DomainInvariantError extends Error {
  public constructor(
    public readonly code: MeetingIntelligenceDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeetingIntelligenceInvariantError";
  }
}

export function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DomainInvariantError("EMPTY_VALUE", `${field} must not be empty`);
  }
  return normalized;
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
