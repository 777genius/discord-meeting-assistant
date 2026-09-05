import { createHash } from "node:crypto";

import type {
  GeneratedSummary,
  SummaryGenerationPort,
  SummaryGenerationRequest,
  SummaryGenerationResult,
} from "@discord-meeting/meeting-core/meeting-intelligence";

export interface SummaryProviderHealth {
  readonly status: "degraded" | "not_serving" | "serving";
}

/**
 * Providerless final-summary policy for the self-hosted OSS topology.
 * It deliberately does not infer decisions or actions: the authoritative
 * transcript remains the evidence and the outline only reports its size.
 */
export class TranscriptOutlineSummaryAdapter implements SummaryGenerationPort {
  public async generate(
    request: SummaryGenerationRequest,
  ): Promise<SummaryGenerationResult<GeneratedSummary>> {
    const turnCount = request.transcript.turns.length;
    const presentation = outlinePresentation(
      request.transcript.turns.map(({ text }) => text),
      turnCount,
    );
    return {
      ok: true,
      value: {
        actionItems: [],
        decisions: [],
        openQuestions: [],
        overview: presentation.overview,
        summaryId: stableSummaryId(request),
        title: presentation.title,
        topics: [],
        version: 1,
      },
    };
  }

  public async checkHealth(): Promise<SummaryProviderHealth> {
    return { status: "serving" };
  }
}

interface OutlinePresentation {
  readonly overview: string;
  readonly title: string;
}

const ukrainianMarkers = new Set([
  "будь", "добре", "додай", "додати", "завдання", "користувач", "ласка",
  "можемо", "можна", "налаштувати", "питання", "посилання", "також", "треба",
  "це", "цей", "ця", "якщо", "залишити", "зробити",
]);
const russianMarkers = new Set([
  "добавить", "добавь", "задача", "если", "можем", "можно", "настроить",
  "нужно", "оставить", "пожалуйста", "пользователь", "решение", "сделать",
  "ссылка", "также", "хорошо", "эта", "это", "этот",
]);

function outlinePresentation(
  turns: readonly string[],
  turnCount: number,
): OutlinePresentation {
  const locale = transcriptPresentationLocale(turns.join(" "));
  if (locale === "uk") {
    return {
      overview: `Фінальний транскрипт складено за записом зустрічі. Реплік: ${turnCount}. Повну версію додано для перевірки.`,
      title: "Транскрипт зустрічі",
    };
  }
  if (locale === "ru") {
    return {
      overview: `Финальный транскрипт составлен по записи встречи. Реплик: ${turnCount}. Полная версия приложена для проверки.`,
      title: "Транскрипт встречи",
    };
  }
  return {
    overview: `Authoritative transcript finalized with ${turnCount} turn${turnCount === 1 ? "" : "s"}. See the attached transcript for complete evidence.`,
    title: "Meeting transcript",
  };
}

function transcriptPresentationLocale(text: string): "en" | "ru" | "uk" {
  const cyrillicLetters = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latinLetters = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (cyrillicLetters <= latinLetters) {
    return "en";
  }
  const ukrainianExclusiveLetters = text.match(/[іїєґ]/giu)?.length ?? 0;
  const russianExclusiveLetters = text.match(/[ыэъё]/giu)?.length ?? 0;
  if (ukrainianExclusiveLetters > 0 && russianExclusiveLetters === 0) {
    return "uk";
  }
  if (russianExclusiveLetters > 0 && ukrainianExclusiveLetters === 0) {
    return "ru";
  }
  const words = text.toLocaleLowerCase().match(/\p{L}+/gu) ?? [];
  const ukrainianScore = ukrainianExclusiveLetters * 3 +
    words.filter((word) => ukrainianMarkers.has(word)).length;
  const russianScore = russianExclusiveLetters * 3 +
    words.filter((word) => russianMarkers.has(word)).length;
  return ukrainianScore > russianScore ? "uk" : "ru";
}

function stableSummaryId(request: SummaryGenerationRequest): string {
  return `outline-${createHash("sha256")
    .update(`${request.meetingId}\0${request.idempotencyKey}\0${request.transcript.transcriptId}`)
    .digest("hex")
    .slice(0, 32)}`;
}
