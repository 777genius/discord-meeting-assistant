import { createHash } from "node:crypto";

const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const PAGE_SIZE = 100;

export type GovernedSurfaceKind = "parent" | "active-thread" | "archived-thread";
export type GovernedThreadVisibility = "private" | "public";

export interface GovernedCampaignObservationPolicy {
  readonly archivedThreadVisibilities: readonly ["public", "private"];
  readonly endedAt: string;
  readonly guildId: string;
  readonly maximumArchivePagesPerParent: number;
  readonly maximumMessagePagesPerSurface: number;
  readonly parentChannelIds: readonly string[];
  readonly startedAt: string;
}

export interface GovernedCampaignSurface {
  readonly archivedAt: string | null;
  readonly channelId: string;
  readonly guildId: string;
  readonly kind: GovernedSurfaceKind;
  readonly parentChannelId: string;
  readonly threadVisibility: GovernedThreadVisibility | null;
}

export interface GovernedCampaignMessage {
  readonly authorApplicationId: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly messageId: string;
  readonly replyToMessageId: string | null;
}

export interface GovernedCampaignObservationPort {
  fetchActiveThreads(guildId: string): Promise<{
    readonly complete: boolean;
    readonly threads: readonly GovernedCampaignSurface[];
  }>;
  fetchArchivedThreads(input: {
    readonly before: string | undefined;
    readonly limit: 100;
    readonly parentChannelId: string;
    readonly visibility: GovernedThreadVisibility;
  }): Promise<{
    readonly completeness: "all" | "joined-only";
    readonly hasMore: boolean;
    readonly nextBefore: string | undefined;
    readonly threads: readonly GovernedCampaignSurface[];
    readonly visibility: GovernedThreadVisibility;
  }>;
  fetchMessages(input: {
    readonly beforeMessageId: string;
    readonly channelId: string;
    readonly limit: 100;
  }): Promise<readonly GovernedCampaignMessage[]>;
  fetchParent(parentChannelId: string): Promise<GovernedCampaignSurface>;
}

export interface GovernedCampaignObservationInput extends GovernedCampaignObservationPolicy {
  readonly expectedAnswerReceipts: readonly {
    readonly channelId: string;
    readonly messageId: string;
    readonly replyToMessageId: string;
  }[];
  readonly sutApplicationId: string;
}

export interface GovernedCampaignObservation {
  readonly canonicalInventorySha256: string;
  readonly inventory: readonly (GovernedCampaignSurface & {
    readonly messageCountInWindow: number;
    readonly messagePagesRead: number;
  })[];
  readonly pagination: {
    readonly activeThreads: { readonly channelIds: readonly string[]; readonly complete: true };
    readonly archivedThreads: readonly {
      readonly pages: readonly {
        readonly before: string | null;
        readonly channelIds: readonly string[];
        readonly hasMore: boolean;
        readonly nextBefore: string | null;
        readonly pageNumber: number;
        readonly termination: "continuing" | "no-more" | "window-start";
      }[];
      readonly parentChannelId: string;
      readonly visibility: GovernedThreadVisibility;
    }[];
    readonly messages: readonly {
      readonly channelId: string;
      readonly pages: readonly {
        readonly beforeMessageId: string;
        readonly messageIds: readonly string[];
        readonly pageNumber: number;
        readonly termination: "continuing" | "short-page" | "window-start";
      }[];
      readonly retainedMessageIds: readonly string[];
    }[];
  };
  readonly receipts: readonly {
    readonly channelId: string;
    readonly messageId: string;
    readonly replyToMessageId: string;
  }[];
  readonly scope: GovernedCampaignObservationPolicy;
}

