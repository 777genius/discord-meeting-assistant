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
import {
  createMeetingDiscordProjectionKey,
  encodeDiscordExternalPublicationId,
} from "./discord-projection.js";
import {
  escapeDiscordMarkdown,
  formatDiscordSpeaker,
  formatDiscordTimestamp,
  truncateDiscordCodeUnits,
  truncateDiscordGraphemesByCodeUnits,
} from "./discord-markdown-formatting.js";
import { toDiscordPublicationFailure } from "./discord-publication-errors.js";

interface DiscordSummaryProjector {
  publish(input: PublishDiscordSummary): Promise<DiscordProjectionReference>;
}

const discordMarkdownLimit = 4_000;
const truncationNotice = "_Саммари сокращено из-за лимита Discord._";
const maximumEvidenceQuoteGraphemes = 180;

type PublicationResult = PortResult<
  Pick<PublicationReceiptSnapshot, "externalPublicationId">
>;

export class DiscordSummaryPublicationAdapter implements SummaryPublicationPort {
  public constructor(private readonly publisher: DiscordSummaryProjector) {}

  public async publish(request: SummaryPublicationRequest): Promise<PublicationResult> {
    try {
      const reference = await this.publisher.publish({
        projectionKey: createMeetingDiscordProjectionKey(
          request.meetingId,
          request.publicationTargetId,
        ),
        legacyProjectionKeys: [request.idempotencyKey],
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
        ...evidenceLines(topic.evidenceTurnIds, evidence),
      ]),
      "Основные темы не выделены.",
    ),
    "",
    "## Решения",
    ...numberedOrEmpty(
      summary.decisions.map((decision) => [
        decision.text.trim(),
        ...evidenceLines(decision.evidenceTurnIds, evidence),
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
            : formatDiscordSpeaker(actionItem.ownerSpeakerId)
        }`,
        `Срок: ${
          actionItem.deadline === null ? "не указан" : actionItem.deadline.trim()
        }`,
        ...evidenceLines(actionItem.evidenceTurnIds, evidence),
      ]),
      "Зафиксированных задач нет.",
    ),
    "",
    "## Открытые вопросы",
    ...numberedOrEmpty(
      summary.openQuestions.map((question) => [
        question.text.trim(),
        ...evidenceLines(question.evidenceTurnIds, evidence),
      ]),
      "Открытых вопросов нет.",
    ),
  ];
  return boundedMarkdown(bodyLines);
}

function boundedMarkdown(bodyLines: readonly string[]): string {
  const body = bodyLines.join("\n").trimEnd();
  if (body.length <= discordMarkdownLimit) {
    return body;
  }

  const suffix = `\n\n${truncationNotice}`;
  const bodyBudget = discordMarkdownLimit - suffix.length;
  const shortenedBody = truncateAtStableBoundary(body, bodyBudget);
  return `${shortenedBody}${suffix}`;
}

function truncateAtStableBoundary(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value.trimEnd();
  }
  const ellipsis = "…";
  const sliced = truncateDiscordCodeUnits(value, Math.max(0, maximumLength - ellipsis.length));
  const finalNewline = sliced.lastIndexOf("\n");
  const stable = finalNewline >= sliced.length - 320
    ? sliced.slice(0, finalNewline)
    : sliced;
  return `${stable.trimEnd()}${ellipsis}`;
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

function evidenceLines(
  evidenceTurnIds: readonly string[],
  evidence: ReadonlyMap<
    string,
    SummaryPublicationRequest["transcript"]["turns"][number]
  >,
): readonly string[] {
  return evidenceTurnIds.map((turnId) => {
    const turn = evidence.get(turnId);
    if (turn === undefined) {
      return "Основание: исходная реплика недоступна";
    }
    const interval = `${formatDiscordTimestamp(turn.startMs)}-${formatDiscordTimestamp(turn.endMs)}`;
    return `Основание: **${interval} · ${formatDiscordSpeaker(turn.speakerId)}:** «${evidenceQuote(turn.text)}»`;
  });
}

function evidenceQuote(value: string): string {
  const normalized = escapeDiscordMarkdown(value.trim().replaceAll(/\s+/gu, " "));
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(normalized),
    (segment) => segment.segment,
  );
  return graphemes.length <= maximumEvidenceQuoteGraphemes
    ? normalized
    : `${graphemes.slice(0, maximumEvidenceQuoteGraphemes - 1).join("")}…`;
}

function normalizeInline(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ");
}

function discordThreadTitle(value: string): string {
  const normalized = normalizeInline(value);
  return truncateDiscordGraphemesByCodeUnits(normalized, 80);
}
