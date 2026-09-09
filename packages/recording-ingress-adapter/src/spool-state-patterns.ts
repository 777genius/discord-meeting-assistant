import { RecordingIngressError } from "./errors.js";
import type { StoredAuthoritativeTrack } from "./spool-state.js";

export const immutableProducerRevision = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
export const sha256Pattern = /^[0-9a-f]{64}$/u;
// Unicode escapes keep this intentional control-character check lint-safe.
const controlCharacterPattern = {
  test(value: string): boolean {
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code <= 0x1f || code === 0x7f) {
        return true;
      }
    }
    return false;
  },
};

type StoredSpeakerAudio = {
  readonly artifactRevision?: string;
  readonly audioLocator: string;
  readonly checksumSha256?: string;
  readonly sizeBytes?: number;
  readonly speakerId: string;
  readonly timelineOffsetMs: number;
};

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordingIngressError("corrupt-spool", "spool metadata is not an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RecordingIngressError("corrupt-spool", `invalid spool field: ${field}`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

export function parseStoredSpeakerAudio(value: unknown): StoredSpeakerAudio {
  const reference = recordValue(value);
  const timelineOffsetMs = reference.timelineOffsetMs;
  if (!Number.isSafeInteger(timelineOffsetMs) || (timelineOffsetMs as number) < 0) {
    throw new RecordingIngressError("corrupt-spool", "invalid completion timeline offset");
  }
  const artifactRevision = optionalString(reference.artifactRevision, "artifactRevision");
  const checksumSha256 = optionalString(reference.checksumSha256, "checksumSha256");
  const sizeBytes = reference.sizeBytes;
  const immutableIdentityFields = [artifactRevision, checksumSha256, sizeBytes]
    .filter((field) => field !== undefined).length;
  if (immutableIdentityFields !== 0 && immutableIdentityFields !== 3) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "completion receipt has a partial immutable track identity",
    );
  }
  if (
    artifactRevision !== undefined &&
    (artifactRevision === "null" ||
      controlCharacterPattern.test(artifactRevision) ||
      !sha256Pattern.test(checksumSha256 as string) ||
      !Number.isSafeInteger(sizeBytes) ||
      (sizeBytes as number) <= 0)
  ) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "completion receipt has an invalid immutable track identity",
    );
  }
  return {
    ...(artifactRevision === undefined ? {} : { artifactRevision }),
    audioLocator: requiredString(reference.audioLocator, "audioLocator"),
    ...(checksumSha256 === undefined ? {} : { checksumSha256 }),
    ...(sizeBytes === undefined ? {} : { sizeBytes: sizeBytes as number }),
    speakerId: requiredString(reference.speakerId, "speakerId"),
    timelineOffsetMs: timelineOffsetMs as number,
  };
}

export function reconstructCompletedTrackIdentity(
  tracks: readonly StoredAuthoritativeTrack[],
  references: readonly StoredSpeakerAudio[],
): readonly StoredSpeakerAudio[] {
  const tracksBySpeaker = new Map<string, StoredAuthoritativeTrack>();
  for (const track of tracks) {
    if (
      track.artifactVersionId === "null" ||
      (track.artifactVersionId !== null &&
        controlCharacterPattern.test(track.artifactVersionId)) ||
      tracksBySpeaker.has(track.speakerId)
    ) {
      throw new RecordingIngressError(
        "corrupt-spool",
        "completion receipt has ambiguous or mutable authoritative track identity",
      );
    }
    tracksBySpeaker.set(track.speakerId, track);
  }
  if (tracksBySpeaker.size !== references.length) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "completion receipt track identity is not bijective",
    );
  }
  return references.map((reference) => {
    const track = tracksBySpeaker.get(reference.speakerId);
    if (
      track === undefined ||
      track.audioLocator !== reference.audioLocator ||
      track.timelineOffsetMs !== reference.timelineOffsetMs
    ) {
      throw new RecordingIngressError(
        "corrupt-spool",
        "completion receipt track identity does not match the recording snapshot",
      );
    }
    const artifactRevision = track.artifactVersionId;
    if (artifactRevision === null) {
      return {
        audioLocator: reference.audioLocator,
        speakerId: reference.speakerId,
        timelineOffsetMs: reference.timelineOffsetMs,
      };
    }
    if (
      reference.artifactRevision !== undefined &&
      (reference.artifactRevision !== artifactRevision ||
        reference.checksumSha256 !== track.checksumSha256 ||
        reference.sizeBytes !== track.sizeBytes)
    ) {
      throw new RecordingIngressError(
        "corrupt-spool",
        "completion receipt track identity does not match the authoritative track",
      );
    }
    return {
      artifactRevision,
      audioLocator: reference.audioLocator,
      checksumSha256: track.checksumSha256,
      sizeBytes: track.sizeBytes,
      speakerId: reference.speakerId,
      timelineOffsetMs: reference.timelineOffsetMs,
    };
  });
}

export function assertManifestIdentity(
  schemaVersion: number,
  manifestRevision: string | undefined,
  manifestChecksumSha256: string | undefined,
  manifestSizeBytes: unknown,
): void {
  const identityCount = [manifestRevision, manifestChecksumSha256, manifestSizeBytes]
    .filter((field) => field !== undefined).length;
  const invalid =
    (identityCount !== 0 && identityCount !== 3) ||
    (schemaVersion === 6 && identityCount !== 3) ||
    manifestRevision === "null" ||
    (manifestRevision !== undefined && controlCharacterPattern.test(manifestRevision)) ||
    (manifestChecksumSha256 !== undefined && !sha256Pattern.test(manifestChecksumSha256)) ||
    (manifestSizeBytes !== undefined &&
      (!Number.isSafeInteger(manifestSizeBytes) || (manifestSizeBytes as number) <= 0));
  if (invalid) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "completion receipt has an invalid immutable manifest identity",
    );
  }
}