export async function observeGovernedPrivateCampaign(
  input: GovernedCampaignObservationInput,
  port: GovernedCampaignObservationPort,
): Promise<GovernedCampaignObservation> {
  assertInput(input);
  const parents = await Promise.all(input.parentChannelIds.map(async (parentChannelId) => {
    const parent = await port.fetchParent(parentChannelId);
    assertSurface(parent, input.guildId, parentChannelId, "parent", null);
    return parent;
  }));
  const active = await port.fetchActiveThreads(input.guildId);
  if (!active.complete) {
    throw new Error("Governed active-thread enumeration is incomplete");
  }
  const governedParents = new Set(input.parentChannelIds);
  const activeThreads = active.threads.filter(({ parentChannelId }) =>
    governedParents.has(parentChannelId));
  for (const thread of activeThreads) {
    assertSurface(thread, input.guildId, thread.parentChannelId, "active-thread",
      thread.threadVisibility);
  }
  const archivedWalks = await Promise.all(input.parentChannelIds.flatMap(
    (parentChannelId) => input.archivedThreadVisibilities.map((visibility) =>
      enumerateArchivedThreads(input, parentChannelId, visibility, port)),
  ));
  const archivedThreads = archivedWalks.flatMap(({ threads }) => threads);
  const surfaces = [...parents, ...activeThreads, ...archivedThreads]
    .toSorted((left, right) => left.channelId.localeCompare(right.channelId));
  if (new Set(surfaces.map(({ channelId }) => channelId)).size !== surfaces.length) {
    throw new Error("Governed campaign surface inventory contains duplicates");
  }
  const observed = await Promise.all(surfaces.map(async (surface) => {
    const messages = await enumerateMessages(input, surface, port);
    return {
      inventory: {
        ...surface,
        messageCountInWindow: messages.messages.length,
        messagePagesRead: messages.pagesRead,
      },
      pagination: messages.pagination,
      receipts: messages.messages.filter(({ authorApplicationId }) =>
        authorApplicationId === input.sutApplicationId).map((message) => {
        if (message.replyToMessageId === null) {
          throw new Error("Governed SUT answer is not a reply");
        }
        return {
          channelId: message.channelId,
          messageId: message.messageId,
          replyToMessageId: message.replyToMessageId,
        };
      }),
    };
  }));
  const scope = {
    archivedThreadVisibilities: input.archivedThreadVisibilities,
    endedAt: input.endedAt,
    guildId: input.guildId,
    maximumArchivePagesPerParent: input.maximumArchivePagesPerParent,
    maximumMessagePagesPerSurface: input.maximumMessagePagesPerSurface,
    parentChannelIds: [...input.parentChannelIds],
    startedAt: input.startedAt,
  };
  const inventory = observed.map(({ inventory: item }) => item);
  const pagination = {
    activeThreads: {
      channelIds: activeThreads.map(({ channelId }) => channelId).toSorted(),
      complete: true as const,
    },
    archivedThreads: archivedWalks.map(({ pagination: archivePagination }) => archivePagination),
    messages: observed.map(({ pagination: item }) => item),
  };
  const receipts = observed.flatMap(({ receipts: matches }) => matches)
    .toSorted((left, right) => left.messageId.localeCompare(right.messageId));
  const expected = [...input.expectedAnswerReceipts]
    .toSorted((left, right) => left.messageId.localeCompare(right.messageId));
  if (JSON.stringify(receipts) !== JSON.stringify(expected)) {
    throw new Error("Governed campaign scope does not contain exactly the intended SUT answers");
  }
  return {
    canonicalInventorySha256: governedCampaignObservationFingerprint({ inventory, pagination, scope }),
    inventory,
    pagination,
    receipts,
    scope,
  };
}

export function governedCampaignObservationFingerprint(input: {
  readonly inventory: GovernedCampaignObservation["inventory"];
  readonly pagination: GovernedCampaignObservation["pagination"];
  readonly scope: GovernedCampaignObservation["scope"];
}): string {
  return canonicalDigest({ inventory: input.inventory, pagination: input.pagination, scope: input.scope });
}

