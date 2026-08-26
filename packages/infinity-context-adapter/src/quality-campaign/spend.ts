import { digest, exactRecord, sha256 } from "./canonical.js";
import type { CallKind } from "./execution.js";
import { FROZEN_ANSWER_EXECUTION } from "./release.js";
import { type SignedValue, verifyExternalSignedValue } from "./signatures.js";

export interface SpendReservation {
  readonly allowedCallKinds: readonly CallKind[]; readonly campaignRootSha256: string;
  readonly expiresAtEpochMs: number; readonly maxCalls: number; readonly maxEncryptedBytes: number;
  readonly maxTokens: number;
  readonly model: "gpt-5.6-sol"; readonly provider: string; readonly reasoning: "xhigh";
  readonly releaseRootSha256: string; readonly repetition: 1 | 2 | 3;
  readonly serviceTier: "default";
}

export type VerifiedSpendReservation = SignedValue<SpendReservation> & {
  readonly spendReservationSha256: string;
};

export function verifySpendReservation(input: { readonly authorityKeyId: string;
  readonly authorityPublicKeyPem: string; readonly campaignRootSha256: string;
  readonly expectedRepetition: 1 | 2 | 3; readonly nowEpochMs: number;
  readonly releaseRootSha256: string; readonly reservation: unknown }):
VerifiedSpendReservation {
  const signed = verifyExternalSignedValue<SpendReservation>(input.reservation,
    input.authorityKeyId, input.authorityPublicKeyPem, "spend reservation");
  const record = exactRecord(signed.payload, ["allowedCallKinds", "campaignRootSha256",
    "expiresAtEpochMs", "maxCalls", "maxEncryptedBytes", "maxTokens", "model", "provider",
    "reasoning", "releaseRootSha256", "repetition", "serviceTier"],
  "spend reservation payload");
  digest(record.campaignRootSha256, "reserved campaign root"); digest(record.releaseRootSha256,
    "reserved release root");
  const allowedCallKinds = decodeAllowedCallKinds(record.allowedCallKinds); if (record.repetition !==
    input.expectedRepetition || record.campaignRootSha256 !==
    input.campaignRootSha256 || record.releaseRootSha256 !== input.releaseRootSha256 ||
    !Number.isSafeInteger(input.nowEpochMs) || typeof record.expiresAtEpochMs !== "number" ||
    record.expiresAtEpochMs <= input.nowEpochMs || typeof record.maxCalls !== "number" ||
    record.maxCalls < 1 || typeof record.maxTokens !== "number" || record.maxTokens < 1 ||
    typeof record.maxEncryptedBytes !== "number" || record.maxEncryptedBytes < 1 ||
    typeof record.provider !== "string" || record.provider.trim() === "" ||
    record.model !== FROZEN_ANSWER_EXECUTION.model || record.reasoning !==
      FROZEN_ANSWER_EXECUTION.reasoning || record.serviceTier !== FROZEN_ANSWER_EXECUTION.serviceTier ||
    ![record.expiresAtEpochMs, record.maxCalls, record.maxTokens,
      record.maxEncryptedBytes].every(Number.isSafeInteger)) {
    throw new Error("spend reservation binding is invalid");
  }
  return Object.freeze({ ...signed, payload: Object.freeze({ ...record,
    allowedCallKinds }) as unknown as SpendReservation,
  spendReservationSha256: sha256(signed) });
}

export function verifySpendReservations(input: { readonly authorityKeyId: string;
  readonly authorityPublicKeyPem: string; readonly campaignRootSha256: string;
  readonly nowEpochMs: number; readonly releaseRootSha256: string;
  readonly reservations: readonly unknown[] }): readonly VerifiedSpendReservation[] {
  if (input.reservations.length !== 3) {
    throw new Error("production campaign requires three signed spend reservations");
  }
  const verified = ([1, 2, 3] as const).map((expectedRepetition, index) =>
    verifySpendReservation({ authorityKeyId: input.authorityKeyId,
      authorityPublicKeyPem: input.authorityPublicKeyPem,
      campaignRootSha256: input.campaignRootSha256, expectedRepetition,
      nowEpochMs: input.nowEpochMs, releaseRootSha256: input.releaseRootSha256,
      reservation: input.reservations[index] }));
  if (new Set(verified.map(({ spendReservationSha256 }) => spendReservationSha256)).size !== 3) {
    throw new Error("production spend reservations are not independently bound");
  }
  return Object.freeze(verified);
}

const CALL_KINDS: readonly CallKind[] = ["adjudicator_1", "adjudicator_2", "answer", "capability",
  "resolver", "retrieval"];

function decodeAllowedCallKinds(value: unknown): readonly CallKind[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((kind) =>
    !CALL_KINDS.includes(kind as CallKind)) || new Set(value).size !== value.length) {
    throw new Error("spend reservation call kinds are invalid");
  }
  return Object.freeze(value as CallKind[]);
}
