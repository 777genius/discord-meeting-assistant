import {
  type SummaryPublicationEffectLedger,
  type SummaryPublicationRequest,
} from "@discord-meeting/meeting-core/publishing";
import {
  type LiveMeetingProjectionRequest,
} from "@discord-meeting/meeting-core/live-meeting";
import { describe, expect, it } from "vitest";

import {
  decodeDiscordExternalPublicationId,
  DiscordLiveMeetingProjectionAdapter,
  DiscordSummaryPublicationAdapter,
  DiscordSummaryPublisher,
  InProcessProjectionLock,
  type DiscordProjectionBody,
  type DiscordProjectionClient,
  type DiscordProjectionContainer,
  type DiscordProjectionReference,
  type LocatedDiscordProjection,
  type PublishDiscordSummary,
} from "../src/index.js";

const parentChannelId = "11111111111111111";
const command: PublishDiscordSummary = {
  projectionKey: "meeting-publication-mode-42",
  parentChannelId,
  threadTitle: "Встреча · 2026-08-03 12:30 UTC",
  markdown: "# Встреча\n\nПервая версия.",
};

interface StoredMessage {
  readonly body: DiscordProjectionBody;
  readonly marker: string;
  readonly messageId: string;
}

interface StoredChannelMessage extends StoredMessage {
  readonly parentChannelId: string;
}

interface StoredThread {
  readonly name: string;
  readonly parentChannelId: string;
  readonly threadId: string;
  message?: StoredMessage;
}

class InMemoryProjectionClient implements DiscordProjectionClient {
  readonly channelMessages = new Map<string, StoredChannelMessage>();
  readonly threads = new Map<string, StoredThread>();
  createChannelMessageCount = 0;
  createThreadCount = 0;
  editMessageCount = 0;
  inspectCount = 0;
  readonly inspectInputs: Array<{ readonly includeThreads?: boolean; readonly marker: string }> = [];
  throwAfterNextChannelMessageCreate = false;
  throwBeforeNextThreadMessageCreate = false;

  async inspect(input: {
    readonly exhaustive?: boolean;
    readonly includeThreads?: boolean;
    readonly parentChannelId: string;
    readonly marker: string;
    readonly referenceHint?: DiscordProjectionReference;
    readonly threadRecoveryName?: string;
  }): Promise<LocatedDiscordProjection | undefined> {
    this.inspectCount += 1;
    this.inspectInputs.push({
      ...(input.includeThreads === undefined ? {} : { includeThreads: input.includeThreads }),
      marker: input.marker,
    });
    const hinted = input.referenceHint === undefined
      ? undefined
      : this.locateReference(input.referenceHint);
    if (hinted !== undefined) {
      return hinted;
    }

    const matchingChannel = [...this.channelMessages.values()]
      .filter((message) =>
        message.parentChannelId === input.parentChannelId && message.marker === input.marker
      );
    const matchingThreads = [...this.threads.values()]
      .filter((thread) =>
        thread.parentChannelId === input.parentChannelId &&
        (thread.message?.marker === input.marker || thread.name === input.threadRecoveryName),
      );
    if (matchingChannel.length + matchingThreads.length > 1) {
      throw new Error("Multiple projection containers match one marker");
    }
    const channelMessage = matchingChannel[0];
    if (channelMessage !== undefined) {
      return {
        kind: "channel-message",
        parentChannelId: input.parentChannelId,
        messageId: channelMessage.messageId,
      };
    }
    const thread = matchingThreads[0];
    return thread === undefined
      ? undefined
      : thread.message === undefined
        ? { kind: "thread", threadId: thread.threadId }
        : { kind: "thread", threadId: thread.threadId, messageId: thread.message.messageId };
  }

  async createThread(input: {
    readonly parentChannelId: string;
    readonly name: string;
    readonly marker: string;
  }): Promise<string> {
    this.createThreadCount += 1;
    const threadId = `2${String(this.createThreadCount).padStart(16, "0")}`;
    this.threads.set(threadId, { ...input, threadId });
    return threadId;
  }

  async reopenThread(input: { readonly threadId: string }): Promise<void> {
    if (!this.threads.has(input.threadId)) {
      throw new Error("Thread does not exist");
    }
  }

  async renameThread(input: { readonly threadId: string; readonly name: string }): Promise<void> {
    const thread = this.requireThread(input.threadId);
    this.threads.set(thread.threadId, { ...thread, name: input.name });
  }

