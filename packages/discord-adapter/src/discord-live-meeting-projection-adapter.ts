import type {
  LiveCaptionSnapshot,
  LiveMeetingProjectionPort,
  LiveMeetingProjectionRequest,
  LiveSummaryDraftSnapshot,
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
  escapeDiscordMarkdown,
  formatDiscordSpeaker,
  formatDiscordTimestamp,
  truncateDiscordCodeUnits,
  truncateDiscordGraphemes,
  truncateDiscordGraphemesByCodeUnits,
} from "./discord-markdown-formatting.js";
import { toDiscordPublicationFailure } from "./discord-publication-errors.js";

interface DiscordLiveProjectionPublisher {
  publish(input: PublishDiscordSummary): Promise<DiscordProjectionReference>;
}

const liveSummaryDescriptionLimit = 4_000;
const liveCaptionsDescriptionLimit = 1_900;
const maximumRecentCaptions = 12;
const maximumCaptionGraphemes = 280;
const captionsFooter = "_Предварительные реплики могут уточняться._";

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
        threadTitle: liveThreadTitle(request.summary),
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
  const heading = "## 🎙️ Сейчас говорят";
  const visibleCaptions = captions
    .filter((caption) => caption.text.trim().length > 0)
    .toSorted(compareCaptions)
    .slice(-maximumRecentCaptions)
    .map(renderCaption);

  if (visibleCaptions.length === 0) {
    return [heading, "", "Пока нет распознанных реплик.", "", captionsFooter].join("\n");
  }

  const budget = liveCaptionsDescriptionLimit - heading.length - captionsFooter.length - 4;
  const selected: string[] = [];
  for (const caption of visibleCaptions.toReversed()) {
    const candidateLength = caption.length + (selected.length === 0 ? 0 : 1);
    if (selected.join("\n").length + candidateLength <= budget) {
      selected.unshift(caption);
    }
  }
  if (selected.length === 0) {
    const newest = visibleCaptions.at(-1) ?? "";
    selected.push(truncateDiscordCodeUnits(newest, Math.max(1, budget)));
  }

  return [heading, "", ...selected, "", captionsFooter].join("\n");
}

function currentReference(
  externalPublicationId: string | null,
): DiscordProjectionReference | undefined {
  return externalPublicationId === null
    ? undefined
    : decodeDiscordExternalPublicationId(externalPublicationId);
}

function liveThreadTitle(summary: LiveSummaryDraftSnapshot | null): string {
  return summary === null
    ? "Встреча в процессе"
    : truncateDiscordGraphemesByCodeUnits(normalizeInline(summary.title), 80);
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

function renderCaption(caption: LiveCaptionSnapshot): string {
  const state = caption.isFinal ? "✓" : "…";
  const text = escapeDiscordMarkdown(
    truncateDiscordGraphemes(caption.text.trim().replaceAll(/\s+/gu, " "), maximumCaptionGraphemes),
  );
  return `${state} \`${formatDiscordTimestamp(caption.startMs)}\` **${formatDiscordSpeaker(caption.speakerId)}:** ${text}`;
}

function compareCaptions(left: LiveCaptionSnapshot, right: LiveCaptionSnapshot): number {
  return left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.speakerId.localeCompare(right.speakerId) ||
    left.text.localeCompare(right.text);
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
