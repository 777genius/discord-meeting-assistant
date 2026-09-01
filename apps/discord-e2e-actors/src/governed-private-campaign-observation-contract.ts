import { z } from "zod";

import { governedCampaignObservationFingerprint } from
  "./governed-private-campaign-observation.js";

const snowflake = z.string().regex(/^\d{17,20}$/u);
const timestamp = z.iso.datetime();
const visibility = z.enum(["public", "private"]);

export const governedCampaignObservationPolicyV1Schema = z.object({
  archivedThreadVisibilities: z.tuple([z.literal("public"), z.literal("private")]),
  endedAt: timestamp,
  guildId: snowflake,
  maximumArchivePagesPerParent: z.number().int().min(1).max(1_000),
  maximumMessagePagesPerSurface: z.number().int().min(1).max(1_000),
  parentChannelIds: z.array(snowflake).min(1).max(32),
  startedAt: timestamp,
}).strict().superRefine((policy, context) => {
  if (Date.parse(policy.startedAt) >= Date.parse(policy.endedAt) ||
    new Set(policy.parentChannelIds).size !== policy.parentChannelIds.length ||
    JSON.stringify(policy.parentChannelIds) !==
      JSON.stringify([...policy.parentChannelIds].toSorted())) {
    context.addIssue({ code: "custom", message: "Governed observation policy is not canonical" });
  }
});

const archivePageSchema = z.object({
  before: timestamp.nullable(), channelIds: z.array(snowflake).max(100),
  hasMore: z.boolean(), nextBefore: timestamp.nullable(), pageNumber: z.number().int().positive(),
  termination: z.enum(["continuing", "no-more", "window-start"]),
}).strict();
const messagePageSchema = z.object({
  beforeMessageId: snowflake, messageIds: z.array(snowflake).max(100),
  pageNumber: z.number().int().positive(),
  termination: z.enum(["continuing", "short-page", "window-start"]),
}).strict();

