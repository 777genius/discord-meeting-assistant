import { z } from "zod";
import { normalizeDatabase } from "./e2e-retained-evidence-snapshot.js";
import { requireEvidence } from "./oss-campaign-artifacts.js";

/** OSS retains the authoritative transcript identity separately from meeting CAS revision. */
export function normalizeOssDatabase(observation: Parameters<typeof normalizeDatabase>[0]) {
  const normalized = normalizeDatabase(observation);
  const { transcript } = z.object({
    transcript: z.object({
      version: z.number().int().positive(), recordingId: z.string().trim().min(1),
    })
  }).parse(observation.snapshot);
  requireEvidence(transcript.recordingId === normalized.snapshot.recording.recordingId,
    "OSS transcript recordingId disagrees with recording");
  return {
    ...normalized, snapshot: {
      ...normalized.snapshot,
      transcript: { ...normalized.snapshot.transcript, ...transcript }
    }
  };
}
