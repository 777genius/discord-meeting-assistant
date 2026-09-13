import { createPublicKey, verify } from "node:crypto";

import { canonicalJson, digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { FROZEN_ANSWER_EXECUTION, type PinnedReleaseDocument,
  QualityCampaignAuthorityPolicy, verifyPinnedReleaseDocument } from "./release.js";

export const EXIT_SAFE_PAUSE = 20, EXIT_OUTCOME_UNKNOWN = 21;

export interface SpendReservation {
  readonly allowedCallKinds: readonly CallKind[]; readonly campaignRootSha256: string;
  readonly expiresAtEpochMs: number; readonly maxCalls: number; readonly maxEncryptedBytes: number;
  readonly maxCallsByKind: Readonly<Record<CallKind, number>>;
  readonly maximumEffectDurationMs: number;
  readonly maxTokens: number;
  readonly model: "gpt-5.6-sol"; readonly provider: string; readonly reasoning: "medium";
  readonly releaseRootSha256: string; readonly repetition: 1 | 2 | 3;
  readonly serviceTier: "default";
}

export interface SignedValue<T> {
  readonly payload: T; readonly signatureBase64: string; readonly signerKeyId: string;
}

export type VerifiedSpendReservation = SignedValue<SpendReservation> & {
  readonly spendReservationSha256: string;
};

export function verifySpendReservation(policy: QualityCampaignAuthorityPolicy, input: {
  readonly campaignRootSha256: string;
  readonly expectedRepetition: 1 | 2 | 3; readonly nowEpochMs: number;
  readonly releaseRootSha256: string; readonly reservation: unknown }):
VerifiedSpendReservation {
  const authority = policy.authority("spend");
  const signed = verifyExternalSignedValue<SpendReservation>(input.reservation,
    authority.keyId, authority.publicKeyPem, "spend reservation");
  const record = exactRecord(signed.payload, ["allowedCallKinds", "campaignRootSha256",
    "expiresAtEpochMs", "maxCalls", "maxCallsByKind", "maxEncryptedBytes", "maximumEffectDurationMs",
    "maxTokens", "model", "provider",
    "reasoning", "releaseRootSha256", "repetition", "serviceTier"],
  "spend reservation payload");
  digest(record.campaignRootSha256, "reserved campaign root"); digest(record.releaseRootSha256,
    "reserved release root");
  const allowedCallKinds = decodeAllowedCallKinds(record.allowedCallKinds);
  const maxCallsByKind = decodeCallKindCeilings(record.maxCallsByKind);
  assertSpendIdentity(record, input);
  assertSpendLimits(record, allowedCallKinds, maxCallsByKind, input.nowEpochMs);
  return Object.freeze({ ...signed, payload: Object.freeze({ ...record,
    allowedCallKinds, maxCallsByKind }) as unknown as SpendReservation,
  spendReservationSha256: sha256(signed) });
}

function assertSpendIdentity(record: Record<string, unknown>, input: {
  readonly campaignRootSha256: string; readonly expectedRepetition: 1 | 2 | 3;
  readonly releaseRootSha256: string }): void {
  if ([record.repetition !== input.expectedRepetition,
    record.campaignRootSha256 !== input.campaignRootSha256,
    record.releaseRootSha256 !== input.releaseRootSha256,
    record.model !== FROZEN_ANSWER_EXECUTION.model,
    record.reasoning !== FROZEN_ANSWER_EXECUTION.reasoning,
    record.serviceTier !== FROZEN_ANSWER_EXECUTION.serviceTier,
    typeof record.provider !== "string" || record.provider.trim() === ""].some(Boolean)) {
    throw new Error("spend reservation binding is invalid");
  }
}

function assertSpendLimits(record: Record<string, unknown>, allowedCallKinds: readonly CallKind[],
  maxCallsByKind: Readonly<Record<CallKind, number>>, nowEpochMs: number): void {
  const limits = [record.expiresAtEpochMs, record.maxCalls, record.maximumEffectDurationMs,
    record.maxTokens, record.maxEncryptedBytes];
  if (!Number.isSafeInteger(nowEpochMs) || !limits.every(Number.isSafeInteger) ||
    Number(record.expiresAtEpochMs) <= nowEpochMs || Number(record.maxCalls) < 1 ||
    Number(record.maxTokens) < 1 || Number(record.maximumEffectDurationMs) < 1 ||
    Number(record.maxEncryptedBytes) < 1 ||
    allowedCallKinds.some((kind) => maxCallsByKind[kind] < 1)) {
    throw new Error("spend reservation binding is invalid");
  }
}

export type CallKind = "adjudicator_1" | "adjudicator_2" | "answer" | "capability" |
  "resolver" | "retrieval";
export type TerminalState = "terminal_failure" | "terminal_success" | "outcome_unknown";
export type JournalState = "blocked_evidence" | "never_reserved" | "provider_reserved" | TerminalState;

export interface AttemptIdentity {
  readonly attemptId: string; readonly callKind: CallKind; readonly callOrdinal: number;
  readonly campaignRootSha256: string; readonly questionDigestSha256: string;
  readonly questionId: string; readonly releaseRootSha256: string; readonly repetition: 1 | 2 | 3;
  readonly spendReservationSha256: string;
}

export interface AttemptReservation extends AttemptIdentity {
  readonly requestDigestSha256: string; readonly state: "provider_reserved";
  readonly schemaVersion: "meeting_knowledge.semantic_quality_provider_reservation.v3";
}

/** Consumer-owned durable-attempt seam; filesystem publication belongs to an outbound adapter. */
export interface AttemptJournalPort {
  readonly authorityPolicy: QualityCampaignAuthorityPolicy;
  admit(input: { readonly identity: AttemptIdentity; readonly requestDigestSha256: string;
    readonly requestedEncryptedBytes: number; readonly requestedTokens: number;
    readonly spend: VerifiedSpendReservation }): Promise<{ readonly admitted: boolean;
      readonly reservation?: AttemptReservation; readonly state: JournalState }>;
  blockEvidence(reservation: AttemptReservation): Promise<void>;
  recoveredState(input: { readonly identity: AttemptIdentity;
    readonly release: PinnedReleaseDocument;
    readonly requestDigestSha256: string }): Promise<JournalState>;
  terminal(input: { readonly identity: AttemptIdentity; readonly reservation: AttemptReservation;
    readonly release: PinnedReleaseDocument; readonly requestBytes: Uint8Array;
    readonly resultEnvelopeBytes: Uint8Array; readonly signedResult: unknown;
    readonly state: TerminalState;
    readonly expectedResultDigestSha256: string }): Promise<{ readonly state: TerminalState }>;
}

export function attemptIdentity(input: Omit<AttemptIdentity, "attemptId">): AttemptIdentity {
  digest(input.campaignRootSha256, "campaign root"); digest(input.questionDigestSha256,
    "question digest"); digest(input.releaseRootSha256, "release root");
  digest(input.spendReservationSha256, "spend reservation"); safeId(input.questionId,
    "question ID"); if (!CALL_KINDS.includes(input.callKind) ||
    ![1, 2, 3].includes(input.repetition) ||
    !Number.isSafeInteger(input.callOrdinal) || input.callOrdinal < 0) {
    throw new Error("attempt identity is invalid");
  }
  return Object.freeze({ attemptId: `sqv4-${sha256({ ...input,
    schemaVersion: "meeting_knowledge.semantic_quality_attempt.v2" })}`,
    callKind: input.callKind, callOrdinal: input.callOrdinal,
    campaignRootSha256: input.campaignRootSha256,
    questionDigestSha256: input.questionDigestSha256, questionId: input.questionId,
    releaseRootSha256: input.releaseRootSha256, repetition: input.repetition,
    spendReservationSha256: input.spendReservationSha256 });
}


export interface ProviderExchangePort {
  exchange(input: { readonly attempt: AttemptIdentity; readonly deadlineEpochMs: number;
    readonly request: Uint8Array;
    readonly signal: AbortSignal;
    readonly requestDigestSha256: string }): Promise<{
    readonly effect: "certain_failure" | "certain_success" | "unknown";
    readonly resultEnvelopeBytes?: Uint8Array;
    readonly resultDigestSha256?: string; readonly signedResult?: unknown;
  }>;
}

export interface ProviderEffectReservation {
  readonly requestedEncryptedBytes: number; readonly requestedTokens: number;
}

/** Exactly one call after a durable reservation. Ambiguous retrieval and answer effects are equal. */
export async function executeReservedExchange(input: { readonly campaignRootSha256: string;
  readonly deadlineEpochMs: number;
  readonly effectReservation: ProviderEffectReservation; readonly identity: AttemptIdentity;
  readonly journal: AttemptJournalPort; readonly nowEpochMs: number;
  readonly port: ProviderExchangePort; readonly provider: string;
  readonly release: PinnedReleaseDocument; readonly request: Uint8Array;
  readonly signal: AbortSignal;
  readonly spendReservation: unknown }):
Promise<JournalState> {
  const authorization = verifyEffectAuthorization(input);
  assertAttemptIdentity(input.identity, { campaignRootSha256: input.campaignRootSha256,
    releaseRootSha256: authorization.releaseRootSha256,
    spendReservationSha256: authorization.spendReservationSha256 });
  const requestDigestSha256 = sha256(input.request); const recovered =
    await input.journal.recoveredState({ identity: input.identity,
    release: input.release, requestDigestSha256 });
  if (recovered !== "never_reserved") {return recovered;}
  const refreshed = verifyEffectAuthorization(input);
  const admission = await input.journal.admit({ identity: input.identity,
    requestDigestSha256, requestedEncryptedBytes:
    refreshed.effectReservation.requestedEncryptedBytes,
    requestedTokens: refreshed.effectReservation.requestedTokens, spend: refreshed.spend });
  if (!admission.admitted || admission.reservation === undefined) {return admission.state;}
  const reservation = admission.reservation;
  if (input.signal.aborted) {return "outcome_unknown";}
  const rawResult = await input.port.exchange({ attempt: input.identity,
    deadlineEpochMs: input.deadlineEpochMs, request: input.request,
    requestDigestSha256, signal: input.signal });
  let result: Awaited<ReturnType<ProviderExchangePort["exchange"]>>;
  try {result = decodeProviderExchangeResult(rawResult);}
  catch {await input.journal.blockEvidence(reservation).catch(() => null);
    return "blocked_evidence";}
  if (result.effect === "unknown") {return "outcome_unknown";}
  if (result.signedResult === undefined || result.resultDigestSha256 === undefined) {
    await input.journal.blockEvidence(reservation).catch(() => null);
    return "blocked_evidence";
  }
  if (result.resultEnvelopeBytes === undefined ||
    sha256(result.resultEnvelopeBytes) !== result.resultDigestSha256) {
    await input.journal.blockEvidence(reservation).catch(() => null);
    return "blocked_evidence";
  }
  try {
    return (await input.journal.terminal({ identity: input.identity, reservation,
      expectedResultDigestSha256: result.resultDigestSha256, requestBytes: input.request,
      resultEnvelopeBytes: result.resultEnvelopeBytes, signedResult: result.signedResult,
      release: input.release,
      state: result.effect === "certain_success" ? "terminal_success" : "terminal_failure" })).state;
  } catch {
    await input.journal.blockEvidence(reservation).catch(() => null);
    return "blocked_evidence";
  }
}

function decodeProviderExchangeResult(value: unknown): Awaited<ReturnType<
  ProviderExchangePort["exchange"]>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("provider exchange result is invalid");
  }
  const effect = (value as Record<string, unknown>).effect;
  const keys = effect === "unknown" ? ["effect"] :
    ["effect", "resultDigestSha256", "resultEnvelopeBytes", "signedResult"];
  const record = exactRecord(value, keys, "provider exchange result");
  if (effect === "unknown") {return { effect: "unknown" };}
  if (!["certain_failure", "certain_success"].includes(String(effect))) {
    throw new Error("provider exchange effect is invalid");
  }
  if (!(record.resultEnvelopeBytes instanceof Uint8Array)) {
    throw new Error("provider exchange result envelope bytes are invalid");
  }
  digest(record.resultDigestSha256, "provider result");
  return record as unknown as Awaited<ReturnType<ProviderExchangePort["exchange"]>>;
}

