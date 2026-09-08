import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createHistoricalReleaseBinding, LEGACY_HISTORICAL_SIGNING_CONTEXT,
  legacyHistoricalCanonicalJson, type LegacyHistoricalPayloadV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { evidenceBackedMeeting } from "./postgres-integration-fixtures.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function legacyFixture(meetingId = "legacy-meeting") {
  const canonical = legacyHistoricalCanonicalJson;
  const snapshot = { ...evidenceBackedMeeting(meetingId, "synthetic-target").toSnapshot(),
    actors: null, source: null, identityProvenance: null, lifecycleGeneration: null };
  const savedSourceJson = canonical(snapshot.transcript);
  const binding = createHistoricalReleaseBinding({ acceptedMeetingRevision: snapshot.revision,
    desiredGeneration: 1, meetingId: snapshot.meetingId, roomId: "synthetic-room", scopeId: "synthetic-scope",
    transcriptId: snapshot.transcript!.transcriptId, transcriptVersion: snapshot.transcript!.version });
  const keys = generateKeyPairSync("ed25519");
  const payload: LegacyHistoricalPayloadV1 = { admission: "signed_legacy_v1", policyVersion: 1,
    policyId: "synthetic-legacy-policy", signerId: "synthetic-operator", binding,
    recordingId: snapshot.recording.recordingId, snapshotSha256: sha(canonical(snapshot)),
    transcriptSha256: sha(savedSourceJson), savedSourceSha256: sha(savedSourceJson),
    identityEvidenceSha256: sha("synthetic identity evidence"),
    scopeRoomEvidenceSha256: sha("synthetic source evidence"),
    durationEvidenceSha256: sha("synthetic recording duration evidence"), authoritativeDurationMs: 10_000,
    actors: [...new Set(snapshot.transcript!.turns.map((turn) => turn.speakerId))]
      .map((actorId) => ({ actorId, kind: "human" as const })) };
  const signed = (candidate: LegacyHistoricalPayloadV1 = payload) => ({ payload: candidate,
    signature: sign(null, Buffer.from(LEGACY_HISTORICAL_SIGNING_CONTEXT + canonical(candidate)),
      keys.privateKey).toString("base64") });
  const trust = [{ policyId: payload.policyId, signerId: payload.signerId,
    publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }];
  return { binding, canonical, payload, savedSourceJson, sha, signed, snapshot, trust };
}
