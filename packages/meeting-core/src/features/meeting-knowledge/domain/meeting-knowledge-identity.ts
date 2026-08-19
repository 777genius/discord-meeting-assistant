export type MeetingKnowledgeActorKind = "automation" | "human" | "unknown";

export interface MeetingKnowledgeSourceIdentity {
  readonly roomId: string;
  readonly scopeId: string;
}

export interface MeetingKnowledgeActorIdentity {
  readonly actorId: string;
  readonly kind: MeetingKnowledgeActorKind;
}

export interface MeetingKnowledgeIdentityProvenance {
  readonly actorObservationState: "consistent" | "conflicted";
  readonly actorSemanticsVersion: number;
  readonly producerCapabilityId: string;
  readonly producerRevision: string;
  readonly rosterState: "sealed" | "unsealed";
}

export interface MeetingKnowledgeIdentityInput {
  readonly actors: readonly MeetingKnowledgeActorIdentity[] | null;
  readonly identityProvenance: MeetingKnowledgeIdentityProvenance | null;
  readonly lifecycleGeneration: number | null;
  readonly source: MeetingKnowledgeSourceIdentity | null;
}

export const trustedSealedRosterProducerCapabilityId =
  "meeting.lifecycle.sealed-actor-roster.v1" as const;
export const trustedSealedRosterActorSemanticsVersion = 1 as const;
export const trustedSealedRosterLifecycleGeneration = 3 as const;

/**
 * Provider-neutral eligibility check over Meeting Lifecycle's canonical
 * snapshot. Lifecycle alone normalizes source and actor observations; Meeting
 * Knowledge checks only the published capability/seal and selects humans.
 */
export class MeetingKnowledgeIdentity {
  public readonly actorSemanticsVersion: number;
  public readonly humanActorIds: readonly string[];
  public readonly producerCapabilityId: string;
  public readonly producerRevision: string;
  public readonly source: MeetingKnowledgeSourceIdentity;

  private constructor(input: {
    readonly actorSemanticsVersion: number;
    readonly humanActorIds: readonly string[];
    readonly producerCapabilityId: string;
    readonly producerRevision: string;
    readonly source: MeetingKnowledgeSourceIdentity;
  }) {
    this.actorSemanticsVersion = input.actorSemanticsVersion;
    this.humanActorIds = Object.freeze([...input.humanActorIds]);
    this.producerCapabilityId = input.producerCapabilityId;
    this.producerRevision = input.producerRevision;
    this.source = Object.freeze({ ...input.source });
    Object.freeze(this);
  }

  public static admit(input: MeetingKnowledgeIdentityInput): MeetingKnowledgeIdentity | null {
    const provenance = input.identityProvenance;
    if (
      input.source === null ||
      input.actors === null ||
      provenance === null ||
      input.lifecycleGeneration !== trustedSealedRosterLifecycleGeneration ||
      provenance.producerCapabilityId !== trustedSealedRosterProducerCapabilityId ||
      provenance.actorSemanticsVersion !== trustedSealedRosterActorSemanticsVersion ||
      provenance.actorObservationState !== "consistent" ||
      provenance.rosterState !== "sealed"
    ) {
      return null;
    }
    return new MeetingKnowledgeIdentity({
      actorSemanticsVersion: provenance.actorSemanticsVersion,
      humanActorIds: input.actors
        .filter((actor) => actor.kind === "human")
        .map((actor) => actor.actorId),
      producerCapabilityId: provenance.producerCapabilityId,
      producerRevision: provenance.producerRevision,
      source: input.source,
    });
  }

  public supportsHumanActor(actorId: string): boolean {
    return this.humanActorIds.includes(actorId);
  }
}
