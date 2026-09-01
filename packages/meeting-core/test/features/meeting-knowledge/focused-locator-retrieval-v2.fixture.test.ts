import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildHistoricalIndexPlan, PrepareFocusedLocatorRetrievalV2Request,
  type HistoricalAuthorizationPort, type HistoricalEvidenceAuthority } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { AppliedStore, TestIds, makeMeeting } from
  "../../fixtures/historical-retrieval-fixtures.js";

export const providerBinding = Object.freeze({ capabilityFingerprint: "3".repeat(64),
  contractVersion: "context-retrieval.v2" as const,
  indexProfileDigest: "2".repeat(64),
  profileId: "locator-v2-qualified-profile",
  rankingPolicy: "weighted_rrf_canonical_preferences.v1" as const,
  requiredProviderLanes: Object.freeze(["postgres_keyword", "qdrant_dense"]),
  serviceRevision: "4".repeat(40),
});
export const identitySkeletons = Object.freeze({
  skeleton: (value: string) => {
    const canonical = value.normalize("NFKC").toLocaleLowerCase("und");
    return Object.freeze({ canonical, certainty: "certain" as const, skeleton: canonical });
  },
});

export function expectPrepared(
  value: Awaited<ReturnType<PrepareFocusedLocatorRetrievalV2Request["prepare"]>>,
): asserts value is Extract<typeof value, { readonly status: "prepared" }> {
  if (value.status !== "prepared") {throw new Error("expected prepared retrieval");}
}

export function providerCandidate(locator: string, request: unknown, providerRank = 1) {
  const contributions = Object.freeze([Object.freeze({ contributionScorePicos: 500_000,
    providerLaneId: "postgres_keyword", providerRank, queryId: "original-question",
    rawScoreKind: "bm25" as const, rawScoreValue: 2.5 })]);
  return Object.freeze({ locator, retrievalProvenance: Object.freeze({
    contributions, fusedScore: 0.5,
    laneIdentity: Object.freeze({ capabilityFingerprint: providerBinding.capabilityFingerprint,
      lane: "historical" as const, profileId: providerBinding.profileId }),
    locator, providerRank, requestDigest: digest(request),
    responseDigest: digest({ contributions, fusedScore: 0.5, locator, providerRank }),
  }) });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJsonValue(value))).digest("hex");
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonicalJsonValue);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([key, nested]) => [key, canonicalJsonValue(nested)]));
}

export function markerTurn(marker: string) {
  return [{ endMs: 1_000, speakerId: "speaker", startMs: 0, text: marker,
    turnId: `turn-${marker}` }];
}

export function fixture() {
  const meeting = makeMeeting({ meetingId: "historical-meeting", turns: [{
    endMs: 430_000, speakerId: "opaque-vlad", startMs: 420_000,
    text: "Влад approved the launch on Tuesday", turnId: "turn-vlad" }] });
  const plan = buildHistoricalIndexPlan(meeting, new TestIds());
  const store = new AppliedStore([{ binding: meeting.binding, plan, remoteDocumentIds: {} }],
    [meeting]);
  const prepare = new PrepareFocusedLocatorRetrievalV2Request({ ids: new TestIds(),
    identitySkeletons, providerBinding,
    speakerAliases: [{ actorKeys: ["opaque-vlad"], aliases: ["Влад", "Vlad"] }], store });
  return { meeting, plan, prepare, store };
}

export function authority(meeting: ReturnType<typeof makeMeeting>): HistoricalEvidenceAuthority {
  return { loadAcceptedFinalMeeting: async (binding) =>
    binding.releaseId === meeting.binding.releaseId ? meeting : null };
}

export function authorization(sequence: boolean[] = [true, true]): HistoricalAuthorizationPort {
  return { authorize: async () => {
    const authorized = sequence.shift() ?? false;
    return { authorizationDigest: "authorization-1", authorizationEpoch: "epoch-1",
      authorized, policyVersion: "room-policy.v1" };
  } };
}

describe("focused locator retrieval V2 fixture", () => {
  it("pins both required provider lanes", () => {
    expect(providerBinding.requiredProviderLanes)
      .toEqual(["postgres_keyword", "qdrant_dense"]);
  });
});
