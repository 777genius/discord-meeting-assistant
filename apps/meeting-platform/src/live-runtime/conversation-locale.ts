import {
  detectAddressedConversation,
} from "@discord-meeting/meeting-core/conversation";

const russianLetter = /[а-яё]/giu;
const englishLetter = /[a-z]/giu;

/** Resolves cue and voice locale without coupling the runtime to an STT SDK. */
export function resolveConversationLocale(
  configuredLocale: string,
  transcriptText: string,
): string {
  if (configuredLocale.trim().toLowerCase() !== "auto") {
    return configuredLocale;
  }
  const addressed = detectAddressedConversation(transcriptText);
  const content = addressed?.usedFallbackPrompt === false
    ? addressed.prompt
    : addressed === null
      ? transcriptText
      : "";
  const russianLetters = content.match(russianLetter)?.length ?? 0;
  const englishLetters = content.match(englishLetter)?.length ?? 0;
  if (russianLetters === 0 && englishLetters === 0) {
    return "auto";
  }
  return russianLetters >= englishLetters ? "ru" : "en";
}
