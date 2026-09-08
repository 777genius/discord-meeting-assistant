import { createHash } from "node:crypto";
import { admitAcceptedFinalMeeting, admitLegacyAcceptedFinalMeeting,
  legacyHistoricalCanonicalJson, type AcceptedFinalMeetingV1,
  type HistoricalReleaseBindingV1, type LegacyHistoricalPayloadV1, type LegacyHistoricalReceiptVerifierPort } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { Meeting, type MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";

export function legacyHistoricalSha256(value: unknown): string {
  return createHash("sha256").update(legacyHistoricalCanonicalJson(value), "utf8").digest("hex");
}

/** Read-only resolver. Callers establish current release/withdrawal in the same DB snapshot. */
export function resolveAcceptedHistoricalMeeting(input: {
  readonly binding: HistoricalReleaseBindingV1;
  readonly revision: number;
  readonly snapshot: unknown;
  readonly receipt?: unknown;
  readonly verifier?: LegacyHistoricalReceiptVerifierPort;
}): AcceptedFinalMeetingV1 | null {
  try {
    const { binding } = input;
    const snapshot = Meeting.restore(input.snapshot as MeetingSnapshot).toSnapshot();
    if (snapshot.revision !== input.revision || snapshot.meetingId !== binding.meetingId ||
      snapshot.transcriptionStage.status !== "succeeded") { return null; }
    if (input.receipt === undefined || input.receipt === null) {
      return resolveLifecycleMeeting(snapshot, binding);
    }
    if (input.verifier === undefined || snapshot.identityProvenance !== null ||
      (snapshot.lifecycleGeneration ?? 0) >= 3) { return null; }
    const { payload } = input.verifier.verify(input.receipt);
    if (legacyHistoricalCanonicalJson(payload.binding) !== legacyHistoricalCanonicalJson(binding) ||
      snapshot.revision !== binding.acceptedMeetingRevision ||
      payload.snapshotSha256 !== legacyHistoricalSha256(input.snapshot) ||
      payload.transcriptSha256 !== legacyHistoricalSha256((input.snapshot as MeetingSnapshot).transcript) ||
      snapshot.recording.recordingId !== payload.recordingId ||
      snapshot.transcript?.transcriptId !== binding.transcriptId ||
      snapshot.transcript.version !== binding.transcriptVersion ||
      !legacyIdentityAgrees(snapshot, payload)) { return null; }
    return admitLegacyAcceptedFinalMeeting({ verifiedPayload: payload, turns: snapshot.transcript.turns });
  } catch { return null; }
}

function resolveLifecycleMeeting(snapshot: MeetingSnapshot, binding: HistoricalReleaseBindingV1) {
  return admitAcceptedFinalMeeting({ actors: snapshot.actors,
    authoritativeDurationMs: snapshot.recording.authoritativeDurationMs ?? null,
    binding, identityProvenance: snapshot.identityProvenance,
    lifecycleGeneration: snapshot.lifecycleGeneration, meetingRevision: snapshot.revision,
    roomId: snapshot.source?.roomId ?? null, scopeId: snapshot.source?.scopeId ?? null,
    transcriptId: snapshot.transcript?.transcriptId ?? null,
    transcriptVersion: snapshot.transcript?.version ?? null, turns: snapshot.transcript?.turns ?? null });
}

function sortedActors(actors: readonly { readonly actorId: string; readonly kind: string }[]) {
  return actors.toSorted((a, b) => a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0);
}

function legacyIdentityAgrees(snapshot: MeetingSnapshot, payload: LegacyHistoricalPayloadV1): boolean {
  if (snapshot.source !== null && (snapshot.source.scopeId !== payload.binding.scopeId ||
    snapshot.source.roomId !== payload.binding.roomId)) { return false; }
  if (snapshot.recording.authoritativeDurationMs !== undefined &&
    snapshot.recording.authoritativeDurationMs !== payload.authoritativeDurationMs) { return false; }
  return snapshot.actors === null || legacyHistoricalCanonicalJson(sortedActors(snapshot.actors)) ===
    legacyHistoricalCanonicalJson(sortedActors(payload.actors));
}
