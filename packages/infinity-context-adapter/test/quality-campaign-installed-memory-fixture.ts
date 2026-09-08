import { admitAcceptedFinalMeeting, buildHistoricalIndexPlan,
  createHistoricalReleaseBinding } from "@discord-meeting/meeting-core/meeting-knowledge";
import { Meeting } from "@discord-meeting/meeting-core/meeting-lifecycle";
import { FinalTranscript } from "@discord-meeting/meeting-core/transcription";

import { HmacHistoricalOpaqueIds } from "../src/hmac-historical-ids.js";

export const ACTOR_KEY_PROFILE = "discord-infinity-actor-key.v1:synthetic-active";

export function canonicalMemoryFixture() {
  const selectedText = "The launch proposal was approved by the review group.";
  const unselectedText = "UNSELECTED-OMEGA must never enter the grounded answer prompt.";
  const meeting = Meeting.record({ actors: [{ actorId: "speaker-a", kind: "human" },
    { actorId: "speaker-b", kind: "human" }], identityProvenance: {
    actorObservationState: "consistent", actorSemanticsVersion: 1,
    producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
    producerRevision: "0123456789abcdef0123456789abcdef01234567", rosterState: "sealed" },
  lifecycleGeneration: 3, meetingId: "packed-historical-meeting",
  publicationTargetId: "packed-publication", recording: { manifestLocator:
    "s3://synthetic/packed-historical-meeting/manifest.json",
  recordingId: "packed-recording", speakerAudio: [{ audioLocator: "s3://synthetic/a.flac",
    speakerId: "speaker-a", timelineOffsetMs: 0 }, { audioLocator: "s3://synthetic/b.flac",
    speakerId: "speaker-b", timelineOffsetMs: 0 }] }, source: { roomId: "packed-room",
    scopeId: "packed-scope" } });
  meeting.beginTranscription();
  const turns = Array.from({ length: 100 }, (_, index) => ({ endMs: index * 10_000 + 2_000,
    speakerId: index % 2 === 0 ? "speaker-a" : "speaker-b", startMs: index * 10_000,
    text: index === 0 ? selectedText : index === 99 ? unselectedText :
      `Synthetic canonical planning turn ${index}.`, turnId: `packed-turn-${index}` }));
  const transcript = FinalTranscript.create({ recordingId: meeting.recording.recordingId,
    transcriptId: "packed-transcript", turns, version: 1 });
  meeting.completeTranscription(transcript);
  const snapshot = meeting.toSnapshot();
  const binding = createHistoricalReleaseBinding({ acceptedMeetingRevision: snapshot.revision,
    desiredGeneration: 1, meetingId: snapshot.meetingId, roomId: snapshot.source!.roomId,
    scopeId: snapshot.source!.scopeId, transcriptId: transcript.transcriptId,
    transcriptVersion: transcript.version });
  const accepted = admitAcceptedFinalMeeting({ actors: snapshot.actors,
    authoritativeDurationMs: snapshot.recording.authoritativeDurationMs ?? null, binding,
    identityProvenance: snapshot.identityProvenance,
    lifecycleGeneration: snapshot.lifecycleGeneration, meetingRevision: snapshot.revision,
    roomId: snapshot.source!.roomId, scopeId: snapshot.source!.scopeId,
    transcriptId: transcript.transcriptId, transcriptVersion: transcript.version, turns });
  if (accepted === null) {throw new Error("packed historical meeting admission failed");}
  const plan = buildHistoricalIndexPlan(accepted,
    new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(7), ACTOR_KEY_PROFILE));
  if (plan.documents.length < 2 || plan.documents[0]!.manifest.turnSources.some(
    ({ turnId }) => turnId === "packed-turn-99")) {
    throw new Error("packed historical fixture did not create selected and unselected blocks");
  }
  const selectedTurnId = "packed-turn-0";
  return { binding, plan, row: { accepted_meeting_revision: binding.acceptedMeetingRevision,
    applied_index_profile_id: "packed-profile", attempt_count: 1,
    desired_generation: binding.desiredGeneration,
    evidence_policy_version: binding.evidencePolicyVersion, lease_fence: 1,
    meeting_id: binding.meetingId, operation: "index", plan,
    profile_rebuild_requested: false, release_id: binding.releaseId,
    remote_document_ids: {}, room_id: binding.roomId, schema_version: binding.schemaVersion,
    scope_id: binding.scopeId, transcript_id: binding.transcriptId,
    transcript_version: binding.transcriptVersion }, selectedLocator:
    plan.documents[0]!.manifest.candidateLocator, selectedText, selectedTurnId, snapshot,
  unselectedText };
}

