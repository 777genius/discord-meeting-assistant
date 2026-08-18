import type { PlatformConfig } from "./platform-config.js";
import { readSecretFile } from "./secret-file-reader.js";
import { assemblePlatformConfig } from "./platform-config-assembly.js";
import {
  readMeetingPlatformBuildProvenance,
  type BuildProvenanceReader,
  type BuildProvenanceV1,
} from "./build-provenance.js";
import {
  loadTwoHourHistoricalQualification,
  type AcceptedTwoHourQualification,
  type QualificationFileReader,
} from "./two-hour-qualification.js";
import { loadRecordingPlaybackConfig } from "./recording-playback-config.js";
import type { ParsedPlatformEnvironment } from "../config.js";

export type SecretFileReader = (path: string) => Promise<string>;

export interface PlatformConfigLoadOptions {
  readonly acceptedTwoHourQualification?: AcceptedTwoHourQualification | null;
  readonly readBuildProvenance?: BuildProvenanceReader;
  readonly readQualificationFile?: QualificationFileReader;
  readonly readSecret?: SecretFileReader;
}

async function loadProductionBuildProvenance(
  environment: ParsedPlatformEnvironment,
  reader: BuildProvenanceReader,
): Promise<BuildProvenanceV1 | undefined> {
  if (environment.NODE_ENV !== "production") {
    return;
  }
  return reader();
}
function resolveLoadOptions(options: PlatformConfigLoadOptions) {
  return {
    acceptedTwoHourQualification: options.acceptedTwoHourQualification,
    readBuildProvenance:
      options.readBuildProvenance ?? readMeetingPlatformBuildProvenance,
    readQualificationFile: options.readQualificationFile,
    readSecret: options.readSecret ?? readSecretFile,
  };
}


export async function loadPlatformConfigWithParser(
  parseEnvironment: (raw: Readonly<Record<string, string | undefined>>) =>
    ParsedPlatformEnvironment,
  rawEnvironment: Readonly<Record<string, string | undefined>> = process.env,
  options: PlatformConfigLoadOptions = {},
): Promise<PlatformConfig> {
  const {
    acceptedTwoHourQualification,
    readBuildProvenance,
    readQualificationFile,
    readSecret,
  } = resolveLoadOptions(options);
  const forbiddenApiKey = Object.keys(rawEnvironment).find((key) =>
    /_API_KEY(?:_FILE)?$/u.test(key),
  );
  if (forbiddenApiKey !== undefined) {
    throw new Error(`API-key environment is forbidden: ${forbiddenApiKey}`);
  }
  const environment = parseEnvironment(rawEnvironment);
  const [
    craigBearerToken,
    conversationRuntimeToken,
    discordToken,
    infinityContextToken,
    infinityContextTopologyKey,
    meetingKnowledgePrincipalKey,
    postgresUrl,
    redisUrl,
    s3AccessKeyId,
    s3SecretAccessKey,
    subscriptionRuntimeToken,
    voicetextServiceToken,
    recordingPlayback,
    buildProvenance,
  ] = await Promise.all([
    readSecret(environment.CRAIG_BEARER_TOKEN_FILE),
    !environment.CONVERSATION_ENABLED ||
    environment.CONVERSATION_RUNTIME_TOKEN_FILE === undefined
      ? Promise.resolve()
      : readSecret(environment.CONVERSATION_RUNTIME_TOKEN_FILE),
    readSecret(environment.DISCORD_TOKEN_FILE),
    environment.INFINITY_CONTEXT_TOKEN_FILE === undefined
      ? Promise.resolve()
      : readSecret(environment.INFINITY_CONTEXT_TOKEN_FILE),
    environment.INFINITY_CONTEXT_TOPOLOGY_KEY_FILE === undefined
      ? Promise.resolve()
      : readSecret(environment.INFINITY_CONTEXT_TOPOLOGY_KEY_FILE),
    (!environment.MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED &&
      !environment.CONVERSATION_ENABLED) ||
    environment.MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE === undefined
      ? Promise.resolve()
      : readSecret(environment.MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE),
    readSecret(environment.POSTGRES_URL_FILE),
    readSecret(environment.REDIS_URL_FILE),
    readSecret(environment.S3_ACCESS_KEY_ID_FILE),
    readSecret(environment.S3_SECRET_ACCESS_KEY_FILE),
    readSecret(environment.SUBSCRIPTION_RUNTIME_TOKEN_FILE),
    environment.VOICETEXT_SERVICE_TOKEN_FILE === undefined
      ? Promise.resolve()
      : readSecret(environment.VOICETEXT_SERVICE_TOKEN_FILE),
    loadRecordingPlaybackConfig(environment, readSecret),
    loadProductionBuildProvenance(environment, readBuildProvenance),
  ]);
  const twoHourHistoricalQualification =
    await loadTwoHourHistoricalQualification(
      environment.MEETING_KNOWLEDGE_TWO_HOUR_QUALIFICATION_FILE,
      buildProvenance,
      readQualificationFile,
      acceptedTwoHourQualification,
    );

  return assemblePlatformConfig(environment, {
    craigBearerToken,
    ...(conversationRuntimeToken === undefined ? {} : { conversationRuntimeToken }),
    discordToken,
    ...(infinityContextToken === undefined ? {} : { infinityContextToken }),
    ...(infinityContextTopologyKey === undefined ? {} : { infinityContextTopologyKey }),
    ...(meetingKnowledgePrincipalKey === undefined
      ? {}
      : { meetingKnowledgePrincipalKey }),
    postgresUrl,
    redisUrl,
    recordingPlayback,
    s3AccessKeyId,
    s3SecretAccessKey,
    subscriptionRuntimeToken,
    ...(voicetextServiceToken === undefined ? {} : { voicetextServiceToken }),
    ...(buildProvenance === undefined ? {} : { buildProvenance }),
    ...(twoHourHistoricalQualification === undefined
      ? {}
      : { twoHourHistoricalQualification }),
  });
}
