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
import { truncateDiscordGraphemesByCodeUnits } from "./discord-markdown-formatting.js";
import {
  renderRussianFullSummaryAttachmentMarkdown,
  renderRussianSummaryMarkdown,
} from "./discord-final-summary-rendering.js";
import { toDiscordPublicationFailure } from "./discord-publication-errors.js";
import {
  type DiscordTranscriptLocale,
  finalTranscriptAttachmentFilename,
  renderRussianFinalTranscriptAttachmentMarkdown,
} from "./discord-transcript-timeline.js";
import {
  dominantTranscriptLocale,
  finalSummaryCopy,
} from "./discord-summary-locale.js";

interface DiscordSummaryProjector {
  publish(
    input: PublishDiscordSummary,
    options?: { readonly directEditOnly?: boolean },
  ): Promise<DiscordProjectionReference>;
}

type PublicationResult = SummaryPublicationResult<
  Pick<PublicationReceiptSnapshot, "externalPublicationId" | "publisherIdentity">
>;

export interface DiscordSummaryPublicationAdapterOptions {
  readonly finalPublicationMode?: DiscordFinalPublicationMode;
  readonly publisherIdentity?: string;
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
      const liveReference = currentReference(request.currentExternalPublicationId);
      const referenceHint = replacesLiveProjection
        ? liveReference
        : undefined;
      const recordingPlaybackUrl = this.options.recordingPlaybackUrl?.(request.meetingId);
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
          recordingPlaybackUrl,
        ),
        ...(replacesLiveProjection
          ? {}
          : {
            reconciledMarkdown: renderRussianSummaryMarkdown(
              request,
              recordingPlaybackUrl,
              finalSummaryCopy[locale].updatedAfterFinalProcessing,
            ),
          }),
        summaryAttachment: {
          content: renderRussianFullSummaryAttachmentMarkdown(
            request,
            recordingPlaybackUrl,
          ),
          filename: "meeting-summary.md",
        },
        transcriptAttachment: {
          content: renderRussianFinalTranscriptAttachmentMarkdown(
            request.transcript.turns,
            locale,
          ),
          filename: finalTranscriptAttachmentFilename,
        },
        ...(referenceHint === undefined ? {} : { currentReference: referenceHint }),
      });
      if (
        !replacesLiveProjection &&
        liveReference !== undefined &&
        !sameDiscordProjectionReference(liveReference, reference)
      ) {
        await this.tryRetireLiveProjection(request, locale, liveReference);
      }
      return {
        ok: true,
        value: {
          externalPublicationId: encodeDiscordExternalPublicationId(reference),
          publisherIdentity: this.options.publisherIdentity ?? "",
        },
      };
    } catch (error: unknown) {
      return { ok: false, failure: toDiscordPublicationFailure(error) };
    }
  }

  /** A stale live draft must never invalidate an already-published final result. */
  private async tryRetireLiveProjection(
    request: SummaryPublicationRequest,
    locale: DiscordTranscriptLocale,
    liveReference: DiscordProjectionReference,
  ): Promise<void> {
    const copy = finalSummaryCopy[locale];
    try {
      await this.publisher.publish({
        currentReference: liveReference,
        markdown: [
          `# ${copy.finalSummaryPublishedTitle}`,
          "",
          `_${copy.liveSuperseded}_`,
        ].join("\n"),
        parentChannelId: request.publicationTargetId,
        projectionKey: createMeetingDiscordProjectionKey(
          request.meetingId,
          request.publicationTargetId,
        ),
        threadTitle: discordThreadTitle(request.summary.title),
      }, { directEditOnly: true });
    } catch {
      // Retirement is a best-effort presentation cleanup. Final publication is
      // already durable and remains the authoritative visible result.
    }
  }
}

function sameDiscordProjectionReference(
  left: DiscordProjectionReference,
  right: DiscordProjectionReference,
): boolean {
  return left.kind === "thread"
    ? right.kind === "thread" &&
      left.threadId === right.threadId &&
      left.messageId === right.messageId
    : right.kind === "channel-message" &&
      left.parentChannelId === right.parentChannelId &&
      left.messageId === right.messageId;
}

function currentReference(
  externalPublicationId: string | null | undefined,
): DiscordProjectionReference | undefined {
  return externalPublicationId === null || externalPublicationId === undefined
    ? undefined
    : decodeDiscordExternalPublicationId(externalPublicationId);
}

function normalizeInline(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ");
}

function discordThreadTitle(value: string): string {
  const normalized = normalizeInline(value);
  return truncateDiscordGraphemesByCodeUnits(normalized, 80);
}
