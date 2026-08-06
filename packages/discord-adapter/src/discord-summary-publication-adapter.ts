import {
  type PublicationReceiptSnapshot,
  type SummaryPublicationPort,
  type SummaryPublicationRequest,
  type SummaryPublicationResult,
} from "@discord-meeting/meeting-core/publishing";

import type {
  DiscordFinalPublicationMode,
  DiscordProjectionReference,
  PublishDiscordSummary,
} from "./discord-projection.js";
import {
  createMeetingDiscordFinalSummaryProjectionKey,
  createMeetingDiscordProjectionKey,
  decodeDiscordExternalPublicationId,
  encodeDiscordExternalPublicationId,
} from "./discord-projection.js";
import {
  formatDiscordSpeaker,
  formatDiscordTimestamp,
  truncateDiscordCodeUnits,
  truncateDiscordGraphemesByCodeUnits,
} from "./discord-markdown-formatting.js";
import {
  contextualDiscordEvidenceTurnIds,
  renderDiscordEvidenceQuote,
} from "./discord-evidence-rendering.js";
import { toDiscordPublicationFailure } from "./discord-publication-errors.js";
import {
  type DiscordTranscriptLocale,
  finalTranscriptAttachmentFilename,
  renderRussianFinalTranscriptAttachmentMarkdown,
  renderRussianTranscriptTimelineMarkdown,
} from "./discord-transcript-timeline.js";

interface DiscordSummaryProjector {
  publish(input: PublishDiscordSummary): Promise<DiscordProjectionReference>;
}

const discordMarkdownLimit = 4_000;

const finalSummaryCopy = {
  en: {
    actionItems: "## Action items",
    decisions: "## Decisions",
    due: "Due",
    keyTopics: "## Key topics and details",
    noActionItems: "No action items were recorded.",
    noDecisions: "No decisions were recorded.",
    noOpenQuestions: "No open questions were recorded.",
    noTopics: "No key topics were identified.",
    notSpecified: "not specified",
    openQuestions: "## Open questions",
    overview: "## Overview",
    owner: "Owner",
    truncationNotice: "_Summary was shortened due to Discord's limit._",
    unassigned: "unassigned",
  },
  ru: {
    actionItems: "## Задачи",
    decisions: "## Решения",
    due: "Срок",
    keyTopics: "## Ключевые темы и детали",
    noActionItems: "Задачи не зафиксированы.",
    noDecisions: "Решения не зафиксированы.",
    noOpenQuestions: "Открытые вопросы не зафиксированы.",
    noTopics: "Ключевые темы не выделены.",
    notSpecified: "не указан",
    openQuestions: "## Открытые вопросы",
    overview: "## Кратко",
    owner: "Ответственный",
    truncationNotice: "_Саммари сокращено из-за лимита Discord._",
    unassigned: "не назначен",
  },
  uk: {
    actionItems: "## Завдання",
    decisions: "## Рішення",
    due: "Термін",
    keyTopics: "## Ключові теми та деталі",
    noActionItems: "Завдання не зафіксовані.",
    noDecisions: "Рішення не зафіксовані.",
    noOpenQuestions: "Відкриті питання не зафіксовані.",
    noTopics: "Ключові теми не виділені.",
    notSpecified: "не вказаний",
    openQuestions: "## Відкриті питання",
    overview: "## Коротко",
    owner: "Відповідальний",
    truncationNotice: "_Самарі скорочено через ліміт Discord._",
    unassigned: "не призначений",
  },
} as const;

type PublicationResult = SummaryPublicationResult<
  Pick<PublicationReceiptSnapshot, "externalPublicationId">
>;

export class DiscordSummaryPublicationAdapter implements SummaryPublicationPort {
  private readonly finalPublicationMode: DiscordFinalPublicationMode;

  public constructor(
    private readonly publisher: DiscordSummaryProjector,
    options: { readonly finalPublicationMode?: DiscordFinalPublicationMode } = {},
  ) {
    this.finalPublicationMode = options.finalPublicationMode ?? "separate-message";
  }

