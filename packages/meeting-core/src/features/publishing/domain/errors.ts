export class PublishingInvariantError extends Error {
  public readonly code = "EMPTY_VALUE";

  public constructor(message: string) {
    super(message);
    this.name = "PublishingInvariantError";
  }
}

export function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new PublishingInvariantError(`${field} must not be empty`);
  }
  return normalized;
}
