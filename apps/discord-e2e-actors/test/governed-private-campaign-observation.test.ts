import { describe, expect, it } from "vitest";

import {
  governedCampaignObservationFingerprint,
  observeGovernedPrivateCampaign,
  type GovernedCampaignMessage,
  type GovernedCampaignObservationInput,
  type GovernedCampaignObservationPort,
  type GovernedCampaignSurface,
} from "../src/governed-private-campaign-observation.js";
import { governedPrivateCampaignObservationV1Schema } from
  "../src/governed-private-campaign-observation-contract.js";
import { assertGovernedObservationPolicyMatchesPlan } from
  "../src/thin-remediation-proof.js";

const guildId = "1533228590643155034";
const parentA = "1533228891827736657";
const parentB = "1533228891827736658";
const activeThread = "1533228891827736659";
const archivedThread = "1533228891827736660";
const activePrivateThread = "1533228891827736661";
const archivedPrivateThread = "1533228891827736662";
const sutId = "1533224474609057793";
const observerId = "1533867700575670282";
const startedAt = "2026-08-24T00:00:00.000Z";
const endedAt = "2026-08-24T00:10:00.000Z";

describe("governed private campaign observation adapter", () => {
  it("paginates beyond 100 messages across multiple governed parents and active/archived threads", async () => {
    const messages = messageSet();
    const expected = [messages[parentA]![120]!, messages[archivedPrivateThread]![0]!].map(receipt);
    const result = await observeGovernedPrivateCampaign(input(expected), port(messages));

    expect(result.receipts).toEqual(expected.toSorted((left, right) =>
      left.messageId.localeCompare(right.messageId)));
    expect(result.inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ channelId: parentA, messagePagesRead: 2 }),
      expect.objectContaining({ channelId: parentB, kind: "parent" }),
      expect.objectContaining({ channelId: activeThread, kind: "active-thread" }),
      expect.objectContaining({ channelId: activePrivateThread, kind: "active-thread",
        messagePagesRead: 2, threadVisibility: "private" }),
      expect.objectContaining({ channelId: archivedThread, kind: "archived-thread",
        threadVisibility: "public" }),
      expect.objectContaining({ channelId: archivedPrivateThread, kind: "archived-thread",
        threadVisibility: "private" }),
    ]));
    expect(result.canonicalInventorySha256).toMatch(/^[a-f\d]{64}$/u);
  });

  it("fails closed when an off-target SUT answer exists on a later message page", async () => {
    const messages = messageSet();
    const intended = [messages[parentA]![10]!, messages[archivedPrivateThread]![0]!];
    messages[parentA]![120] = { ...messages[parentA]![120]!, authorApplicationId: sutId,
      replyToMessageId: snowflake(30) };

    await expect(observeGovernedPrivateCampaign(
      input(intended.map(receipt)), port(messages),
    )).rejects.toThrow(/exactly the intended SUT answers/u);
  });

  it("fails closed on missing permissions and partial active/archive enumeration", async () => {
    const messages = messageSet();
    const expected = [messages[parentA]![120]!, messages[archivedPrivateThread]![0]!].map(receipt);
    const permissionFailure = port(messages);
    permissionFailure.fetchMessages = () => Promise.reject(new Error("Missing Access"));
    await expect(observeGovernedPrivateCampaign(input(expected), permissionFailure))
      .rejects.toThrow("Missing Access");

    const partialActive = port(messages);
    partialActive.fetchActiveThreads = async () => ({ complete: false, threads: [] });
    await expect(observeGovernedPrivateCampaign(input(expected), partialActive))
      .rejects.toThrow(/active-thread enumeration is incomplete/u);

    const partialArchive = port(messages);
    partialArchive.fetchArchivedThreads = async ({ visibility }) => ({
      completeness: visibility === "private" ? "joined-only" : "all", hasMore: false,
      nextBefore: undefined, threads: [], visibility,
    });
    await expect(observeGovernedPrivateCampaign(input(expected), partialArchive))
      .rejects.toThrow(/private archived-thread enumeration is incomplete/u);
  });

  it("fails closed on archive cursor loops and message pagination limits", async () => {
    const messages = messageSet();
    const expected = [messages[parentA]![120]!, messages[archivedPrivateThread]![0]!].map(receipt);
    const looping = port(messages);
    looping.fetchArchivedThreads = async ({ before, parentChannelId, visibility }) => ({
      completeness: "all",
      hasMore: true,
      nextBefore: before ?? "2026-08-24T00:09:00.000Z",
      threads: [surface(archivedThread, parentChannelId, "archived-thread",
        "2026-08-24T00:09:00.000Z", visibility)],
      visibility,
    });
    await expect(observeGovernedPrivateCampaign(input(expected), looping))
      .rejects.toThrow(/cursor did not advance/u);

    await expect(observeGovernedPrivateCampaign({
      ...input(expected), maximumMessagePagesPerSurface: 1,
    }, port(messages))).rejects.toThrow(/message pagination limit/u);
  });

  it("independently paginates more than 100 private archives and catches a later-page answer", async () => {
    const messages = messageSet();
    const privateArchives = Array.from({ length: 101 }, (_, index) => {
      const channelId = (BigInt(archivedPrivateThread) + BigInt(index + 10)).toString();
      messages[channelId] = [message(channelId, index + 300, index === 100 ? sutId : observerId)];
      return surface(channelId, parentA, "archived-thread",
        new Date(Date.parse("2026-08-24T00:09:00.000Z") - index).toISOString(), "private");
    });
    const expected = [messages[parentA]![120]!, messages[archivedPrivateThread]![0]!].map(receipt);
    const hostile = port(messages);
    hostile.fetchArchivedThreads = async ({ before, parentChannelId, visibility }) => {
      if (parentChannelId !== parentA || visibility !== "private") {
        return { completeness: "all", hasMore: false, nextBefore: undefined, threads: [],
          visibility };
      }
      const offset = before === undefined ? 0 : 100;
      const threads = privateArchives.slice(offset, offset + 100);
      return { completeness: "all", hasMore: offset === 0,
        nextBefore: threads.at(-1)?.archivedAt ?? undefined, threads, visibility };
    };

    await expect(observeGovernedPrivateCampaign(input(expected), hostile))
      .rejects.toThrow(/exactly the intended SUT answers/u);
  });

  it("rejects duplicate public/private identities and seals visibility into the fingerprint", async () => {
    const messages = messageSet();
    const expected = [messages[parentA]![120]!, messages[archivedPrivateThread]![0]!].map(receipt);
    const duplicate = port(messages);
    duplicate.fetchArchivedThreads = async ({ parentChannelId, visibility }) => ({
      completeness: "all", hasMore: false, nextBefore: undefined,
      threads: parentChannelId === parentA
        ? [surface(archivedThread, parentA, "archived-thread", "2026-08-24T00:08:00.000Z",
          visibility)] : [],
      visibility,
    });
    await expect(observeGovernedPrivateCampaign(input(expected), duplicate))
      .rejects.toThrow(/inventory contains duplicates/u);

    const observed = await observeGovernedPrivateCampaign(input(expected), port(messages));
    const privateItem = observed.inventory.find(({ channelId }) =>
      channelId === archivedPrivateThread)!;
    const publicInventory = observed.inventory.map((item) => item === privateItem
      ? { ...item, threadVisibility: "public" as const } : item);
    expect(governedCampaignObservationFingerprint({ inventory: publicInventory,
      pagination: observed.pagination,
      scope: observed.scope })).not.toBe(observed.canonicalInventorySha256);
  });

  it("rejects attacker-selected end times, page bounds, and visibility policies", async () => {
    const messages = messageSet();
    const expected = [messages[parentA]![120]!, messages[archivedPrivateThread]![0]!].map(receipt);
    const observed = await observeGovernedPrivateCampaign(input(expected), port(messages));
    const compiled = observed.scope;
    const scopes = [
      { ...compiled, endedAt: "2026-08-24T00:11:00.000Z" },
      { ...compiled, maximumArchivePagesPerParent: compiled.maximumArchivePagesPerParent + 1 },
      { ...compiled, maximumMessagePagesPerSurface: compiled.maximumMessagePagesPerSurface + 1 },
    ];
    for (const scope of scopes) {
      const resealed = { ...observed, scope,
        canonicalInventorySha256: governedCampaignObservationFingerprint({
          inventory: observed.inventory, pagination: observed.pagination, scope,
        }) };
      expect(governedPrivateCampaignObservationV1Schema.safeParse(resealed).success).toBe(true);
      expect(() => { assertGovernedObservationPolicyMatchesPlan(scope,
        { historicalReplyObservationPolicy: compiled }); }).toThrow();
    }
    const reversedVisibility = structuredClone(observed) as unknown as {
      scope: { archivedThreadVisibilities: string[] };
    };
    reversedVisibility.scope.archivedThreadVisibilities = ["private", "public"];
    expect(governedPrivateCampaignObservationV1Schema.safeParse(reversedVisibility).success)
      .toBe(false);
  });

  it("rejects omitted parents and archive/message page or cursor receipts after resealing", async () => {
    const messages = messageSet();
    const expected = [messages[parentA]![120]!, messages[archivedPrivateThread]![0]!].map(receipt);
    const observed = await observeGovernedPrivateCampaign(input(expected), port(messages));
    const mutations = [
      (value: typeof observed) => { mutableArray(value.inventory).splice(0, 1); },
      (value: typeof observed) => {
        mutableArray(value.pagination.archivedThreads[0]!.pages).splice(0);
      },
      (value: typeof observed) => {
        const pages = value.pagination.messages.find(({ pages: retained }) => retained.length > 1)!.pages;
        mutableArray(pages).splice(1, 1);
      },
      (value: typeof observed) => {
        Reflect.set(value.pagination.archivedThreads[0]!.pages[0]!, "nextBefore",
          "2026-08-24T00:09:00.000Z");
      },
    ];
    for (const mutate of mutations) {
      const hostile = structuredClone(observed);
      mutate(hostile);
      Reflect.set(hostile, "canonicalInventorySha256",
        governedCampaignObservationFingerprint(hostile));
      expect(governedPrivateCampaignObservationV1Schema.safeParse(hostile).success).toBe(false);
    }
  });
});

