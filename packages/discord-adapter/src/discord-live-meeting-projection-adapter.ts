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
  publish(
    input: PublishDiscordSummary,
    options?: {
      readonly directEditOnly?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<DiscordProjectionReference>;
}

const liveSummaryDescriptionLimit = 4_000;
const finalizingProjectionTimeoutMs = 5_000;

export class DiscordLiveMeetingProjectionAdapter implements LiveMeetingProjectionPort {
  private readonly finalizingTimeoutMs: number;

  public constructor(
    private readonly publisher: DiscordLiveProjectionPublisher,
    options: { readonly finalizingTimeoutMs?: number } = {},
  ) {
    this.finalizingTimeoutMs = options.finalizingTimeoutMs ?? finalizingProjectionTimeoutMs;
  }

  public async publish(
    request: LiveMeetingProjectionRequest,
  ): Promise<PortResult<{ readonly externalPublicationId: string }>> {
    try {
      const referenceHint = currentReference(request.currentExternalPublicationId);
      const reference = await this.publisher.publish(
        {
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
        },
        request.phase === "finalizing"
          ? {
            directEditOnly: true,
            signal: AbortSignal.timeout(this.finalizingTimeoutMs),
          }
          : {},
      );
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
  request: Pick<LiveMeetingProjectionRequest, "elapsedMs" | "phase" | "summary">,
): string {
  if (request.summary === null) {
    return boundLiveSummary([
      request.phase === "finalizing" ? "# Finalizing..." : "# Meeting in progress",
      "",
      "## Live summary",
      request.phase === "finalizing"
        ? "Finalizing... The latest live captions are being reconciled with the complete recording."
        : "Initial insights will appear after the first few minutes. The bot is showing live captions in the meantime.",
      "",
      `_Duration: ${formatDiscordTimestamp(request.elapsedMs)}_`,
    ]);
  }

  const { summary } = request;
  return boundLiveSummary([
    request.phase === "finalizing" ? "# Finalizing..." : `# ${normalizeInline(summary.title)}`,
    ...(request.phase === "finalizing"
      ? ["", `_Latest live draft: ${normalizeInline(summary.title)}_`]
      : []),
    "",
    "## Live summary",
    summary.overview.trim(),
    "",
    "## Key topics",
    ...numberedOrEmpty(
      summary.topics.map((topic) => [
        topic.title.trim(),
        ...topic.points.map((point) => point.trim()),
      ]),
      "No key topics have been identified yet.",
    ),
    "",
    "## Decisions",
    ...numberedOrEmpty(
      summary.decisions.map((decision) => [decision.text.trim()]),
      "No decisions have been recorded yet.",
    ),
    "",
    "## Action items",
    ...numberedOrEmpty(
      summary.actionItems.map((actionItem) => [
        actionItem.text.trim(),
        `Owner: ${
          actionItem.ownerSpeakerId === null
            ? "unassigned"
            : formatDiscordSpeaker(actionItem.ownerSpeakerId)
        }`,
        `Due: ${actionItem.deadline === null ? "not specified" : actionItem.deadline.trim()}`,
      ]),
      "No action items have been recorded yet.",
    ),
    "",
    "## Open questions",
    ...numberedOrEmpty(
      summary.openQuestions.map((question) => [question.text.trim()]),
      "No open questions have been recorded yet.",
    ),
    "",
    request.phase === "finalizing"
      ? "_Finalizing... This is the latest live draft and caption history while final transcription and review complete._"
      : `_Updates during the meeting · ${formatDiscordTimestamp(request.elapsedMs)}_`,
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
  return formatLiveMeetingStartUtc(request.updatedAtMs, request.elapsedMs) ?? "Meeting";
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
    "Meeting ·",
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

  const suffix = "\n\n_Live summary was shortened due to Discord's limit._";
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
