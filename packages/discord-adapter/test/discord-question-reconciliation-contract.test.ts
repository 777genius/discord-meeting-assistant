import { DiscordLocalFinalReplyHandler, DiscordQuestionPrincipalCodec } from
  "@discord-meeting/discord-adapter";
import { EventEmitter } from "node:events";
import type { Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { containerId, guildId, questionId } from
  "./discord-local-final-reply-contract.fixture.js";

function reconciliationQuestion(
  codec: DiscordQuestionPrincipalCodec,
  quarantined: boolean,
  reconciledQuestionId: string = questionId,
) {
  return {
    authorizationPrincipalRef: null, botApplicationIdentity: null,
    deliveryContainerId: containerId,
    finalProjectionReceipt:
      `discord:v2:channel:${containerId}:message:44444444444444444`,
    questionHash: codec.questionHash("Original question"),
    questionId: reconciledQuestionId,
    ...(quarantined ? {
      reconciliationDisposition: "quarantined" as const,
    } : {
    }),
    requesterSubject: codec.keyedSubject("77777777777777777", guildId),
    scopeId: guildId,
  } as const;
}

function reconciliationHandler(input: {
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly quarantined?: boolean;
  readonly questions?: readonly ReturnType<typeof reconciliationQuestion>[];
}) {
  const codec = new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7));
  const cancelQuestion = vi.fn().mockResolvedValue(null);
  const convergeDeliveredQuestion = vi.fn().mockResolvedValue(true);
  const recordQuestionMutation = vi.fn().mockResolvedValue(null);
  let durableCursor: string | null = null;
  const saveQuestionReconciliationCursor = vi.fn(async (cursor: {
    readonly expectedAfterQuestionId: string | null;
    readonly nextAfterQuestionId: string | null;
  }) => {
    if (cursor.expectedAfterQuestionId !== durableCursor) {return false;}
    durableCursor = cursor.nextAfterQuestionId;
    return true;
  });
  const handler = new DiscordLocalFinalReplyHandler({
    admission: { execute: vi.fn() },
    admissions: { recordQuestionMutation,
      withdrawProjection: vi.fn().mockResolvedValue([]) },
    client: Object.assign(new EventEmitter(), {
      channels: { fetch: input.fetch },
      user: { id: "11111111111111111" },
    }) as unknown as Client,
    jobs: { cancelQuestion, convergeDeliveredQuestion,
      hasActiveQuestion: vi.fn().mockResolvedValue(false),
      loadQuestionReconciliationCursor: vi.fn(async () => durableCursor),
      listActiveQuestionsForReconciliation: vi.fn(async ({ afterQuestionId,
        maximumRows }: { readonly afterQuestionId: string | null;
          readonly maximumRows: number }) => (input.questions ?? [
          reconciliationQuestion(codec, input.quarantined === true),
        ]).filter(({ questionId: candidate }) => afterQuestionId === null ||
          candidate > afterQuestionId).slice(0, maximumRows)),
      saveQuestionReconciliationCursor },
    options: { principalTtlSeconds: 900 }, principals: codec,
    publication: { cancelBeforeRequest: vi.fn().mockResolvedValue(true) },
    scopes: { resultsContainerForGuild: () => Promise.resolve(containerId) },
  });
  return { cancelQuestion, convergeDeliveredQuestion, handler, recordQuestionMutation,
    saveQuestionReconciliationCursor };
}