  async createMessage(input: {
    readonly container: DiscordProjectionContainer;
    readonly body: DiscordProjectionBody;
    readonly marker: string;
    readonly nonce: string;
  }): Promise<string> {
    if (input.container.kind === "thread") {
      const thread = this.requireThread(input.container.threadId);
      if (this.throwBeforeNextThreadMessageCreate) {
        this.throwBeforeNextThreadMessageCreate = false;
        throw new Error("process stopped before create-message outcome");
      }
      const message = this.nextMessage(input.body, input.marker);
      this.threads.set(thread.threadId, { ...thread, message });
      return message.messageId;
    }
    this.createChannelMessageCount += 1;
    const message = this.nextMessage(input.body, input.marker);
    this.channelMessages.set(message.messageId, {
      ...message,
      parentChannelId: input.container.parentChannelId,
    });
    if (this.throwAfterNextChannelMessageCreate) {
      this.throwAfterNextChannelMessageCreate = false;
      throw new Error("unknown create-message outcome");
    }
    return message.messageId;
  }

  async editMessage(input: {
    readonly reference: DiscordProjectionReference;
    readonly body: DiscordProjectionBody;
    readonly marker: string;
  }): Promise<void> {
    const message = input.reference.kind === "thread"
      ? this.requireThread(input.reference.threadId).message
      : this.findChannelMessage(input.reference.parentChannelId, input.reference.messageId);
    if (message?.messageId !== input.reference.messageId) {
      throw Object.assign(new Error("Message does not exist"), { code: 10_008 });
    }
    this.editMessageCount += 1;
    const next = { ...message, body: input.body, marker: input.marker };
    if (input.reference.kind === "thread") {
      const thread = this.requireThread(input.reference.threadId);
      this.threads.set(thread.threadId, { ...thread, message: next });
      return;
    }
    this.channelMessages.set(input.reference.messageId, {
      ...next,
      parentChannelId: input.reference.parentChannelId,
    });
  }

  deleteChannelMessage(messageId: string): void {
    this.channelMessages.delete(messageId);
  }

  private locateReference(reference: DiscordProjectionReference): LocatedDiscordProjection | undefined {
    if (reference.kind === "thread") {
      const thread = this.threads.get(reference.threadId);
      if (thread?.message?.messageId !== reference.messageId) {
        return undefined;
      }
      return { kind: "thread", threadId: thread.threadId, messageId: thread.message.messageId };
    }
    const message = this.findChannelMessage(reference.parentChannelId, reference.messageId);
    return message === undefined
      ? undefined
      : {
        kind: "channel-message",
        parentChannelId: reference.parentChannelId,
        messageId: message.messageId,
      };
  }

  private findChannelMessage(
    expectedParentChannelId: string,
    messageId: string,
  ): StoredChannelMessage | undefined {
    const message = this.channelMessages.get(messageId);
    return message?.parentChannelId === expectedParentChannelId ? message : undefined;
  }

  private nextMessage(body: DiscordProjectionBody, marker: string): StoredMessage {
    const ordinal = this.editMessageCount + this.createChannelMessageCount + this.threads.size + 1;
    return { body, marker, messageId: `3${String(ordinal).padStart(16, "0")}` };
  }

  private requireThread(threadId: string): StoredThread {
    const thread = this.threads.get(threadId);
    if (thread === undefined) {
      throw new Error("Thread does not exist");
    }
    return thread;
  }
}

function publisher(
  client: DiscordProjectionClient,
  publicationMode?: "message" | "thread",
): DiscordSummaryPublisher {
  return new DiscordSummaryPublisher(
    client,
    new InProcessProjectionLock(),
    effectLedger(client),
    publicationMode === undefined ? {} : { publicationMode },
  );
}

const effectLedgers = new WeakMap<object, SummaryPublicationEffectLedger>();

function effectLedger(client: object): SummaryPublicationEffectLedger {
  const existing = effectLedgers.get(client);
  if (existing !== undefined) {
    return existing;
  }
  const entries = new Map<string, string | null>();
  const created: SummaryPublicationEffectLedger = {
    completeSummaryPublicationEffect: async (input) => {
      entries.set(input.projectionKey, input.externalReceipt);
    },
    replaceSummaryPublicationEffect: async (input) => {
      entries.set(input.projectionKey, input.externalReceipt);
    },
    reserveSummaryPublicationEffect: async (input) => {
      const externalReceipt = entries.get(input.projectionKey);
      if (typeof externalReceipt === "string") {
        return { externalReceipt, status: "completed" };
      }
      if (externalReceipt === null) {
        return { status: "pending" };
      }
      entries.set(input.projectionKey, null);
      return { status: "acquired" };
    },
  };
  effectLedgers.set(client, created);
  return created;
}

