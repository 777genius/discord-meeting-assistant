const RECOVERY_DELAYS_MS = Object.freeze([
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
]);

/**
 * Returns a bounded delay for a one-based durable recovery generation.
 * Later generations remain recoverable without increasing provider pressure.
 */
export function postCallRecoveryDelayMs(recoveryGeneration: number): number {
  if (!Number.isSafeInteger(recoveryGeneration) || recoveryGeneration < 1) {
    throw new RangeError("post-call recovery generation must be a positive safe integer");
  }
  return RECOVERY_DELAYS_MS[
    Math.min(recoveryGeneration, RECOVERY_DELAYS_MS.length) - 1
  ]!;
}
