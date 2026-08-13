import type { HostedCampaignAdmissionReceiptV1 } from "./hosted-campaign-admission.js";
import { writeCreateOnlyPrivateJson } from "./create-only-private-json.js";

export async function writeCreateOnlyAdmissionReceipt(
  path: string,
  receipt: HostedCampaignAdmissionReceiptV1,
): Promise<void> {
  await writeCreateOnlyPrivateJson(path, receipt);
}
