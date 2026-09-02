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
  /** Opaque storage-provider identity for this immutable object version. */
  readonly artifactRevision?: string;
  readonly audioLocator: string;
  readonly checksumSha256?: string;
  readonly sizeBytes?: number;
  readonly speakerId: string;
  readonly timelineOffsetMs: number;
}

export interface RecordingArtifactSnapshot {
  /**
   * Duration derived from the authoritative recording lifecycle, when the
   * producer can prove it. Legacy snapshots legitimately omit this field.
   */
  readonly authoritativeDurationMs?: number;
  readonly manifestLocator: string;
  readonly recordingId: string;
  readonly speakerAudio: readonly SpeakerAudioReferenceSnapshot[];
}

export interface SpeakerAudioReference {
  readonly artifactRevision?: string;
  readonly audioLocator: string;
  readonly checksumSha256?: string;
  readonly sizeBytes?: number;
  readonly speakerId: SpeakerId;
  readonly timelineOffsetMs: number;
}

function immutableIdentity(
  reference: SpeakerAudioReferenceSnapshot,
): Pick<SpeakerAudioReference, "artifactRevision" | "checksumSha256" | "sizeBytes"> {
  const values = [reference.artifactRevision, reference.checksumSha256, reference.sizeBytes];
  const present = values.filter((value) => value !== undefined).length;
  if (present === 0) return {};
  if (present !== values.length) {
    throw new DomainInvariantError(
      "INVALID_NUMBER",
      "recording speaker audio immutable identity must be complete",
    );
  }
  const artifactRevision = requireNonEmpty(
    reference.artifactRevision as string,
    "recording.speakerAudio.artifactRevision",
  );
  const checksumSha256 = requireNonEmpty(
    reference.checksumSha256 as string,
    "recording.speakerAudio.checksumSha256",
  );
  const sizeBytes = reference.sizeBytes as number;
  if (
    artifactRevision === "null" ||
    /[\u0000-\u001f\u007f]/u.test(artifactRevision) ||
    !/^[0-9a-f]{64}$/u.test(checksumSha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0
  ) {
    throw new DomainInvariantError(
      "INVALID_NUMBER",
      "recording speaker audio immutable identity is invalid",
    );
  }
  return { artifactRevision, checksumSha256, sizeBytes };
}

export class RecordingArtifact {
  public readonly authoritativeDurationMs: number | undefined;
  public readonly recordingId: RecordingId;
  public readonly manifestLocator: string;
  public readonly speakerAudio: readonly SpeakerAudioReference[];

  private constructor(snapshot: RecordingArtifactSnapshot) {
    this.authoritativeDurationMs = snapshot.authoritativeDurationMs === undefined
      ? undefined
      : requireNonNegativeInteger(
          snapshot.authoritativeDurationMs,
          "recording.authoritativeDurationMs",
        );
    this.recordingId = createRecordingId(snapshot.recordingId);
    this.manifestLocator = requireNonEmpty(
      snapshot.manifestLocator,
      "recording.manifestLocator",
    );

    const references = snapshot.speakerAudio.map((reference) =>
      Object.freeze({
        ...immutableIdentity(reference),
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
      ...(this.authoritativeDurationMs === undefined
        ? {}
        : { authoritativeDurationMs: this.authoritativeDurationMs }),
      manifestLocator: this.manifestLocator,
      recordingId: this.recordingId,
      speakerAudio: this.speakerAudio.map((reference) => ({
        ...(reference.artifactRevision === undefined
          ? {}
          : {
              artifactRevision: reference.artifactRevision,
              checksumSha256: reference.checksumSha256 as string,
              sizeBytes: reference.sizeBytes as number,
            }),
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
      this.authoritativeDurationMs !== other.authoritativeDurationMs ||
      this.speakerAudio.length !== other.speakerAudio.length
    ) {
      return false;
    }

    return this.speakerAudio.every((reference, index) => {
      const candidate = other.speakerAudio[index];
      return (
        candidate !== undefined &&
        reference.artifactRevision === candidate.artifactRevision &&
        reference.audioLocator === candidate.audioLocator &&
        reference.checksumSha256 === candidate.checksumSha256 &&
        reference.sizeBytes === candidate.sizeBytes &&
        reference.speakerId === candidate.speakerId &&
        reference.timelineOffsetMs === candidate.timelineOffsetMs
      );
    });
  }
}