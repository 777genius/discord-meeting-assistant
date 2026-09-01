import { assertCraigCampaignStackInputMatchesTrust, type craigCampaignStackTrustSchema } from
  "./craig-campaign-stack-release-trust.js";
import type { CraigCampaignStackInput } from "./craig-disposable-campaign-stack.js";
import type { HostedCampaignReleaseReferenceV1 } from "./hosted-campaign-release-reference.js";
import type { z } from "zod";
import { digestCraigCampaignStackCanonical } from "./craig-campaign-stack-digest.js";
import { deriveCraigCampaignNetworkPolicy } from "./craig-campaign-network-plan.js";
import { join } from "node:path";

export function assertCraigStackInputMatchesCompiledTrust(candidate: CraigCampaignStackInput,
  trustRoot: Readonly<{ campaignRoot: string; craigNetworkPolicy: Readonly<{ tcpDestinationPort: 443;
    udpDestinationPorts: Readonly<{ end: number; start: number }> }>;
    craigStack: z.infer<typeof craigCampaignStackTrustSchema> }>,
  expectedRelease: HostedCampaignReleaseReferenceV1): void {
  if (candidate.campaignRoot !== trustRoot.campaignRoot) {
    throw new Error("Craig campaign root does not match the compiled release trust root");
  }
  if (candidate.credentialFile !== join(candidate.campaignRoot, candidate.campaignId, "control", "craig.env")) {
    throw new Error("Craig credential path does not match the compiled campaign-root authority");
  }
  assertCraigCampaignStackInputMatchesTrust(candidate, trustRoot.craigStack, expectedRelease);
  const expectedNetwork = deriveCraigCampaignNetworkPolicy(candidate.campaignId, expectedRelease,
    trustRoot.craigNetworkPolicy.udpDestinationPorts);
  if (digestCraigCampaignStackCanonical(candidate.networkPolicy)
      !== digestCraigCampaignStackCanonical(expectedNetwork)
    || candidate.networkPolicy.udpDestinationPorts.start !== trustRoot.craigNetworkPolicy.udpDestinationPorts.start
    || candidate.networkPolicy.udpDestinationPorts.end !== trustRoot.craigNetworkPolicy.udpDestinationPorts.end) {
    throw new Error("Craig disposable network ports do not match the compiled release policy");
  }
}