function verifyEffectAuthorization(input: { readonly campaignRootSha256: string;
  readonly deadlineEpochMs: number;
  readonly effectReservation: ProviderEffectReservation; readonly identity: AttemptIdentity;
  readonly nowEpochMs: number; readonly provider: string;
  readonly journal: AttemptJournalPort; readonly release: PinnedReleaseDocument;
  readonly signal: AbortSignal;
  readonly spendReservation: unknown }): { readonly releaseRootSha256: string;
    readonly spendReservationSha256: string; readonly spend: VerifiedSpendReservation;
    readonly effectReservation: ProviderEffectReservation } {
  const release = verifyPinnedReleaseDocument(input.journal.authorityPolicy, input.release);
  const spend = verifySpendReservation(input.journal.authorityPolicy, { campaignRootSha256:
    input.campaignRootSha256,
    expectedRepetition: input.identity.repetition, nowEpochMs: input.nowEpochMs,
    releaseRootSha256: release.releaseRootSha256, reservation: input.spendReservation });
  const reservation = exactRecord(input.effectReservation, ["requestedEncryptedBytes",
    "requestedTokens"], "provider effect reservation");
  const values = Object.values(reservation); if (input.provider !== spend.payload.provider ||
    !spend.payload.allowedCallKinds.includes(input.identity.callKind) ||
    spend.payload.maxCallsByKind[input.identity.callKind] < 1 ||
    values.some((value) => !Number.isSafeInteger(value) || Number(value) < 0) ||
    Number(reservation.requestedTokens) < 1 ||
    input.signal.aborted || !Number.isSafeInteger(input.deadlineEpochMs) ||
    input.deadlineEpochMs <= input.nowEpochMs ||
    input.deadlineEpochMs > spend.payload.expiresAtEpochMs ||
    input.deadlineEpochMs - input.nowEpochMs > spend.payload.maximumEffectDurationMs ||
    Number(reservation.requestedTokens) > spend.payload.maxTokens ||
    Number(reservation.requestedEncryptedBytes) > spend.payload.maxEncryptedBytes) {
    throw new Error("provider effect exceeds its exact signed spend reservation");
  }
  return { releaseRootSha256: release.releaseRootSha256,
    spendReservationSha256: spend.spendReservationSha256, spend,
    effectReservation: reservation as unknown as ProviderEffectReservation };
}

