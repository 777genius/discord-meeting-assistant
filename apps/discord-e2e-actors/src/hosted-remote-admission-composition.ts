import { z } from "zod";

import {
  deriveHostedClockPreflightReceiptV2,
} from "./hosted-clock-proof-v2.js";
import {
  assertHostedDeploymentSafetyRevalidatedV1,
  hostedDeploymentSafetyExpectationV1Schema,
  type HostedDeploymentSafetyExpectationV1,
  type HostedDeploymentSafetyReceiptV1,
  verifyHostedDeploymentSafetyReceiptV1,
} from "./hosted-deployment-safety-receipt.js";
import {
  produceHostedDiscordIdentityReceiptV1,
  type HostedDiscordIdentityReceiptInput,
} from "./hosted-discord-identity-producer.js";
import {
  produceVoicetextSemanticCanaryReceiptV1,
  type ProduceVoicetextCanaryInputV1,
  type VoicetextCanaryRunnerV1,
} from "./hosted-voicetext-semantic-canary-producer.js";
import type {
  HostedCampaignRemoteAdmissionProbe,
  HostedCampaignRemoteAdmissionProbeRequest,
  HostedDeploymentRevalidationBaselineV1,
} from "./hosted-campaign-remote-admission.js";
import { hostedDeploymentRevalidationBaselineV1Schema } from "./hosted-campaign-remote-admission.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-target.js";
import type { HostedClockPreflightProbe } from "./collect-hosted-clock-preflight.js";

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);

export interface HostedDeploymentSafetyReceiptProducer {
  collect(): Promise<HostedDeploymentSafetyReceiptV1>;
}

export function createHostedDeploymentSafetyRevalidator(
  producer: HostedDeploymentSafetyReceiptProducer,
): (baseline: HostedDeploymentRevalidationBaselineV1, signal?: AbortSignal) => Promise<void> {
  return async (baselineValue, signal) => {
    assertNotAborted(signal);
    const baseline = hostedDeploymentRevalidationBaselineV1Schema.parse(baselineValue);
    const freshReceipt = await producer.collect();
    assertNotAborted(signal);
    const fresh = verifyHostedDeploymentSafetyReceiptV1(freshReceipt);
    if (baseline.campaignId !== fresh.campaignId
      || baseline.expectationSha256 !== fresh.expectationSha256
      || baseline.deploymentFingerprint !== fresh.deploymentFingerprint) {
      throw new Error("Hosted deployment changed after safety admission");
    }
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Hosted admission revalidation aborted");
  }
}

/**
 * Trusted, test-only runtime wiring. This object must be constructed by the host
 * process, never deserialized from operator-authored campaign JSON.
 */
export interface HostedRemoteAdmissionCompositionConfig {
  readonly campaignId: string;
  readonly clock: HostedClockPreflightProbe;
  readonly deployment: {
    readonly expectation: HostedDeploymentSafetyExpectationV1;
    readonly producer: HostedDeploymentSafetyReceiptProducer;
  };
  readonly discord: HostedDiscordIdentityReceiptInput;
  readonly meetingPlatformRevision: string;
  readonly planSha256: string;
  readonly voicetext: {
    readonly input: ProduceVoicetextCanaryInputV1;
    readonly runner: VoicetextCanaryRunnerV1;
  };
}

export function createHostedCampaignRemoteAdmissionProbe(
  configValue: HostedRemoteAdmissionCompositionConfig,
): HostedCampaignRemoteAdmissionProbe {
  const config = validateComposition(configValue);
  return Object.freeze({
    inspect: async (request: HostedCampaignRemoteAdmissionProbeRequest) => {
      assertRequest(request, config);

      // Deployment must be proven before any provider or Discord request is made.
      const deploymentSafety = await config.deployment.producer.collect();
      const discordIdentity = await produceHostedDiscordIdentityReceiptV1(config.discord);
      const voicetextCanary = await produceVoicetextSemanticCanaryReceiptV1(
        config.voicetext.input,
        config.voicetext.runner,
      );
      const clockPreflight = deriveHostedClockPreflightReceiptV2(
        await config.clock.collectClockPreflight(),
      );

      // Detect a deployment swap during the slower external probes. The second
      // receipt is deliberately not admitted as a fifth readiness section.
      const deploymentRevalidation = await config.deployment.producer.collect();
      assertHostedDeploymentSafetyRevalidatedV1(deploymentSafety, deploymentRevalidation);

      return Object.freeze({
        clockPreflight,
        deploymentSafety,
        discordIdentity,
        kind: "hosted-remote-admission-evidence" as const,
        schemaVersion: 1 as const,
        voicetextCanary,
      });
    },
  });
}

function validateComposition(
  value: HostedRemoteAdmissionCompositionConfig,
): HostedRemoteAdmissionCompositionConfig {
  const campaignId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u).parse(value.campaignId);
  const meetingPlatformRevision = sourceRevisionSchema.parse(value.meetingPlatformRevision);
  const planSha256 = sha256Schema.parse(value.planSha256);
  const expectation = hostedDeploymentSafetyExpectationV1Schema.parse(value.deployment.expectation);
  const discord = value.discord;
  const voicetext = value.voicetext.input;
  const target = HOSTED_CAMPAIGN_TARGET;
  const expectedTarget = {
    deploymentScope: target.deploymentScope,
    environment: target.environment,
    guildId: target.guildId,
    mutationTarget: target.mutationTarget,
    publicationChannelId: target.publicationChannelId,
    voiceChannelId: target.voiceChannelId,
  };
  const meetingService = expectation.services.find(({ component }) => component === "meetingPlatform");
  if (expectation.campaignId !== campaignId
    || meetingService?.sourceRevision !== meetingPlatformRevision
    || discord.binding.campaignId !== campaignId
    || discord.binding.planSha256 !== planSha256
    || discord.binding.sourceRevision !== meetingPlatformRevision
    || discord.binding.host !== target.host
    || JSON.stringify(discord.target) !== JSON.stringify(expectedTarget)
    || voicetext.binding.campaignId !== campaignId
    || voicetext.binding.planSha256 !== planSha256
    || voicetext.binding.sourceRevision !== meetingPlatformRevision
    || voicetext.binding.host !== target.host
    || voicetext.binding.containerId !== discord.binding.containerId
    || voicetext.binding.imageDigestSha256 !== discord.binding.imageDigestSha256
    || meetingService.repositoryDigest.endsWith(`@sha256:${discord.binding.imageDigestSha256}`) === false) {
    throw new Error("Hosted remote admission composition is not bound to the exact private deployment and plan");
  }
  return Object.freeze({ ...value, campaignId, meetingPlatformRevision, planSha256,
    deployment: Object.freeze({ ...value.deployment, expectation }) });
}

function assertRequest(
  request: HostedCampaignRemoteAdmissionProbeRequest,
  config: HostedRemoteAdmissionCompositionConfig,
): void {
  if (request.campaignId !== config.campaignId
    || request.planSha256 !== config.planSha256
    || request.meetingPlatformRevision !== config.meetingPlatformRevision) {
    throw new Error("Hosted remote admission request does not match the trusted runtime binding");
  }
}
