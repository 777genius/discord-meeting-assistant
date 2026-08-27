import { expect, it } from "vitest";

import { admitCumulativeSpend, attemptIdentity, CALL_KINDS, type CallKind,
  type DurableSpendClaim, FROZEN_ANSWER_EXECUTION, sha256 } from "../src/index.js";

const campaignRootSha256 = sha256("campaign");
const releaseRootSha256 = sha256("release");

function fixture(questionCount: 30 | 240) {
  const reservations = ([1, 2, 3] as const).map((repetition) => {
    const spendReservationSha256 = sha256(`reservation-${questionCount}-${repetition}`);
    const maxCallsByKind = Object.fromEntries(CALL_KINDS.map((kind) =>
      [kind, questionCount])) as Record<CallKind, number>;
    return { payload: { allowedCallKinds: CALL_KINDS, campaignRootSha256,
      expiresAtEpochMs: 10_000, maxCalls: questionCount * CALL_KINDS.length,
      maxCallsByKind, maxEncryptedBytes: questionCount * CALL_KINDS.length * 11,
      maximumEffectDurationMs: 1_000, maxTokens: questionCount * CALL_KINDS.length * 7,
      ...FROZEN_ANSWER_EXECUTION, provider: "provider", releaseRootSha256, repetition },
    signatureBase64: "verified-upstream", signerKeyId: "spend",
    spendReservationSha256 };
  });
  const expected: { identity: ReturnType<typeof attemptIdentity>;
    requestDigestSha256: string }[] = [];
  const claims: DurableSpendClaim[] = [];
  for (const reservation of reservations) {
    for (let question = 0; question < questionCount; question += 1) {
      for (const callKind of CALL_KINDS) {
        const questionId = `q-${question}`;
        const identity = attemptIdentity({ callKind, callOrdinal: 0, campaignRootSha256,
          questionDigestSha256: sha256(questionId), questionId, releaseRootSha256,
          repetition: reservation.payload.repetition,
          spendReservationSha256: reservation.spendReservationSha256 });
        const requestDigestSha256 = sha256(`request-${identity.attemptId}`);
        expected.push({ identity, requestDigestSha256 });
        claims.push({ admissionId: `admission-${identity.attemptId}`,
          attemptId: identity.attemptId, callKind, campaignRootSha256,
          repetition: reservation.payload.repetition, requestedEncryptedBytes: 11,
          requestedTokens: 7, requestDigestSha256,
          schemaVersion: "meeting_knowledge.semantic_quality_budget_claim.v1",
          spendReservationSha256: reservation.spendReservationSha256 });
      }
    }
  }
  return { claims, expected, reservations };
}

it.each([240, 30] as const)("reconstructs exact 3x%s cumulative provider/reviewer/resolver spend",
  (questionCount) => {
    const value = fixture(questionCount);
    const proof = admitCumulativeSpend(value);
    expect(proof.repetitions).toEqual(value.reservations.map((reservation) => ({
      calls: questionCount * CALL_KINDS.length,
      callsByKind: Object.fromEntries(CALL_KINDS.map((kind) => [kind, questionCount])),
      encryptedBytes: questionCount * CALL_KINDS.length * 11,
      repetition: reservation.payload.repetition,
      spendReservationSha256: reservation.spendReservationSha256,
      tokens: questionCount * CALL_KINDS.length * 7 })));
  });

it.each(["maxCalls", "maxCallsByKind", "maxTokens", "maxEncryptedBytes"] as const)(
  "rejects individually valid 3x240 claims whose cumulative %s exceeds the signed reservation",
  (ceiling) => {
    const value = fixture(240);
    const first = value.reservations[0]!;
    const payload = { ...first.payload };
    if (ceiling === "maxCalls") {payload.maxCalls -= 1;}
    if (ceiling === "maxCallsByKind") {
      payload.maxCallsByKind = { ...payload.maxCallsByKind, resolver: 239 };
    }
    if (ceiling === "maxTokens") {payload.maxTokens -= 1;}
    if (ceiling === "maxEncryptedBytes") {payload.maxEncryptedBytes -= 1;}
    value.reservations[0] = { ...first, payload };
    expect(() => admitCumulativeSpend(value)).toThrow(/proven cumulative spend exceeds/u);
  });

it.each(["missing", "duplicate", "substituted", "cross-campaign", "cross-reservation"] as const)(
  "rejects %s durable cumulative evidence", (attack) => {
    const value = fixture(30);
    if (attack === "missing") {value.claims.pop();}
    if (attack === "duplicate") {value.claims[1] = value.claims[0]!;}
    if (attack === "substituted") {
      value.claims[0] = { ...value.claims[0]!, requestDigestSha256: sha256("substitute") };
    }
    if (attack === "cross-campaign") {
      value.claims[0] = { ...value.claims[0]!, campaignRootSha256: sha256("foreign") };
    }
    if (attack === "cross-reservation") {
      value.claims[0] = { ...value.claims[0]!, spendReservationSha256:
        value.reservations[1]!.spendReservationSha256 };
    }
    expect(() => admitCumulativeSpend(value)).toThrow(/cumulative spend/u);
  });
