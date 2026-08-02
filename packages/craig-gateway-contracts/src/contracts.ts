import { z } from "zod";

const discordSnowflakeSchema = z.string().regex(/^\d{17,20}$/u);
const identifierSchema = z.string().min(1).max(128);
const instantSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const storageKeySchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/") && !value.includes(".."), {
    message: "Storage keys must be relative and cannot traverse directories",
  });

const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: identifierSchema,
    recordingId: identifierSchema,
    guildId: discordSnowflakeSchema,
    channelId: discordSnowflakeSchema,
    occurredAt: instantSchema,
  })
  .strict();

const meetingStartedSchema = envelopeSchema.extend({
  type: z.literal("meeting.started"),
  participantIds: z.array(discordSnowflakeSchema).max(1_000),
});

const participantChangedSchema = envelopeSchema.extend({
  type: z.enum(["participant.joined", "participant.left"]),
  participantId: discordSnowflakeSchema,
});

const connectionChangedSchema = envelopeSchema.extend({
  type: z.enum(["meeting.connection_lost", "meeting.connection_recovered"]),
  reason: z.string().min(1).max(256).nullable(),
});

const meetingStoppedSchema = envelopeSchema.extend({
  type: z.enum(["meeting.ended", "meeting.aborted"]),
  reason: z.string().min(1).max(256).nullable(),
});

const artifactReadySchema = envelopeSchema.extend({
  type: z.literal("recording.artifact_ready"),
  endedAt: instantSchema,
  multitrackManifestKey: storageKeySchema,
  usersManifestKey: storageKeySchema,
});

const authoritativeRecordingReadySchema = envelopeSchema.extend({
  type: z.literal("recording.authoritative_ready"),
  endedAt: instantSchema,
  sourceFilesChecksumSha256: sha256Schema,
  trackCount: z.number().int().min(1).max(64),
});

export const craigLifecycleEventSchema = z.discriminatedUnion("type", [
  meetingStartedSchema,
  participantChangedSchema,
  connectionChangedSchema,
  meetingStoppedSchema,
  artifactReadySchema,
  authoritativeRecordingReadySchema,
]);

export type CraigLifecycleEvent = z.infer<typeof craigLifecycleEventSchema>;

export const authoritativeTrackUploadMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    uploadId: identifierSchema,
    recordingId: identifierSchema,
    guildId: discordSnowflakeSchema,
    channelId: discordSnowflakeSchema,
    speakerId: discordSnowflakeSchema,
    trackNumber: z.number().int().min(1).max(1_000),
    timelineOffsetMs: z.number().int().nonnegative(),
    checksumSha256: sha256Schema,
    sizeBytes: z.number().int().positive().max(64 * 1_024 * 1_024),
  })
  .strict();

export type AuthoritativeTrackUploadMetadata = z.infer<
  typeof authoritativeTrackUploadMetadataSchema
>;

export const voicePacketSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordingId: identifierSchema,
    guildId: discordSnowflakeSchema,
    channelId: discordSnowflakeSchema,
    speakerId: discordSnowflakeSchema,
    rtpTimestamp: z.number().int().min(0).max(0xffff_ffff),
    rtpSequence: z.number().int().min(0).max(0xffff),
    receivedAtMs: z.number().int().nonnegative(),
    relativeTimeMs: z.number().int().nonnegative(),
    opus: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0, {
      message: "Opus packet cannot be empty",
    }),
  })
  .strict();

export type VoicePacket = z.infer<typeof voicePacketSchema>;

export const wireVoicePacketSchema = voicePacketSchema.omit({ opus: true }).extend({
  opusBase64: z.base64().min(4).max(4_096),
});

export const voicePacketBatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    packets: z.array(wireVoicePacketSchema).min(1).max(256),
  })
  .strict();

export type VoicePacketBatch = z.infer<typeof voicePacketBatchSchema>;

export function parseCraigLifecycleEvent(input: unknown): CraigLifecycleEvent {
  return craigLifecycleEventSchema.parse(input);
}

export function parseAuthoritativeTrackUploadMetadata(
  input: unknown,
): AuthoritativeTrackUploadMetadata {
  return authoritativeTrackUploadMetadataSchema.parse(input);
}

export function parseVoicePacket(input: unknown): VoicePacket {
  return voicePacketSchema.parse(input);
}

export function parseVoicePacketBatch(input: unknown): VoicePacketBatch {
  return voicePacketBatchSchema.parse(input);
}
