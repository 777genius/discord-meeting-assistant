import { RecordingIngressError } from "./errors.js";

export function parseCompletedAuthoritativeDuration(
  value: unknown,
  required: boolean,
): number | undefined {
  if (value === undefined) {
    if (required) {
      throw new RecordingIngressError(
        "corrupt-spool",
        "authoritative duration is missing",
      );
    }
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "invalid authoritative recording duration",
    );
  }
  return value;
}
