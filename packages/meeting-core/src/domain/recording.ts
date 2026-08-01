import {
  DomainInvariantError,
  requireNonEmpty,
  requireNonNegativeInteger,
} from "./errors.js";
import {
  createRecordingId,
  createSpeakerId,
  type RecordingId,
  type SpeakerId,
} from "./identifiers.js";

export interface SpeakerAudioReferenceSnapshot {
  readonly audioLocator: string;
  readonly speakerId: string;
  readonly timelineOffsetMs: number;
}

export interface RecordingArtifactSnapshot {
  readonly manifestLocator: string;
  readonly recordingId: string;
  readonly speakerAudio: readonly SpeakerAudioReferenceSnapshot[];
}

export interface SpeakerAudioReference {
  readonly audioLocator: string;
  readonly speakerId: SpeakerId;
  readonly timelineOffsetMs: number;
}

export class RecordingArtifact {
  public readonly recordingId: RecordingId;
  public readonly manifestLocator: string;
  public readonly speakerAudio: readonly SpeakerAudioReference[];

  private constructor(snapshot: RecordingArtifactSnapshot) {
    this.recordingId = createRecordingId(snapshot.recordingId);
    this.manifestLocator = requireNonEmpty(
      snapshot.manifestLocator,
      "recording.manifestLocator",
    );

    const references = snapshot.speakerAudio.map((reference) =>
      Object.freeze({
        audioLocator: requireNonEmpty(
          reference.audioLocator,
          "recording.speakerAudio.audioLocator",
        ),
        speakerId: createSpeakerId(reference.speakerId),
        timelineOffsetMs: requireNonNegativeInteger(
          reference.timelineOffsetMs,
          "recording.speakerAudio.timelineOffsetMs",
        ),
      }),
    );

    const locators = new Set(references.map(({ audioLocator }) => audioLocator));
    if (locators.size !== references.length) {
      throw new DomainInvariantError(
        "DUPLICATE_IDENTIFIER",
        "recording speaker audio locators must be unique",
      );
    }

    this.speakerAudio = Object.freeze(references);
  }

  public static create(snapshot: RecordingArtifactSnapshot): RecordingArtifact {
    return new RecordingArtifact(snapshot);
  }

  public toSnapshot(): RecordingArtifactSnapshot {
    return {
      manifestLocator: this.manifestLocator,
      recordingId: this.recordingId,
      speakerAudio: this.speakerAudio.map((reference) => ({
        audioLocator: reference.audioLocator,
        speakerId: reference.speakerId,
        timelineOffsetMs: reference.timelineOffsetMs,
      })),
    };
  }

  public equals(other: RecordingArtifact): boolean {
    if (
      this.recordingId !== other.recordingId ||
      this.manifestLocator !== other.manifestLocator ||
      this.speakerAudio.length !== other.speakerAudio.length
    ) {
      return false;
    }

    return this.speakerAudio.every((reference, index) => {
      const candidate = other.speakerAudio[index];
      return (
        candidate !== undefined &&
        reference.audioLocator === candidate.audioLocator &&
        reference.speakerId === candidate.speakerId &&
        reference.timelineOffsetMs === candidate.timelineOffsetMs
      );
    });
  }
}
