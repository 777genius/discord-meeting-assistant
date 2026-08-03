import type {
  LiveMeetingProjectionRequest,
  SummaryPublicationRequest,
} from "@discord-meeting/meeting-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createMeetingDiscordProjectionKey,
  DiscordLiveMeetingProjectionAdapter,
  DiscordSummaryPublicationAdapter,
  DiscordSummaryPublisher,
  InProcessProjectionLock,
  type DiscordProjectionBody,
  type DiscordProjectionClient,
  type DiscordProjectionReference,
  type LocatedDiscordProjection,
  type PublishDiscordSummary,
} from "../src/index.js";

const command: PublishDiscordSummary = {
  projectionKey: "meeting-2026-08-02",
  parentChannelId: "11111111111111111",
  threadTitle: "Meeting summary",
  markdown: "## Summary\n\nInitial summary.",
};

class FakeDiscordProjectionClient implements DiscordProjectionClient {
  readonly threads: Array<{
    threadId: string;
    parentChannelId: string;
    name: string;
    marker: string;
    message?: { messageId: string; body: DiscordProjectionBody; marker: string };
  }> = [];

  createThreadCount = 0;
  createMessageCount = 0;
  inspectCount = 0;
  renameCount = 0;
  editMessageCount = 0;
  throwAfterNextThreadCreate = false;
  throwAfterNextMessageCreate = false;
  throwAfterNextMessageEdit = false;
  nextMessageEditError: Error | null = null;
  createDelayMilliseconds = 0;

  async inspect(input: {
    parentChannelId: string;
    marker: string;
    referenceHint?: DiscordProjectionReference;
  }): Promise<LocatedDiscordProjection | undefined> {
    this.inspectCount += 1;
    const byHint = input.referenceHint === undefined
      ? undefined
      : this.threads.find(
          (thread) =>
            thread.threadId === input.referenceHint?.threadId &&
            thread.message?.messageId === input.referenceHint.messageId,
        );
    const thread = byHint ?? this.threads.find(
      (candidate) =>
        candidate.parentChannelId === input.parentChannelId && candidate.marker === input.marker,
    );

    if (thread === undefined) {
      return undefined;
    }
    return thread.message === undefined
      ? { threadId: thread.threadId }
      : { threadId: thread.threadId, messageId: thread.message.messageId };
  }

  async createThread(input: {
    parentChannelId: string;
    name: string;
    marker: string;
  }): Promise<string> {
    if (this.createDelayMilliseconds > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.createDelayMilliseconds);
      });
    }
    this.createThreadCount += 1;
    const threadId = `${2_000_000_000_000_0000 + this.createThreadCount}`;
    this.threads.push({ threadId, ...input });
    if (this.throwAfterNextThreadCreate) {
      this.throwAfterNextThreadCreate = false;
      throw new Error("unknown create-thread outcome");
    }
    return threadId;
  }

  async renameThread(input: { threadId: string; name: string }): Promise<void> {
    this.renameCount += 1;
    this.thread(input.threadId).name = input.name;
  }

  async createMessage(input: {
    threadId: string;
    body: DiscordProjectionBody;
    marker: string;
  }): Promise<string> {
    this.createMessageCount += 1;
    const messageId = `3${String(this.createMessageCount).padStart(16, "0")}`;
    this.thread(input.threadId).message = { messageId, ...input };
    if (this.throwAfterNextMessageCreate) {
      this.throwAfterNextMessageCreate = false;
      throw new Error("unknown create-message outcome");
    }
    return messageId;
  }

  async editMessage(input: {
    threadId: string;
    messageId: string;
    body: DiscordProjectionBody;
    marker: string;
  }): Promise<void> {
    const message = this.thread(input.threadId).message;
    if (message?.messageId !== input.messageId) {
      throw new Error("Message does not exist");
    }
    if (this.nextMessageEditError !== null) {
      const error = this.nextMessageEditError;
      this.nextMessageEditError = null;
      throw error;
    }
    this.editMessageCount += 1;
    message.body = input.body;
    message.marker = input.marker;
    if (this.throwAfterNextMessageEdit) {
      this.throwAfterNextMessageEdit = false;
      throw new Error("unknown edit outcome");
    }
  }

  private thread(threadId: string) {
    const thread = this.threads.find((candidate) => candidate.threadId === threadId);
    if (thread === undefined) {
      throw new Error("Thread does not exist");
    }
    return thread;
  }
}