// oxlint-disable-next-line complexity
async function enumerateArchivedThreads(
  input: GovernedCampaignObservationInput,
  parentChannelId: string,
  visibility: GovernedThreadVisibility,
  port: GovernedCampaignObservationPort,
): Promise<{
  readonly pagination: GovernedCampaignObservation["pagination"]["archivedThreads"][number];
  readonly threads: readonly GovernedCampaignSurface[];
}> {
  const threads: GovernedCampaignSurface[] = [];
  const pages: GovernedCampaignObservation["pagination"]["archivedThreads"][number]["pages"][number][] = [];
  let before: string | undefined;
  for (let pageNumber = 1; pageNumber <= input.maximumArchivePagesPerParent; pageNumber += 1) {
    const page = await port.fetchArchivedThreads({ before, limit: PAGE_SIZE, parentChannelId,
      visibility });
    if (page.completeness !== "all" || page.visibility !== visibility) {
      throw new Error(`Governed ${visibility} archived-thread enumeration is incomplete`);
    }
    for (const thread of page.threads) {
      assertSurface(thread, input.guildId, parentChannelId, "archived-thread", visibility);
      if (thread.archivedAt === null || !Number.isFinite(Date.parse(thread.archivedAt))) {
        throw new Error("Governed archived thread lacks an archive timestamp");
      }
    }
    const archiveTimes = page.threads.map(({ archivedAt }) => Date.parse(archivedAt ?? ""));
    if (archiveTimes.some((value, index) => index > 0 && value > archiveTimes[index - 1]!)) {
      throw new Error(`Governed ${visibility} archived-thread page is not monotonic`);
    }
    threads.push(...page.threads.filter(({ archivedAt }) =>
      archivedAt !== null && Date.parse(archivedAt) >= Date.parse(input.startedAt)));
    const crossedWindowStart = page.threads.some(({ archivedAt }) =>
      archivedAt !== null && Date.parse(archivedAt) < Date.parse(input.startedAt));
    const termination = crossedWindowStart ? "window-start" as const
      : !page.hasMore ? "no-more" as const : "continuing" as const;
    pages.push({
      before: before ?? null,
      channelIds: page.threads.map(({ channelId }) => channelId),
      hasMore: page.hasMore,
      nextBefore: page.nextBefore ?? null,
      pageNumber,
      termination,
    });
    if (!page.hasMore || crossedWindowStart) {
      return { pagination: { pages, parentChannelId, visibility }, threads };
    }
    const expectedNextBefore = page.threads.at(-1)?.archivedAt ?? undefined;
    if (page.nextBefore !== expectedNextBefore) {
      throw new Error(`Governed ${visibility} archived-thread cursor is not canonical`);
    }
    if (page.nextBefore === undefined || page.nextBefore === before) {
      throw new Error(`Governed ${visibility} archived-thread pagination cursor did not advance`);
    }
    const previousBefore = before;
    if (previousBefore !== undefined && archiveTimes.some((value) =>
      value >= Date.parse(previousBefore))) {
      throw new Error(`Governed ${visibility} archived-thread page is not monotonic`);
    }
    if (before !== undefined && Date.parse(page.nextBefore) >= Date.parse(before)) {
      throw new Error(`Governed ${visibility} archived-thread pagination cursor is not monotonic`);
    }
    before = page.nextBefore;
  }
  throw new Error(`Governed ${visibility} archived-thread pagination limit was reached`);
}

