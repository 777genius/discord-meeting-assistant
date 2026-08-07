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
  type DiscordTranscriptTimelineEntry,
} from "./discord-transcript-timeline.js";
import {
  dominantTranscriptLocale,
  finalSummaryCopy,
} from "./discord-summary-locale.js";

interface DiscordSummaryProjector {
  publish(input: PublishDiscordSummary): Promise<DiscordProjectionReference>;
}

const discordMarkdownLimit = 4_000;

type PublicationResult = SummaryPublicationResult<
  Pick<PublicationReceiptSnapshot, "externalPublicationId">
>;

export interface DiscordSummaryPublicationAdapterOptions {
  readonly finalPublicationMode?: DiscordFinalPublicationMode;
  readonly recordingPlaybackUrl?: (meetingId: string) => string;
}

export class DiscordSummaryPublicationAdapter implements SummaryPublicationPort {
  private readonly finalPublicationMode: DiscordFinalPublicationMode;

  public constructor(
    private readonly publisher: DiscordSummaryProjector,
    private readonly options: DiscordSummaryPublicationAdapterOptions = {},
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
        markdown: renderRussianSummaryMarkdown(
          request,
          this.options.recordingPlaybackUrl?.(request.meetingId),
        ),
        liveCaptionsMarkdown: renderRussianFinalTranscriptTimelineMarkdown(
          finalTranscriptTimelineEntries(request.transcript),
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
  recordingPlaybackUrl?: string,
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
          copy.sourceUtteranceUnavailable,
        ),
      ]),
      copy.noTopics,
    ),
    "",
    copy.decisions,
    ...numberedOrEmpty(
      entriesInTimelineOrder(summary.decisions, evidence).map((decision) => [
        decision.text.trim(),
        ...evidenceLines(
          decision.evidenceTurnIds,
          evidence,
          decision.text,
          copy.sourceUtteranceUnavailable,
        ),
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
          copy.sourceUtteranceUnavailable,
        ),
      ]),
      copy.noActionItems,
    ),
    "",
    copy.openQuestions,
    ...numberedOrEmpty(
      entriesInTimelineOrder(summary.openQuestions, evidence).map((question) => [
        question.text.trim(),
        ...evidenceLines(
          question.evidenceTurnIds,
          evidence,
          question.text,
          copy.sourceUtteranceUnavailable,
        ),
      ]),
      copy.noOpenQuestions,
    ),
  ];
  const footerLines = recordingPlaybackUrl === undefined
    ? []
    : [copy.recordingHeading, `[${copy.recordingLink}](${recordingPlaybackUrl})`];
  return boundedMarkdown(bodyLines, copy.truncationNotice, footerLines);
}

/**
 * The final Discord timeline is rendered from the authoritative transcript,
 * never from the best-effort live packet stream.
 */
export function renderRussianFinalTranscriptTimelineMarkdown(
  entries: readonly DiscordTranscriptTimelineEntry[],
  locale: DiscordTranscriptLocale = dominantTranscriptLocale(entries),
): string {
  return renderRussianTranscriptTimelineMarkdown(entries, "final", locale);
}

type TranscriptReadableSegmentSnapshot = NonNullable<
  SummaryPublicationRequest["transcript"]["readableSegments"]
>[number];

function finalTranscriptTimelineEntries(
  transcript: SummaryPublicationRequest["transcript"],
): readonly DiscordTranscriptTimelineEntry[] {
  const readableSegments = transcript.readableSegments ?? [];
  return readableSegments.length > 0
    ? readableSegments.map(toDiscordTranscriptTimelineEntry)
    : transcript.turns;
}

function toDiscordTranscriptTimelineEntry(
  segment: TranscriptReadableSegmentSnapshot,
): DiscordTranscriptTimelineEntry {
  return {
    endMs: segment.endMs,
    speakerId: segment.speakerId,
    startMs: segment.startMs,
    text: segment.text,
  };
}

function boundedMarkdown(
  bodyLines: readonly string[],
  truncationNotice: string,
  footerLines: readonly string[] = [],
): string {
  const body = bodyLines.join("\n").trimEnd();
  const footer = footerLines.length === 0 ? "" : `\n\n${footerLines.join("\n")}`;
  if (body.length + footer.length <= discordMarkdownLimit) {
    return `${body}${footer}`;
  }

  const suffix = `\n\n${truncationNotice}`;
  const boundedFooter = suffix.length + footer.length <= discordMarkdownLimit
    ? footer
    : "";
  const bodyBudget = discordMarkdownLimit - suffix.length - boundedFooter.length;
  const shortenedBody = truncateAtStableBoundary(body, bodyBudget);
  return `${shortenedBody}${suffix}${boundedFooter}`;
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
  sourceUtteranceUnavailable: string,
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
        return sourceUtteranceUnavailable;
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
