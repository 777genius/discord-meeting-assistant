import type { RetainedE2eEvidence } from "./e2e-evidence-schema.js";

interface DiscordAttachmentMetadata {
  readonly filename: string;
  readonly sizeBytes: number;
}

export function sameDiscordAttachments(
  left: readonly DiscordAttachmentMetadata[],
  right: readonly DiscordAttachmentMetadata[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const normalizedLeft = sortedDiscordAttachments(left);
  const normalizedRight = sortedDiscordAttachments(right);
  return normalizedLeft.every((attachment, index) => {
    const candidate = normalizedRight[index];
    return candidate?.filename === attachment.filename &&
      candidate.sizeBytes === attachment.sizeBytes;
  });
}

function sortedDiscordAttachments(
  attachments: readonly DiscordAttachmentMetadata[],
): readonly DiscordAttachmentMetadata[] {
  return attachments.toSorted((leftAttachment, rightAttachment) =>
    leftAttachment.filename.localeCompare(rightAttachment.filename) ||
    leftAttachment.sizeBytes - rightAttachment.sizeBytes
  );
}

export function publicationContainerIdentity(
  publication: RetainedE2eEvidence["publication"] | RetainedE2eEvidence["replay"],
): string {
  if ("threadId" in publication) {
    return `thread:${publication.threadId}`;
  }
  return publication.container.kind === "thread"
    ? `thread:${publication.container.threadId}`
    : `channel-message:${publication.container.parentChannelId}`;
}

export function expectedPublicationThreadCount(
  publication: RetainedE2eEvidence["publication"] | RetainedE2eEvidence["replay"],
): number {
  if ("threadId" in publication) {
    return 1;
  }
  return publication.container.kind === "thread" ? 1 : 0;
}
