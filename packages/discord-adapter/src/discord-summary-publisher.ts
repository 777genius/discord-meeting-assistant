import { createHash } from "node:crypto";

import {
  type SummaryPublicationEffectLedger,
} from "@discord-meeting/meeting-core/publishing";

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
  decodeDiscordExternalPublicationId,
  discordPublicationModeSchema,
  encodeDiscordExternalPublicationId,
  publishDiscordSummarySchema,
  toDiscordProjectionBody,
} from "./discord-projection.js";
import {
  isConfirmedMissingDiscordProjection,
  shouldReconcileDirectProjectionEditFailure,
} from "./discord-projection-error-classification.js";
import { DiscordProjectionConfigurationError } from "./discordjs-projection-client.js";
import {
  createDiscordThreadName,
  createDiscordThreadRecoveryName,
  createProjectionMarker,
} from "./projection-marker.js";

export interface DiscordSummaryPublisherOptions {
  /**
   * Each projection defaults to one mutable message in the results channel.
   * Existing thread receipts remain in their original container so a rollout
   * never creates a second visible projection for the same meeting.
   */
  readonly publicationMode?: DiscordPublicationMode;
}

export interface DiscordSummaryPublicationAttemptOptions {
  /** Cancels a best-effort live edit before the authoritative final write. */
  readonly signal?: AbortSignal;
  /** Never starts recovery work for a transient, non-authoritative projection. */
  readonly directEditOnly?: boolean;
}

type AcquiredProjection =
  | { readonly createdThread: false; readonly located: LocatedDiscordProjection }
  | {
    readonly createdThread: true;
    readonly located: Extract<LocatedDiscordProjection, { readonly kind: "thread" }>;
  };

interface ProjectionRecoveryIdentity {
  readonly legacyMarkers: readonly string[];
  readonly marker: string;
  readonly threadRecoveryName: string;
}

export class DiscordSummaryPublisher {
  private readonly publicationMode: DiscordPublicationMode;

  constructor(
    private readonly client: DiscordProjectionClient,
    private readonly lock: ProjectionLock,
    private readonly effectLedger: SummaryPublicationEffectLedger,
    options: DiscordSummaryPublisherOptions = {},
  ) {
    this.publicationMode = discordPublicationModeSchema.parse(
      options.publicationMode ?? "message",
    );
  }

