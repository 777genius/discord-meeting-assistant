import type { LiveMeetingRuntimeDependencies } from "./contracts.js";

const defaultSpeakerIdleFinalizeMs = 750;

export function assertLivePublicationTargetSource(
  dependencies: LiveMeetingRuntimeDependencies,
): void {
  if (
    dependencies.publicationTargets === undefined &&
    dependencies.publicationTargetId === undefined
  ) {
    throw new Error("a live meeting publication target source is required");
  }
}

export function resolveSpeakerIdleFinalizeMs(value: number | undefined): number {
  const resolved = value ?? defaultSpeakerIdleFinalizeMs;
  if (!Number.isSafeInteger(resolved) || resolved < 100 || resolved > 10_000) {
    throw new RangeError("speakerIdleFinalizeMs must be between 100 and 10000");
  }
  return resolved;
}