export const governedPrivateCampaignObservationV1Schema = z.object({
  canonicalInventorySha256: z.string().regex(/^[a-f\d]{64}$/u),
  inventory: z.array(z.object({
    archivedAt: timestamp.nullable(), channelId: snowflake, guildId: snowflake,
    kind: z.enum(["parent", "active-thread", "archived-thread"]),
    messageCountInWindow: z.number().int().nonnegative(),
    messagePagesRead: z.number().int().positive(), parentChannelId: snowflake,
    threadVisibility: z.enum(["public", "private"]).nullable(),
  }).strict().refine((surface) => (surface.kind === "parent") ===
    (surface.threadVisibility === null), "Governed surface visibility is invalid"))
    .min(1).max(10_000),
  pagination: z.object({
    activeThreads: z.object({ channelIds: z.array(snowflake).max(10_000),
      complete: z.literal(true) }).strict(),
    archivedThreads: z.array(z.object({ pages: z.array(archivePageSchema).min(1).max(1_000),
      parentChannelId: snowflake, visibility }).strict()).min(2).max(64),
    messages: z.array(z.object({ channelId: snowflake,
      pages: z.array(messagePageSchema).min(1).max(1_000),
      retainedMessageIds: z.array(snowflake).max(100_000) }).strict()).min(1).max(10_000),
  }).strict(),
  receipts: z.array(z.object({ channelId: snowflake, messageId: snowflake,
    replyToMessageId: snowflake }).strict()).length(2),
  scope: governedCampaignObservationPolicyV1Schema,
}).strict().superRefine((observation, context) => {
  const fail = (message: string): void => { context.addIssue({ code: "custom", message }); };
  if (governedCampaignObservationFingerprint(observation) !==
    observation.canonicalInventorySha256) {
    fail("Governed campaign inventory seal is invalid");
  }
  const inventoryIds = observation.inventory.map(({ channelId }) => channelId);
  if (new Set(inventoryIds).size !== inventoryIds.length || JSON.stringify(inventoryIds) !==
    JSON.stringify([...inventoryIds].toSorted()) || observation.inventory.some((surface) =>
    surface.guildId !== observation.scope.guildId ||
    !observation.scope.parentChannelIds.includes(surface.parentChannelId))) {
    fail("Governed campaign inventory is duplicated, unordered, or outside policy");
  }
  const parents = observation.inventory.filter(({ kind }) => kind === "parent");
  if (JSON.stringify(parents.map(({ channelId }) => channelId)) !==
    JSON.stringify(observation.scope.parentChannelIds)) {
    fail("Governed campaign inventory omits a policy parent");
  }
  const activeIds = observation.inventory.filter(({ kind }) => kind === "active-thread")
    .map(({ channelId }) => channelId).toSorted();
  if (JSON.stringify(activeIds) !==
    JSON.stringify(observation.pagination.activeThreads.channelIds)) {
    fail("Governed active-thread completeness metadata differs from inventory");
  }
  const expectedArchiveKeys = observation.scope.parentChannelIds.flatMap((parentChannelId) =>
    observation.scope.archivedThreadVisibilities.map((item) => `${parentChannelId}:${item}`));
  const archiveKeys = observation.pagination.archivedThreads.map(
    ({ parentChannelId, visibility: item }) => `${parentChannelId}:${item}`,
  );
  if (JSON.stringify(archiveKeys) !== JSON.stringify(expectedArchiveKeys)) {
    fail("Governed archive pagination omits or reorders a policy walk");
  }
  for (const walk of observation.pagination.archivedThreads) {
    const expectedIds = observation.inventory.filter(({ kind, parentChannelId, threadVisibility }) =>
      kind === "archived-thread" && parentChannelId === walk.parentChannelId &&
      threadVisibility === walk.visibility).map(({ channelId }) => channelId);
    const observedIds = walk.pages.flatMap(({ channelIds }) => channelIds)
      .filter((channelId) => expectedIds.includes(channelId));
    if (!completeArchiveChain(walk.pages) || JSON.stringify(observedIds.toSorted()) !==
      JSON.stringify(expectedIds.toSorted())) {
      fail("Governed archive cursor receipts are incomplete or differ from inventory");
    }
  }
  if (JSON.stringify(observation.pagination.messages.map(({ channelId }) => channelId)) !==
    JSON.stringify(inventoryIds)) {
    fail("Governed message pagination omits or reorders an inventory surface");
  }
  for (const messages of observation.pagination.messages) {
    const surface = observation.inventory.find(({ channelId }) => channelId === messages.channelId);
    const fetched = new Set(messages.pages.flatMap(({ messageIds }) => messageIds));
    if (surface === undefined || !completeMessageChain(messages.pages) ||
      surface.messagePagesRead !== messages.pages.length ||
      surface.messageCountInWindow !== messages.retainedMessageIds.length ||
      messages.retainedMessageIds.some((messageId) => !fetched.has(messageId))) {
      fail("Governed per-surface message cursor receipts are incomplete");
    }
  }
  if (observation.receipts.some(({ channelId, messageId }) =>
    !observation.pagination.messages.some((messages) => messages.channelId === channelId &&
      messages.retainedMessageIds.includes(messageId)))) {
    fail("Governed SUT receipt is absent from retained per-surface pagination metadata");
  }
});

function completeArchiveChain(pages: readonly z.infer<typeof archivePageSchema>[]): boolean {
  return pages.every((page, index) => page.pageNumber === index + 1 &&
    page.before === (index === 0 ? null : pages[index - 1]!.nextBefore) &&
    (index === pages.length - 1 ? page.termination !== "continuing" :
      page.termination === "continuing" && page.hasMore && page.nextBefore !== null) &&
    (page.termination !== "no-more" || (!page.hasMore && page.nextBefore === null))) &&
    pages.at(-1)?.termination !== "continuing";
}

function completeMessageChain(pages: readonly z.infer<typeof messagePageSchema>[]): boolean {
  return pages.every((page, index) => page.pageNumber === index + 1 &&
    (index === pages.length - 1 ? page.termination !== "continuing" :
      page.termination === "continuing" && page.messageIds.length === 100) &&
    (index === 0 || page.beforeMessageId === pages[index - 1]!.messageIds.at(-1))) &&
    pages.at(-1)?.termination !== "continuing";
}
