import {
  selectHistoricalHumanTurns, normalizeHistoricalActors,
  validateHistoricalReleaseBinding,
  type AcceptedFinalMeetingV1, type HistoricalActorV1,
  type HistoricalReleaseBindingV1, type HistoricalTranscriptTurnV1,
} from "./historical-evidence.js";

export const LEGACY_HISTORICAL_SIGNING_CONTEXT = "meeting-knowledge.signed-legacy.v1\n";
export interface LegacyHistoricalPayloadV1 {
  readonly admission: "signed_legacy_v1";
  readonly policyVersion: 1;
  readonly policyId: string;
  readonly signerId: string;
  readonly binding: HistoricalReleaseBindingV1;
  readonly recordingId: string;
  readonly snapshotSha256: string;
  readonly transcriptSha256: string;
  readonly savedSourceSha256: string;
  readonly identityEvidenceSha256: string;
  readonly scopeRoomEvidenceSha256: string;
  readonly durationEvidenceSha256: string;
  readonly authoritativeDurationMs: number;
  readonly actors: readonly HistoricalActorV1[];
}

export interface SignedLegacyHistoricalReceiptV1 {
  readonly payload: LegacyHistoricalPayloadV1;
  readonly signature: string;
}

/** Canonical JSON v1: sorted UTF-16 object keys; exact array order; JSON primitives. */
export function legacyHistoricalCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) { return JSON.stringify(value); }
  if (Array.isArray(value)) { return `[${value.map(legacyHistoricalCanonicalJson).join(",")}]`; }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).toSorted().map((key) =>
      `${JSON.stringify(key)}:${legacyHistoricalCanonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("legacy canonical JSON contains an unsupported value");
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).toSorted().join("|") !== [...keys].toSorted().join("|")) {
    throw new Error("legacy admission contract has missing or unknown fields");
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 ||
    value.trim() !== value) {
    throw new Error("legacy admission identifier is invalid");
  }
  for (const character of value) {
    if (character.charCodeAt(0) < 32) { throw new Error("legacy admission identifier is invalid"); }
  }
}

function supportedPolicy(admission: unknown, policyVersion: unknown): boolean {
  return admission === "signed_legacy_v1" && policyVersion === 1;
}

/** Decodes without granting signature authority. No implicit normalization of signed fields. */
export function decodeSignedLegacyHistoricalReceipt(value: unknown): SignedLegacyHistoricalReceiptV1 {
  const receipt = closed(value, ["payload", "signature"]);
  const payload = closed(receipt.payload, ["admission", "policyVersion", "policyId", "signerId",
    "binding", "recordingId", "snapshotSha256", "transcriptSha256", "savedSourceSha256",
    "identityEvidenceSha256", "scopeRoomEvidenceSha256", "durationEvidenceSha256",
    "authoritativeDurationMs", "actors"]);
  if (!supportedPolicy(payload.admission, payload.policyVersion)) {
    throw new Error("legacy admission policy version is unsupported");
  }
  for (const field of ["policyId", "signerId", "recordingId"]) { identifier(payload[field]); }
  for (const field of ["snapshotSha256", "transcriptSha256", "savedSourceSha256",
    "identityEvidenceSha256", "scopeRoomEvidenceSha256", "durationEvidenceSha256"]) {
    if (typeof payload[field] !== "string" || !/^[a-f0-9]{64}$/u.test(payload[field])) {
      throw new Error("legacy admission evidence digest is invalid");
    }
  }
  const binding = closed(payload.binding, ["acceptedMeetingRevision", "desiredGeneration",
    "evidencePolicyVersion", "meetingId", "releaseId", "roomId", "schemaVersion", "scopeId",
    "transcriptId", "transcriptVersion"]);
  for (const field of ["meetingId", "roomId", "scopeId", "transcriptId"]) { identifier(binding[field]); }
  const validated = validateHistoricalReleaseBinding(binding as unknown as HistoricalReleaseBindingV1);
  if (legacyHistoricalCanonicalJson(validated) !== legacyHistoricalCanonicalJson(binding)) {
    throw new Error("legacy admission release is not exact");
  }
  if (!Array.isArray(payload.actors) || payload.actors.length === 0 || payload.actors.length > 1_000) {
    throw new Error("legacy admission roster is invalid");
  }
  for (const candidate of payload.actors) {
    const actor = closed(candidate, ["actorId", "kind"]);
    identifier(actor.actorId);
    if (actor.kind !== "human" && actor.kind !== "automation") {
      throw new Error("legacy admission requires evidenced explicit actor kinds");
    }
  }
  normalizeHistoricalActors(payload.actors as HistoricalActorV1[]);
  if (!Number.isSafeInteger(payload.authoritativeDurationMs) ||
    (payload.authoritativeDurationMs as number) <= 0) {
    throw new Error("legacy admission duration is invalid");
  }
  if (typeof receipt.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/u.test(receipt.signature)) {
    throw new Error("legacy admission requires an Ed25519 signature");
  }
  // A detached, deeply frozen JSON value prevents caller mutation across adapter awaits.
  const detached = JSON.parse(legacyHistoricalCanonicalJson(receipt)) as SignedLegacyHistoricalReceiptV1;
  for (const actor of detached.payload.actors) { Object.freeze(actor); }
  Object.freeze(detached.payload.actors); Object.freeze(detached.payload.binding);
  Object.freeze(detached.payload);
  return Object.freeze(detached);
}

/** Caller supplies verified boundary data; crypto and durable current-source checks are adapters. */
export function admitLegacyAcceptedFinalMeeting(input: {
  readonly verifiedPayload: LegacyHistoricalPayloadV1;
  readonly turns: readonly HistoricalTranscriptTurnV1[];
}): AcceptedFinalMeetingV1 | null {
  const payload = input.verifiedPayload;
  const actors = normalizeHistoricalActors(payload.actors);
  const roster = new Set(actors.map(({ actorId }) => actorId));
  if (!supportedPolicy(payload.admission, payload.policyVersion) ||
    actors.some(({ kind }) => kind === "unknown") ||
    !Number.isSafeInteger(payload.authoritativeDurationMs) || payload.authoritativeDurationMs <= 0 ||
    input.turns.some((turn) => !roster.has(turn.speakerId) || turn.endMs > payload.authoritativeDurationMs)) {
    throw new Error("legacy transcript lacks complete identity or duration authority");
  }
  const humanTurns = selectHistoricalHumanTurns(input.turns,
    new Set(actors.filter(({ kind }) => kind === "human").map(({ actorId }) => actorId)));
  if (humanTurns.length === 0) { return null; }
  return Object.freeze({ admission: "signed_legacy_v1", authoritativeDurationMs:
    payload.authoritativeDurationMs, binding: validateHistoricalReleaseBinding(payload.binding),
    humanTurns, schemaVersion: 1 });
}
