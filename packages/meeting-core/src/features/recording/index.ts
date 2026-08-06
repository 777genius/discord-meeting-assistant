export { DomainInvariantError as RecordingInvariantError } from "./domain/errors.js";
export {
  createRecordingId,
  createSpeakerId,
  type RecordingId,
  type SpeakerId,
} from "./domain/identifiers.js";
export {
  RecordingArtifact,
  type RecordingArtifactSnapshot,
  type SpeakerAudioReference,
  type SpeakerAudioReferenceSnapshot,
} from "./domain/recording.js";
