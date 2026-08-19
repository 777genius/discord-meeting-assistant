import {
  MeetingKnowledgeInvariantError,
} from "./errors.js";

export type AnswerLocale = "en" | "mixed" | "ru";

const russianRequest = /(?:ответ(?:ь|ьте)|пиши|скажи)?\s*(?:на\s+русском|по-русски|русский\s+язык)/iu;
const englishRequest = /(?:answer|respond|reply|write)\s+(?:me\s+)?(?:in\s+)?english|in\s+english/iu;
const cyrillicLetter = /\p{Script=Cyrillic}/u;
const latinLetter = /\p{Script=Latin}/u;

export function resolveAnswerLocale(question: string): AnswerLocale {
  if (typeof question !== "string") {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_LOCALE",
      "question must be text before locale resolution",
    );
  }
  const requestsRussian = russianRequest.test(question);
  const requestsEnglish = englishRequest.test(question);
  if (requestsRussian || requestsEnglish) {
    return requestsRussian && requestsEnglish
      ? "mixed"
      : requestsRussian
        ? "ru"
        : "en";
  }

  let cyrillic = 0;
  let latin = 0;
  for (const character of question) {
    if (cyrillicLetter.test(character)) {
      cyrillic += 1;
    } else if (latinLetter.test(character)) {
      latin += 1;
    }
  }
  if (cyrillic === 0) {
    return "en";
  }
  if (latin === 0) {
    return "ru";
  }
  const minorityShare = Math.min(cyrillic, latin) / (cyrillic + latin);
  if (minorityShare >= 0.15) {
    return "mixed";
  }
  return cyrillic > latin ? "ru" : "en";
}
