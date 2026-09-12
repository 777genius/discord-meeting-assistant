import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DurableAttemptJournal, withOwnedAttemptJournal } from "../src/quality-campaign/attempt-journal.js";
import { admitCumulativeSpend } from "../src/quality-campaign/cumulative-spend.js";
import { attemptIdentity, type VerifiedSpendReservation } from "../src/quality-campaign/execution.js";
import { verifyCanonicalScopeRetention } from "../src/quality-campaign/retention.js";
import { scopeObservation, scopeObservationCustody } from "./quality-campaign-scope-observation-fixture.js";

const digest = (value: string) => value.repeat(64);

describe("authenticated scope retention and durable budget", () => {
  it("keeps unavailable metadata attempts and their unknown read in the denominator", async () => {
    const identity = attemptIdentity({ callKind: "answer", callOrdinal: 0,
      campaignRootSha256: digest("a"), releaseRootSha256: digest("b"),
      questionDigestSha256: digest("c"), questionId: "q-1", repetition: 1,
      spendReservationSha256: digest("d") });
    const observation = { schemaVersion: "meeting_knowledge.scope_resolution.v1",
      status: "unavailable", reads: [{ kind: "scope_spaces", requestSha256: digest("e"),
        responseBytes: 0, responseSha256: null, status: "outcome_unknown" }] };
    const retained = await verifyCanonicalScopeRetention([identity], {
      readScopeObservation: async () => ({ observation, receipt: { algorithm: "A256GCM",
        artifactKind: "scope_resolution_observation", attemptId: identity.attemptId,
        envelopeSha256: digest("f"), plaintextSha256: digest("1"),
        rootBindingSha256: identity.campaignRootSha256,
        schemaVersion: "meeting_knowledge.semantic_quality_artifact_receipt.v1",
        sizeBytes: 256, storeIdentitySha256: digest("2") } }) });
    expect(retained.expectedSpendClaims).toHaveLength(1);
    expect(retained.expectedSpendClaims[0]).toMatchObject({
      identity: { callKind: "capability", callOrdinal: 1 },
      requestDigestSha256: digest("e") });
  });

  it("reconstructs ordinals 1/2 exactly once and accounts for real durable claims across restart", async () => {
    const reservations = ([1, 2, 3] as const).map<VerifiedSpendReservation>((repetition) => ({
      signerKeyId: "synthetic-budget-authority", signatureBase64: "AA==",
      spendReservationSha256: digest(String(repetition)), payload: {
        allowedCallKinds: ["capability"], campaignRootSha256: digest("a"),
        releaseRootSha256: digest("b"), repetition, maxCalls: 2,
        maxCallsByKind: { capability: 2, answer: 0, retrieval: 0, adjudicator_1: 0, adjudicator_2: 0, resolver: 0 }, maxTokens: 2, maxEncryptedBytes: 4096, expiresAtEpochMs: 2_000_000_000_000,
        maximumEffectDurationMs: 3000, model: "gpt-5.6-terra", provider: "subscription-runtime",
        reasoning: "low", serviceTier: "default",
      },
    }));
    const identities = reservations.map((spend) => attemptIdentity({ callKind: "answer", callOrdinal: 0,
      campaignRootSha256: digest("a"), releaseRootSha256: digest("b"), questionDigestSha256: digest("c"),
      questionId: "q-1", repetition: spend.payload.repetition, spendReservationSha256: spend.spendReservationSha256 }));
    const root = await mkdtemp(join(tmpdir(), "scope-budget-retention-"));
    const journal = new DurableAttemptJournal(root, {} as never);
    await withOwnedAttemptJournal(journal, async () => {
      for (const [index, identity] of identities.entries()) {
        for (const [ordinal, read] of scopeObservation(identity).reads.entries()) {
          const request = { identity: attemptIdentity({ campaignRootSha256: identity.campaignRootSha256,
          releaseRootSha256: identity.releaseRootSha256, questionId: identity.questionId,
          questionDigestSha256: identity.questionDigestSha256, repetition: identity.repetition,
          spendReservationSha256: identity.spendReservationSha256, callKind: "capability", callOrdinal: ordinal + 1 }),
            requestDigestSha256: read.requestSha256, requestedEncryptedBytes: 2048,
            requestedTokens: 1, spend: reservations[index]! };
          await expect(journal.admit({ ...request, requestedTokens: 0 })).rejects.toThrow("budget claim is invalid");
          expect((await journal.admit(request)).admitted).toBe(true);
          expect((await journal.admit(request)).admitted).toBe(false);
        }
      }
    });
    const custody = scopeObservationCustody();
    const retained = await verifyCanonicalScopeRetention(identities, custody);
    expect(retained.expectedSpendClaims.map(({ identity }) => identity.callOrdinal)).toEqual([1, 2, 1, 2, 1, 2]);
    expect(retained.totalStoredBytes).toBeGreaterThan(0);
    await expect(verifyCanonicalScopeRetention(identities, custody)).resolves.toEqual(retained);
    const reopened = new DurableAttemptJournal(root, {} as never);
    await withOwnedAttemptJournal(reopened, async () => {
      const claims = (await Promise.all(reservations.map((spend) => reopened.loadAdmittedClaims(spend)))).flat();
      expect(claims).toHaveLength(6);
      const proof = admitCumulativeSpend({ claims, expected: retained.expectedSpendClaims, reservations });
      expect(proof.repetitions.map(({ calls, encryptedBytes, tokens }) => ({ calls, encryptedBytes, tokens })))
        .toEqual([1, 2, 3].map(() => ({ calls: 2, encryptedBytes: 4096, tokens: 2 })));
      expect(() => admitCumulativeSpend({ claims, expected: retained.expectedSpendClaims.slice(1), reservations }))
        .toThrow("orphaned");
      expect(() => admitCumulativeSpend({ claims: claims.map((claim, index) => index === 0 ?
        { ...claim, requestDigestSha256: digest("f") } : claim), expected: retained.expectedSpendClaims, reservations }))
        .toThrow("substituted");
      for (const claim of retained.expectedSpendClaims) {
        expect(await reopened.recoveredState({ identity: claim.identity,
          requestDigestSha256: claim.requestDigestSha256, release: {} as never })).toBe("outcome_unknown");
      }
    });
  });
});
