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

function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

const envelopeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: identifierSchema,
    recordingId: identifierSchema,
    guildId: discordSnowflakeSchema,
    channelId: discordSnowflakeSchema,
    occurredAt: instantSchema,
  })
  .strict();

const meetingStartedV1Schema = envelopeV1Schema.extend({
  type: z.literal("meeting.started"),
  participantIds: z.array(discordSnowflakeSchema).max(1_000),
});

const participantChangedV1Schema = envelopeV1Schema.extend({
  type: z.enum(["participant.joined", "participant.left"]),
  participantId: discordSnowflakeSchema,
});

const connectionChangedV1Schema = envelopeV1Schema.extend({
  type: z.enum(["meeting.connection_lost", "meeting.connection_recovered"]),
  reason: z.string().min(1).max(256).nullable(),
});

const meetingStoppedV1Schema = envelopeV1Schema.extend({
  type: z.enum(["meeting.ended", "meeting.aborted"]),
  reason: z.string().min(1).max(256).nullable(),
});

const artifactReadyV1Schema = envelopeV1Schema.extend({
  type: z.literal("recording.artifact_ready"),
  endedAt: instantSchema,
  multitrackManifestKey: storageKeySchema,
  usersManifestKey: storageKeySchema,
});

const authoritativeRecordingReadyV1Schema = envelopeV1Schema.extend({
  type: z.literal("recording.authoritative_ready"),
  endedAt: instantSchema,
  sourceFilesChecksumSha256: sha256Schema,
  trackCount: z.number().int().min(1).max(64),
});

const actorKindSchema = z.enum(["human", "automation", "unknown"]);
const actorSchema = z.object({
  actorId: discordSnowflakeSchema,
  kind: actorKindSchema,
}).strict();
const actorRosterSchema = z.array(actorSchema).max(1_000).superRefine((actors, context) => {
  const kindsByActor = new Map<string, string>();
  for (const [index, actor] of actors.entries()) {
    const existingKind = kindsByActor.get(actor.actorId);
    if (existingKind !== undefined) {
      context.addIssue({
        code: "custom",
        message: existingKind === actor.kind
          ? "Actor roster cannot repeat an actor"
          : "Actor roster contains conflicting actor kinds",
        path: [index, "actorId"],
      });
    }
    kindsByActor.set(actor.actorId, actor.kind);
  }
});

const envelopeV2Schema = z.object({
  schemaVersion: z.literal(2),
  eventId: identifierSchema,
  recordingId: identifierSchema,
  guildId: discordSnowflakeSchema,
  channelId: discordSnowflakeSchema,
  occurredAt: instantSchema,
}).strict();

const meetingStartedV2Schema = envelopeV2Schema.extend({
  type: z.literal("meeting.started"),
  actors: actorRosterSchema,
});
const participantChangedV2Schema = envelopeV2Schema.extend({
  type: z.enum(["participant.joined", "participant.left"]),
  actor: actorSchema,
});
const connectionChangedV2Schema = envelopeV2Schema.extend({
  type: z.enum(["meeting.connection_lost", "meeting.connection_recovered"]),
  reason: z.string().min(1).max(256).nullable(),
});
const meetingStoppedV2Schema = envelopeV2Schema.extend({
  type: z.enum(["meeting.ended", "meeting.aborted"]),
  reason: z.string().min(1).max(256).nullable(),
});
const artifactReadyV2Schema = envelopeV2Schema.extend({
  type: z.literal("recording.artifact_ready"),
  endedAt: instantSchema,
  multitrackManifestKey: storageKeySchema,
  usersManifestKey: storageKeySchema,
});
const authoritativeRecordingReadyV2Schema = envelopeV2Schema.extend({
  type: z.literal("recording.authoritative_ready"),
  actors: actorRosterSchema,
  endedAt: instantSchema,
  sourceFilesChecksumSha256: sha256Schema,
  trackCount: z.number().int().min(1).max(64),
});

const craigLifecycleEventV1Schema = z.discriminatedUnion("type", [
  meetingStartedV1Schema,
  participantChangedV1Schema,
  connectionChangedV1Schema,
  meetingStoppedV1Schema,
  artifactReadyV1Schema,
  authoritativeRecordingReadyV1Schema,
]);
const craigLifecycleEventV2Schema = z.discriminatedUnion("type", [
  meetingStartedV2Schema,
  participantChangedV2Schema,
  connectionChangedV2Schema,
  meetingStoppedV2Schema,
  artifactReadyV2Schema,
  authoritativeRecordingReadyV2Schema,
]);

