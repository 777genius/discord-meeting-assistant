import type {
  PortResult,
  PublicationReceiptSnapshot,
  SummaryPublicationPort,
  SummaryPublicationRequest,
} from "@discord-meeting/meeting-core";

import type {
  DiscordProjectionReference,
  PublishDiscordSummary,
} from "./discord-projection.js";
import { toDiscordPublicationFailure } from "./discord-publication-errors.js";

interface DiscordSummaryProjector {
  publish(input: PublishDiscordSummary): Promise<DiscordProjectionReference>;
}

const discordMarkdownLimit = 4_000;
const truncationNotice = "_Саммари сокращено из-за лимита Discord._";

type PublicationResult = PortResult<
  Pick<PublicationReceiptSnapshot, "externalPublicationId">
>;

export class DiscordSummaryPublicationAdapter implements SummaryPublicationPort {
  public constructor(private readonly publisher: DiscordSummaryProjector) {}

  public async publish(request: SummaryPublicationRequest): Promise<PublicationResult> {
    try {
      const reference = await this.publisher.publish({
        projectionKey: request.idempotencyKey,
        parentChannelId: request.publicationTargetId,
        threadTitle: discordThreadTitle(request.summary.title),
        markdown: renderRussianSummaryMarkdown(request),
      });
      return {
        ok: true,
        value: { externalPublicationId: encodeDiscordExternalPublicationId(reference) },
      };
    } catch (error: unknown) {
      return { ok: false, failure: toDiscordPublicationFailure(error) };
    }
  }
}

export function encodeDiscordExternalPublicationId(
  reference: DiscordProjectionReference,
): string {
  return `discord:v1:thread:${reference.threadId}:message:${reference.messageId}`;
}

export function renderRussianSummaryMarkdown(
  request: Pick<SummaryPublicationRequest, "meetingId" | "summary" | "transcript">,
): string {
  const { summary } = request;
  const evidence = new Map(request.transcript.turns.map((turn) => [turn.turnId, turn]));
  const bodyLines = [
    `# ${normalizeInline(summary.title)}`,
    "",
    "## Кратко",
    summary.overview.trim(),
    "",
    "## Основные темы",
    ...numberedOrEmpty(
      summary.topics.map((topic) => [
        topic.title.trim(),
        ...topic.points.map((point) => point.trim()),
        evidenceLine(topic.evidenceTurnIds, evidence),
      ]),
      "Основные темы не выделены.",
    ),
    "",
    "## Решения",
    ...numberedOrEmpty(
      summary.decisions.map((decision) => [
        decision.text.trim(),
        evidenceLine(decision.evidenceTurnIds, evidence),
      ]),
      "Зафиксированных решений нет.",
    ),
    "",
    "## Задачи",
    ...numberedOrEmpty(
      summary.actionItems.map((actionItem) => [
        actionItem.text.trim(),
        `Ответственный: ${
          actionItem.ownerSpeakerId === null
            ? "не назначен"
            : inlineCode(actionItem.ownerSpeakerId)
        }`,
        `Срок: ${
          actionItem.deadline === null ? "не указан" : actionItem.deadline.trim()
        }`,
        evidenceLine(actionItem.evidenceTurnIds, evidence),
      ]),
      "Зафиксированных задач нет.",
    ),
    "",
    "## Открытые вопросы",
    ...(summary.openQuestions.length === 0
      ? ["Открытых вопросов нет."]
      : summary.openQuestions.map((question) => `- ${question.trim()}`)),
  ];
  const footer = `Встреча: ${boundedInlineCode(request.meetingId)} · Саммари: ${boundedInlineCode(summary.summaryId)} · Версия: ${summary.version}`;

  return boundedMarkdown(bodyLines, footer);
}

function boundedMarkdown(bodyLines: readonly string[], footer: string): string {
  const body = bodyLines.join("\n").trimEnd();
  const complete = `${body}\n\n${footer}`;
  if (complete.length <= discordMarkdownLimit) {
    return complete;
  }

  const suffix = `\n\n${truncationNotice}\n\n${footer}`;
  const bodyBudget = discordMarkdownLimit - suffix.length;
  const shortenedBody = truncateAtStableBoundary(body, bodyBudget);
  return `${shortenedBody}${suffix}`;
}

function truncateAtStableBoundary(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value.trimEnd();
  }
  const ellipsis = "…";
  const sliced = safeCodeUnitSlice(value, Math.max(0, maximumLength - ellipsis.length));
  const finalNewline = sliced.lastIndexOf("\n");
  const stable = finalNewline >= sliced.length - 320
    ? sliced.slice(0, finalNewline)
    : sliced;
  return `${stable.trimEnd()}${ellipsis}`;
}

function safeCodeUnitSlice(value: string, maximumLength: number): string {
  let sliced = value.slice(0, maximumLength);
  const finalCodeUnit = sliced.charCodeAt(sliced.length - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) {
    sliced = sliced.slice(0, -1);
  }
  return sliced;
}

function numberedOrEmpty(
  entries: readonly (readonly string[])[],
  emptyMessage: string,
): readonly string[] {
  if (entries.length === 0) {
    return [emptyMessage];
  }

  return entries.flatMap((entry, index) => [
    `${index + 1}. ${entry[0] ?? ""}`,
    ...entry.slice(1).map((line) => `   - ${line}`),
  ]);
}

function evidenceLine(
  evidenceTurnIds: readonly string[],
  evidence: ReadonlyMap<
    string,
    SummaryPublicationRequest["transcript"]["turns"][number]
  >,
): string {
  return `Доказательства: ${evidenceTurnIds.map((turnId) => {
    const turn = evidence.get(turnId);
    if (turn === undefined) {
      return inlineCode(turnId);
    }
    return `${inlineCode(turnId)} [${formatTimestamp(turn.startMs)}-${formatTimestamp(turn.endMs)}] ${inlineCode(turn.speakerId)}`;
  }).join(", ")}`;
}

function formatTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const fraction = milliseconds % 1_000;
  const base = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
  return hours === 0 ? base : `${String(hours).padStart(2, "0")}:${base}`;
}

function inlineCode(value: string): string {
  return `\`${value.trim().replaceAll("`", "ˋ")}\``;
}

function boundedInlineCode(value: string): string {
  const normalized = value.trim().replaceAll("`", "ˋ");
  return inlineCode(
    normalized.length <= 96
      ? normalized
      : `${safeCodeUnitSlice(normalized, 95)}…`,
  );
}

function normalizeInline(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ");
}

function discordThreadTitle(value: string): string {
  const normalized = normalizeInline(value);
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(normalized),
    (segment) => segment.segment,
  ).slice(0, 80).join("");
}
