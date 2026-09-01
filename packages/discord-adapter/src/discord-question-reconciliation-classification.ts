/** Only provider error codes documenting authoritative absence may tombstone. */
export function isExplicitDiscordAbsence(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== null &&
    typeof current === "object" && !visited.has(current); depth += 1) {
    visited.add(current);
    const candidate = current as { readonly cause?: unknown; readonly code?: unknown };
    if (candidate.code === 10_008 || candidate.code === 10_003 ||
      candidate.code === "10008" || candidate.code === "10003") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** Unknown Member is the only closed Discord code used as fresh membership denial. */
export function isExplicitDiscordMemberAbsence(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== null &&
    typeof current === "object" && !visited.has(current); depth += 1) {
    visited.add(current);
    const candidate = current as { readonly cause?: unknown; readonly code?: unknown };
    if (candidate.code === 10_007 || candidate.code === "10007") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function reconciliationPrincipalMatches(
  principal: ReturnType<DiscordQuestionPrincipalCodec["resolve"]>,
  question: { readonly deliveryContainerId: string; readonly requesterSubject: string;
    readonly scopeId: string },
  principals: DiscordQuestionPrincipalCodec,
): boolean {
  return principal === null || (principal.scopeId === question.scopeId &&
    principal.authorizationContainerId === question.deliveryContainerId &&
    principals.keyedSubject(principal.actorId, principal.scopeId) ===
      question.requesterSubject);
}

export function reconciliationProjectionMatchesChannel(
  channel: NonNullable<Awaited<ReturnType<Client["channels"]["fetch"]>>>,
  projection: NonNullable<ReturnType<typeof decodeDiscordExternalPublicationId>>,
): boolean {
  return projection.kind === "thread"
    ? channel.isThread() && projection.threadId === channel.id
    : !channel.isThread() && projection.parentChannelId === channel.id;
}
import type { Client } from "discord.js";

import type { DiscordQuestionPrincipalCodec } from "./discord-question-principal.js";
import type { decodeDiscordExternalPublicationId } from "./discord-projection.js";
