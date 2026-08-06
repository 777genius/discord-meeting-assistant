import {
  type PublicationReceiptSnapshot,
  type SummaryPublicationPort,
  type SummaryPublicationRequest,
  type SummaryPublicationResult,
} from "@discord-meeting/meeting-core/publishing";

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
  truncateDiscordGraphemesByCodeUnits,
} from "./discord-markdown-formatting.js";
import { toDiscordPublicationFailure } from "./discord-publication-errors.js";
import {
  finalTranscriptAttachmentFilename,
  renderRussianFinalTranscriptAttachmentMarkdown,
  renderRussianTranscriptTimelineMarkdown,
} from "./discord-transcript-timeline.js";

interface DiscordSummaryProjector {
  publish(input: PublishDiscordSummary): Promise<DiscordProjectionReference>;
}

const discordMarkdownLimit = 4_000;
const truncationNotice = "_Summary was shortened due to Discord's limit._";
const maximumEvidenceQuoteGraphemes = 180;

type PublicationResult = SummaryPublicationResult<
  Pick<PublicationReceiptSnapshot, "externalPublicationId">
>;

export interface DiscordSummaryPublicationAdapterOptions {
  readonly recordingPlaybackUrl?: (meetingId: string) => string;
}

export class DiscordSummaryPublicationAdapter implements SummaryPublicationPort {
  public constructor(
    private readonly publisher: DiscordSummaryProjector,
    private readonly options: DiscordSummaryPublicationAdapterOptions = {},
  ) {}

  public async publish(request: SummaryPublicationRequest): Promise<PublicationResult> {
    try {
      const referenceHint = currentReference(request.currentExternalPublicationId);
      const reference = await this.publisher.publish({
        projectionKey: createMeetingDiscordProjectionKey(
          request.meetingId,
          request.publicationTargetId,
        ),
        legacyProjectionKeys: [request.idempotencyKey],
        parentChannelId: request.publicationTargetId,
        threadTitle: discordThreadTitle(request.summary.title),
        markdown: renderRussianSummaryMarkdown(
          request,
          this.options.recordingPlaybackUrl?.(request.meetingId),
        ),
        liveCaptionsMarkdown: renderRussianFinalTranscriptTimelineMarkdown(
          request.transcript.turns,
        ),
        transcriptAttachment: {
          content: renderRussianFinalTranscriptAttachmentMarkdown(request.transcript.turns),
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
  const evidence = new Map(request.transcript.turns.map((turn) => [turn.turnId, turn]));
  const bodyLines = [
    `# ${normalizeInline(summary.title)}`,
    "",
    "## Overview",
    summary.overview.trim(),
    "",
    "## Key topics",
    ...numberedOrEmpty(
      topicsInTimelineOrder(summary.topics, evidence).map((topic) => [
        topic.title.trim(),
        ...topic.points.map((point) => point.trim()),
        ...evidenceLines(topic.evidenceTurnIds, evidence),
      ]),
      "No key topics were identified.",
    ),
    "",
    "## Decisions",
    ...numberedOrEmpty(
      entriesInTimelineOrder(summary.decisions, evidence).map((decision) => [
        decision.text.trim(),
        ...evidenceLines(decision.evidenceTurnIds, evidence),
      ]),
      "No decisions were recorded.",
    ),
    "",
    "## Action items",
    ...numberedOrEmpty(
      entriesInTimelineOrder(summary.actionItems, evidence).map((actionItem) => [
        actionItem.text.trim(),
        `Owner: ${
          actionItem.ownerSpeakerId === null
            ? "unassigned"
            : formatDiscordSpeaker(actionItem.ownerSpeakerId)
        }`,
        `Due: ${
          actionItem.deadline === null ? "not specified" : actionItem.deadline.trim()
        }`,
        ...evidenceLines(actionItem.evidenceTurnIds, evidence),
      ]),
      "No action items were recorded.",
    ),
    "",
    "## Open questions",
    ...numberedOrEmpty(
      entriesInTimelineOrder(summary.openQuestions, evidence).map((question) => [
        question.text.trim(),
        ...evidenceLines(question.evidenceTurnIds, evidence),
      ]),
      "No open questions were recorded.",
    ),
  ];
  const footerLines = recordingPlaybackUrl === undefined
    ? []
    : ["## Recording", `[Listen to the recording](${recordingPlaybackUrl})`];
  return boundedMarkdown(bodyLines, footerLines);
}

/**
 * The final Discord timeline is rendered from the authoritative transcript,
 * never from the best-effort live packet stream.
 */
export function renderRussianFinalTranscriptTimelineMarkdown(
  turns: SummaryPublicationRequest["transcript"]["turns"],
): string {
  return renderRussianTranscriptTimelineMarkdown(turns, "final");
}

function boundedMarkdown(
  bodyLines: readonly string[],
  footerLines: readonly string[] = [],
): string {
  const body = bodyLines.join("\n").trimEnd();
  const footer = footerLines.length === 0 ? "" : `\n\n${footerLines.join("\n")}`;
  if (body.length + footer.length <= discordMarkdownLimit) {
    return `${body}${footer}`;
  }

  const suffix = `\n\n${truncationNotice}`;
  const bodyBudget = discordMarkdownLimit - suffix.length - footer.length;
  const shortenedBody = truncateAtStableBoundary(body, bodyBudget);
  return `${shortenedBody}${suffix}${footer}`;
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
  return evidenceTurnIds
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
      return `**${interval} · ${formatDiscordSpeaker(turn.speakerId)}:** «${evidenceQuote(turn.text)}»`;
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
