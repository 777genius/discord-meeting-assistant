import type {
  DiscordProjectionClient,
  DiscordProjectionReference,
  LocatedDiscordProjection,
  ProjectionLock,
  PublishDiscordSummary,
} from "./discord-projection.js";
import {
  publishDiscordSummarySchema,
  toDiscordProjectionBody,
} from "./discord-projection.js";
import { createDiscordThreadName, createProjectionMarker } from "./projection-marker.js";
import { shouldReconcileDirectProjectionEditFailure } from "./discord-projection-error-classification.js";

export class DiscordSummaryPublisher {
  constructor(
    private readonly client: DiscordProjectionClient,
    private readonly lock: ProjectionLock,
  ) {}

  async publish(rawInput: PublishDiscordSummary): Promise<DiscordProjectionReference> {
    const input = publishDiscordSummarySchema.parse(rawInput);
    const marker = createProjectionMarker(input.projectionKey);
    const legacyMarkers = uniqueMarkers(input.legacyProjectionKeys ?? [], marker);
    const lockKey = `${input.parentChannelId}:${marker}`;

    return this.lock.runExclusive(lockKey, async () => {
      if (input.currentReference !== undefined) {
        try {
          await this.client.editMessage({
            threadId: input.currentReference.threadId,
            messageId: input.currentReference.messageId,
            body: toDiscordProjectionBody(input),
            marker,
          });
          return input.currentReference;
        } catch (error: unknown) {
          if (!shouldReconcileDirectProjectionEditFailure(error)) {
            throw error;
          }
          // The direct reference can be stale, deleted, or have an unknown remote
          // outcome. Reconcile the marker before creating anything new.
        }
      }

      return this.reconcile(input, marker, legacyMarkers);
    });
  }

  private async reconcile(
    input: PublishDiscordSummary,
    marker: string,
    legacyMarkers: readonly string[],
  ): Promise<DiscordProjectionReference> {
    const threadName = createDiscordThreadName(input.threadTitle, marker);
    let located = await this.locateProjection(input, marker, legacyMarkers);

    if (located === undefined) {
      located = await this.createOrRecoverThread(input, threadName, marker, legacyMarkers);
    }

    await this.client.renameThread({ threadId: located.threadId, name: threadName });

    const message = located.messageId === undefined
      ? await this.createOrRecoverMessage(input, located.threadId, marker, legacyMarkers)
      : { created: false, messageId: located.messageId };

    if (!message.created) {
      await this.client.editMessage({
        threadId: located.threadId,
        messageId: message.messageId,
        body: toDiscordProjectionBody(input),
        marker,
      });
    }

    return { threadId: located.threadId, messageId: message.messageId };
  }

  private async createOrRecoverThread(
    input: PublishDiscordSummary,
    name: string,
    marker: string,
    legacyMarkers: readonly string[],
  ): Promise<LocatedDiscordProjection> {
    try {
      return {
        threadId: await this.client.createThread({
          parentChannelId: input.parentChannelId,
          name,
          marker,
        }),
      };
    } catch (error: unknown) {
      const recovered = await this.locateProjection(input, marker, legacyMarkers);
      if (recovered !== undefined) {
        return recovered;
      }
      throw error;
    }
  }

  private async createOrRecoverMessage(
    input: PublishDiscordSummary,
    threadId: string,
    marker: string,
    legacyMarkers: readonly string[],
  ): Promise<{ readonly created: boolean; readonly messageId: string }> {
    try {
      const messageId = await this.client.createMessage({
        threadId,
        body: toDiscordProjectionBody(input),
        marker,
      });
      return { created: true, messageId };
    } catch (error: unknown) {
      const recovered = await this.locateProjection(input, marker, legacyMarkers);
      if (recovered?.messageId !== undefined) {
        return { created: false, messageId: recovered.messageId };
      }
      throw error;
    }
  }

  private async locateProjection(
    input: PublishDiscordSummary,
    marker: string,
    legacyMarkers: readonly string[],
  ): Promise<LocatedDiscordProjection | undefined> {
    for (const candidateMarker of [marker, ...legacyMarkers]) {
      const located = await this.client.inspect({
        parentChannelId: input.parentChannelId,
        marker: candidateMarker,
        ...(input.currentReference === undefined ? {} : { referenceHint: input.currentReference }),
      });
      if (located !== undefined) {
        return located;
      }
    }
    return undefined;
  }
}

function uniqueMarkers(legacyProjectionKeys: readonly string[], primaryMarker: string): string[] {
  return [...new Set(legacyProjectionKeys.map(createProjectionMarker))]
    .filter((marker) => marker !== primaryMarker);
}
