import {
  hostedClockPreflightReceiptV2Schema,
  type HostedClockPreflightReceiptV2,
} from "./hosted-clock-proof-v2.js";
import { writeCreateOnlyPrivateJson } from "./create-only-private-json.js";

export async function writeCreateOnlyClockPreflightProof(
  path: string,
  proof: HostedClockPreflightReceiptV2,
): Promise<void> {
  hostedClockPreflightReceiptV2Schema.parse(proof);
  await writeCreateOnlyPrivateJson(path, proof);
}
