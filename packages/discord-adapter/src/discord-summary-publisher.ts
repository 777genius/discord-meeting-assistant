import type {
  DiscordProjectionClient,
  DiscordProjectionReference,
  LocatedDiscordProjection,
  ProjectionLock,
  PublishDiscordSummary,
} from "./discord-projection.js";
import { publishDiscordSummarySchema } from "./discord-projection.js";
import { createDiscordThreadName, createProjectionMarker } from "./projection-marker.js";

export class DiscordSummaryPublisher {
  constructor(
    private readonly client: DiscordProjectionClient,
    private readonly lock: ProjectionLock,
  ) {}

  async publish(rawInput: PublishDiscordSummary): Promise<DiscordProjectionReference> {
    const input = publishDiscordSummarySchema.parse(rawInput);
    const marker = createProjectionMarker(input.projectionKey);
    const lockKey = `${input.parentChannelId}:${marker}`;

    return this.lock.runExclusive(lockKey, async () => this.reconcile(input, marker));
  }

  private async reconcile(
    input: PublishDiscordSummary,
    marker: string,
  ): Promise<DiscordProjectionReference> {
    const threadName = createDiscordThreadName(input.threadTitle, marker);
    let located = await this.client.inspect({
      parentChannelId: input.parentChannelId,
      marker,
      ...(input.currentReference === undefined ? {} : { referenceHint: input.currentReference }),
    });

    if (located === undefined) {
      located = await this.createOrRecoverThread(input.parentChannelId, threadName, marker);
    }

    await this.client.renameThread({ threadId: located.threadId, name: threadName });

    const messageId = located.messageId ??
      (await this.createOrRecoverMessage(input, located.threadId, marker));

    await this.client.editMessage({
      threadId: located.threadId,
      messageId,
      markdown: input.markdown,
      marker,
    });

    return { threadId: located.threadId, messageId };
  }

  private async createOrRecoverThread(
    parentChannelId: string,
    name: string,
    marker: string,
  ): Promise<LocatedDiscordProjection> {
    try {
      return {
        threadId: await this.client.createThread({ parentChannelId, name, marker }),
      };
    } catch (error: unknown) {
      const recovered = await this.client.inspect({ parentChannelId, marker });
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
  ): Promise<string> {
    try {
      return await this.client.createMessage({
        threadId,
        markdown: input.markdown,
        marker,
      });
    } catch (error: unknown) {
      const recovered = await this.client.inspect({
        parentChannelId: input.parentChannelId,
        marker,
      });
      if (recovered?.messageId !== undefined) {
        return recovered.messageId;
      }
      throw error;
    }
  }
}
