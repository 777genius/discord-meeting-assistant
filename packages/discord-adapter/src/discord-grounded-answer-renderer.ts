import {
  MeetingKnowledgeInvariantError,
  type AnswerLocale,
  type FinalReplyRendererPort,
  type FixedFinalReplyOutcome,
  type GroundedAnswer,
  type GroundingEvidence,
} from "@discord-meeting/meeting-core/meeting-knowledge";

function formatTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function escapeDiscordMarkdown(value: string): string {
  return value.replace(/([\\*_~|>`#[\]()])/gu, "\\$1");
}

const fixedReplies: Readonly<
  Record<AnswerLocale, Readonly<Record<FixedFinalReplyOutcome, string>>>
> = Object.freeze({
  en: Object.freeze({
    insufficient_evidence: "There is not enough confirmed meeting evidence to answer that.",
    not_a_question: "This reply does not appear to contain a question.",
    processing: "The meeting evidence is still being processed. Please try again later.",
    unavailable: "A grounded answer is currently unavailable. Please try again later.",
    unsupported_size: "This meeting is too large for the currently qualified answer profile.",
  }),
  mixed: Object.freeze({
    insufficient_evidence: "Недостаточно подтверждённых данных / Not enough confirmed meeting evidence.",
    not_a_question: "В сообщении нет вопроса / This reply does not appear to be a question.",
    processing: "Данные ещё обрабатываются / The meeting evidence is still being processed.",
    unavailable: "Ответ сейчас недоступен / The grounded answer is currently unavailable.",
    unsupported_size: "Встреча слишком большая / The meeting is too large for the qualified profile.",
  }),
  ru: Object.freeze({
    insufficient_evidence: "Недостаточно подтверждённых данных встречи, чтобы ответить.",
    not_a_question: "Похоже, в этом сообщении нет вопроса.",
    processing: "Данные встречи ещё обрабатываются. Попробуйте позже.",
    unavailable: "Подтверждённый ответ сейчас недоступен. Попробуйте позже.",
    unsupported_size: "Встреча слишком большая для текущего проверенного профиля ответов.",
  }),
});

/** Owns Discord markdown, localization, and stable citation presentation. */
export class DiscordGroundedAnswerRenderer implements FinalReplyRendererPort {
  public renderAnswer(input: {
    readonly answer: GroundedAnswer;
    readonly evidence: readonly GroundingEvidence[];
    readonly maximumCharacters: number;
  }): string {
    if (input.answer.status !== "answered") {
      return this.renderFixed({
        locale: input.answer.locale,
        outcome: input.answer.status,
      });
    }
    const evidenceById = new Map(
      input.evidence.map((item) => [item.evidenceId, item]),
    );
    const speakerOrder = new Map<string, number>();
    for (const item of input.evidence) {
      if (!speakerOrder.has(item.speakerId)) {
        speakerOrder.set(item.speakerId, speakerOrder.size + 1);
      }
    }
    const renderedClaims = input.answer.claims.map((claim) => {
      if (claim.support === "complete_coverage_absence") {
        const proof = input.answer.locale === "ru"
          ? "Проверены все разрешённые блоки"
          : input.answer.locale === "mixed"
            ? "Проверены все разрешённые блоки / All authorized blocks checked"
            : "All authorized blocks checked";
        return `${escapeDiscordMarkdown(claim.text)}\n-# ${proof}`;
      }
      const citations = claim.evidenceIds.map((evidenceId) => {
        const item = evidenceById.get(evidenceId);
        if (item === undefined) {
          throw new MeetingKnowledgeInvariantError(
            "INVALID_PROVIDER_ANSWER",
            "rendering requires every citation to be locally rehydrated",
          );
        }
        const speaker = speakerOrder.get(item.speakerId);
        if (speaker === undefined) {
          throw new MeetingKnowledgeInvariantError(
            "INVALID_PROVIDER_ANSWER",
            "rendering could not resolve a stable speaker reference",
          );
        }
        return `S${speaker} · ${formatTime(item.startMs)} · ${escapeDiscordMarkdown(item.turnId)}`;
      }).join("; ");
      return `${escapeDiscordMarkdown(claim.text)}\n-# ${citations}`;
    });
    const rendered = renderedClaims.join("\n\n");
    if (
      !Number.isSafeInteger(input.maximumCharacters) ||
      input.maximumCharacters < 1 ||
      rendered.length > input.maximumCharacters
    ) {
      throw new MeetingKnowledgeInvariantError(
        "UNSUPPORTED_SIZE",
        "the complete answer cannot fit one message",
      );
    }
    return rendered;
  }

  public renderFixed(input: {
    readonly locale: AnswerLocale;
    readonly outcome: FixedFinalReplyOutcome;
  }): string {
    return fixedReplies[input.locale][input.outcome];
  }
}