describe("Discord publication container modes", () => {
  it("defaults to one direct SUT message in the results channel", async () => {
    const client = new InMemoryProjectionClient();
    const subject = publisher(client);

    const first = await subject.publish(command);
    const second = await subject.publish({
      ...command,
      currentReference: first,
      markdown: "# Встреча\n\nОбновлённая версия.",
    });

    expect(first).toEqual({
      kind: "channel-message",
      parentChannelId,
      messageId: first.messageId,
    });
    expect(second).toEqual(first);
    expect(client.channelMessages.size).toBe(1);
    expect(client.threads.size).toBe(0);
    expect(client.createChannelMessageCount).toBe(1);
    expect(client.editMessageCount).toBe(1);
    expect(client.inspectInputs[0]?.includeThreads).toBe(false);
  });

  it("keeps separate direct projections for separate meetings in one results channel", async () => {
    const client = new InMemoryProjectionClient();
    const subject = publisher(client);

    const first = await subject.publish(command);
    const second = await subject.publish({
      ...command,
      projectionKey: "meeting-publication-mode-43",
    });

    expect(first.kind).toBe("channel-message");
    expect(second.kind).toBe("channel-message");
    expect(first.messageId).not.toBe(second.messageId);
    expect(client.channelMessages.size).toBe(2);
    expect(client.threads.size).toBe(0);
  });

  it("keeps threads as explicit opt-in and never exposes the internal marker in their title", async () => {
    const client = new InMemoryProjectionClient();
    const reference = await publisher(client, "thread").publish(command);
    const thread = [...client.threads.values()][0];

    expect(reference.kind).toBe("thread");
    expect(client.channelMessages.size).toBe(0);
    expect(thread?.name).toBe("Встреча · 2026-08-03 12:30 UTC");
    expect(thread?.name).not.toContain("код");
    expect(thread?.name).not.toContain("meeting-projection:");
    expect(client.inspectInputs[0]?.includeThreads).toBe(true);
  });

  it("does not merge two thread-mode meetings that share the same UTC-minute title", async () => {
    const client = new InMemoryProjectionClient();
    const subject = publisher(client, "thread");

    const first = await subject.publish(command);
    const second = await subject.publish({
      ...command,
      projectionKey: "meeting-publication-mode-43",
    });

    expect(first.kind).toBe("thread");
    expect(second.kind).toBe("thread");
    expect(first.messageId).not.toBe(second.messageId);
    expect(client.threads.size).toBe(2);
    expect([...client.threads.values()].map(({ name }) => name)).toEqual([
      "Встреча · 2026-08-03 12:30 UTC",
      "Встреча · 2026-08-03 12:30 UTC",
    ]);
  });

  it("finishes and humanizes a recovery thread left before message creation", async () => {
    const client = new InMemoryProjectionClient();
    client.throwBeforeNextThreadMessageCreate = true;

    await expect(publisher(client, "thread").publish(command)).rejects.toThrow(
      "process stopped before create-message outcome",
    );
    expect(client.threads.size).toBe(1);
    expect([...client.threads.values()][0]?.name).toContain("Meeting Platform recovery");

    const recovered = await publisher(client, "thread").publish(command);

    expect(recovered.kind).toBe("thread");
    expect(client.threads.size).toBe(1);
    expect([...client.threads.values()][0]?.message).toBeDefined();
    expect([...client.threads.values()][0]?.name).toBe(
      "Встреча · 2026-08-03 12:30 UTC",
    );
  });

  it("decodes legacy thread receipts and writes honest v2 container receipts", () => {
    expect(decodeDiscordExternalPublicationId(
      "discord:v1:thread:22222222222222222:message:33333333333333333",
    )).toEqual({
      kind: "thread",
      threadId: "22222222222222222",
      messageId: "33333333333333333",
    });
  });

  it("reconciles a direct-message unknown outcome and restart scan without duplication", async () => {
    const client = new InMemoryProjectionClient();
    client.throwAfterNextChannelMessageCreate = true;
    const first = await publisher(client).publish(command);
    const afterRestart = await publisher(client).publish(command);

    expect(first).toEqual(afterRestart);
    expect(first.kind).toBe("channel-message");
    expect(client.channelMessages.size).toBe(1);
    expect(client.createChannelMessageCount).toBe(1);
    expect(client.inspectCount).toBeGreaterThan(1);
  });

  it("creates one replacement after a deleted direct message and then edits that receipt", async () => {
    const client = new InMemoryProjectionClient();
    const subject = publisher(client);
    const first = await subject.publish(command);
    client.deleteChannelMessage(first.messageId);

    const replacement = await subject.publish({
      ...command,
      currentReference: first,
      markdown: "# Встреча\n\nВосстановленная версия.",
    });
    await subject.publish({
      ...command,
      currentReference: replacement,
      markdown: "# Встреча\n\nОбновление после восстановления.",
    });

    expect(replacement.kind).toBe("channel-message");
    expect(replacement.messageId).not.toBe(first.messageId);
    expect(client.channelMessages.size).toBe(1);
    expect(client.createChannelMessageCount).toBe(2);
    expect(client.editMessageCount).toBe(1);
  });

  it("keeps live and final publication on one direct message", async () => {
    const client = new InMemoryProjectionClient();
    const subject = publisher(client);
    const live = new DiscordLiveMeetingProjectionAdapter(subject);
    const final = new DiscordSummaryPublicationAdapter(subject);
    const liveRequest: LiveMeetingProjectionRequest = {
      captions: [{
        endMs: 4_000,
        isFinal: true,
        speakerId: "speaker-a",
        startMs: 1_000,
        text: "Согласуем выпуск.",
      }],
      currentExternalPublicationId: null,
      elapsedMs: 5_000,
      idempotencyKey: "meeting-live-projection:v1|meeting-mode-42",
      meetingId: "meeting-mode-42",
      phase: "live",
      publicationTargetId: parentChannelId,
      revision: 1,
      status: "active",
      summary: null,
      updatedAtMs: 1_780_000_000_000,
    };
    const finalRequest: SummaryPublicationRequest = {
      currentExternalPublicationId: null,
      idempotencyKey: "meeting-summary-publication:v1|meeting-mode-42",
      meetingId: "meeting-mode-42",
      publicationTargetId: parentChannelId,
      summary: {
        actionItems: [],
        decisions: [],
        openQuestions: [],
        overview: "Выпуск согласован.",
        summaryId: "summary-mode-42",
        title: "Итоги встречи",
        topics: [],
        transcriptId: "transcript-mode-42",
        version: 1,
      },
      transcript: {
        recordingId: "recording-mode-42",
        transcriptId: "transcript-mode-42",
        turns: [{
          endMs: 4_000,
          speakerId: "speaker-a",
          startMs: 1_000,
          text: "Согласуем выпуск.",
          turnId: "turn-mode-42",
        }],
        version: 1,
      },
    };

    const liveResult = await live.publish(liveRequest);
    expect(liveResult.ok).toBe(true);
    if (!liveResult.ok) {
      throw new Error("expected live publication to succeed");
    }
    const finalResult = await final.publish({
      ...finalRequest,
      currentExternalPublicationId: liveResult.value.externalPublicationId,
    });

    expect(finalResult).toEqual({
      ok: true,
      value: { externalPublicationId: liveResult.value.externalPublicationId },
    });
    expect(client.channelMessages.size).toBe(1);
    expect(client.threads.size).toBe(0);
    const initialReference = decodeDiscordExternalPublicationId(
      liveResult.value.externalPublicationId,
    );
    const message = initialReference?.kind === "channel-message"
      ? client.channelMessages.get(initialReference.messageId)
      : undefined;
    expect(message?.body.transcriptAttachment).toEqual({
      content: [
        "# Meeting transcript",
        "",
        "_Final transcript based on the meeting recording._",
        "",
        "## `00:01-00:04` · speaker-a",
        "",
        "Согласуем выпуск.",
      ].join("\n"),
      filename: "meeting-transcript.md",
    });

    const retry = await final.publish({
      ...finalRequest,
      currentExternalPublicationId: finalResult.ok
        ? finalResult.value.externalPublicationId
        : null,
    });
    expect(retry).toEqual(finalResult);
    expect(client.channelMessages.size).toBe(1);
    expect(client.threads.size).toBe(0);
    expect(client.editMessageCount).toBeGreaterThanOrEqual(2);
  });
});