function publisher(client: DiscordProjectionClient): DiscordSummaryPublisher {
  return new DiscordSummaryPublisher(client, new InProcessProjectionLock());
}

describe("DiscordSummaryPublisher contract", () => {
  it("does not edit a message immediately after a known-fresh create", async () => {
    const client = new FakeDiscordProjectionClient();

    await publisher(client).publish(command);

    expect(client.createMessageCount).toBe(1);
    expect(client.editMessageCount).toBe(0);
  });

  it("creates one projection and updates that projection on rerun", async () => {
    const client = new FakeDiscordProjectionClient();
    const subject = publisher(client);

    const first = await subject.publish(command);
    const second = await subject.publish({
      ...command,
      markdown: "## Summary\n\nCorrected summary.",
      currentReference: first,
    });

    expect(second).toEqual(first);
    expect(client.threads).toHaveLength(1);
    expect(client.createThreadCount).toBe(1);
    expect(client.createMessageCount).toBe(1);
    expect(client.threads[0]?.name).toMatch(/ \[код [0-9a-f]{20}\]$/u);
    expect(client.threads[0]?.message?.body.markdown).toContain("Corrected summary");
  });

  it("reconciles a thread create whose remote outcome was unknown", async () => {
    const client = new FakeDiscordProjectionClient();
    client.throwAfterNextThreadCreate = true;

    const reference = await publisher(client).publish(command);

    expect(reference.threadId).toBe(client.threads[0]?.threadId);
    expect(client.threads).toHaveLength(1);
    expect(client.createThreadCount).toBe(1);
    expect(client.createMessageCount).toBe(1);
  });

  it("reconciles a message create whose remote outcome was unknown", async () => {
    const client = new FakeDiscordProjectionClient();
    client.throwAfterNextMessageCreate = true;

    const reference = await publisher(client).publish(command);

    expect(reference.messageId).toBe(client.threads[0]?.message?.messageId);
    expect(client.createThreadCount).toBe(1);
    expect(client.createMessageCount).toBe(1);
  });

  it("serializes concurrent publication for the same projection", async () => {
    const client = new FakeDiscordProjectionClient();
    client.createDelayMilliseconds = 10;
    const subject = publisher(client);

    const results = await Promise.all([
      subject.publish(command),
      subject.publish({ ...command, markdown: "## Summary\n\nNewest summary." }),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(client.createThreadCount).toBe(1);
    expect(client.createMessageCount).toBe(1);
    expect(client.threads[0]?.message?.body.markdown).toContain("Newest summary");
  });

  it("creates once then directly edits many live revisions without another inspect or rename", async () => {
    const client = new FakeDiscordProjectionClient();
    const subject = publisher(client);
    const first = await subject.publish(command);
    const inspectionsAfterCreate = client.inspectCount;
    const renamesAfterCreate = client.renameCount;

    let current = first;
    for (const markdown of [
      "## Summary\n\nFast live update one.",
      "## Summary\n\nFast live update two.",
      "## Summary\n\nFast live update three.",
    ]) {
      current = await subject.publish({ ...command, markdown, currentReference: current });
    }

    expect(current).toEqual(first);
    expect(client.inspectCount).toBe(inspectionsAfterCreate);
    expect(client.renameCount).toBe(renamesAfterCreate);
    expect(client.editMessageCount).toBe(3);
    expect(client.createThreadCount).toBe(1);
    expect(client.createMessageCount).toBe(1);
  });

  it("recovers a failed direct edit through the marker without creating a second projection", async () => {
    const client = new FakeDiscordProjectionClient();
    const subject = publisher(client);
    const first = await subject.publish(command);
    client.throwAfterNextMessageEdit = true;

    const recovered = await subject.publish({
      ...command,
      markdown: "## Summary\n\nRecovered update.",
      currentReference: first,
    });

    expect(recovered).toEqual(first);
    expect(client.threads).toHaveLength(1);
    expect(client.createThreadCount).toBe(1);
    expect(client.createMessageCount).toBe(1);
    expect(client.threads[0]?.message?.body.markdown).toContain("Recovered update");
    expect(client.inspectCount).toBeGreaterThan(1);
  });

  it("returns a new receipt after a deleted message and directly edits it on the next refresh", async () => {
    const client = new FakeDiscordProjectionClient();
    const subject = publisher(client);
    const first = await subject.publish(command);
    const thread = client.threads[0];
    if (thread === undefined) {
      throw new Error("expected an initial Discord thread");
    }
    delete thread.message;

    const recovered = await subject.publish({
      ...command,
      markdown: "## Summary\n\nRecovered after deletion.",
      currentReference: first,
    });

    expect(recovered.threadId).toBe(first.threadId);
    expect(recovered.messageId).not.toBe(first.messageId);
    expect(client.threads).toHaveLength(1);
    expect(client.createMessageCount).toBe(2);
    const inspectionsAfterRecovery = client.inspectCount;
    const renamesAfterRecovery = client.renameCount;
    const editsAfterRecovery = client.editMessageCount;

    await expect(subject.publish({
      ...command,
      markdown: "## Summary\n\nDirect update after recovery.",
      currentReference: recovered,
    })).resolves.toEqual(recovered);

    expect(client.createMessageCount).toBe(2);
    expect(client.inspectCount).toBe(inspectionsAfterRecovery);
    expect(client.renameCount).toBe(renamesAfterRecovery);
    expect(client.editMessageCount).toBe(editsAfterRecovery + 1);
  });

  it.each([
    Object.assign(new Error("rate limited"), { status: 429 }),
    Object.assign(new Error("forbidden"), { status: 403 }),
    z.string().safeParse(42).error!,
  ])("does not reconcile a direct edit for a known failure", async (error) => {
    const client = new FakeDiscordProjectionClient();
    const subject = publisher(client);
    const reference = await subject.publish(command);
    const inspectionsBeforeFailure = client.inspectCount;
    const renamesBeforeFailure = client.renameCount;
    client.nextMessageEditError = error;

    await expect(subject.publish({
      ...command,
      markdown: "## Summary\n\nKnown failure.",
      currentReference: reference,
    })).rejects.toBe(error);

    expect(client.inspectCount).toBe(inspectionsBeforeFailure);
    expect(client.renameCount).toBe(renamesBeforeFailure);
    expect(client.createThreadCount).toBe(1);
    expect(client.createMessageCount).toBe(1);
  });

  it("reconciles an archived thread so the existing projection can be edited", async () => {
    const client = new FakeDiscordProjectionClient();
    const subject = publisher(client);
    const reference = await subject.publish(command);
    const inspectionsBeforeFailure = client.inspectCount;
    client.nextMessageEditError = Object.assign(new Error("thread is archived"), {
      code: 50_083,
      status: 403,
    });

    await expect(subject.publish({
      ...command,
      markdown: "## Summary\n\nRecovered archived thread.",
      currentReference: reference,
    })).resolves.toEqual(reference);

    expect(client.inspectCount).toBeGreaterThan(inspectionsBeforeFailure);
    expect(client.renameCount).toBe(2);
    expect(client.createThreadCount).toBe(1);
    expect(client.createMessageCount).toBe(1);
    expect(client.threads[0]?.message?.body.markdown).toContain("Recovered archived thread");
  });

  it("reconciles a legacy operation marker into the canonical meeting projection", async () => {
    const client = new FakeDiscordProjectionClient();
    const subject = publisher(client);
    const legacyKey = "meeting-summary-publication:v1|legacy";
    const first = await subject.publish({ ...command, projectionKey: legacyKey });
    const canonicalKey = createMeetingDiscordProjectionKey("meeting-42", command.parentChannelId);

    const reconciled = await subject.publish({
      ...command,
      projectionKey: canonicalKey,
      legacyProjectionKeys: [legacyKey],
      markdown: "## Summary\n\nCanonical update.",
    });

    expect(reconciled).toEqual(first);
    expect(client.createThreadCount).toBe(1);
    expect(client.createMessageCount).toBe(1);
    expect(client.threads[0]?.message?.body.markdown).toContain("Canonical update");
  });

  it("replaces a live captions embed with the final one-embed summary", async () => {
    const client = new FakeDiscordProjectionClient();
    const subject = publisher(client);
    const projectionKey = createMeetingDiscordProjectionKey("meeting-42", command.parentChannelId);
    const live = await subject.publish({
      ...command,
      projectionKey,
      markdown: "# Встреча в процессе\n\nПредварительное саммари.",
      liveCaptionsMarkdown: "## 🎙️ Сейчас говорят\n\n… `00:05` **Аня:** привет",
    });

    const final = await subject.publish({
      ...command,
      projectionKey,
      markdown: "# Итоги встречи\n\nФинальное саммари.",
      currentReference: live,
    });

    expect(final).toEqual(live);
    expect(client.threads).toHaveLength(1);
    expect(client.threads[0]?.message?.body).toEqual({
      markdown: "# Итоги встречи\n\nФинальное саммари.",
    });
  });

  it("keeps one projection when a manually renamed live thread is finalized", async () => {
    const client = new FakeDiscordProjectionClient();
    const subject = publisher(client);
    const livePublisher = new DiscordLiveMeetingProjectionAdapter(subject);
    const finalPublisher = new DiscordSummaryPublicationAdapter(subject);
    const liveRequest: LiveMeetingProjectionRequest = {
      captions: [{
        endMs: 8_000,
        isFinal: false,
        speakerId: "speaker-a",
        startMs: 5_000,
        text: "Обсуждаем выпуск.",
      }],
      currentExternalPublicationId: null,
      elapsedMs: 8_000,
      idempotencyKey: "meeting-live-projection:v1|meeting-42",
      meetingId: "meeting-42",
      publicationTargetId: command.parentChannelId,
      revision: 1,
      status: "active",
      summary: null,
      updatedAtMs: 8_000,
    };
    const finalRequest: SummaryPublicationRequest = {
      idempotencyKey: "meeting-summary-publication:v1|meeting-42",
      meetingId: "meeting-42",
      publicationTargetId: command.parentChannelId,
      summary: {
        actionItems: [],
        decisions: [],
        openQuestions: [],
        overview: "Выпуск согласован.",
        summaryId: "summary-42",
        title: "Итоги встречи",
        topics: [],
        transcriptId: "transcript-42",
        version: 1,
      },
      transcript: {
        recordingId: "recording-42",
        transcriptId: "transcript-42",
        turns: [],
        version: 1,
      },
    };

    const live = await livePublisher.publish(liveRequest);
    expect(live.ok).toBe(true);
    if (!live.ok) {
      throw new Error("expected the live publication to succeed");
    }

    const liveThread = client.threads[0];
    if (liveThread === undefined) {
      throw new Error("expected a live Discord thread");
    }
    liveThread.name = "Ручное переименование [legacy marker]";
    liveThread.marker = "legacy-manual-marker";

    const final = await finalPublisher.publish({
      ...finalRequest,
      currentExternalPublicationId: live.value.externalPublicationId,
    });

    expect(final).toEqual({
      ok: true,
      value: { externalPublicationId: live.value.externalPublicationId },
    });
    expect(client.threads).toHaveLength(1);
    expect(client.createThreadCount).toBe(1);
    expect(client.createMessageCount).toBe(1);
    expect(client.threads[0]?.message?.body.markdown).toContain("Выпуск согласован.");
  });
});
