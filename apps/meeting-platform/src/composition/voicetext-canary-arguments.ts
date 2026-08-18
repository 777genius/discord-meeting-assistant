import type {
  VoicetextBatchProfile,
  VoicetextLiveProfile,
} from "@discord-meeting/voicetext-adapter";

export function isVoicetextBatchProfile(value: string): value is VoicetextBatchProfile {
  return value === "deepgram-nova-3" || value === "elevenlabs-scribe-v2";
}

export function isVoicetextLiveProfile(value: string): value is VoicetextLiveProfile {
  return value === "deepgram-nova-3" || value === "elevenlabs-scribe-v2-realtime";
}

export function requiredBatchProfile(value: string): VoicetextBatchProfile {
  if (!isVoicetextBatchProfile(value)) {
    throw new Error("Voicetext semantic canary batch profile is invalid");
  }
  return value;
}

export function requiredLiveProfile(value: string): VoicetextLiveProfile {
  if (!isVoicetextLiveProfile(value)) {
    throw new Error("Voicetext semantic canary live profile is invalid");
  }
  return value;
}

export function exactCanaryDeadlineMs(value: string): number {
  if (!/^[1-9]\d{0,5}$/u.test(value)) {
    throw new Error("Voicetext semantic canary deadline is invalid");
  }
  const deadlineMs = Number(value);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs > 300_000) {
    throw new Error("Voicetext semantic canary deadline is invalid");
  }
  return deadlineMs;
}

export function exactCanaryKeyterms(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("Voicetext semantic canary keyterms are invalid", { cause: error });
  }
  if (!Array.isArray(parsed) || !areExactCanaryKeyterms(parsed)) {
    throw new Error("Voicetext semantic canary keyterms are invalid");
  }
  return Object.freeze([...parsed]);
}

export function areExactCanaryKeyterms(value: readonly unknown[]): value is readonly string[] {
  if (value.length < 1 || value.length > 100) {return false;}
  const terms = value.filter((term): term is string => typeof term === "string");
  return terms.length === value.length
    && terms.every((term) => term.length <= 100 && term.trim() === term && term.length > 0)
    && new Set(terms).size === terms.length;
}

export function exactCanaryEndpoint(origin: string, path: string): string {
  const originUrl = new URL(origin);
  const endpoint = new URL(path, originUrl);
  if (originUrl.origin !== origin || !path.startsWith("/") || endpoint.origin !== origin) {
    throw new Error("Voicetext semantic canary endpoint is invalid");
  }
  return endpoint.toString();
}
