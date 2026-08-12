import { z } from "zod";

const identifier = z.string().trim().min(1);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const httpStatus = z.number().int().min(100).max(599);

const recordingPlaybackManifestStatus = z.enum([
  "processing",
  "unavailable",
  "ready",
]);

export const recordingPlaybackEvidenceV1Schema = z.object({
  capabilitySha256: sha256,
  link: z.object({
    origin: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    }),
    pathname: z.literal("/recordings/playback"),
  }).strict(),
  manifest: z.object({
    readinessExpectation: z.enum(["already-ready", "transition"]),
    recordingId: identifier,
    statuses: z.array(recordingPlaybackManifestStatus).min(1)
      .refine((statuses) => statuses.at(-1) === "ready", "Final playback status must be ready")
      .refine(
        (statuses) => statuses.slice(0, -1).every((status) => status !== "ready"),
        "Ready playback status must be terminal",
      ),
  }).strict(),
  resume: z.object({
    manifestStatus: z.literal("ready"),
    recordingId: identifier,
    statusCode: httpStatus,
  }).strict(),
  tracks: z.array(z.object({
    checksumSha256: sha256,
    contentLength: z.number().int().positive(),
    contentRange: z.string().regex(/^bytes \d+-\d+\/\d+$/u),
    index: z.number().int().nonnegative(),
    statusCode: httpStatus,
  }).strict()).min(1),
}).strict();

export type RecordingPlaybackEvidenceV1 = z.infer<
  typeof recordingPlaybackEvidenceV1Schema
>;
