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
  digestVoicetextCanaryRequiredTermsV1,
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
import {
  HostedRemoteDiscordIdentityProbe,
  type BoundedRemoteContainerProcessPort,
} from "./hosted-remote-discord-identity-probe.js";
import { HostedRemoteCraigIdentityProbe } from "./hosted-remote-craig-identity-probe.js";

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);

export interface HostedDeploymentSafetyReceiptProducer {
  collect(signal?: AbortSignal): Promise<HostedDeploymentSafetyReceiptV1>;
}

export function createHostedDeploymentSafetyRevalidator(
  producer: HostedDeploymentSafetyReceiptProducer,
): (baseline: HostedDeploymentRevalidationBaselineV1, signal?: AbortSignal) => Promise<void> {
  return async (baselineValue, signal) => {
    assertNotAborted(signal);
    const baseline = hostedDeploymentRevalidationBaselineV1Schema.parse(baselineValue);
    const freshReceipt = await producer.collect(signal);
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
  readonly clock: HostedClockPreflightProbe & Readonly<{
    /** Pinned by trusted host wiring; never loaded from campaign evidence. */
    maximumClockSkewBoundMs: number;
  }>;
  readonly deployment: {
    readonly expectation: HostedDeploymentSafetyExpectationV1;
    readonly producer: HostedDeploymentSafetyReceiptProducer;
  };
  readonly discord: Omit<HostedDiscordIdentityReceiptInput, "roles"> & Readonly<{
    roles: Omit<HostedDiscordIdentityReceiptInput["roles"], "botikPlayback" | "remotePlatformSut">;
  }>;
  readonly craig: Readonly<{
    containerId: string;
    imageDigestSha256: string;
    sourceRevision: string;
  }>;
  readonly meetingPlatformRevision: string;
  readonly planSha256: string;
  readonly remoteContainerProcess: BoundedRemoteContainerProcessPort;
  readonly voicetext: {
    /** Pinned fixture-definition thresholds, constructed by trusted host wiring. */
    readonly fixtureExpectation: Readonly<{
      maximumCharacterErrorRate: number;
      maximumTimelineDeltaMs: number;
      maximumWordErrorRate: number;
    }>;
    readonly input: ProduceVoicetextCanaryInputV1;
    readonly runner: VoicetextCanaryRunnerV1;
  };
}

export function createHostedCampaignRemoteAdmissionProbe(
  configValue: HostedRemoteAdmissionCompositionConfig,
): HostedCampaignRemoteAdmissionProbe {
  const config = validateComposition(configValue);
  return Object.freeze({
    clockPreflightExpectation: Object.freeze({
      maximumClockSkewBoundMs: config.clock.maximumClockSkewBoundMs,
    }),
    voicetextCanaryExpectation: Object.freeze({
      binding: config.voicetext.input.binding,
      endpoint: config.voicetext.input.endpoint,
      ...config.voicetext.fixtureExpectation,
      requiredTermCount: config.voicetext.input.requiredTerms.length,
      requiredTermsExpectationSha256: digestVoicetextCanaryRequiredTermsV1(
        config.voicetext.input.requiredTerms,
      ),
    }),
    inspect: async (request: HostedCampaignRemoteAdmissionProbeRequest, signal?: AbortSignal) => {
      assertRequest(request, config);
      assertNotAborted(signal);

      // Deployment must be proven before any provider or Discord request is made.
      const deploymentSafety = await config.deployment.producer.collect(signal);
      assertNotAborted(signal);
      await produceHostedDiscordIdentityReceiptV1(createDiscordIdentityInput(config), signal);
      assertNotAborted(signal);
      const voicetextCanary = await produceVoicetextSemanticCanaryReceiptV1(
        { ...config.voicetext.input, ...(signal === undefined ? {} : { signal }) },
        config.voicetext.runner,
      );
      assertNotAborted(signal);

      // Refresh short-lived identity and clock evidence after the potentially slow
      // canary. Both are independent and completion-stamped by their producers.
      const [discordIdentity, clockExchange] = await Promise.all([
        produceHostedDiscordIdentityReceiptV1(createDiscordIdentityInput(config), signal),
        config.clock.collectClockPreflight(signal),
      ]);
      assertNotAborted(signal);
      const clockPreflight = deriveHostedClockPreflightReceiptV2(clockExchange);

      // Detect a deployment swap during the slower external probes. The final
      // receipt is the admitted baseline, not the stale first sample.
      const deploymentRevalidation = await config.deployment.producer.collect(signal);
      assertNotAborted(signal);
      assertHostedDeploymentSafetyRevalidatedV1(deploymentSafety, deploymentRevalidation);

      return Object.freeze({
        clockPreflight,
        deploymentSafety: deploymentRevalidation,
        discordIdentity,
        kind: "hosted-remote-admission-evidence" as const,
        schemaVersion: 1 as const,
        voicetextCanary,
      });
    },
  });
}

function createDiscordIdentityInput(
  config: HostedRemoteAdmissionCompositionConfig,
): HostedDiscordIdentityReceiptInput {
  const binding = config.discord.binding;
  return {
    ...config.discord,
    roles: {
      ...config.discord.roles,
      botikPlayback: {
        expectation: {
          applicationId: HOSTED_CAMPAIGN_TARGET.botikApplicationId,
          tokenFile: {
            account: "botik-playback",
            ownerUid: 10_001,
            path: "/run/secrets/discord_bot_token",
            scope: "remote-deployment-secret",
          },
        },
        probe: new HostedRemoteCraigIdentityProbe(config.remoteContainerProcess, {
          ...config.craig,
          host: binding.host,
        }),
      },
      remotePlatformSut: {
        expectation: {
          applicationId: HOSTED_CAMPAIGN_TARGET.sutApplicationId,
          tokenFile: {
            account: "sut",
            ownerUid: 10_001,
            path: "/run/secrets/discord-sut-token",
            scope: "remote-deployment-secret",
          },
        },
        probe: new HostedRemoteDiscordIdentityProbe(config.remoteContainerProcess, {
          containerId: binding.containerId,
          host: binding.host,
          imageDigestSha256: binding.imageDigestSha256,
          sourceRevision: binding.sourceRevision,
        }),
      },
    },
  };
}

function validateComposition(
  value: HostedRemoteAdmissionCompositionConfig,
): HostedRemoteAdmissionCompositionConfig {
  const campaignId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u).parse(value.campaignId);
  const meetingPlatformRevision = sourceRevisionSchema.parse(value.meetingPlatformRevision);
  const planSha256 = sha256Schema.parse(value.planSha256);
  const expectation = hostedDeploymentSafetyExpectationV1Schema.parse(value.deployment.expectation);
  const clock = Object.freeze({
    collectClockPreflight: (signal?: AbortSignal) => value.clock.collectClockPreflight(signal),
    maximumClockSkewBoundMs: z.number().int().nonnegative().max(60_000)
      .parse(value.clock.maximumClockSkewBoundMs),
  });
  const discord = value.discord;
  const voicetext = value.voicetext.input;
  const fixtureExpectation = z.object({
    maximumCharacterErrorRate: z.number().min(0).lt(1),
    maximumTimelineDeltaMs: z.number().int().nonnegative().max(60_000),
    maximumWordErrorRate: z.number().min(0).lt(1),
  }).strict().parse(value.voicetext.fixtureExpectation);
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
  const craigService = expectation.services.find(({ component }) => component === "craig");
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
    || !meetingService.repositoryDigest.endsWith(`@sha256:${discord.binding.imageDigestSha256}`)
    || craigService?.sourceRevision !== value.craig.sourceRevision
    || !craigService.repositoryDigest.endsWith(`@sha256:${value.craig.imageDigestSha256}`)) {
    throw new Error("Hosted remote admission composition is not bound to the exact private deployment and plan");
  }
  return Object.freeze({ ...value, campaignId, clock, meetingPlatformRevision, planSha256,
    deployment: Object.freeze({ ...value.deployment, expectation }),
    voicetext: Object.freeze({ ...value.voicetext, fixtureExpectation }) });
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
