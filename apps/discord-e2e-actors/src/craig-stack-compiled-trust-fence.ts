import { assertCraigCampaignStackInputMatchesTrust, type craigCampaignStackTrustSchema } from
  "./craig-campaign-stack-release-trust.js";
import type { CraigCampaignStackInput } from "./craig-disposable-campaign-stack.js";
import type { HostedCampaignReleaseReferenceV1 } from "./hosted-campaign-release-reference.js";
import type { z } from "zod";

export function assertCraigStackInputMatchesCompiledTrust(candidate: CraigCampaignStackInput,
  trustRoot: Readonly<{ craigNetworkPolicy: Readonly<{ tcpDestinationPort: 443;
    udpDestinationPorts: Readonly<{ end: number; start: number }> }>;
    craigStack: z.infer<typeof craigCampaignStackTrustSchema> }>,
  expectedRelease: HostedCampaignReleaseReferenceV1): void {
  assertCraigCampaignStackInputMatchesTrust(candidate, trustRoot.craigStack, expectedRelease);
  if (candidate.networkPolicy.udpDestinationPorts.start !== trustRoot.craigNetworkPolicy.udpDestinationPorts.start
    || candidate.networkPolicy.udpDestinationPorts.end !== trustRoot.craigNetworkPolicy.udpDestinationPorts.end) {
    throw new Error("Craig disposable network ports do not match the compiled release policy");
  }
}
