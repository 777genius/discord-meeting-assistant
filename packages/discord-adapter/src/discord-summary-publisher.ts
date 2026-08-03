import type {
  DiscordProjectionClient,
  DiscordProjectionContainer,
  DiscordProjectionReference,
  DiscordPublicationMode,
  LocatedDiscordProjection,
  ProjectionLock,
  PublishDiscordSummary,
} from "./discord-projection.js";
import {
  discordPublicationModeSchema,
  publishDiscordSummarySchema,
  toDiscordProjectionBody,
} from "./discord-projection.js";
import { shouldReconcileDirectProjectionEditFailure } from "./discord-projection-error-classification.js";
import {
  createDiscordThreadName,
  createDiscordThreadRecoveryName,
  createProjectionMarker,
} from "./projection-marker.js";

export interface DiscordSummaryPublisherOptions {
  /**
   * New meetings default to one mutable message in the results channel.
   * Existing thread receipts remain in their original container so a rollout
   * never creates a second visible projection for the same meeting.
   */
  readonly publicationMode?: DiscordPublicationMode;
}

type AcquiredProjection =
  | { readonly createdThread: false; readonly located: LocatedDiscordProjection }
  | {
    readonly createdThread: true;
    readonly located: Extract<LocatedDiscordProjection, { readonly kind: "thread" }>;
  };

export class DiscordSummaryPublisher {
  private readonly publicationMode: DiscordPublicationMode;

  constructor(
    private readonly client: DiscordProjectionClient,
    private readonly lock: ProjectionLock,
    options: DiscordSummaryPublisherOptions = {},
  ) {
    this.publicationMode = discordPublicationModeSchema.parse(
      options.publicationMode ?? "message",
    );
  }

  async publish(rawInput: PublishDiscordSummary): Promise<DiscordProjectionReference> {
    const input = publishDiscordSummarySchema.parse(rawInput);
    const marker = createProjectionMarker(input.projectionKey);
    const legacyMarkers = uniqueMarkers(input.legacyProjectionKeys ?? [], marker);
    const lockKey = `${input.parentChannelId}:${marker}`;

    return this.lock.runExclusive(lockKey, async () => {
      if (input.currentReference !== undefined) {
        try {
          await this.client.editMessage({
            reference: input.currentReference,
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
    const threadName = createDiscordThreadName(input.threadTitle);
    const threadRecoveryName = createDiscordThreadRecoveryName(marker);
    const existing = await this.locateProjection(
      input,
      marker,
      legacyMarkers,
      threadRecoveryName,
    );
    const acquired: AcquiredProjection = existing === undefined
      ? await this.createOrRecoverContainer(
        input,
        threadRecoveryName,
        marker,
        legacyMarkers,
      )
      : existing.kind === "thread" && existing.messageId === undefined
        ? {
          // A recovery-name thread without a marker-bearing message is the
          // durable remnant of a crash between Discord thread and message
          // creation. Complete it and replace the temporary name.
          createdThread: true,
          located: existing,
        }
        : { createdThread: false, located: existing };
    const { createdThread, located } = acquired;

    if (located.kind === "thread") {
      await this.client.reopenThread({ threadId: located.threadId });
    }

    const message = located.messageId === undefined
      ? await this.createOrRecoverMessage(
        input,
        toContainer(located),
        marker,
        legacyMarkers,
        threadRecoveryName,
      )
      : { created: false, messageId: located.messageId };

    if (createdThread) {
      await this.client.renameThread({ threadId: located.threadId, name: threadName });
    }

    const reference = toReference(located, message.messageId);
    if (!message.created) {
      await this.client.editMessage({
        reference,
        body: toDiscordProjectionBody(input),
        marker,
      });
    }

    return reference;
  }

  private async createOrRecoverContainer(
    input: PublishDiscordSummary,
    threadRecoveryName: string,
    marker: string,
    legacyMarkers: readonly string[],
  ): Promise<AcquiredProjection> {
    if (this.publicationMode === "message") {
      return {
        createdThread: false,
        located: { kind: "channel-message", parentChannelId: input.parentChannelId },
      };
    }

    try {
      return {
        createdThread: true,
        located: {
          kind: "thread",
          threadId: await this.client.createThread({
            parentChannelId: input.parentChannelId,
            name: threadRecoveryName,
            marker,
          }),
        },
      };
    } catch (error: unknown) {
      const recovered = await this.locateProjection(
        input,
        marker,
        legacyMarkers,
        threadRecoveryName,
      );
      if (recovered !== undefined) {
        return recovered.kind === "thread" && recovered.messageId === undefined
          ? { createdThread: true, located: recovered }
          : { createdThread: false, located: recovered };
      }
      throw error;
    }
  }

  private async createOrRecoverMessage(
    input: PublishDiscordSummary,
    container: DiscordProjectionContainer,
    marker: string,
    legacyMarkers: readonly string[],
    threadRecoveryName: string,
  ): Promise<{ readonly created: boolean; readonly messageId: string }> {
    try {
      const messageId = await this.client.createMessage({
        container,
        body: toDiscordProjectionBody(input),
        marker,
      });
      return { created: true, messageId };
    } catch (error: unknown) {
      const recovered = await this.locateProjection(
        input,
        marker,
        legacyMarkers,
        threadRecoveryName,
      );
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
    threadRecoveryName: string,
  ): Promise<LocatedDiscordProjection | undefined> {
    const candidates = [marker, ...legacyMarkers];
    for (const [index, candidateMarker] of candidates.entries()) {
      const located = await this.client.inspect({
        includeThreads: this.publicationMode === "thread" ||
          input.currentReference?.kind === "thread" ||
          index > 0,
        parentChannelId: input.parentChannelId,
        marker: candidateMarker,
        ...(input.currentReference === undefined ? {} : { referenceHint: input.currentReference }),
        threadRecoveryName,
      });
      if (located !== undefined) {
        return located;
      }
    }
    return undefined;
  }
}

function toContainer(located: LocatedDiscordProjection): DiscordProjectionContainer {
  return located.kind === "thread"
    ? { kind: "thread", threadId: located.threadId }
    : { kind: "channel-message", parentChannelId: located.parentChannelId };
}

function toReference(
  located: LocatedDiscordProjection,
  messageId: string,
): DiscordProjectionReference {
  return located.kind === "thread"
    ? { kind: "thread", threadId: located.threadId, messageId }
    : { kind: "channel-message", parentChannelId: located.parentChannelId, messageId };
}

function uniqueMarkers(legacyProjectionKeys: readonly string[], primaryMarker: string): string[] {
  return [...new Set(legacyProjectionKeys.map(createProjectionMarker))]
    .filter((marker) => marker !== primaryMarker);
}