export const craigLifecycleEventSchema = z.union([
  craigLifecycleEventV1Schema,
  craigLifecycleEventV2Schema,
]);

export type CraigLifecycleEvent = z.infer<typeof craigLifecycleEventSchema>;
export type CraigActor = z.infer<typeof actorSchema>;
export type CraigActorKind = z.infer<typeof actorKindSchema>;

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

export const craigPlaybackProtocolVersion = 1 as const;
export const craigPlaybackSampleRateHz = 48_000 as const;
export const craigPlaybackChannels = 1 as const;
export const maximumCraigPlaybackPcmBytes = 19_200;

const playbackTurnEnvelopeSchema = z.object({
  schemaVersion: z.literal(craigPlaybackProtocolVersion),
  recordingId: identifierSchema,
  turnId: identifierSchema,
  attemptId: identifierSchema,
});

const playbackStartSchema = playbackTurnEnvelopeSchema
  .extend({
    type: z.literal("playback-start"),
    format: z.literal("pcm_s16le"),
    sampleRateHz: z.literal(craigPlaybackSampleRateHz),
    channels: z.literal(craigPlaybackChannels),
  })
  .strict();

const playbackAudioChunkSchema = playbackTurnEnvelopeSchema
  .extend({
    type: z.literal("audio-chunk"),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    pcmBase64: z.base64().min(4).max(25_600),
  })
  .strict()
  .refine(
    (value) => {
      const byteLength = decodedBase64ByteLength(value.pcmBase64);
      return byteLength > 0 &&
        byteLength <= maximumCraigPlaybackPcmBytes &&
        byteLength % 2 === 0;
    },
    "PCM chunks must contain bounded 16-bit samples",
  );

const playbackFinishSchema = playbackTurnEnvelopeSchema
  .extend({ type: z.literal("playback-finish") })
  .strict();

const playbackCancelSchema = playbackTurnEnvelopeSchema
  .extend({
    type: z.literal("playback-cancel"),
    reason: z.enum([
      "barge-in",
      "meeting-ended",
      "playback-failed",
      "runtime-shutdown",
      "superseded",
    ]),
  })
  .strict();

export const craigPlaybackCommandSchema = z.discriminatedUnion("type", [
  playbackStartSchema,
  playbackAudioChunkSchema,
  playbackFinishSchema,
  playbackCancelSchema,
]);

export type CraigPlaybackCommand = z.infer<typeof craigPlaybackCommandSchema>;

const playbackSessionReadySchema = z
  .object({
    schemaVersion: z.literal(craigPlaybackProtocolVersion),
    type: z.literal("session-ready"),
    recordingId: identifierSchema,
    guildId: discordSnowflakeSchema,
    channelId: discordSnowflakeSchema,
    gatewaySessionId: identifierSchema,
  })
  .strict();

const playbackStartedSchema = playbackTurnEnvelopeSchema
  .extend({
    type: z.literal("playback-started"),
    startedAtMs: z.number().int().nonnegative(),
  })
  .strict();

const playbackFinishedSchema = playbackTurnEnvelopeSchema
  .extend({
    type: z.literal("playback-finished"),
    finishedAtMs: z.number().int().nonnegative(),
  })
  .strict();

const playbackFailedSchema = playbackTurnEnvelopeSchema
  .extend({
    type: z.literal("playback-failed"),
    code: z.enum([
      "backpressure",
      "connection-unavailable",
      "invalid-audio",
      "playback-error",
      "transport-disconnected",
    ]),
    safeMessage: z.string().trim().min(1).max(512),
    retryable: z.boolean(),
  })
  .strict();

export const craigPlaybackEventSchema = z.discriminatedUnion("type", [
  playbackSessionReadySchema,
  playbackStartedSchema,
  playbackFinishedSchema,
  playbackFailedSchema,
]);

export type CraigPlaybackEvent = z.infer<typeof craigPlaybackEventSchema>;

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

export function parseCraigPlaybackCommand(input: unknown): CraigPlaybackCommand {
  return craigPlaybackCommandSchema.parse(input);
}

export function parseCraigPlaybackEvent(input: unknown): CraigPlaybackEvent {
  return craigPlaybackEventSchema.parse(input);
}