export function verifyExternalSignedValue<T>(value: unknown, keyId: string,
  publicKeyPem: string, label: string):
SignedValue<T> {
  const record = exactRecord(value, ["payload", "signatureBase64", "signerKeyId"], label);
  if (record.signerKeyId !== keyId || typeof record.signatureBase64 !== "string") {
    throw new Error(`${label} signer is invalid`);
  }
  let valid = false;
  try {valid = verify(null, Buffer.from(canonicalJson(record.payload)), createPublicKey(publicKeyPem),
    Buffer.from(record.signatureBase64, "base64"));} catch {valid = false;}
  if (!valid) {throw new Error(`${label} signature is invalid`);}
  return Object.freeze(record as unknown as SignedValue<T>);
}


export const CALL_KINDS: readonly CallKind[] = ["adjudicator_1", "adjudicator_2", "answer", "capability", "resolver", "retrieval"];

function decodeAllowedCallKinds(value: unknown): readonly CallKind[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((kind) =>
    !CALL_KINDS.includes(kind as CallKind)) || new Set(value).size !== value.length) {
    throw new Error("spend reservation call kinds are invalid");
  }
  return Object.freeze(value as CallKind[]);
}

function decodeCallKindCeilings(value: unknown): Readonly<Record<CallKind, number>> {
  const record = exactRecord(value, CALL_KINDS, "spend reservation call-kind ceilings");
  if (Object.values(record).some((count) => !Number.isSafeInteger(count) || Number(count) < 0)) {
    throw new Error("spend reservation call-kind ceilings are invalid");
  }
  return Object.freeze(record as unknown as Record<CallKind, number>);
}

export function assertAttemptIdentity(identity: AttemptIdentity, binding?: {
  readonly campaignRootSha256: string; readonly releaseRootSha256: string;
  readonly spendReservationSha256: string }): void {
  const reconstructed = attemptIdentity({ callKind: identity.callKind,
    callOrdinal: identity.callOrdinal, campaignRootSha256: identity.campaignRootSha256,
    questionDigestSha256: identity.questionDigestSha256, questionId: identity.questionId,
    releaseRootSha256: identity.releaseRootSha256, repetition: identity.repetition,
    spendReservationSha256: identity.spendReservationSha256 });
  if (canonicalJson(identity) !== canonicalJson(reconstructed) || binding !== undefined &&
    (identity.campaignRootSha256 !== binding.campaignRootSha256 ||
      identity.releaseRootSha256 !== binding.releaseRootSha256 ||
      identity.spendReservationSha256 !== binding.spendReservationSha256)) {
    throw new Error("attempt identity does not reconstruct from the exact campaign binding");
  }
}
