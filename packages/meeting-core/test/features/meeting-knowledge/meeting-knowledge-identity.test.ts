import { describe, expect, it } from "vitest";

import {
  MeetingKnowledgeIdentity,
  trustedSealedRosterProducerCapabilityId,
} from "@discord-meeting/meeting-core/meeting-knowledge";

const source = { roomId: "room-1", scopeId: "scope-1" } as const;
const trustedProvenance = {
  actorObservationState: "consistent",
  actorSemanticsVersion: 1,
  producerCapabilityId: trustedSealedRosterProducerCapabilityId,
  producerRevision: "0123456789abcdef0123456789abcdef01234567",
  rosterState: "sealed",
} as const;

describe("Meeting Knowledge identity admission", () => {
  it("admits only actors durably classified as human", () => {
    const identity = MeetingKnowledgeIdentity.admit({
      actors: [
        { actorId: "botik", kind: "automation" },
        { actorId: "speaker-a", kind: "human" },
        { actorId: "speaker-b", kind: "unknown" },
      ],
      identityProvenance: trustedProvenance,
      lifecycleGeneration: 3,
      source,
    });

    expect(identity?.humanActorIds).toEqual(["speaker-a"]);
    expect(identity?.supportsHumanActor("speaker-a")).toBe(true);
    expect(identity?.supportsHumanActor("botik")).toBe(false);
    expect(identity?.supportsHumanActor("speaker-b")).toBe(false);
    expect(identity?.producerRevision).toBe(trustedProvenance.producerRevision);
  });

  it("consumes Lifecycle's canonical source and actor ordering without recanonicalizing", () => {
    const identity = MeetingKnowledgeIdentity.admit({
      actors: [
        { actorId: "Z", kind: "human" },
        { actorId: "z", kind: "human" },
        { actorId: "ä", kind: "human" },
      ],
      identityProvenance: trustedProvenance,
      lifecycleGeneration: 3,
      source,
    });

    expect(identity?.humanActorIds).toEqual(["Z", "z", "ä"]);
  });

  it("denies legacy, unversioned, and capability-less v2 meetings", () => {
    expect(MeetingKnowledgeIdentity.admit({
      actors: [],
      identityProvenance: trustedProvenance,
      lifecycleGeneration: 3,
      source: null,
    })).toBeNull();
    expect(MeetingKnowledgeIdentity.admit({
      actors: null,
      identityProvenance: trustedProvenance,
      lifecycleGeneration: 3,
      source,
    })).toBeNull();
    expect(MeetingKnowledgeIdentity.admit({
      actors: [],
      identityProvenance: null,
      lifecycleGeneration: null,
      source,
    })).toBeNull();
    expect(MeetingKnowledgeIdentity.admit({
      actors: [],
      identityProvenance: null,
      lifecycleGeneration: 2,
      source,
    })).toBeNull();
  });

  it.each([
    ["unknown capability", { producerCapabilityId: "meeting.lifecycle.future.v99" }, 3],
    ["unknown actor semantics", { actorSemanticsVersion: 2 }, 3],
    ["future lifecycle generation", {}, 4],
    ["unsealed roster", { rosterState: "unsealed" }, 3],
    ["actor-kind conflict", { actorObservationState: "conflicted" }, 3],
  ] as const)("denies %s while leaving the recording identity readable", (
    _case,
    provenanceOverride,
    lifecycleGeneration,
  ) => {
    expect(MeetingKnowledgeIdentity.admit({
      actors: [{ actorId: "speaker-a", kind: "human" }],
      identityProvenance: { ...trustedProvenance, ...provenanceOverride },
      lifecycleGeneration,
      source,
    })).toBeNull();
  });
});
