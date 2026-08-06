import type { S3Client } from "@aws-sdk/client-s3";
import type { PostgresMeetingRepository } from "@discord-meeting/postgres-adapter";

import type { PlatformConfig } from "../config.js";
import { GetRecordingPlayback } from "../recording-playback/application/recording-playback.js";
import {
  createRecordingPlaybackRoutesPlugin,
  HmacRecordingPlaybackAccess,
  PostgresRecordingPlaybackCatalog,
  S3RecordingPlaybackAudioReader,
} from "../recording-playback/adapters/index.js";

export interface PlatformRecordingPlaybackComposition {
  readonly recordingPlaybackUrl?: (meetingId: string) => string;
  readonly routes?: ReturnType<typeof createRecordingPlaybackRoutesPlugin>;
}

export function createPlatformRecordingPlaybackComposition(input: {
  readonly config: PlatformConfig;
  readonly meetings: PostgresMeetingRepository;
  readonly s3: S3Client;
}): PlatformRecordingPlaybackComposition {
  const playbackConfig = input.config.recordingPlayback;
  if (playbackConfig === undefined) {
    return {};
  }
  const secret = input.config.secrets.recordingPlaybackSigningSecret;
  if (secret === undefined) {
    throw new Error("Recording playback signing secret is missing from validated config");
  }
  const access = new HmacRecordingPlaybackAccess({
    publicBaseUrl: playbackConfig.publicBaseUrl,
    secret,
  });
  const playback = new GetRecordingPlayback(
    new PostgresRecordingPlaybackCatalog(input.meetings),
    new S3RecordingPlaybackAudioReader({
      accessPolicy: {
        bucket: input.config.s3.bucket,
        keyPrefix: input.config.s3.prefix,
      },
      client: input.s3,
    }),
  );
  return {
    recordingPlaybackUrl: (meetingId) => access.issueUrl(meetingId),
    routes: createRecordingPlaybackRoutesPlugin({
      access,
      playback,
      secureCookies: new URL(playbackConfig.publicBaseUrl).protocol === "https:",
    }),
  };
}
