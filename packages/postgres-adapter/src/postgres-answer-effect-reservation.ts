import type { AnswerEffectReservationInput } from "@discord-meeting/meeting-core/publishing";
import { createHash } from "node:crypto";

interface StoredAnswerEffect {
  readonly authority_scope_id: string | null;
  readonly authorization_digest: string;
  readonly binding_hash: string;
  readonly delivery_container_id: string | null;
  readonly effect_id: string;
  readonly marker: string;
  readonly payload_bytes: string;
  readonly payload_hash: string;
  readonly projection_target_container_id: string;
  readonly reply_to_remote_message_id: string;
  readonly source_meeting_ids: readonly string[];
  readonly state: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}

function legacyPayloadUpgradesTo(
  row: StoredAnswerEffect,
  input: AnswerEffectReservationInput,
): boolean {
  if (row.state !== "reserved" && row.state !== "claimed") {
    return false;
  }
  try {
    const payload = JSON.parse(row.payload_bytes) as Record<string, unknown>;
    const reference = payload.message_reference;
    if (reference === null || typeof reference !== "object" || Array.isArray(reference)) {
      return false;
    }
    const upgraded = {
      ...payload,
      message_reference: {
        ...(reference as Record<string, unknown>),
        channel_id: input.deliveryContainerId,
      },
    };
    return (reference as Record<string, unknown>).channel_id ===
        row.projection_target_container_id &&
      sha256(row.payload_bytes) === row.payload_hash &&
      JSON.stringify(canonicalValue(upgraded)) === input.payloadBytes &&
      sha256(input.payloadBytes) === input.payloadHash;
  } catch {
    return false;
  }
}

function bindingMatches(
  row: StoredAnswerEffect,
  input: AnswerEffectReservationInput,
): boolean {
  return row.binding_hash === input.bindingHash ||
    input.legacyBindingHash !== undefined && row.binding_hash === input.legacyBindingHash;
}

function sourceMeetingsMatch(
  row: StoredAnswerEffect,
  input: AnswerEffectReservationInput,
): boolean {
  return row.source_meeting_ids.length === input.sourceMeetingIds.length &&
    row.source_meeting_ids.every((value, index) => value === input.sourceMeetingIds[index]);
}

export function answerEffectFieldsMatch(
  row: StoredAnswerEffect,
  input: AnswerEffectReservationInput,
): boolean {
  const payloadMatches = row.payload_bytes === input.payloadBytes ||
    row.payload_bytes === "{}" && ["cancelled", "retracted"]
      .includes(row.state);
  return row.effect_id === input.effectId &&
    row.authority_scope_id === input.authorityScopeId &&
    row.delivery_container_id === input.deliveryContainerId &&
    row.projection_target_container_id === input.projectionTargetContainerId &&
    row.reply_to_remote_message_id === input.replyToRemoteMessageId &&
    sourceMeetingsMatch(row, input) && row.marker === input.marker &&
    payloadMatches && row.payload_hash === input.payloadHash &&
    bindingMatches(row, input) &&
    row.authorization_digest === input.authorizationDigest;
}

export function legacyAnswerEffectFieldsMatch(
  row: StoredAnswerEffect,
  input: AnswerEffectReservationInput,
): boolean {
  return row.effect_id === input.effectId &&
    row.authority_scope_id === input.authorityScopeId &&
    row.delivery_container_id === input.deliveryContainerId &&
    row.projection_target_container_id === input.projectionTargetContainerId &&
    row.reply_to_remote_message_id === input.replyToRemoteMessageId &&
    sourceMeetingsMatch(row, input) && row.marker === input.marker &&
    bindingMatches(row, input) &&
    row.authorization_digest === input.authorizationDigest &&
    legacyPayloadUpgradesTo(row, input);
}
