import { createHash } from "node:crypto";
import { Meeting, type MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";
import type { BinaryArtifactReader } from "@discord-meeting/object-storage-adapter";

type Recording = MeetingSnapshot["recording"];

export interface LegacyRecordingEvidence {
  readonly artifacts: BinaryArtifactReader;
  /** Reads the trusted ingress completion receipt, never a caller-authored manifest. */
  readonly completedRecording: (recordingId: string) => Promise<Recording | undefined>;
  readonly onVerified: (evidence: { meetingId: string; recordingId: string }) => void;
}

/** Resolves only missing identity using retained authority and fully verified bytes. */
export async function verifyLegacyRecordingIdentity(
  stored: MeetingSnapshot,
  evidence: LegacyRecordingEvidence,
): Promise<MeetingSnapshot> {
  const meetingId = stored.meetingId;
  if (stored.recording.speakerAudio.every(hasIdentity)) {
    return stored;
  }
  const receipt = await evidence.completedRecording(stored.recording.recordingId);
  if (receipt === undefined) {
    throw new Error("legacy recording requires its authoritative completion receipt");
  }
  const recording = mergeIdentity(stored.recording, receipt);
  // Drain every pinned version before returning any upgraded snapshot. Checking
  // metadata or HEAD alone would authenticate neither the bytes nor old data.
  for (const track of recording.speakerAudio) {
    const artifact = await evidence.artifacts.read({
      expected: { checksumSha256: track.checksumSha256!, sizeBytes: track.sizeBytes! },
      locator: track.audioLocator,
      revision: track.artifactRevision!,
    });
    if (artifact.versionId !== track.artifactRevision ||
        artifact.checksumSha256 !== track.checksumSha256 ||
        artifact.sizeBytes !== track.sizeBytes) {
      throw new Error("legacy recording artifact metadata mismatch");
    }
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of artifact.body) {
      size += chunk.byteLength;
      if (size > track.sizeBytes!) { throw new Error("legacy recording artifact size mismatch"); }
      digest.update(chunk);
    }
    if (size !== track.sizeBytes || digest.digest("hex") !== track.checksumSha256) {
      throw new Error("legacy recording artifact integrity mismatch");
    }
  }
  const verified = Meeting.restore({ ...stored, recording }).toSnapshot();
  evidence.onVerified({ meetingId, recordingId: recording.recordingId });
  return verified;
}

function hasIdentity(track: Recording["speakerAudio"][number]): boolean {
  return track.artifactRevision !== undefined && track.checksumSha256 !== undefined &&
    track.sizeBytes !== undefined;
}

function mergeIdentity(stored: Recording, receipt: Recording): Recording {
  if (stored.recordingId !== receipt.recordingId ||
      stored.manifestLocator !== receipt.manifestLocator ||
      stored.speakerAudio.length !== receipt.speakerAudio.length ||
      new Set(receipt.speakerAudio.map((track) => track.speakerId)).size !== receipt.speakerAudio.length) {
    throw new Error("legacy recording completion receipt identity mismatch");
  }
  for (const field of ["manifestRevision", "manifestChecksumSha256", "manifestSizeBytes", "authoritativeDurationMs"] as const) {
    if (stored[field] !== undefined && receipt[field] !== undefined && stored[field] !== receipt[field]) {
      throw new Error("legacy recording completion receipt facts mismatch");
    }
  }
  const speakerAudio = stored.speakerAudio.map((track) => {
    const trusted = receipt.speakerAudio.find((candidate) => candidate.speakerId === track.speakerId);
    if (trusted === undefined || !hasIdentity(trusted) ||
        track.audioLocator !== trusted.audioLocator ||
        track.timelineOffsetMs !== trusted.timelineOffsetMs ||
        (track.artifactRevision !== undefined && track.artifactRevision !== trusted.artifactRevision) ||
        (track.checksumSha256 !== undefined && track.checksumSha256 !== trusted.checksumSha256) ||
        (track.sizeBytes !== undefined && track.sizeBytes !== trusted.sizeBytes)) {
      throw new Error("legacy recording completion receipt track mismatch");
    }
    return { ...track, artifactRevision: trusted.artifactRevision!,
      checksumSha256: trusted.checksumSha256!, sizeBytes: trusted.sizeBytes! };
  });
  // The old manifest and duration remain authoritative. This path fills only
  // missing speaker integrity fields; it does not replace other recording facts.
  return { ...stored, speakerAudio };
}
