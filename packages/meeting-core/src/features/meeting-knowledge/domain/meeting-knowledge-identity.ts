export type MeetingKnowledgeActorKind = "automation" | "human" | "unknown";

export interface MeetingKnowledgeSourceIdentity {
  readonly roomId: string;
  readonly scopeId: string;
}

export interface MeetingKnowledgeActorIdentity {
  readonly actorId: string;
  readonly kind: MeetingKnowledgeActorKind;
}

export interface MeetingKnowledgeIdentityInput {
  readonly actors: readonly MeetingKnowledgeActorIdentity[] | null;
  readonly source: MeetingKnowledgeSourceIdentity | null;
}

export class MeetingKnowledgeIdentityInvariantError extends Error {
  public override readonly name = "MeetingKnowledgeIdentityInvariantError";

  public constructor(
    public readonly code:
      | "CONFLICTING_ACTOR_KIND"
      | "DUPLICATE_ACTOR"
      | "INVALID_IDENTITY",
    message: string,
  ) {
    super(message);
  }
}

function requireIdentity(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MeetingKnowledgeIdentityInvariantError(
      "INVALID_IDENTITY",
      `${field} must be non-empty`,
    );
  }
  return value.trim();
}

function compareOpaqueIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Provider-neutral proof that a meeting has durable source and actor identity.
 * Transcript evidence admission later reuses this proof but remains a separate
 * invariant: an audio track alone never establishes that its actor is human.
 */
export class MeetingKnowledgeIdentity {
  public readonly humanActorIds: readonly string[];
  public readonly source: MeetingKnowledgeSourceIdentity;

  private constructor(input: {
    readonly humanActorIds: readonly string[];
    readonly source: MeetingKnowledgeSourceIdentity;
  }) {
    this.humanActorIds = Object.freeze([...input.humanActorIds]);
    this.source = Object.freeze({ ...input.source });
    Object.freeze(this);
  }

  public static admit(input: MeetingKnowledgeIdentityInput): MeetingKnowledgeIdentity | null {
    if (input.source === null || input.actors === null) {
      return null;
    }
    const source = {
      roomId: requireIdentity(input.source.roomId, "source.roomId"),
      scopeId: requireIdentity(input.source.scopeId, "source.scopeId"),
    };
    const actors = input.actors.map((actor) => {
      if (actor.kind !== "human" && actor.kind !== "automation" && actor.kind !== "unknown") {
        throw new MeetingKnowledgeIdentityInvariantError(
          "INVALID_IDENTITY",
          "actor kind must be human, automation, or unknown",
        );
      }
      return {
        actorId: requireIdentity(actor.actorId, "actors.actorId"),
        kind: actor.kind,
      };
    }).toSorted((left, right) => compareOpaqueIds(left.actorId, right.actorId));
    for (let index = 1; index < actors.length; index += 1) {
      const previous = actors[index - 1];
      const current = actors[index];
      if (previous !== undefined && current !== undefined && previous.actorId === current.actorId) {
        throw new MeetingKnowledgeIdentityInvariantError(
          previous.kind === current.kind ? "DUPLICATE_ACTOR" : "CONFLICTING_ACTOR_KIND",
          previous.kind === current.kind
            ? "actor roster cannot repeat an actor"
            : "one actor cannot have conflicting kinds",
        );
      }
    }
    return new MeetingKnowledgeIdentity({
      humanActorIds: actors
        .filter((actor) => actor.kind === "human")
        .map((actor) => actor.actorId),
      source,
    });
  }

  public supportsHumanActor(actorId: string): boolean {
    return this.humanActorIds.includes(actorId);
  }
}
