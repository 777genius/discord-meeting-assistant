import { z } from "zod";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);

/** Immutable release identity shared by campaign receipts and retained proof. */
export const hostedCampaignReleaseReferenceV1Schema = z.object({
  releaseBindingSha256: sha256Schema,
  releaseId: identifierSchema,
  trustRootSha256: sha256Schema,
}).strict();

export type HostedCampaignReleaseReferenceV1 = Readonly<
  z.infer<typeof hostedCampaignReleaseReferenceV1Schema>
>;
