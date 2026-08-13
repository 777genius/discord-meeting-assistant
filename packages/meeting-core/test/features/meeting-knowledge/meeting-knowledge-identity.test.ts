import { describe, expect, it } from "vitest";

import {
  MeetingKnowledgeIdentity,
  MeetingKnowledgeIdentityInvariantError,
} from "@discord-meeting/meeting-core/meeting-knowledge";

const source = { roomId: "room-1", scopeId: "scope-1" } as const;

describe("Meeting Knowledge identity admission", () => {
  it("admits only actors durably classified as human", () => {
    const identity = MeetingKnowledgeIdentity.admit({
      actors: [
        { actorId: "botik", kind: "automation" },
        { actorId: "speaker-b", kind: "unknown" },
        { actorId: "speaker-a", kind: "human" },
      ],
      source,
    });

    expect(identity?.humanActorIds).toEqual(["speaker-a"]);
    expect(identity?.supportsHumanActor("speaker-a")).toBe(true);
    expect(identity?.supportsHumanActor("botik")).toBe(false);
    expect(identity?.supportsHumanActor("speaker-b")).toBe(false);
  });

  it("denies legacy meetings with absent source or actor identity", () => {
    expect(MeetingKnowledgeIdentity.admit({ actors: [], source: null })).toBeNull();
    expect(MeetingKnowledgeIdentity.admit({ actors: null, source })).toBeNull();
  });

  it("fails closed when one actor has conflicting kinds", () => {
    expect(() => MeetingKnowledgeIdentity.admit({
      actors: [
        { actorId: "speaker-a", kind: "human" },
        { actorId: "speaker-a", kind: "automation" },
      ],
      source,
    })).toThrow(expect.objectContaining({
      code: "CONFLICTING_ACTOR_KIND",
      name: MeetingKnowledgeIdentityInvariantError.name,
    }));
  });
});
