export type MeetingKnowledgeInvariantCode =
  | "DUPLICATE_EVIDENCE"
  | "INVALID_BINDING"
  | "INVALID_EVIDENCE"
  | "INVALID_GROUNDING_PLAN"
  | "INVALID_LOCALE"
  | "INVALID_PROVIDER_ANSWER"
  | "INVALID_TRANSITION"
  | "UNSAFE_OUTPUT"
  | "UNSUPPORTED_SIZE";

export class MeetingKnowledgeInvariantError extends Error {
  public override readonly name = "MeetingKnowledgeInvariantError";

  public constructor(
    public readonly code: MeetingKnowledgeInvariantCode,
    message: string,
  ) {
    super(message);
  }
}

export function requireKnowledgeText(
  value: string,
  field: string,
  maximumLength = 4_096,
): string {
  if (typeof value !== "string") {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_BINDING",
      `${field} must be text`,
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_BINDING",
      `${field} must contain between 1 and ${maximumLength} characters`,
    );
  }
  return normalized;
}

export function requireKnowledgeInteger(
  value: number,
  field: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_BINDING",
      `${field} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

export function requireSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_BINDING",
      `${field} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}