function input(
  expectedAnswerReceipts: GovernedCampaignObservationInput["expectedAnswerReceipts"],
): GovernedCampaignObservationInput {
  return {
    archivedThreadVisibilities: ["public", "private"],
    endedAt,
    expectedAnswerReceipts,
    guildId,
    maximumArchivePagesPerParent: 10,
    maximumMessagePagesPerSurface: 10,
    parentChannelIds: [parentA, parentB],
    startedAt,
    sutApplicationId: sutId,
  };
}

function mutableArray<T>(value: readonly T[]): T[] {
  return value as T[];
}

function port(
  messages: Record<string, GovernedCampaignMessage[]>,
): GovernedCampaignObservationPort & {
  fetchMessages: GovernedCampaignObservationPort["fetchMessages"];
} {
  return {
    fetchActiveThreads: async () => ({ complete: true,
      threads: [surface(activeThread, parentB, "active-thread", null, "public"),
        surface(activePrivateThread, parentB, "active-thread", null, "private")] }),
    fetchArchivedThreads: async ({ parentChannelId, visibility }) => ({
      completeness: "all",
      hasMore: false,
      nextBefore: undefined,
      threads: parentChannelId === parentA
        ? [surface(visibility === "public" ? archivedThread : archivedPrivateThread, parentA,
          "archived-thread", "2026-08-24T00:08:00.000Z", visibility)]
        : [],
      visibility,
    }),
    fetchMessages: async ({ beforeMessageId, channelId, limit }) =>
      (messages[channelId] ?? []).filter(({ messageId }) =>
        BigInt(messageId) < BigInt(beforeMessageId)).toSorted((left, right) =>
        BigInt(left.messageId) > BigInt(right.messageId) ? -1 : 1).slice(0, limit),
    fetchParent: async (parentChannelId) => surface(parentChannelId, parentChannelId, "parent"),
  };
}