async function enumerateMessages(
  input: GovernedCampaignObservationInput,
  surface: GovernedCampaignSurface,
  port: GovernedCampaignObservationPort,
): Promise<{
  readonly messages: readonly GovernedCampaignMessage[];
  readonly pagesRead: number;
  readonly pagination: GovernedCampaignObservation["pagination"]["messages"][number];
}> {
  const retained: GovernedCampaignMessage[] = [];
  const pages: GovernedCampaignObservation["pagination"]["messages"][number]["pages"][number][] = [];
  const seen = new Set<string>();
  let beforeMessageId = snowflakeAfter(input.endedAt);
  for (let pagesRead = 1; pagesRead <= input.maximumMessagePagesPerSurface; pagesRead += 1) {
    const page = await port.fetchMessages({ beforeMessageId, channelId: surface.channelId,
      limit: PAGE_SIZE });
    const ordered = [...page].toSorted((left, right) =>
      BigInt(right.messageId) < BigInt(left.messageId) ? -1 : 1);
    for (const message of ordered) {
      if (message.channelId !== surface.channelId || BigInt(message.messageId) >=
        BigInt(beforeMessageId) || seen.has(message.messageId)) {
        throw new Error("Governed message pagination is partial, duplicated, or non-monotonic");
      }
      seen.add(message.messageId);
    }
    retained.push(...ordered.filter(({ createdAt }) => Date.parse(createdAt) >=
      Date.parse(input.startedAt) && Date.parse(createdAt) <= Date.parse(input.endedAt)));
    const crossedWindowStart = ordered.some(({ createdAt }) =>
      Date.parse(createdAt) < Date.parse(input.startedAt));
    const termination = crossedWindowStart ? "window-start" as const
      : page.length < PAGE_SIZE ? "short-page" as const : "continuing" as const;
    pages.push({ beforeMessageId, messageIds: ordered.map(({ messageId }) => messageId),
      pageNumber: pagesRead, termination });
    if (page.length < PAGE_SIZE || crossedWindowStart) {
      return { messages: retained, pagesRead, pagination: {
        channelId: surface.channelId, pages,
        retainedMessageIds: retained.map(({ messageId }) => messageId),
      } };
    }
    const next = ordered.at(-1)?.messageId;
    if (next === undefined || BigInt(next) >= BigInt(beforeMessageId)) {
      throw new Error("Governed message pagination cursor did not advance");
    }
    beforeMessageId = next;
  }
  throw new Error("Governed message pagination limit was reached");
}

function assertInput(input: GovernedCampaignObservationInput): void {
  if (input.parentChannelIds.length < 1 || new Set(input.parentChannelIds).size !==
    input.parentChannelIds.length || JSON.stringify(input.parentChannelIds) !==
      JSON.stringify([...input.parentChannelIds].toSorted()) ||
    JSON.stringify(input.archivedThreadVisibilities) !== JSON.stringify(["public", "private"]) ||
    Date.parse(input.startedAt) >= Date.parse(input.endedAt) ||
    input.expectedAnswerReceipts.length !== 2 ||
    new Set(input.expectedAnswerReceipts.map(({ messageId }) => messageId)).size !== 2 ||
    !Number.isSafeInteger(input.maximumArchivePagesPerParent) ||
    input.maximumArchivePagesPerParent < 1 || input.maximumArchivePagesPerParent > 1_000 ||
    !Number.isSafeInteger(input.maximumMessagePagesPerSurface) ||
    input.maximumMessagePagesPerSurface < 1 || input.maximumMessagePagesPerSurface > 1_000) {
    throw new Error("Governed private campaign observation scope is invalid");
  }
}

function assertSurface(
  surface: GovernedCampaignSurface,
  guildId: string,
  parentChannelId: string,
  kind: GovernedSurfaceKind,
  threadVisibility: GovernedThreadVisibility | null,
): void {
  if (surface.guildId !== guildId || surface.parentChannelId !== parentChannelId ||
    surface.kind !== kind || surface.threadVisibility !== threadVisibility ||
    (kind === "parent") !== (threadVisibility === null)) {
    throw new Error("Governed campaign surface is unavailable or outside its explicit scope");
  }
}

function snowflakeAfter(timestamp: string): string {
  const milliseconds = BigInt(Date.parse(timestamp) + 1);
  return ((milliseconds - DISCORD_EPOCH_MS) << 22n).toString();
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) =>
      left.localeCompare(right)).map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}
