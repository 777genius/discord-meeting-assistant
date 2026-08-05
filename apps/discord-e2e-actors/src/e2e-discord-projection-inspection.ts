import type {
  DiscordProjectionContainerObservation,
  DiscordProjectionMessageObservation,
  DiscordProjectionObservation,
} from "./e2e-retained-evidence-contracts.js";

export type DiscordPublicationReference =
  | {
    readonly kind: "channel-message";
    readonly messageId: string;
    readonly parentChannelId: string;
  }
  | {
    readonly kind: "thread";
    readonly messageId: string;
    readonly parentChannelId: string;
    readonly threadId: string;
  };

export function parseDiscordPublication(
  value: string,
  parentChannelId: string,
): DiscordPublicationReference {
  const legacyThread = /^discord:v1:thread:([^:]+):message:([^:]+)$/u.exec(value);
  if (legacyThread?.[1] !== undefined && legacyThread[2] !== undefined) {
    return {
      kind: "thread",
      parentChannelId,
      threadId: legacyThread[1],
      messageId: legacyThread[2],
    };
  }
  const thread = /^discord:v2:thread:([^:]+):message:([^:]+)$/u.exec(value);
  if (thread?.[1] !== undefined && thread[2] !== undefined) {
    return {
      kind: "thread",
      parentChannelId,
      threadId: thread[1],
      messageId: thread[2],
    };
  }
  const channel = /^discord:v2:channel:([^:]+):message:([^:]+)$/u.exec(value);
  if (channel?.[1] !== undefined && channel[2] !== undefined) {
    return {
      kind: "channel-message",
      parentChannelId: channel[1],
      messageId: channel[2],
    };
  }
  throw new Error("Postgres publication receipt is not a supported Discord reference");
}

export function assertDiscordReference(
  observation: DiscordProjectionObservation,
  reference: DiscordPublicationReference,
): DiscordProjectionMessageObservation {
  const message = observation.matchingMessages.find((candidate) =>
    candidate.messageId === reference.messageId && sameDiscordContainer(candidate.container, reference)
  );
  const expectedThreadId = reference.kind === "thread" ? reference.threadId : undefined;
  if (
    message === undefined ||
    (expectedThreadId !== undefined && !observation.matchingThreadIds.includes(expectedThreadId))
  ) {
    throw new Error("Discord publication receipt is absent from the marker scan");
  }
  return message;
}

export function assertExactDiscordProjection(
  observation: DiscordProjectionObservation,
  reference: DiscordPublicationReference,
  phase: string,
): void {
  const expectedThreadCount = reference.kind === "thread" ? 1 : 0;
  if (
    observation.matchingMessages.length !== 1 ||
    observation.matchingThreadIds.length !== expectedThreadCount
  ) {
    throw new Error(`Discord projection is not exact-one ${phase}`);
  }
}

export function toEvidenceContainer(
  reference: DiscordPublicationReference,
): DiscordProjectionContainerObservation {
  return reference.kind === "thread"
    ? {
      kind: "thread",
      parentChannelId: reference.parentChannelId,
      threadId: reference.threadId,
    }
    : { kind: "channel-message", parentChannelId: reference.parentChannelId };
}

export async function projectionMarker(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idempotencyKey));
  return `meeting-projection:${Buffer.from(digest).toString("hex").slice(0, 20)}`;
}

// Kept independent from the production Discord adapter so retained E2E
// evidence cannot pass because verifier and SUT share the same implementation.
export async function createMeetingDiscordProjectionKey(
  meetingId: string,
  targetChannelId: string,
): Promise<string> {
  const canonical = JSON.stringify([
    "meeting-discord-projection:v2",
    meetingId,
    targetChannelId,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return `meeting-discord-projection:v2:${Buffer.from(digest).toString("hex")}`;
}

function sameDiscordContainer(
  container: DiscordProjectionContainerObservation,
  reference: DiscordPublicationReference,
): boolean {
  if (container.kind !== reference.kind || container.parentChannelId !== reference.parentChannelId) {
    return false;
  }
  return container.kind !== "thread" ||
    (reference.kind === "thread" && container.threadId === reference.threadId);
}
