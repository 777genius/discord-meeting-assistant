import { digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { assertAttemptIdentity, CALL_KINDS, type AttemptIdentity, type CallKind,
  type VerifiedSpendReservation } from "./execution.js";

export interface DurableSpendClaim {
  readonly admissionId: string;
  readonly attemptId: string;
  readonly callKind: CallKind;
  readonly campaignRootSha256: string;
  readonly repetition: 1 | 2 | 3;
  readonly requestedEncryptedBytes: number;
  readonly requestedTokens: number;
  readonly requestDigestSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_budget_claim.v1";
  readonly spendReservationSha256: string;
}

export interface ExpectedSpendClaim {
  readonly identity: AttemptIdentity;
  readonly requestDigestSha256: string;
}

export interface RepetitionSpendTotal {
  readonly calls: number;
  readonly callsByKind: Readonly<Record<CallKind, number>>;
  readonly encryptedBytes: number;
  readonly repetition: 1 | 2 | 3;
  readonly spendReservationSha256: string;
  readonly tokens: number;
}

export interface CumulativeSpendProof {
  readonly claimSetSha256: string;
  readonly repetitions: readonly RepetitionSpendTotal[];
  readonly schemaVersion: "meeting_knowledge.semantic_quality_cumulative_spend_proof.v1";
}

export interface CumulativeSpendLedgerPort {
  loadAdmittedClaims(reservation: VerifiedSpendReservation): Promise<readonly unknown[]>;
}

/** Reconstructs totals only from exact durable claims; caller-supplied aggregates are not input. */
// Exact identity, membership, and four independent ceilings intentionally share one fail-closed pass.
// oxlint-disable-next-line complexity
export function admitCumulativeSpend(input: {
  readonly claims: readonly unknown[];
  readonly expected: readonly ExpectedSpendClaim[];
  readonly reservations: readonly VerifiedSpendReservation[];
}): CumulativeSpendProof {
  if (input.reservations.length !== 3 || input.expected.length === 0) {
    throw new Error("cumulative spend evidence requires three repetition reservations");
  }
  const reservations = new Map(input.reservations.map((reservation) =>
    [reservation.spendReservationSha256, reservation] as const));
  if (reservations.size !== 3 || new Set(input.reservations.map(({ payload }) =>
    payload.repetition)).size !== 3) {
    throw new Error("cumulative spend reservations are duplicated or substituted");
  }
  const expected = new Map<string, ExpectedSpendClaim>();
  for (const value of input.expected) {
    assertAttemptIdentity(value.identity);
    const requestDigestSha256 = digest(value.requestDigestSha256, "expected spend request");
    const reservation = reservations.get(value.identity.spendReservationSha256);
    if (reservation === undefined || reservation.payload.repetition !== value.identity.repetition ||
      reservation.payload.campaignRootSha256 !== value.identity.campaignRootSha256 ||
      reservation.payload.releaseRootSha256 !== value.identity.releaseRootSha256 ||
      expected.has(value.identity.attemptId)) {
      throw new Error("expected cumulative spend membership is duplicated or foreign");
    }
    expected.set(value.identity.attemptId, Object.freeze({ identity: value.identity,
      requestDigestSha256 }));
  }
  if (input.claims.length !== expected.size) {
    throw new Error("cumulative spend evidence is missing, duplicated, or orphaned");
  }
  const admissionIds = new Set<string>();
  const claims = input.claims.map(decodeSpendClaim);
  for (const claim of claims) {
    const membership = expected.get(claim.attemptId);
    if (membership === undefined || admissionIds.has(claim.admissionId) ||
      claim.callKind !== membership.identity.callKind ||
      claim.campaignRootSha256 !== membership.identity.campaignRootSha256 ||
      claim.repetition !== membership.identity.repetition ||
      claim.requestDigestSha256 !== membership.requestDigestSha256 ||
      claim.spendReservationSha256 !== membership.identity.spendReservationSha256) {
      throw new Error("cumulative spend claim is missing, duplicated, substituted, or foreign");
    }
    admissionIds.add(claim.admissionId);
    expected.delete(claim.attemptId);
  }
  if (expected.size !== 0) {
    throw new Error("cumulative spend evidence is missing exact attempts");
  }
  const totals = ([1, 2, 3] as const).map((repetition) => {
    const reservation = input.reservations.find(({ payload }) => payload.repetition === repetition)!;
    const repetitionClaims = claims.filter((claim) => claim.repetition === repetition);
    const callsByKind = Object.fromEntries(CALL_KINDS.map((kind) => [kind,
      repetitionClaims.filter((claim) => claim.callKind === kind).length])) as
      Record<CallKind, number>;
    const encryptedBytes = repetitionClaims.reduce((sum, claim) =>
      safeAdd(sum, claim.requestedEncryptedBytes), 0);
    const tokens = repetitionClaims.reduce((sum, claim) => safeAdd(sum,
      claim.requestedTokens), 0);
    if (repetitionClaims.length > reservation.payload.maxCalls ||
      encryptedBytes > reservation.payload.maxEncryptedBytes ||
      tokens > reservation.payload.maxTokens || CALL_KINDS.some((kind) =>
      callsByKind[kind] > reservation.payload.maxCallsByKind[kind]) ||
      repetitionClaims.some((claim) =>
        !reservation.payload.allowedCallKinds.includes(claim.callKind))) {
      throw new Error("proven cumulative spend exceeds its exact signed reservation");
    }
    return Object.freeze({ calls: repetitionClaims.length, callsByKind:
      Object.freeze(callsByKind), encryptedBytes, repetition,
    spendReservationSha256: reservation.spendReservationSha256, tokens });
  });
  const canonicalClaims = claims.toSorted((left, right) =>
    left.attemptId.localeCompare(right.attemptId));
  return Object.freeze({ claimSetSha256: sha256(canonicalClaims), repetitions:
    Object.freeze(totals),
  schemaVersion: "meeting_knowledge.semantic_quality_cumulative_spend_proof.v1" });
}

function decodeSpendClaim(value: unknown): DurableSpendClaim {
  const record = exactRecord(value, ["admissionId", "attemptId", "callKind",
    "campaignRootSha256", "repetition", "requestedEncryptedBytes", "requestedTokens",
    "requestDigestSha256", "schemaVersion", "spendReservationSha256"],
  "cumulative durable spend claim");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_budget_claim.v1" ||
    !CALL_KINDS.includes(record.callKind as CallKind) ||
    ![1, 2, 3].includes(Number(record.repetition)) ||
    ![record.requestedEncryptedBytes, record.requestedTokens].every((number) =>
      Number.isSafeInteger(number) && Number(number) >= 0) ||
    Number(record.requestedTokens) < 1) {
    throw new Error("cumulative durable spend claim is invalid");
  }
  safeId(record.admissionId, "cumulative spend admission ID");
  safeId(record.attemptId, "cumulative spend attempt ID");
  digest(record.campaignRootSha256, "cumulative spend campaign root");
  digest(record.requestDigestSha256, "cumulative spend request");
  digest(record.spendReservationSha256, "cumulative spend reservation");
  return Object.freeze(record as unknown as DurableSpendClaim);
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {throw new Error("cumulative spend total is invalid");}
  return result;
}
