const defaultSpeakerIdleFinalizeMs = 750;

export function resolveSpeakerIdleFinalizeMs(value: number | undefined): number {
  const resolved = value ?? defaultSpeakerIdleFinalizeMs;
  if (!Number.isSafeInteger(resolved) || resolved < 100 || resolved > 10_000) {
    throw new RangeError("speakerIdleFinalizeMs must be between 100 and 10000");
  }
  return resolved;
}
