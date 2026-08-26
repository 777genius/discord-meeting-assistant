import { z } from "zod";

import { digestCraigCampaignStackCanonical as digestCanonical } from "./craig-campaign-stack-digest.js";
import { hostedCampaignReleaseReferenceV1Schema, type HostedCampaignReleaseReferenceV1 } from
  "./hosted-campaign-release-reference.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const canonicalIpv4 = z.string().regex(/^(?:10|172)\.(?:\d{1,3}\.){2}\d{1,3}$/u).refine((value) =>
  value.split(".").every((octet) => Number(octet) <= 255 && (octet === "0" || !octet.startsWith("0"))));
export const craigCampaignComposeProjectSchema = z.string().regex(/^craig-e2e-[a-f\d]{20}$/u);
export const craigCampaignNetworkPolicySchema = z.object({
  botIpv4: canonicalIpv4,
  bridgeInterface: z.string().regex(/^[a-z][a-z0-9]{0,14}$/u),
  chain: z.string().regex(/^[A-Z][A-Z0-9_]{0,27}$/u),
  databaseIpv4: canonicalIpv4,
  name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/u),
  subnet: z.string().regex(/^(?:10|172)\.(?:\d{1,3}\.){2}0\/24$/u),
  tcpDestinationPort: z.literal(443),
  udpDestinationPorts: z.object({ end: z.number().int().min(1).max(65_535),
    start: z.number().int().min(1).max(65_535) }).strict()
    .refine(({ end, start }) => end >= start, "UDP destination port range is inverted"),
}).strict();

export function deriveCraigCampaignNetworkPolicy(campaignId: string, release: HostedCampaignReleaseReferenceV1,
  udpDestinationPorts: Readonly<{ end: number; start: number }>): z.infer<typeof craigCampaignNetworkPolicySchema> {
  const projectName = craigProjectName(campaignId, release);
  const identity = digestCanonical({ campaignId, release });
  const secondOctet = 64 + (Number.parseInt(identity.slice(0, 2), 16) % 64);
  const thirdOctet = Number.parseInt(identity.slice(2, 4), 16);
  return craigCampaignNetworkPolicySchema.parse({ botIpv4: `10.${secondOctet}.${thirdOctet}.2`,
    bridgeInterface: `ce2e${identity.slice(0, 10)}`, chain: `CE2E_${identity.slice(0, 20).toUpperCase()}`,
    databaseIpv4: `10.${secondOctet}.${thirdOctet}.3`, name: `${projectName}-network`,
    subnet: `10.${secondOctet}.${thirdOctet}.0/24`, tcpDestinationPort: 443, udpDestinationPorts });
}

export function craigProjectName(campaignId: string, release: HostedCampaignReleaseReferenceV1): string {
  identifier.parse(campaignId);
  const parsedRelease = hostedCampaignReleaseReferenceV1Schema.parse(release);
  return `craig-e2e-${digestCanonical({ campaignId, release: parsedRelease }).slice(0, 20)}`;
}
