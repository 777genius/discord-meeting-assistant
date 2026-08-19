import type { MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";

function sameRecording(
  left: MeetingSnapshot["recording"],
  right: MeetingSnapshot["recording"],
): boolean {
  return left.recordingId === right.recordingId &&
    left.manifestLocator === right.manifestLocator &&
    left.speakerAudio.length === right.speakerAudio.length &&
    left.speakerAudio.every((track, index) => {
      const candidate = right.speakerAudio[index];
      return candidate !== undefined &&
        track.audioLocator === candidate.audioLocator &&
        track.speakerId === candidate.speakerId &&
        track.timelineOffsetMs === candidate.timelineOffsetMs;
    });
}

function sameSource(
  left: MeetingSnapshot["source"],
  right: MeetingSnapshot["source"],
): boolean {
  return left === null || right === null
    ? left === right
    : left.roomId === right.roomId && left.scopeId === right.scopeId;
}

function sameActors(
  left: MeetingSnapshot["actors"],
  right: MeetingSnapshot["actors"],
): boolean {
  return left === null || right === null
    ? left === right
    : left.length === right.length && left.every((actor, index) => {
        const candidate = right[index];
        return candidate !== undefined &&
          actor.actorId === candidate.actorId &&
          actor.kind === candidate.kind;
      });
}

function sameLifecycleIdentity(
  left: Pick<MeetingSnapshot, "identityProvenance" | "lifecycleGeneration">,
  right: Pick<MeetingSnapshot, "identityProvenance" | "lifecycleGeneration">,
): boolean {
  const preGenerationLegacyReplay = left.lifecycleGeneration === null &&
    left.identityProvenance === null &&
    right.identityProvenance === null &&
    (right.lifecycleGeneration === 1 || right.lifecycleGeneration === 2);
  return preGenerationLegacyReplay ||
    (left.lifecycleGeneration === right.lifecycleGeneration &&
      JSON.stringify(left.identityProvenance) === JSON.stringify(right.identityProvenance));
}

export function sameRecordedMeetingIdentity(
  left: MeetingSnapshot,
  right: MeetingSnapshot,
): boolean {
  return left.publicationTargetId === right.publicationTargetId &&
    sameRecording(left.recording, right.recording) &&
    sameSource(left.source, right.source) &&
    sameActors(left.actors, right.actors) &&
    sameLifecycleIdentity(left, right);
}
