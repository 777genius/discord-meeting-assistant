import {
  trustedSealedRosterActorSemanticsVersion,
  trustedSealedRosterLifecycleGeneration,
  trustedSealedRosterProducerCapabilityId,
  type MeetingKnowledgeActorIdentity,
  type MeetingKnowledgeIdentityProvenance,
} from "./meeting-knowledge-identity.js";
import {
  requireKnowledgeInteger,
  requireKnowledgeText,
} from "./errors.js";

export const LIVE_FINALIZED_MEMORY_SCHEMA_VERSION = 1 as const;
export const LIVE_FINALIZED_MEMORY_POLICY_VERSION =
  "meeting-knowledge.live-finalized-hot-tail.v1" as const;

export interface TrustedLiveMemoryIdentityInputV1 {
  readonly actors: readonly MeetingKnowledgeActorIdentity[];
  readonly identityProvenance: MeetingKnowledgeIdentityProvenance;
  readonly lifecycleGeneration: number;
  readonly meetingId: string;
  readonly roomId: string;
  readonly scopeId: string;
}

export interface TrustedLiveMemoryIdentityV1 {
  readonly humanActorIds: readonly string[];
  readonly meetingId: string;
  readonly producerRevision: string;
  readonly roomId: string;
  readonly rosterState: "sealed" | "unsealed";
  readonly schemaVersion: typeof LIVE_FINALIZED_MEMORY_SCHEMA_VERSION;
  readonly scopeId: string;
}

export interface AttestedActiveLiveMemoryIdentityV1 {
  readonly actorSemanticsVersion: number;
  readonly producerCapabilityId: string;
  readonly rosterState: "sealed" | "unsealed";
  readonly schemaVersion: number;
  readonly state: "active" | "ended" | "withdrawn";
}

/**
 * Durable `attested_active` predicate for transient live knowledge. Schema v1
 * rows can only be created after v3 lifecycle admission has proved a consistent
 * observation; reads additionally recheck the exact capability and semantics.
 * A terminal seal is intentionally not required until final/historical use.
 */
export function isAttestedActiveLiveMemoryIdentity(
  input: AttestedActiveLiveMemoryIdentityV1,
): boolean {
  return input.schemaVersion === LIVE_FINALIZED_MEMORY_SCHEMA_VERSION &&
    input.producerCapabilityId === trustedSealedRosterProducerCapabilityId &&
    input.actorSemanticsVersion === trustedSealedRosterActorSemanticsVersion &&
    (input.rosterState === "sealed" || input.rosterState === "unsealed") &&
    input.state === "active";
}

/**
 * Active memory may use a trusted but not-yet-sealed lifecycle roster. This is
 * deliberately narrower than historical admission: it is transient, checked
 * again on every read, and can never create an Infinity/final-release intent.
 */
export function admitTrustedLiveMemoryIdentity(
  input: TrustedLiveMemoryIdentityInputV1,
): TrustedLiveMemoryIdentityV1 | null {
  const provenance = input.identityProvenance;
  if (
    input.lifecycleGeneration !== trustedSealedRosterLifecycleGeneration ||
    provenance.producerCapabilityId !== trustedSealedRosterProducerCapabilityId ||
    provenance.actorSemanticsVersion !== trustedSealedRosterActorSemanticsVersion ||
    provenance.actorObservationState !== "consistent"
  ) {
    return null;
  }
  const humanActorIds = input.actors
    .filter(({ kind }) => kind === "human")
    .map(({ actorId }) => requireKnowledgeText(actorId, "liveMemory.actorId", 256))
    .toSorted();
  if (
    humanActorIds.length === 0 ||
    new Set(humanActorIds).size !== humanActorIds.length
  ) {
    return null;
  }
  requireKnowledgeInteger(input.lifecycleGeneration, "liveMemory.lifecycleGeneration", 1);
  return Object.freeze({
    humanActorIds: Object.freeze(humanActorIds),
    meetingId: requireKnowledgeText(input.meetingId, "liveMemory.meetingId", 1_024),
    producerRevision: requireKnowledgeText(
      provenance.producerRevision,
      "liveMemory.producerRevision",
      1_024,
    ),
    roomId: requireKnowledgeText(input.roomId, "liveMemory.roomId", 1_024),
    rosterState: provenance.rosterState,
    schemaVersion: LIVE_FINALIZED_MEMORY_SCHEMA_VERSION,
    scopeId: requireKnowledgeText(input.scopeId, "liveMemory.scopeId", 1_024),
  });
}
