import { digestCanonical } from "./hosted-campaign-local-admission.js";
import {
  assertHostedCampaignPlanMatchesDefinitionAndBindings,
} from "./hosted-campaign-admission.js";
import {
  evaluateHostedRemoteAdmission,
  type HostedCampaignRemoteAdmissionProbe,
} from "./hosted-campaign-remote-admission.js";
import { hostedCampaignDefinitionV1Schema } from "./hosted-campaign-plan-builder.js";
import { createHostedCampaignRemoteAdmissionProbe } from "./hosted-remote-admission-composition.js";
import {
  HOSTED_CAMPAIGN_PRODUCTION_POLICY,
  type HostedCampaignProductionCandidate,
  type HostedCampaignProductionPolicy,
} from "./hosted-campaign-production-policy.js";

export type HostedCampaignProductionCompositionFailureReason =
  | "MISSING_TRUST_BINDING"
  | "REMOTE_READINESS_INCOMPLETE"
  | "INSUFFICIENT_LAUNCH_HEADROOM";

export class HostedCampaignProductionCompositionError extends Error {
  public constructor(
    readonly reason: HostedCampaignProductionCompositionFailureReason,
    message: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = "HostedCampaignProductionCompositionError";
  }
}

export interface HostedCampaignProductionComposition {
  createInitialAdmissionProbe(input: Readonly<{
    bindings: unknown;
    definition: unknown;
    plan: unknown;
  }>): HostedCampaignRemoteAdmissionProbe;
  authorizeFreshAdmission(input: Readonly<{
    bindings: unknown;
    deadlineEpochMs: number;
    definition: unknown;
    minimumHeadroomMs: number;
    plan: unknown;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    assertReadyForFirstChild(): void;
    clockPreflightProof: NonNullable<Awaited<ReturnType<typeof evaluateHostedRemoteAdmission>>["clockPreflightProof"]>;
  }>>;
}

export function createHostedCampaignProductionComposition(
  policy: HostedCampaignProductionPolicy = HOSTED_CAMPAIGN_PRODUCTION_POLICY,
  now: () => number = Date.now,
): HostedCampaignProductionComposition {
  const composition: HostedCampaignProductionComposition = {
    createInitialAdmissionProbe: (input) => createProbe(policy, candidate(input)),
    authorizeFreshAdmission: async (input) => {
      input.signal.throwIfAborted();
      assertHeadroom(input.deadlineEpochMs, input.minimumHeadroomMs, now());
      const exactCandidate = candidate(input);
      const remote = await evaluateHostedRemoteAdmission(
        createProbe(policy, exactCandidate),
        {
          campaignId: exactCandidate.campaignId,
          meetingPlatformRevision: exactCandidate.meetingPlatformRevision,
          planSha256: exactCandidate.planSha256,
        },
        now,
        input.signal,
      );
      input.signal.throwIfAborted();
      if (remote.readiness === undefined || remote.clockPreflightProof === undefined
        || remote.missingSections.length !== 0) {
        throw new HostedCampaignProductionCompositionError(
          "REMOTE_READINESS_INCOMPLETE",
          "Hosted campaign fresh remote readiness is incomplete",
        );
      }
      const freshnessFenceEpochMs = now();
      assertHeadroom(input.deadlineEpochMs, input.minimumHeadroomMs, freshnessFenceEpochMs);
      const readinessExpiresEpochMs = Date.parse(remote.readiness.expiresAt);
      if (!Number.isSafeInteger(readinessExpiresEpochMs)
        || readinessExpiresEpochMs - freshnessFenceEpochMs < input.minimumHeadroomMs) {
        throw new HostedCampaignProductionCompositionError(
          "INSUFFICIENT_LAUNCH_HEADROOM",
          "Hosted campaign fresh readiness lacks launch headroom",
        );
      }
      return Object.freeze({
        assertReadyForFirstChild: () => {
          input.signal.throwIfAborted();
          const launchEpochMs = now();
          assertHeadroom(input.deadlineEpochMs, input.minimumHeadroomMs, launchEpochMs);
          if (readinessExpiresEpochMs - launchEpochMs < input.minimumHeadroomMs) {
            throw new HostedCampaignProductionCompositionError(
              "INSUFFICIENT_LAUNCH_HEADROOM",
              "Hosted campaign fresh readiness expired before launch",
            );
          }
        },
        clockPreflightProof: remote.clockPreflightProof,
      });
    },
  };
  return Object.freeze(composition);
}

function candidate(input: Readonly<{
  bindings: unknown;
  definition: unknown;
  plan: unknown;
}>): HostedCampaignProductionCandidate {
  const definition = hostedCampaignDefinitionV1Schema.parse(input.definition);
  const plan = assertHostedCampaignPlanMatchesDefinitionAndBindings(
    definition,
    input.bindings,
    input.plan,
  );
  return Object.freeze({
    bindings: input.bindings,
    campaignId: definition.campaignId,
    definition,
    meetingPlatformRevision: definition.revisions.meetingPlatform,
    plan,
    planSha256: digestCanonical(plan),
  });
}

function createProbe(
  policy: HostedCampaignProductionPolicy,
  exactCandidate: HostedCampaignProductionCandidate,
): HostedCampaignRemoteAdmissionProbe {
  if (policy.trustBinding === undefined) {
    throw new HostedCampaignProductionCompositionError(
      "MISSING_TRUST_BINDING",
      "Hosted campaign production trust binding is not compiled",
    );
  }
  return createHostedCampaignRemoteAdmissionProbe(policy.trustBinding.createConfig(exactCandidate));
}

function assertHeadroom(deadlineEpochMs: number, minimumHeadroomMs: number, nowEpochMs: number): void {
  if (!Number.isSafeInteger(deadlineEpochMs) || !Number.isSafeInteger(minimumHeadroomMs)
    || minimumHeadroomMs < 1 || !Number.isSafeInteger(nowEpochMs)
    || deadlineEpochMs - nowEpochMs < minimumHeadroomMs) {
    throw new HostedCampaignProductionCompositionError(
      "INSUFFICIENT_LAUNCH_HEADROOM",
      "Hosted campaign deadline lacks launch headroom",
    );
  }
}
