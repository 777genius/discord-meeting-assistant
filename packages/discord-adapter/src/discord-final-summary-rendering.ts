import type { SummaryPublicationRequest } from "@discord-meeting/meeting-core/publishing";

import {
  contextualDiscordEvidenceTurnIds,
  renderDiscordEvidenceQuote,
} from "./discord-evidence-rendering.js";
import {
  formatDiscordSpeaker,
  formatDiscordTimestamp,
  truncateDiscordCodeUnits,
} from "./discord-markdown-formatting.js";
import { dominantTranscriptLocale, finalSummaryCopy } from "./discord-summary-locale.js";

const discordMarkdownLimit = 4_000;

type SummaryRenderRequest = Pick<
  SummaryPublicationRequest,
  "meetingId" | "summary" | "transcript"
>;

export function renderRussianSummaryMarkdown(
  request: SummaryRenderRequest,
  recordingPlaybackUrl?: string,
  statusNotice?: string,
): string {
  const locale = dominantTranscriptLocale(request.transcript.turns);
  const copy = finalSummaryCopy[locale];
  const bodyLines = summaryBodyLines(request, false, statusNotice);
  const footerLines = [
    copy.fullSummaryAttachment,
    ...(recordingPlaybackUrl === undefined
      ? []
      : [copy.recordingHeading, `[${copy.recordingLink}](${recordingPlaybackUrl})`]),
  ];
  return boundedMarkdown(bodyLines, copy.truncationNotice, footerLines);
}

export function renderRussianFullSummaryAttachmentMarkdown(
  request: SummaryRenderRequest,
  recordingPlaybackUrl?: string,
): string {
  const locale = dominantTranscriptLocale(request.transcript.turns);
  const copy = finalSummaryCopy[locale];
  return [
    ...summaryBodyLines(request, true),
    ...(recordingPlaybackUrl === undefined
      ? []
      : ["", copy.recordingHeading, `[${copy.recordingLink}](${recordingPlaybackUrl})`]),
  ].join("\n").trimEnd();
}

function summaryBodyLines(
  request: SummaryRenderRequest,
  includeEvidence: boolean,
  statusNotice?: string,
): readonly string[] {
  const { summary } = request;
  const locale = dominantTranscriptLocale(request.transcript.turns);
  const copy = finalSummaryCopy[locale];
  const evidence = new Map(request.transcript.turns.map((turn) => [turn.turnId, turn]));
  return [
    `# ${normalizeInline(summary.title)}`,
    ...(statusNotice === undefined ? [] : ["", `_${statusNotice}_`]),
    "",
    copy.overview,
    summary.overview.trim(),
    "",
    copy.keyTopics,
    ...numberedOrEmpty(
      topicsInTimelineOrder(summary.topics, evidence).map((topic) => [
        topic.title.trim(),
        ...topic.points.map((point) => point.trim()),
        ...(includeEvidence
          ? evidenceLines(
            topic.evidenceTurnIds,
            evidence,
            [topic.title, ...topic.points].join(" "),
            copy.sourceUtteranceUnavailable,
          )
          : []),
      ]),
      copy.noTopics,
    ),
    "",
    copy.decisions,
    ...numberedOrEmpty(
      entriesInTimelineOrder(summary.decisions, evidence).map((decision) => [
        decision.text.trim(),
        ...(includeEvidence
          ? evidenceLines(
            decision.evidenceTurnIds,
            evidence,
            decision.text,
            copy.sourceUtteranceUnavailable,
          )
          : []),
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
        ...(includeEvidence
          ? evidenceLines(
            actionItem.evidenceTurnIds,
            evidence,
            [actionItem.text, actionItem.deadline ?? ""].join(" "),
            copy.sourceUtteranceUnavailable,
          )
          : []),
      ]),
      copy.noActionItems,
    ),
    "",
    copy.openQuestions,
    ...numberedOrEmpty(
      entriesInTimelineOrder(summary.openQuestions, evidence).map((question) => [
        question.text.trim(),
        ...(includeEvidence
          ? evidenceLines(
            question.evidenceTurnIds,
            evidence,
            question.text,
            copy.sourceUtteranceUnavailable,
          )
          : []),
      ]),
      copy.noOpenQuestions,
    ),
  ];
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
      const interval = `${formatDiscordTimestamp(turn.startMs)}-${
        formatDiscordTimestamp(turn.endMs)
      }`;
      return `**${interval} · ${formatDiscordSpeaker(turn.speakerId)}:** «${
        renderDiscordEvidenceQuote(turn.text, claimText)
      }»`;
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
