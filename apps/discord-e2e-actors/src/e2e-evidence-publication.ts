import type { RetainedE2eEvidence } from "./e2e-evidence-schema.js";

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
