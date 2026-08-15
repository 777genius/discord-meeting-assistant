import type {
  LiveConversationConfiguration,
  LiveParticipantGreetingProfile,
} from "./contracts.js";

export const exactGreetingSystemPrompt = [
  "Speak exactly the greeting provided by the user.",
  "Do not add, remove, translate, explain, or quote anything.",
  "Return only the greeting itself.",
].join(" ");

export type GreetingAttemptOutcome =
  | "played"
  | "unplayed"
  | "partial"
  | "unknown"
  | "busy"
  | "awaiting-prompt"
  | "ignored"
  | "queued"
  | "reused"
  | "failed";

export interface ResolvedParticipantGreeting {
  readonly locale: "en" | "ru";
  readonly prompt: string;
}

export function participantGreetingProfile(
  configuration: LiveConversationConfiguration,
  participantId: string,
): LiveParticipantGreetingProfile | undefined {
  return configuration.greetings?.profiles[participantId];
}

export function resolveParticipantGreeting(
  configuration: LiveConversationConfiguration,
  participantId: string,
): ResolvedParticipantGreeting | undefined {
  const greetings = configuration.greetings;
  if (
    greetings === undefined ||
    greetings.excludedParticipantIds.includes(participantId)
  ) {
    return undefined;
  }
  const profile = participantGreetingProfile(configuration, participantId);
  if (profile === undefined) {
    const locale = conversationGreetingLocale(
      configuration.locale,
      greetings.defaultLocale,
    );
    return locale === "ru"
      ? { locale: "ru", prompt: "Привет!" }
      : { locale: "en", prompt: "Hi!" };
  }
  return profile.greetingLocale === "ru"
    ? { locale: "ru", prompt: `Привет, ${profile.spokenName}!` }
    : { locale: "en", prompt: `Hi, ${profile.spokenName}!` };
}

function conversationGreetingLocale(
  configuredLocale: string,
  fallback: "en" | "ru",
): "en" | "ru" {
  const normalized = configuredLocale.normalize("NFKC").trim().toLowerCase();
  if (normalized === "ru" || normalized.startsWith("ru-")) {
    return "ru";
  }
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }
  return fallback;
}