  async publish(
    rawInput: PublishDiscordSummary,
    options: DiscordSummaryPublicationAttemptOptions = {},
  ): Promise<DiscordProjectionReference> {
    const input = publishDiscordSummarySchema.parse(rawInput);
    const marker = createProjectionMarker(input.projectionKey);
    const legacyMarkers = uniqueMarkers(input.legacyProjectionKeys ?? [], marker);
    const lockKey = `${input.parentChannelId}:${marker}`;

    return this.lock.runExclusive(lockKey, async () => {
      let allowReplacement = false;
      options.signal?.throwIfAborted();
      if (options.directEditOnly === true && input.currentReference === undefined) {
        throw new DiscordProjectionConfigurationError(
          "Direct-only Discord projection requires a current reference",
        );
      }
      if (input.currentReference !== undefined) {
        try {
          await this.client.editMessage({
            reference: input.currentReference,
            body: toDiscordProjectionBody(input, "reconciled"),
            marker,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          return input.currentReference;
        } catch (error: unknown) {
          options.signal?.throwIfAborted();
          if (options.directEditOnly === true) {
            throw error;
          }
          if (!shouldReconcileDirectProjectionEditFailure(error)) {
            throw error;
          }
          allowReplacement = isConfirmedMissingDiscordProjection(error);
          // The direct reference can be stale, deleted, or have an unknown remote
          // outcome. Reconcile the marker before creating anything new.
        }
      }

      return this.reconcile(input, marker, legacyMarkers, allowReplacement);
    });
  }

  private async reconcile(
    input: PublishDiscordSummary,
    marker: string,
    legacyMarkers: readonly string[],
    allowReplacement: boolean,
  ): Promise<DiscordProjectionReference> {
    const reservation = await this.effectLedger.reserveSummaryPublicationEffect({
      projectionKey: input.projectionKey,
      publicationTargetId: input.parentChannelId,
    });
    const durableReference = reservation.status === "completed"
      ? decodeDiscordExternalPublicationId(reservation.externalReceipt)
      : undefined;
    if (reservation.status === "completed" && durableReference === undefined) {
        throw new Error("Durable Discord publication receipt is invalid");
    }
    const threadName = createDiscordThreadName(input.threadTitle);
    const recovery: ProjectionRecoveryIdentity = {
      legacyMarkers,
      marker,
      threadRecoveryName: createDiscordThreadRecoveryName(marker),
    };
    const referenceHint = durableReference ?? input.currentReference;
    const existing = await this.locateDurableProjection(
      input,
      recovery,
      referenceHint,
      reservation.status !== "acquired",
    );
    if (
      existing === undefined
      && reservation.status === "completed"
      && !allowReplacement
    ) {
      throw new Error(
        "Discord publication has an unresolved durable create reservation",
      );
    }
    const messageNonce = createProjectionMessageNonce(
      input.projectionKey,
      reservation.status === "completed" ? reservation.externalReceipt : undefined,
    );
    const acquired: AcquiredProjection = existing === undefined
      ? await this.createOrRecoverContainer(
        input,
        recovery,
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
        recovery,
        messageNonce,
      )
      : { created: false, messageId: located.messageId };

    if (createdThread) {
      await this.client.renameThread({ threadId: located.threadId, name: threadName });
    }

    const reference = toReference(located, message.messageId);
    const externalReceipt = encodeDiscordExternalPublicationId(reference);
    if (reservation.status === "completed" && durableReference !== undefined) {
      await this.effectLedger.replaceSummaryPublicationEffect({
        expectedExternalReceipt: reservation.externalReceipt,
        externalReceipt,
        projectionKey: input.projectionKey,
        publicationTargetId: input.parentChannelId,
      });
    } else {
      await this.effectLedger.completeSummaryPublicationEffect({
        externalReceipt,
        projectionKey: input.projectionKey,
        publicationTargetId: input.parentChannelId,
      });
    }
    if (!message.created) {
      await this.client.editMessage({
        reference,
        body: toDiscordProjectionBody(input, "reconciled"),
        marker,
      });
    }

    return reference;
  }

  private async createOrRecoverContainer(
    input: PublishDiscordSummary,
    recovery: ProjectionRecoveryIdentity,
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
            name: recovery.threadRecoveryName,
            marker: recovery.marker,
          }),
        },
      };
    } catch (error: unknown) {
      const recovered = await this.locateProjection(
        input,
        recovery,
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
    recovery: ProjectionRecoveryIdentity,
    nonce: string,
  ): Promise<{ readonly created: boolean; readonly messageId: string }> {
    try {
      const messageId = await this.client.createMessage({
        container,
        body: toDiscordProjectionBody(input),
        marker: recovery.marker,
        nonce,
      });
      return { created: true, messageId };
    } catch (error: unknown) {
      const recovered = await this.locateProjection(
        input,
        recovery,
      );
      if (recovered?.messageId !== undefined) {
        return { created: false, messageId: recovered.messageId };
      }
      throw error;
    }
  }

  private async locateProjection(
    input: PublishDiscordSummary,
    recovery: ProjectionRecoveryIdentity,
    options: {
      readonly exhaustive?: boolean;
      readonly referenceHint?: DiscordProjectionReference;
    } = {},
  ): Promise<LocatedDiscordProjection | undefined> {
    const candidates = [recovery.marker, ...recovery.legacyMarkers];
    const referenceHint = options.referenceHint ?? input.currentReference;
    for (const [index, candidateMarker] of candidates.entries()) {
      const located = await this.client.inspect({
        exhaustive: options.exhaustive ?? false,
        includeThreads: this.publicationMode === "thread" ||
          referenceHint?.kind === "thread" ||
          index > 0,
        parentChannelId: input.parentChannelId,
        marker: candidateMarker,
        ...(referenceHint === undefined ? {} : { referenceHint }),
        threadRecoveryName: recovery.threadRecoveryName,
      });
      if (located !== undefined) {
        return located;
      }
    }
    return undefined;
  }

  private async locateDurableProjection(
    input: PublishDiscordSummary,
    recovery: ProjectionRecoveryIdentity,
    referenceHint: DiscordProjectionReference | undefined,
    exhaustiveRecoveryRequired: boolean,
  ): Promise<LocatedDiscordProjection | undefined> {
    const referenceOptions = referenceHint === undefined ? {} : { referenceHint };
    const bounded = await this.locateProjection(input, recovery, referenceOptions);
    if (bounded !== undefined || !exhaustiveRecoveryRequired) {
      return bounded;
    }
    return this.locateProjection(input, recovery, {
      exhaustive: true,
      ...referenceOptions,
    });
  }
}

function createProjectionMessageNonce(
  projectionKey: string,
  replacedExternalReceipt: string | undefined,
): string {
  return createHash("sha256")
    .update("discord-projection-message-v1")
    .update("\0")
    .update(projectionKey)
    .update("\0")
    .update(replacedExternalReceipt ?? "initial")
    .digest("hex")
    .slice(0, 25);
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
