import type { SummaryPublicationRequest } from "@discord-meeting/meeting-core/publishing";

import type { DiscordTranscriptLocale } from "./discord-transcript-timeline.js";

export const finalSummaryCopy = {
  en: {
    actionItems: "## Action items", decisions: "## Decisions", due: "Due",
    keyTopics: "## Key topics and details", noActionItems: "No action items were recorded.",
    noDecisions: "No decisions were recorded.", noOpenQuestions: "No open questions were recorded.",
    noTopics: "No key topics were identified.", notSpecified: "not specified",
    openQuestions: "## Open questions", overview: "## Overview", owner: "Owner",
    finalSummaryPublishedTitle: "Final summary published",
    fullSummaryAttachment: "_Full summary with evidence: `meeting-summary.md`._",
    recordingHeading: "## Recording", recordingLink: "Listen to the recording",
    sourceUtteranceUnavailable: "The source utterance is unavailable.",
    truncationNotice: "_Summary was shortened due to Discord's limit._", unassigned: "unassigned",
    updatedAfterFinalProcessing: "Updated after final processing.",
    liveSuperseded: "The preliminary live summary was superseded by the final summary published separately.",
  },
  ru: {
    actionItems: "## Задачи", decisions: "## Решения", due: "Срок",
    keyTopics: "## Ключевые темы и детали", noActionItems: "Задачи не зафиксированы.",
    noDecisions: "Решения не зафиксированы.", noOpenQuestions: "Открытые вопросы не зафиксированы.",
    noTopics: "Ключевые темы не выделены.", notSpecified: "не указан",
    openQuestions: "## Открытые вопросы", overview: "## Кратко", owner: "Ответственный",
    finalSummaryPublishedTitle: "Финальное саммари опубликовано",
    fullSummaryAttachment: "_Полное саммари с основаниями: `meeting-summary.md`._",
    recordingHeading: "## Запись", recordingLink: "Прослушать запись",
    sourceUtteranceUnavailable: "Исходная реплика недоступна.",
    truncationNotice: "_Саммари сокращено из-за лимита Discord._", unassigned: "не назначен",
    updatedAfterFinalProcessing: "Обновлено после завершения финальной обработки.",
    liveSuperseded: "Предварительное live-саммари заменено финальным саммари, опубликованным отдельно.",
  },
  uk: {
    actionItems: "## Завдання", decisions: "## Рішення", due: "Термін",
    keyTopics: "## Ключові теми та деталі", noActionItems: "Завдання не зафіксовані.",
    noDecisions: "Рішення не зафіксовані.", noOpenQuestions: "Відкриті питання не зафіксовані.",
    noTopics: "Ключові теми не виділені.", notSpecified: "не вказаний",
    openQuestions: "## Відкриті питання", overview: "## Коротко", owner: "Відповідальний",
    finalSummaryPublishedTitle: "Фінальне самарі опубліковано",
    fullSummaryAttachment: "_Повне самарі з підтвердженнями: `meeting-summary.md`._",
    recordingHeading: "## Запис", recordingLink: "Прослухати запис",
    sourceUtteranceUnavailable: "Початкова репліка недоступна.",
    truncationNotice: "_Самарі скорочено через ліміт Discord._", unassigned: "не призначений",
    updatedAfterFinalProcessing: "Оновлено після завершення фінальної обробки.",
    liveSuperseded: "Попереднє live-самарі замінено фінальним самарі, опублікованим окремо.",
  },
} as const;

export function dominantTranscriptLocale(
  turns: readonly Pick<
    SummaryPublicationRequest["transcript"]["turns"][number],
    "text"
  >[],
): DiscordTranscriptLocale {
  const transcriptText = turns.map((turn) => turn.text).join(" ");
  const cyrillic = (transcriptText.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const latin = (transcriptText.match(/\p{Script=Latin}/gu) ?? []).length;
  if (cyrillic <= latin) {
    return "en";
  }
  const ukrainianExclusive = (transcriptText.match(/[іїєґ]/giu) ?? []).length;
  const russianExclusive = (transcriptText.match(/[ыэъё]/giu) ?? []).length;
  if (ukrainianExclusive > 0 && russianExclusive === 0) {
    return "uk";
  }
  if (russianExclusive > 0 && ukrainianExclusive === 0) {
    return "ru";
  }
  const words = transcriptText.toLocaleLowerCase().match(/\p{L}+/gu) ?? [];
  const ukrainianScore = ukrainianExclusive * 3 + words.filter((word) => ukrainianMarkers.has(word)).length;
  const russianScore = russianExclusive * 3 + words.filter((word) => russianMarkers.has(word)).length;
  return ukrainianScore > russianScore ? "uk" : "ru";
}

const ukrainianMarkers = new Set([
  "будь", "добре", "додай", "додати", "завдання", "залишити", "користувач",
  "ласка", "можемо", "можна", "налаштувати", "питання", "посилання", "також",
  "треба", "це", "цей", "ця", "якщо", "зробити",
]);
const russianMarkers = new Set([
  "добавить", "добавь", "задача", "если", "можем", "можно", "настроить",
  "нужно", "оставить", "пожалуйста", "пользователь", "решение", "сделать",
  "ссылка", "также", "хорошо", "эта", "это", "этот",
]);
