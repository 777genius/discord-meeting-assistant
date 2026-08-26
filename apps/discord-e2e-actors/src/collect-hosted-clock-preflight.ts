import { isAbsolute } from "node:path";

import { z } from "zod";

import { deriveHostedClockPreflightReceiptV2 } from "./hosted-clock-proof-v2.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";
import {
  privateHostedServiceLevelArtifactExists,
  writeCreateOnlyPrivateHostedServiceLevelArtifact,
} from "./hosted-service-level-source-artifact.js";
import { SshHostedServiceLevelRawProbe } from "./hosted-service-level-raw-probe.js";

const absolutePath = z.string().refine(isAbsolute, "Expected an absolute path");
const craigProject = z.string().regex(/^(?:craig-meeting-e2e|craig-e2e-[a-f\d]{20})$/u);

const hostedClockPreflightProducerConfigSchema = z.object({
  outputPath: absolutePath,
  remote: z.object({
    composeFile: absolutePath,
    craigProjectName: craigProject,
    craigServiceName: z.literal("bot"),
    environmentFile: absolutePath,
    host: z.literal(HOSTED_CAMPAIGN_TARGET.host),
    mutationTarget: z.literal(HOSTED_CAMPAIGN_TARGET.mutationTarget),
    projectName: z.literal(HOSTED_CAMPAIGN_TARGET.project),
    sourceRoot: absolutePath,
  }).strict(),
}).strict();

export type HostedClockPreflightProducerConfig = z.infer<
  typeof hostedClockPreflightProducerConfigSchema
>;

export interface HostedClockPreflightProbe {
  collectClockPreflight(signal?: AbortSignal): Promise<unknown>;
}

export async function collectHostedClockPreflight(
  configValue: HostedClockPreflightProducerConfig,
  probe: HostedClockPreflightProbe,
  signal?: AbortSignal,
): Promise<void> {
  const config = hostedClockPreflightProducerConfigSchema.parse(configValue);
  if (await privateHostedServiceLevelArtifactExists(config.outputPath)) {
    throw new Error("Hosted clock preflight output already exists and will not be replaced");
  }
  const receipt = deriveHostedClockPreflightReceiptV2(await probe.collectClockPreflight(signal));
  await writeCreateOnlyPrivateHostedServiceLevelArtifact(
    config.outputPath,
    `${JSON.stringify(receipt, undefined, 2)}\n`,
  );
}

const environmentSchema = z.looseObject({
  DISCORD_E2E_CLOCK_PREFLIGHT_OUTPUT: absolutePath,
  DISCORD_E2E_MUTATION_TARGET: z.literal(HOSTED_CAMPAIGN_TARGET.mutationTarget),
  DISCORD_E2E_REMOTE_COMPOSE_FILE: absolutePath,
  DISCORD_E2E_REMOTE_CRAIG_PROJECT: craigProject,
  DISCORD_E2E_REMOTE_CRAIG_SERVICE: z.literal("bot"),
  DISCORD_E2E_REMOTE_ENV_FILE: absolutePath,
  DISCORD_E2E_REMOTE_HOST: z.literal(HOSTED_CAMPAIGN_TARGET.host),
  DISCORD_E2E_REMOTE_PROJECT: z.literal(HOSTED_CAMPAIGN_TARGET.project),
  DISCORD_E2E_REMOTE_SOURCE_ROOT: absolutePath,
});

function loadHostedClockPreflightProducerConfig(
  environment: NodeJS.ProcessEnv,
): HostedClockPreflightProducerConfig {
  const value = environmentSchema.parse(environment);
  return hostedClockPreflightProducerConfigSchema.parse({
    outputPath: value.DISCORD_E2E_CLOCK_PREFLIGHT_OUTPUT,
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
  });
}

async function main(): Promise<void> {
  const config = loadHostedClockPreflightProducerConfig(process.env);
  await collectHostedClockPreflight(config, new SshHostedServiceLevelRawProbe(config.remote));
  process.stdout.write(`${JSON.stringify({
    kind: "hosted-clock-preflight-completion",
    outputPath: config.outputPath,
    schemaVersion: 2,
    status: "ready",
  })}\n`);
}

if (process.argv[1]?.endsWith("collect-hosted-clock-preflight.js") === true) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Unknown clock preflight failure"}\n`);
    process.exitCode = 1;
  });
}
