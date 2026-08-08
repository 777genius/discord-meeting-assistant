import {
  ChannelType,
  Client,
  ThreadAutoArchiveDuration,
} from "discord.js";

import type {
  DiscordProjectionBody,
  DiscordProjectionClient,
  DiscordProjectionReference,
  LocatedDiscordProjection,
} from "./discord-projection.js";
import { DiscordProjectionConfigurationError } from "./discordjs-projection-errors.js";
import {
  fetchDiscordProjectionParentChannel,
  fetchDiscordProjectionThread,
  inspectDiscordProjection,
} from "./discordjs-projection-inspection.js";
import {
  toDiscordMessagePayload,
  toDiscordRestMessageEditBody,
} from "./discordjs-projection-message-payload.js";

export {
  DiscordProjectionConfigurationError,
  DiscordProjectionConflictError,
} from "./discordjs-projection-errors.js";
export { toDiscordMessagePayload } from "./discordjs-projection-message-payload.js";

export class DiscordJsProjectionClient implements DiscordProjectionClient {
  public constructor(private readonly client: Client) {}

  public async inspect(input: {
    readonly exhaustive?: boolean;
    readonly includeThreads?: boolean;
    readonly parentChannelId: string;
    readonly marker: string;
    readonly referenceHint?: DiscordProjectionReference;
    readonly threadRecoveryName?: string;
  }): Promise<LocatedDiscordProjection | undefined> {
    return inspectDiscordProjection(this.client, input);
  }

  public async createThread(input: {
    readonly parentChannelId: string;
    readonly name: string;
    readonly marker: string;
  }): Promise<string> {
    const parent = await fetchDiscordProjectionParentChannel(this.client, input.parentChannelId);
    const common = {
      name: input.name,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: "Create idempotent meeting summary projection",
    } as const;
    const thread = parent.type === ChannelType.GuildText
      ? await parent.threads.create({ ...common, type: ChannelType.PublicThread })
      : await parent.threads.create({ ...common, type: ChannelType.AnnouncementThread });
    return thread.id;
  }

  public async reopenThread(input: { readonly threadId: string }): Promise<void> {
    const thread = await fetchDiscordProjectionThread(this.client, input.threadId);
    await thread.edit({
      archived: false,
      reason: "Reconcile meeting summary projection",
    });
  }

  public async renameThread(input: { readonly threadId: string; readonly name: string }): Promise<void> {
    const thread = await fetchDiscordProjectionThread(this.client, input.threadId);
    await thread.edit({
      name: input.name,
      archived: false,
      reason: "Finalize meeting summary projection thread title",
    });
  }

  public async createMessage(input: {
    readonly container:
      | { readonly kind: "thread"; readonly threadId: string }
      | { readonly kind: "channel-message"; readonly parentChannelId: string };
    readonly body: DiscordProjectionBody;
    readonly marker: string;
    readonly nonce: string;
  }): Promise<string> {
    const destination = input.container.kind === "thread"
      ? await fetchDiscordProjectionThread(this.client, input.container.threadId)
      : await fetchDiscordProjectionParentChannel(this.client, input.container.parentChannelId);
    const message = await destination.send({
      ...toDiscordMessagePayload(input.body, input.marker),
      enforceNonce: true,
      nonce: input.nonce,
    });
    return message.id;
  }

  public async editMessage(input: {
    readonly reference: DiscordProjectionReference;
    readonly body: DiscordProjectionBody;
    readonly marker: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (input.signal !== undefined) {
      input.signal.throwIfAborted();
      if (
        input.body.summaryAttachment !== undefined ||
        input.body.transcriptAttachment !== undefined
      ) {
        throw new DiscordProjectionConfigurationError(
          "Abortable Discord projection edits cannot include attachments",
        );
      }
      const channelId = input.reference.kind === "thread"
        ? input.reference.threadId
        : input.reference.parentChannelId;
      await this.client.rest.patch(
        `/channels/${channelId}/messages/${input.reference.messageId}`,
        {
          body: toDiscordRestMessageEditBody(input.body, input.marker),
          signal: input.signal,
        },
      );
      return;
    }
    const destination = input.reference.kind === "thread"
      ? await fetchDiscordProjectionThread(this.client, input.reference.threadId)
      : await fetchDiscordProjectionParentChannel(this.client, input.reference.parentChannelId);
    const message = await destination.messages.fetch(input.reference.messageId);
    await message.edit(toDiscordMessagePayload(input.body, input.marker));
  }
}