function messageSet(): Record<string, GovernedCampaignMessage[]> {
  const parentMessages = Array.from({ length: 150 }, (_, index) => message(parentA, index,
    index === 120 ? sutId : observerId));
  return {
    [activeThread]: [message(activeThread, 202, observerId)],
    [activePrivateThread]: Array.from({ length: 150 }, (_, index) =>
      message(activePrivateThread, index + 500, observerId)),
    [archivedThread]: [message(archivedThread, 201, observerId)],
    [archivedPrivateThread]: [message(archivedPrivateThread, 204, sutId)],
    [parentA]: parentMessages,
    [parentB]: [message(parentB, 200, observerId)],
  };
}

function message(channelId: string, index: number, authorApplicationId: string): GovernedCampaignMessage {
  return {
    authorApplicationId,
    channelId,
    createdAt: new Date(Date.parse("2026-08-24T00:05:00.000Z") + index).toISOString(),
    messageId: snowflake(index),
    replyToMessageId: authorApplicationId === sutId ? snowflake(index + 1_000) : null,
  };
}

function snowflake(index: number): string {
  return (((BigInt(Date.parse("2026-08-24T00:05:00.000Z") + index) -
    1_420_070_400_000n) << 22n) + BigInt(index)).toString();
}

function receipt(observedMessage: GovernedCampaignMessage) {
  return { channelId: observedMessage.channelId, messageId: observedMessage.messageId,
    replyToMessageId: observedMessage.replyToMessageId! };
}

function surface(
  channelId: string,
  parentChannelId: string,
  kind: GovernedCampaignSurface["kind"],
  archivedAt: string | null = null,
  threadVisibility: GovernedCampaignSurface["threadVisibility"] = kind === "parent" ? null : "public",
): GovernedCampaignSurface {
  return { archivedAt, channelId, guildId, kind, parentChannelId, threadVisibility };
}
