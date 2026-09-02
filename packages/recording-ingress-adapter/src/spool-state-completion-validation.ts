import { RecordingIngressError } from "./errors.js";
import type { StoredActor, StoredAuthoritativeTrack } from "./spool-state.js";

export function assertTrackActors(actors: readonly StoredActor[] | null, speakerAudio: readonly { readonly speakerId: string }[]): void {
  if (actors === null) return;
  const actorIds = new Set(actors.map((actor) => actor.actorId));
  if (speakerAudio.some((track) => !actorIds.has(track.speakerId))) throw new RecordingIngressError("corrupt-spool", "completion receipt has a track without authoritative actor identity");
}

export function assertCompletedTrackIdentity(tracks: readonly StoredAuthoritativeTrack[], speakerAudio: readonly { readonly artifactRevision?: string; readonly audioLocator: string; readonly checksumSha256?: string; readonly sizeBytes?: number; readonly speakerId: string; readonly timelineOffsetMs: number }[]): void {
  if (tracks.length !== speakerAudio.length) throw new RecordingIngressError("corrupt-spool", "completion receipt track identity does not match the recording snapshot");
  const referencesBySpeaker = new Map<string, (typeof speakerAudio)[number]>();
  const uploadIds = new Set<string>(); const trackNumbers = new Set<number>();
  for (const reference of speakerAudio) {
    if (referencesBySpeaker.has(reference.speakerId)) throw new RecordingIngressError("corrupt-spool", "completion receipt repeats a speaker");
    referencesBySpeaker.set(reference.speakerId, reference);
  }
  for (const track of tracks) {
    if (uploadIds.has(track.uploadId) || trackNumbers.has(track.trackNumber)) throw new RecordingIngressError("corrupt-spool", "completion receipt repeats a track identity");
    uploadIds.add(track.uploadId); trackNumbers.add(track.trackNumber);
    const reference = referencesBySpeaker.get(track.speakerId);
    if (reference === undefined || reference.audioLocator !== track.audioLocator || reference.timelineOffsetMs !== track.timelineOffsetMs || (reference.artifactRevision !== undefined && track.artifactVersionId !== null && reference.artifactRevision !== track.artifactVersionId) || (reference.checksumSha256 !== undefined && reference.checksumSha256 !== track.checksumSha256) || (reference.sizeBytes !== undefined && reference.sizeBytes !== track.sizeBytes)) throw new RecordingIngressError("corrupt-spool", "completion receipt track identity does not match the recording snapshot");
  }
}
