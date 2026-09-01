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

const maximumPersonalizedNamesPerCohort = 7;

/** Bounded cohort copy: configured names are literal and every other human is counted. */
export function resolveParticipantGreetingCohort(
  configuration: LiveConversationConfiguration,
  participantIds: readonly string[],
): ResolvedParticipantGreeting {
  const representedNamedParticipantIds = new Set(
    participantIds
      .filter((participantId) =>
        participantGreetingProfile(configuration, participantId) !== undefined
      )
      .slice(0, maximumPersonalizedNamesPerCohort),
  );
  const groups = (["ru", "en"] as const).flatMap((locale) => {
    const members = participantIds.filter((participantId) =>
      resolveParticipantGreeting(configuration, participantId)?.locale === locale
    );
    if (members.length === 0) {
      return [];
    }
    const names = members.flatMap((participantId) => {
      const profile = participantGreetingProfile(configuration, participantId);
      return profile === undefined || !representedNamedParticipantIds.has(participantId)
        ? []
        : [profile.spokenName];
    });
    const anonymousCount = members.length - names.length;
    const represented = [
      ...names,
      ...(anonymousCount === 0
        ? []
        : [locale === "ru"
            ? russianGuestCount(anonymousCount)
            : anonymousCount === 1 ? "one guest" : `${anonymousCount} guests`]),
    ].join(", ");
    return [locale === "ru" ? `Привет, ${represented}!` : `Hi, ${represented}!`];
  });
  const locale = participantIds.some((participantId) =>
    resolveParticipantGreeting(configuration, participantId)?.locale === "ru"
  ) ? "ru" : "en";
  return {
    locale,
    prompt: groups.join(" "),
  };
}

function russianGuestCount(count: number): string {
  if (count === 1) {
    return "один гость";
  }
  const finalTwoDigits = count % 100;
  const finalDigit = count % 10;
  if (finalTwoDigits >= 11 && finalTwoDigits <= 14) {
    return `${count} гостей`;
  }
  if (finalDigit >= 2 && finalDigit <= 4) {
    return `${count} гостя`;
  }
  return `${count} гостей`;
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