describe("Discord question reconciliation fetch classification", () => {
  it.each([
    ["rate limit", { code: 20_028, status: 429 }],
    ["permission failure", { code: 50_013, status: 403 }],
    ["timeout", Object.assign(new Error("timed out"), { name: "AbortError" })],
    ["server failure", { status: 503 }],
    ["unclassified HTTP absence", { status: 404 }],
  ])("preserves cursor/job state while Discord is unavailable: %s",
    async (_label, error) => {
      const fetch = vi.fn().mockRejectedValueOnce(error)
        .mockRejectedValueOnce({ code: 10_003, status: 404 });
      const fixture = reconciliationHandler({ fetch });

      fixture.handler.start();
      await fixture.handler.settle();
      expect(fixture.recordQuestionMutation).not.toHaveBeenCalled();
      expect(fixture.cancelQuestion).not.toHaveBeenCalled();
      expect(fixture.saveQuestionReconciliationCursor).toHaveBeenLastCalledWith({
        expectedAfterQuestionId: null, nextAfterQuestionId: null,
      });

      await fixture.handler.reconcilePending();
      expect(fixture.recordQuestionMutation).toHaveBeenCalledWith({ kind: "delete",
        questionId, retentionSeconds: 86_400 });
      expect(fixture.cancelQuestion).toHaveBeenCalledWith(questionId);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fixture.saveQuestionReconciliationCursor).toHaveBeenCalledTimes(2);
      fixture.handler.close();
    });

  it("converges a missed edit on a later periodic confirmation", async () => {
    const channel = {
      id: containerId, isTextBased: () => true, isThread: () => false,
      messages: { fetch: vi.fn().mockResolvedValue({
        author: { id: "77777777777777777" }, content: "Edited while offline",
        reference: { messageId: "44444444444444444" }, webhookId: null,
      }) },
    };
    const fetch = vi.fn().mockRejectedValueOnce({ status: 503 })
      .mockResolvedValue(channel);
    const fixture = reconciliationHandler({ fetch });

    fixture.handler.start();
    await fixture.handler.settle();
    expect(fixture.cancelQuestion).not.toHaveBeenCalled();
    await fixture.handler.reconcilePending();
    expect(fixture.recordQuestionMutation).toHaveBeenCalledWith({ kind: "edit",
      questionId, retentionSeconds: 86_400 });
    expect(fixture.cancelQuestion).toHaveBeenCalledWith(questionId);
    fixture.handler.close();
  });

  it("never fetches or mutates a durable quarantined row after restart", async () => {
    const fetch = vi.fn();
    const fixture = reconciliationHandler({ fetch, quarantined: true });

    fixture.handler.start();
    await fixture.handler.settle();
    await fixture.handler.reconcilePending();
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.recordQuestionMutation).not.toHaveBeenCalled();
    expect(fixture.cancelQuestion).not.toHaveBeenCalled();
    fixture.handler.close();
  });

  it("converges a current delivered effect out of periodic eligibility", async () => {
    const projectionId = "44444444444444444";
    const channel = {
      id: containerId, isTextBased: () => true, isThread: () => false,
      messages: { fetch: vi.fn(({ message }: { readonly message: string }) =>
        Promise.resolve(message === projectionId
          ? { author: { id: "11111111111111111" }, channelId: containerId,
              webhookId: null }
          : { author: { id: "77777777777777777" }, channelId: containerId,
              content: "Original question", reference: { messageId: projectionId },
              webhookId: null })) },
    };
    const fixture = reconciliationHandler({ fetch: vi.fn().mockResolvedValue(channel) });
    fixture.handler.start();
    await fixture.handler.settle();
    expect(fixture.convergeDeliveredQuestion).toHaveBeenCalledWith(questionId);
    expect(fixture.cancelQuestion).not.toHaveBeenCalled();
    expect(fixture.recordQuestionMutation).not.toHaveBeenCalled();
    fixture.handler.close();
  });

  it("bounds one invocation to one page and stops its cursor before an outage",
    async () => {
      const codec = new DiscordQuestionPrincipalCodec(Buffer.alloc(32, 7));
      const questions = Array.from({ length: 101 }, (_, index) =>
        reconciliationQuestion(codec, false,
          String(33_333_333_333_330_000n + BigInt(index))));
      const projectionId = "44444444444444444";
      const currentChannel = {
        id: containerId, isTextBased: () => true, isThread: () => false,
        messages: { fetch: vi.fn(({ message }: { readonly message: string }) =>
          Promise.resolve(message === projectionId
            ? { author: { id: "11111111111111111" }, channelId: containerId,
                webhookId: null }
            : { author: { id: "77777777777777777" }, channelId: containerId,
                content: "Original question", reference: { messageId: projectionId },
                webhookId: null })) },
      };
      const fetch = vi.fn()
        .mockResolvedValueOnce(currentChannel)
        .mockRejectedValueOnce({ status: 503 });
      const fixture = reconciliationHandler({ fetch, questions });

      fixture.handler.start();
      await fixture.handler.settle();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fixture.saveQuestionReconciliationCursor).toHaveBeenLastCalledWith({
        expectedAfterQuestionId: null,
        nextAfterQuestionId: questions[0]!.questionId,
      });
      expect(fixture.cancelQuestion).not.toHaveBeenCalled();

      fetch.mockResolvedValue(currentChannel);
      await fixture.handler.reconcilePending();
      expect(fetch).toHaveBeenCalledTimes(102);
      expect(fixture.saveQuestionReconciliationCursor).toHaveBeenLastCalledWith({
        expectedAfterQuestionId: questions[0]!.questionId,
        nextAfterQuestionId: questions[100]!.questionId,
      });
      // The page boundary is durable; no second page can run in this invocation.
      await fixture.handler.reconcilePending();
      expect(fixture.saveQuestionReconciliationCursor).toHaveBeenLastCalledWith({
        expectedAfterQuestionId: questions[100]!.questionId,
        nextAfterQuestionId: null,
      });
      fixture.handler.close();
    });
});
