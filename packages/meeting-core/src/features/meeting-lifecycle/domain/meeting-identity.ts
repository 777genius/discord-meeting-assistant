import { DomainInvariantError, requireNonEmpty } from "./errors.js";

export type MeetingActorKind = "automation" | "human" | "unknown";

export interface MeetingSourceSnapshot {
  readonly roomId: string;
  readonly scopeId: string;
}

export interface MeetingActorSnapshot {
  readonly actorId: string;
  readonly kind: MeetingActorKind;
}

function compareOpaqueIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeSource(
  source: MeetingSourceSnapshot | null | undefined,
): MeetingSourceSnapshot | null {
  if (source === null || source === undefined) {
    return null;
  }
  return Object.freeze({
    roomId: requireNonEmpty(source.roomId, "meeting.source.roomId"),
    scopeId: requireNonEmpty(source.scopeId, "meeting.source.scopeId"),
  });
}

export function normalizeActors(
  actors: readonly MeetingActorSnapshot[] | null | undefined,
): readonly MeetingActorSnapshot[] | null {
  if (actors === null || actors === undefined) {
    return null;
  }
  const normalized = actors.map((actor) => {
    if (actor.kind !== "human" && actor.kind !== "automation" && actor.kind !== "unknown") {
      throw new DomainInvariantError(
        "INVALID_ACTOR_KIND",
        "meeting actor kind must be human, automation, or unknown",
      );
    }
    return Object.freeze({
      actorId: requireNonEmpty(actor.actorId, "meeting.actors.actorId"),
      kind: actor.kind,
    });
  }).toSorted((left, right) => compareOpaqueIds(left.actorId, right.actorId));
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous !== undefined && current !== undefined && previous.actorId === current.actorId) {
      throw new DomainInvariantError(
        previous.kind === current.kind ? "DUPLICATE_ACTOR" : "CONFLICTING_ACTOR_KIND",
        previous.kind === current.kind
          ? "meeting actor roster cannot repeat an actor"
          : "one meeting actor cannot have conflicting kinds",
      );
    }
  }
  return Object.freeze(normalized);
}
