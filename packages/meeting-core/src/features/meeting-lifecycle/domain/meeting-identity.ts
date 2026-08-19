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

export interface MeetingIdentityProvenanceSnapshot {
  readonly actorObservationState: "consistent" | "conflicted";
  readonly actorSemanticsVersion: number;
  readonly producerCapabilityId: string;
  readonly producerRevision: string;
  readonly rosterState: "sealed" | "unsealed";
}

const immutableProducerRevision = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

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
    const kind: unknown = actor.kind;
    if (kind !== "human" && kind !== "automation" && kind !== "unknown") {
      throw new DomainInvariantError(
        "INVALID_ACTOR_KIND",
        "meeting actor kind must be human, automation, or unknown",
      );
    }
    return Object.freeze({
      actorId: requireNonEmpty(actor.actorId, "meeting.actors.actorId"),
      kind,
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

export function normalizeLifecycleGeneration(
  generation: number | null | undefined,
): number | null {
  if (generation === null || generation === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new DomainInvariantError(
      "INVALID_SNAPSHOT",
      "meeting lifecycle generation must be a positive safe integer",
    );
  }
  return generation;
}

export function normalizeIdentityProvenance(
  provenance: MeetingIdentityProvenanceSnapshot | null | undefined,
  lifecycleGeneration: number | null,
): MeetingIdentityProvenanceSnapshot | null {
  if (provenance === null || provenance === undefined) {
    return null;
  }
  const actorObservationState: unknown = provenance.actorObservationState;
  const rosterState: unknown = provenance.rosterState;
  if (
    actorObservationState !== "consistent" &&
    actorObservationState !== "conflicted"
  ) {
    throw new DomainInvariantError(
      "INVALID_SNAPSHOT",
      "meeting actor observation state is invalid",
    );
  }
  if (rosterState !== "sealed" && rosterState !== "unsealed") {
    throw new DomainInvariantError(
      "INVALID_SNAPSHOT",
      "meeting roster state is invalid",
    );
  }
  if (lifecycleGeneration === null || lifecycleGeneration < 3) {
    throw new DomainInvariantError(
      "INVALID_SNAPSHOT",
      "producer capability provenance requires lifecycle generation 3 or newer",
    );
  }
  if (
    !Number.isSafeInteger(provenance.actorSemanticsVersion) ||
    provenance.actorSemanticsVersion < 1
  ) {
    throw new DomainInvariantError(
      "INVALID_SNAPSHOT",
      "meeting actor semantics version must be a positive safe integer",
    );
  }
  const producerCapabilityId: unknown = provenance.producerCapabilityId;
  if (
    typeof producerCapabilityId !== "string" ||
    producerCapabilityId.trim().length === 0 ||
    producerCapabilityId.length > 128
  ) {
    throw new DomainInvariantError(
      "INVALID_SNAPSHOT",
      "meeting producer capability ID must be a bounded non-empty string",
    );
  }
  const producerRevision: unknown = provenance.producerRevision;
  if (typeof producerRevision !== "string" || !immutableProducerRevision.test(producerRevision)) {
    throw new DomainInvariantError(
      "INVALID_SNAPSHOT",
      "meeting producer revision must be an immutable lowercase hexadecimal revision",
    );
  }
  return Object.freeze({
    actorObservationState,
    actorSemanticsVersion: provenance.actorSemanticsVersion,
    // Capability identity is compared byte-for-byte by Meeting Knowledge. Do
    // not trim an unsupported value into the trusted capability.
    producerCapabilityId,
    producerRevision,
    rosterState,
  });
}