  public async publish(request: SummaryPublicationRequest): Promise<PublicationResult> {
    try {
      const locale = dominantTranscriptLocale(request.transcript.turns);
      const replacesLiveProjection = this.finalPublicationMode === "replace-live";
      const referenceHint = replacesLiveProjection
        ? currentReference(request.currentExternalPublicationId)
        : undefined;
      const reference = await this.publisher.publish({
        projectionKey: replacesLiveProjection
          ? createMeetingDiscordProjectionKey(
              request.meetingId,
              request.publicationTargetId,
            )
          : createMeetingDiscordFinalSummaryProjectionKey(
              request.meetingId,
              request.publicationTargetId,
            ),
        ...(replacesLiveProjection
          ? { legacyProjectionKeys: [request.idempotencyKey] }
          : {}),
        parentChannelId: request.publicationTargetId,
        threadTitle: discordThreadTitle(request.summary.title),
        markdown: renderRussianSummaryMarkdown(request),
        liveCaptionsMarkdown: renderRussianFinalTranscriptTimelineMarkdown(
          request.transcript.turns,
          locale,
        ),
        transcriptAttachment: {
          content: renderRussianFinalTranscriptAttachmentMarkdown(
            request.transcript.turns,
            locale,
          ),
          filename: finalTranscriptAttachmentFilename,
        },
        ...(referenceHint === undefined ? {} : { currentReference: referenceHint }),
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

function currentReference(
  externalPublicationId: string | null | undefined,
): DiscordProjectionReference | undefined {
  return externalPublicationId === null || externalPublicationId === undefined
    ? undefined
    : decodeDiscordExternalPublicationId(externalPublicationId);
}

export function renderRussianSummaryMarkdown(
  request: Pick<SummaryPublicationRequest, "meetingId" | "summary" | "transcript">,
): string {
  const { summary } = request;
  const locale = dominantTranscriptLocale(request.transcript.turns);
  const copy = finalSummaryCopy[locale];
  const evidence = new Map(request.transcript.turns.map((turn) => [turn.turnId, turn]));
  const bodyLines = [
    `# ${normalizeInline(summary.title)}`,
    "",
    copy.overview,
    summary.overview.trim(),
    "",
    copy.keyTopics,
    ...numberedOrEmpty(
      topicsInTimelineOrder(summary.topics, evidence).map((topic) => [
        topic.title.trim(),
        ...topic.points.map((point) => point.trim()),
        ...evidenceLines(
          topic.evidenceTurnIds,
          evidence,
          [topic.title, ...topic.points].join(" "),
        ),
      ]),
      copy.noTopics,
    ),
    "",
    copy.decisions,
    ...numberedOrEmpty(
      entriesInTimelineOrder(summary.decisions, evidence).map((decision) => [
        decision.text.trim(),
        ...evidenceLines(decision.evidenceTurnIds, evidence, decision.text),
      ]),
      copy.noDecisions,
    ),
    "",
    copy.actionItems,
    ...numberedOrEmpty(
      entriesInTimelineOrder(summary.actionItems, evidence).map((actionItem) => [
        actionItem.text.trim(),
        `${copy.owner}: ${
          actionItem.ownerSpeakerId === null
            ? copy.unassigned
            : formatDiscordSpeaker(actionItem.ownerSpeakerId)
        }`,
        `${copy.due}: ${
          actionItem.deadline === null ? copy.notSpecified : actionItem.deadline.trim()
        }`,
        ...evidenceLines(
          actionItem.evidenceTurnIds,
          evidence,
          [actionItem.text, actionItem.deadline ?? ""].join(" "),
        ),
      ]),
      copy.noActionItems,
    ),
    "",
    copy.openQuestions,
    ...numberedOrEmpty(
      entriesInTimelineOrder(summary.openQuestions, evidence).map((question) => [
        question.text.trim(),
        ...evidenceLines(question.evidenceTurnIds, evidence, question.text),
      ]),
      copy.noOpenQuestions,
    ),
  ];
  return boundedMarkdown(bodyLines, copy.truncationNotice);
}

/**
 * The final Discord timeline is rendered from the authoritative transcript,
 * never from the best-effort live packet stream.
 */
export function renderRussianFinalTranscriptTimelineMarkdown(
  turns: SummaryPublicationRequest["transcript"]["turns"],
  locale: DiscordTranscriptLocale = dominantTranscriptLocale(turns),
): string {
  return renderRussianTranscriptTimelineMarkdown(turns, "final", locale);
}

function boundedMarkdown(bodyLines: readonly string[], truncationNotice: string): string {
  const body = bodyLines.join("\n").trimEnd();
  if (body.length <= discordMarkdownLimit) {
    return body;
  }

  const suffix = `\n\n${truncationNotice}`;
  const bodyBudget = discordMarkdownLimit - suffix.length;
  const shortenedBody = truncateAtStableBoundary(body, bodyBudget);
  return `${shortenedBody}${suffix}`;
}

function dominantTranscriptLocale(
  turns: SummaryPublicationRequest["transcript"]["turns"],
): DiscordTranscriptLocale {
  const transcriptText = turns.map((turn) => turn.text).join(" ");
  if ((transcriptText.match(/[іїєґ]/giu) ?? []).length > 0) {
    return "uk";
  }
  const cyrillic = (transcriptText.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const latin = (transcriptText.match(/\p{Script=Latin}/gu) ?? []).length;
  return cyrillic > latin ? "ru" : "en";
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
  claimText: string,
): readonly string[] {
  const resolvedTurnIds = contextualDiscordEvidenceTurnIds(evidenceTurnIds, evidence);
  return resolvedTurnIds
    .map((turnId, originalIndex) => ({
      originalIndex,
      startMs: evidence.get(turnId)?.startMs ?? null,
      turnId,
    }))
    .toSorted((left, right) =>
      compareNullableStartMs(left.startMs, right.startMs) ||
      left.originalIndex - right.originalIndex
    )
    .map(({ turnId }) => {
      const turn = evidence.get(turnId);
      if (turn === undefined) {
        return "The source utterance is unavailable.";
      }
      const interval = `${formatDiscordTimestamp(turn.startMs)}-${formatDiscordTimestamp(turn.endMs)}`;
      return `**${interval} · ${formatDiscordSpeaker(turn.speakerId)}:** «${renderDiscordEvidenceQuote(turn.text, claimText)}»`;
    });
}

function topicsInTimelineOrder(
  topics: SummaryPublicationRequest["summary"]["topics"],
  evidence: ReadonlyMap<
    string,
    SummaryPublicationRequest["transcript"]["turns"][number]
  >,
): readonly SummaryPublicationRequest["summary"]["topics"][number][] {
  return topics
    .map((topic, originalIndex) => ({
      earliestStartMs: earliestEvidenceStartMs(topic.evidenceTurnIds, evidence),
      originalIndex,
      topic,
    }))
    .toSorted((left, right) => {
      const timelineOrder = compareNullableStartMs(left.earliestStartMs, right.earliestStartMs);
      return timelineOrder ||
        left.originalIndex - right.originalIndex ||
        normalizeInline(left.topic.title).localeCompare(normalizeInline(right.topic.title));
    })
    .map(({ topic }) => topic);
}

function entriesInTimelineOrder<T extends { readonly evidenceTurnIds: readonly string[] }>(
  entries: readonly T[],
  evidence: ReadonlyMap<
    string,
    SummaryPublicationRequest["transcript"]["turns"][number]
  >,
): readonly T[] {
  return entries
    .map((entry, originalIndex) => ({
      earliestStartMs: earliestEvidenceStartMs(entry.evidenceTurnIds, evidence),
      entry,
      originalIndex,
    }))
    .toSorted((left, right) =>
      compareNullableStartMs(left.earliestStartMs, right.earliestStartMs) ||
      left.originalIndex - right.originalIndex
    )
    .map(({ entry }) => entry);
}

function earliestEvidenceStartMs(
  evidenceTurnIds: readonly string[],
  evidence: ReadonlyMap<
    string,
    SummaryPublicationRequest["transcript"]["turns"][number]
  >,
): number | null {
  let earliest: number | null = null;
  for (const turnId of evidenceTurnIds) {
    const turn = evidence.get(turnId);
    if (turn === undefined || !Number.isSafeInteger(turn.startMs) || turn.startMs < 0) {
      continue;
    }
    const { startMs } = turn;
    earliest = earliest === null ? startMs : Math.min(earliest, startMs);
  }
  return earliest;
}

function compareNullableStartMs(left: number | null, right: number | null): number {
  if (left === null) {
    return right === null ? 0 : 1;
  }
  if (right === null) {
    return -1;
  }
  return left - right;
}


function normalizeInline(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ");
}

function discordThreadTitle(value: string): string {
  const normalized = normalizeInline(value);
  return truncateDiscordGraphemesByCodeUnits(normalized, 80);
}
