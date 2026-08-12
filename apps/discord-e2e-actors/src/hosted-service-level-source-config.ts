import { isAbsolute } from "node:path";

import { z } from "zod";

import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";

const absolutePath = z.string().refine(isAbsolute, "Expected an absolute path");
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
export const hostedServiceLevelSourceConfigSchema = z.object({
  campaignId: identifier,
  clockPreflightPath: absolutePath.optional(),
  meetingId: identifier,
  outputs: z.object({
    clockAttestations: absolutePath,
    database: absolutePath,
    meetingPlatformLogs: absolutePath,
    report: absolutePath,
    s3: absolutePath,
  }).strict(),
  recordingId: identifier,
  remote: z.object({
    composeFile: absolutePath,
    craigProjectName: z.literal(HOSTED_CAMPAIGN_TARGET.craigProject),
    craigServiceName: z.literal("bot"),
    environmentFile: absolutePath,
    host: z.literal(HOSTED_CAMPAIGN_TARGET.host),
    mutationTarget: z.literal(HOSTED_CAMPAIGN_TARGET.mutationTarget),
    projectName: z.literal(HOSTED_CAMPAIGN_TARGET.project),
    sourceRoot: absolutePath,
  }).strict(),
  runId: identifier,
  sources: z.object({
    campaignProof: absolutePath,
    fixtureManifest: absolutePath,
    playbackLinkProof: absolutePath,
    readyReceipt: absolutePath,
    supplementalPlayback: absolutePath,
    voice: z.array(absolutePath).length(6),
  }).strict(),
}).strict().superRefine((value, context) => {
  const paths = [
    ...Object.values(value.outputs),
    ...(value.clockPreflightPath === undefined ? [] : [value.clockPreflightPath]),
    ...Object.values(value.sources).flat(),
  ];
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", message: "Hosted service-level source paths must be unique" });
  }
});

export type HostedServiceLevelSourceConfig = z.infer<
  typeof hostedServiceLevelSourceConfigSchema
>;

const environmentSchema = z.object({
  DISCORD_E2E_MUTATION_TARGET: z.literal(HOSTED_CAMPAIGN_TARGET.mutationTarget),
  DISCORD_E2E_REMOTE_COMPOSE_FILE: absolutePath,
  DISCORD_E2E_REMOTE_CRAIG_PROJECT: z.literal(HOSTED_CAMPAIGN_TARGET.craigProject),
  DISCORD_E2E_REMOTE_CRAIG_SERVICE: z.literal("bot"),
  DISCORD_E2E_REMOTE_ENV_FILE: absolutePath,
  DISCORD_E2E_REMOTE_HOST: z.literal(HOSTED_CAMPAIGN_TARGET.host),
  DISCORD_E2E_REMOTE_PROJECT: z.literal(HOSTED_CAMPAIGN_TARGET.project),
  DISCORD_E2E_REMOTE_SOURCE_ROOT: absolutePath,
  DISCORD_E2E_SLA_CAMPAIGN_ID: identifier,
  DISCORD_E2E_SLA_CAMPAIGN_PROOF_INPUT: absolutePath,
  DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT: absolutePath,
  DISCORD_E2E_SLA_CLOCK_PREFLIGHT_INPUT: absolutePath.optional(),
  DISCORD_E2E_SLA_DATABASE_INPUT: absolutePath,
  DISCORD_E2E_SLA_FIXTURE_MANIFEST_INPUT: absolutePath,
  DISCORD_E2E_SLA_MEETING_ID: identifier,
  DISCORD_E2E_SLA_MEETING_PLATFORM_LOG_INPUT: absolutePath,
  DISCORD_E2E_SLA_PLAYBACK_LINK_PROOF_INPUT: absolutePath,
  DISCORD_E2E_SLA_READY_RECEIPT_INPUT: absolutePath,
  DISCORD_E2E_SLA_RECORDING_ID: identifier,
  DISCORD_E2E_SLA_RUN_ID: identifier,
  DISCORD_E2E_SLA_S3_INPUT: absolutePath,
  DISCORD_E2E_SLA_SOURCE_REPORT_OUTPUT: absolutePath,
  DISCORD_E2E_SLA_SUPPLEMENTAL_PLAYBACK_INPUT: absolutePath,
  DISCORD_E2E_SLA_VOICE_INPUTS: z.string().transform((value, context) => {
    try {
      return z.array(absolutePath).length(6).parse(JSON.parse(value) as unknown);
    } catch {
      context.addIssue({ code: "custom", message: "Expected six absolute voice input paths" });
      return z.NEVER;
    }
  }),
});

export function loadHostedServiceLevelSourceConfig(
  environment: NodeJS.ProcessEnv,
): HostedServiceLevelSourceConfig {
  const value = environmentSchema.parse(environment);
  return hostedServiceLevelSourceConfigSchema.parse({
    campaignId: value.DISCORD_E2E_SLA_CAMPAIGN_ID,
    ...(value.DISCORD_E2E_SLA_CLOCK_PREFLIGHT_INPUT === undefined ? {} : {
      clockPreflightPath: value.DISCORD_E2E_SLA_CLOCK_PREFLIGHT_INPUT,
    }),
    meetingId: value.DISCORD_E2E_SLA_MEETING_ID,
    outputs: {
      clockAttestations: value.DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT,
      database: value.DISCORD_E2E_SLA_DATABASE_INPUT,
      meetingPlatformLogs: value.DISCORD_E2E_SLA_MEETING_PLATFORM_LOG_INPUT,
      report: value.DISCORD_E2E_SLA_SOURCE_REPORT_OUTPUT,
      s3: value.DISCORD_E2E_SLA_S3_INPUT,
    },
    recordingId: value.DISCORD_E2E_SLA_RECORDING_ID,
    remote: {
      composeFile: value.DISCORD_E2E_REMOTE_COMPOSE_FILE,
      craigProjectName: value.DISCORD_E2E_REMOTE_CRAIG_PROJECT,
      craigServiceName: value.DISCORD_E2E_REMOTE_CRAIG_SERVICE,
      environmentFile: value.DISCORD_E2E_REMOTE_ENV_FILE,
      host: value.DISCORD_E2E_REMOTE_HOST,
      mutationTarget: value.DISCORD_E2E_MUTATION_TARGET,
      projectName: value.DISCORD_E2E_REMOTE_PROJECT,
      sourceRoot: value.DISCORD_E2E_REMOTE_SOURCE_ROOT,
    },
    runId: value.DISCORD_E2E_SLA_RUN_ID,
    sources: {
      campaignProof: value.DISCORD_E2E_SLA_CAMPAIGN_PROOF_INPUT,
      fixtureManifest: value.DISCORD_E2E_SLA_FIXTURE_MANIFEST_INPUT,
      playbackLinkProof: value.DISCORD_E2E_SLA_PLAYBACK_LINK_PROOF_INPUT,
      readyReceipt: value.DISCORD_E2E_SLA_READY_RECEIPT_INPUT,
      supplementalPlayback: value.DISCORD_E2E_SLA_SUPPLEMENTAL_PLAYBACK_INPUT,
      voice: value.DISCORD_E2E_SLA_VOICE_INPUTS,
    },
  });
}
