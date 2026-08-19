import type {
  LiveMeetingLifecycleEvent,
  LiveMeetingParticipantEvent,
  LiveMeetingRuntimeDependencies,
  LiveMeetingStartedEvent,
} from "./contracts.js";

type AuthoritativeReadyEvent = Extract<
  LiveMeetingLifecycleEvent,
  { readonly type: "recording.authoritative_ready" }
>;

export async function registerFinalizedMemory(
  dependencies: LiveMeetingRuntimeDependencies,
  event: LiveMeetingStartedEvent,
): Promise<void> {
  const identity = event.memoryIdentity;
  if (identity === undefined) {
    return;
  }
  await dependencies.finalizedMemory?.registerMeeting({
    actors: identity.actors,
    identityProvenance: identity.identityProvenance,
    lifecycleGeneration: identity.lifecycleGeneration,
    meetingId: event.recordingId,
    roomId: identity.roomId,
    scopeId: identity.scopeId,
  });
  await dependencies.finalizedMemory?.synchronizeMeeting(event.recordingId);
}

export async function sealFinalizedMemory(
  dependencies: LiveMeetingRuntimeDependencies,
  event: AuthoritativeReadyEvent,
): Promise<void> {
  const identity = event.memoryIdentity;
  if (identity === undefined) {
    return;
  }
  await dependencies.finalizedMemory?.sealMeeting({
    actors: identity.actors,
    identityProvenance: identity.identityProvenance,
    lifecycleGeneration: identity.lifecycleGeneration,
    meetingId: event.recordingId,
    roomId: identity.roomId,
    scopeId: identity.scopeId,
  });
  await dependencies.finalizedMemory?.synchronizeMeeting(event.recordingId);
}

export async function observeFinalizedHuman(
  dependencies: LiveMeetingRuntimeDependencies,
  event: LiveMeetingParticipantEvent,
): Promise<void> {
  if (event.memoryHumanObservation === undefined) {
    return;
  }
  const observation = {
    actorId: event.memoryHumanObservation.actorId,
    meetingId: event.recordingId,
    producerRevision: event.memoryHumanObservation.producerRevision,
  };
  if (event.type === "participant.joined") {
    await dependencies.finalizedMemory?.observeHuman(observation);
  } else {
    await dependencies.finalizedMemory?.removeHuman(observation);
  }
}
