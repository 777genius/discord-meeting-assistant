import {
  LiveFinalizedMemoryWorker,
  admitTrustedLiveMemoryIdentity,
  isAttestedActiveLiveMemoryIdentity,
  type CanonicalEvidenceTurn,
  type LiveFinalizedMemoryLeaseV1,
  type LiveFinalizedMemorySyncStore,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { describe, expect, it } from "vitest";

const turn: CanonicalEvidenceTurn = {
  endMs: 2_000,
  speakerId: "human-1",
  startMs: 1_000,
  text: "The launch is Friday.",
  turnId: "turn-1",
};

const lease: LiveFinalizedMemoryLeaseV1 = {
  attempt: 1,
  fence: 1,
  identityGeneration: 1,
  meetingId: "meeting-1",
  mutationId: "mutation-1",
  sourceGeneration: 1,
  turnHash: "canonical-hash",
  turnId: turn.turnId,
};

function trustedIdentity() {
  return {
    actors: [
      { actorId: "human-1", kind: "human" as const },
      { actorId: "bot-1", kind: "automation" as const },
    ],
    identityProvenance: {
      actorObservationState: "consistent" as const,
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "producer-r1",
      rosterState: "unsealed" as const,
    },
    lifecycleGeneration: 3,
    meetingId: "meeting-1",
    roomId: "room-1",
    scopeId: "scope-1",
  };
}

class MemoryStore implements LiveFinalizedMemorySyncStore {
  public applied = 0;
  public deadLetters: string[] = [];
  public failApply = false;
  public next: LiveFinalizedMemoryLeaseV1 | null = lease;
  public retries: string[] = [];

  public claimNext(): Promise<LiveFinalizedMemoryLeaseV1 | null> {
    const current = this.next;
    this.next = null;
    return Promise.resolve(current);
  }

  public loadCanonicalTurn(): Promise<CanonicalEvidenceTurn | null> {
    return Promise.resolve(turn);
  }

  public apply(): Promise<void> {
    if (this.failApply) {
      throw new Error("synthetic apply failure");
    }
    this.applied += 1;
    return Promise.resolve();
  }

  public recordDeadLetter(_lease: LiveFinalizedMemoryLeaseV1, code: string): Promise<void> {
    this.deadLetters.push(code);
    return Promise.resolve();
  }

  public recordRetry(_lease: LiveFinalizedMemoryLeaseV1, input: { readonly code: string }): Promise<void> {
    this.retries.push(input.code);
    return Promise.resolve();
  }
}

describe("trusted live finalized memory", () => {
  it("defines attested_active independently from the terminal roster seal", () => {
    const attestation = {
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      rosterState: "unsealed" as const,
      schemaVersion: 1,
      state: "active" as const,
    };

    expect(isAttestedActiveLiveMemoryIdentity(attestation)).toBe(true);
    expect(isAttestedActiveLiveMemoryIdentity({
      ...attestation,
      producerCapabilityId: "unknown-capability",
    })).toBe(false);
    expect(isAttestedActiveLiveMemoryIdentity({
      ...attestation,
      state: "ended",
    })).toBe(false);
  });

  it("admits only trusted consistent human lifecycle identity", () => {
    expect(admitTrustedLiveMemoryIdentity(trustedIdentity())).toMatchObject({
      humanActorIds: ["human-1"],
      rosterState: "unsealed",
      schemaVersion: 1,
    });
    expect(admitTrustedLiveMemoryIdentity({
      ...trustedIdentity(),
      identityProvenance: {
        ...trustedIdentity().identityProvenance,
        actorObservationState: "conflicted",
      },
    })).toBeNull();
    expect(admitTrustedLiveMemoryIdentity({
      ...trustedIdentity(),
      actors: [{ actorId: "bot-1", kind: "automation" }],
    })).toBeNull();
  });

  it("applies a canonical mutation and retries or dead-letters bounded failures", async () => {
    const store = new MemoryStore();
    const worker = new LiveFinalizedMemoryWorker(store, {
      hash: () => "canonical-hash",
    });
    await expect(worker.executeOnce()).resolves.toMatchObject({ status: "applied" });
    expect(store.applied).toBe(1);

    store.next = lease;
    store.failApply = true;
    await expect(worker.executeOnce()).resolves.toMatchObject({ status: "retry_wait" });
    expect(store.retries).toEqual(["Error"]);

    store.next = { ...lease, attempt: 8, fence: 2 };
    await expect(worker.executeOnce()).resolves.toMatchObject({ status: "dead_letter" });
    expect(store.deadLetters).toEqual(["Error"]);
  });

  it("dead-letters a locator whose canonical local content changed", async () => {
    const store = new MemoryStore();
    const worker = new LiveFinalizedMemoryWorker(store, { hash: () => "different" });
    await expect(worker.executeOnce()).resolves.toMatchObject({ status: "dead_letter" });
    expect(store.applied).toBe(0);
    expect(store.deadLetters).toEqual(["canonical_turn_mismatch"]);
  });
});
