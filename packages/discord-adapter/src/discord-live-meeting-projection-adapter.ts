import type {
  LiveCaptionSnapshot,
  LiveMeetingProjectionPort,
  LiveMeetingProjectionRequest,
  PortResult,
} from "@discord-meeting/meeting-core";

import type {
  DiscordProjectionReference,
  PublishDiscordSummary,
} from "./discord-projection.js";
import {
  createMeetingDiscordProjectionKey,
  decodeDiscordExternalPublicationId,
  encodeDiscordExternalPublicationId,
} from "./discord-projection.js";
import {
  formatDiscordSpeaker,
  formatDiscordTimestamp,
  truncateDiscordCodeUnits,
} from "./discord-markdown-formatting.js";
import { toDiscordPublicationFailure } from "./discord-publication-errors.js";
import { renderRussianTranscriptTimelineMarkdown } from "./discord-transcript-timeline.js";

interface DiscordLiveProjectionPublisher {
  publish(input: PublishDiscordSummary): Promise<DiscordProjectionReference>;
}

const liveSummaryDescriptionLimit = 4_000;

export class DiscordLiveMeetingProjectionAdapter implements LiveMeetingProjectionPort {
  public constructor(private readonly publisher: DiscordLiveProjectionPublisher) {}

  public async publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
    try {
      const referenceHint = currentReference(request.currentExternalPublicationId);
      const reference = await this.publisher.publish({
        projectionKey: createMeetingDiscordProjectionKey(
          request.meetingId,
          request.publicationTargetId,
        ),
        legacyProjectionKeys: [request.idempotencyKey],
        parentChannelId: request.publicationTargetId,
        threadTitle: liveThreadTitle(request),
        markdown: renderRussianLiveSummaryMarkdown(request),
        liveCaptionsMarkdown: renderRussianLiveCaptionsMarkdown(request.captions),
        ...(referenceHint === undefined
          ? {}
          : { currentReference: referenceHint }),
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

export function renderRussianLiveSummaryMarkdown(
  request: Pick<LiveMeetingProjectionRequest, "elapsedMs" | "status" | "summary">,
): string {
  if (request.summary === null) {
    return boundLiveSummary([
      "# Встреча в процессе",
      "",
      "## Предварительное саммари",
      request.status === "ended"
        ? "Звонок завершён, готовим финальное саммари по полной записи."
        : "Первые выводы появятся после первых минут разговора. Пока бот показывает live-субтитры.",
      "",
      `_Длительность: ${formatDiscordTimestamp(request.elapsedMs)}_`,
    ]);
  }

  const { summary } = request;
  return boundLiveSummary([
    `# ${normalizeInline(summary.title)}`,
    "",
    "## Предварительное саммари",
    summary.overview.trim(),
    "",
    "## Основные темы",
    ...numberedOrEmpty(
      summary.topics.map((topic) => [
        topic.title.trim(),
        ...topic.points.map((point) => point.trim()),
      ]),
      "Основные темы пока не выделены.",
    ),
    "",
    "## Решения",
    ...numberedOrEmpty(
      summary.decisions.map((decision) => [decision.text.trim()]),
      "Зафиксированных решений пока нет.",
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
        `Срок: ${actionItem.deadline === null ? "не указан" : actionItem.deadline.trim()}`,
      ]),
      "Зафиксированных задач пока нет.",
    ),
    "",
    "## Открытые вопросы",
    ...numberedOrEmpty(
      summary.openQuestions.map((question) => [question.text.trim()]),
      "Открытых вопросов пока нет.",
    ),
    "",
    request.status === "ended"
      ? "_Звонок завершён. Это предварительная версия до финальной сверки._"
      : `_Обновляется во время встречи · ${formatDiscordTimestamp(request.elapsedMs)}_`,
  ]);
}

export function renderRussianLiveCaptionsMarkdown(
  captions: readonly LiveCaptionSnapshot[],
): string {
  return renderRussianTranscriptTimelineMarkdown(captions, "live");
}

function currentReference(
  externalPublicationId: string | null,
): DiscordProjectionReference | undefined {
  return externalPublicationId === null
    ? undefined
    : decodeDiscordExternalPublicationId(externalPublicationId);
}

function liveThreadTitle(
  request: Pick<LiveMeetingProjectionRequest, "elapsedMs" | "updatedAtMs">,
): string {
  return formatLiveMeetingStartUtc(request.updatedAtMs, request.elapsedMs) ?? "Встреча";
}

function formatLiveMeetingStartUtc(updatedAtMs: number, elapsedMs: number): string | undefined {
  if (
    !Number.isSafeInteger(updatedAtMs) ||
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0
  ) {
    return undefined;
  }
  const startedAtMs = updatedAtMs - elapsedMs;
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) {
    return undefined;
  }
  const startedAt = new Date(startedAtMs);
  if (Number.isNaN(startedAt.valueOf())) {
    return undefined;
  }
  return [
    "Встреча ·",
    `${startedAt.getUTCFullYear()}-${padUtc(startedAt.getUTCMonth() + 1)}-${padUtc(startedAt.getUTCDate())}`,
    `${padUtc(startedAt.getUTCHours())}:${padUtc(startedAt.getUTCMinutes())}`,
    "UTC",
  ].join(" ");
}

function padUtc(value: number): string {
  return String(value).padStart(2, "0");
}

function boundLiveSummary(lines: readonly string[]): string {
  const body = lines.join("\n").trimEnd();
  if (body.length <= liveSummaryDescriptionLimit) {
    return body;
  }

  const suffix = "\n\n_Предварительное саммари сокращено из-за лимита Discord._";
  const shortened = truncateDiscordCodeUnits(
    body,
    Math.max(0, liveSummaryDescriptionLimit - suffix.length - 1),
  ).trimEnd();
  return `${shortened}…${suffix}`;
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

function normalizeInline(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ");
}
