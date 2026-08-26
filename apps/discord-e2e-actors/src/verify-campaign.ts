import { readFile } from "node:fs/promises";

import {
  deploymentRevisionExpectationSchema,
  fixtureManifestV1Schema,
  historicalReplyCampaignEvidenceV1Schema,
  retainedE2eEvidenceSchema,
  serviceLevelThresholdsSchema,
  verifyE2eCampaign,
} from "./e2e-evidence.js";
import { thinRemediationProofV1Schema } from "./thin-remediation-proof.js";

async function main(): Promise<void> {
  const { evidencePaths, historicalReplyPath, manifestPath, thinRemediationPath, thresholdsPath } =
    parseCampaignArguments(process.argv.slice(2));
  const manifest = fixtureManifestV1Schema.parse(await readJson(manifestPath));
  const runs = await Promise.all(
    evidencePaths.map(async (path) => retainedE2eEvidenceSchema.parse(await readJson(path))),
  );
  const expectedRevisions = deploymentRevisionExpectationSchema.parse({
    craig: process.env.DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION,
    meetingPlatform: process.env.DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION,
    pipecat: process.env.DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION,
    subscriptionRuntime: process.env.DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION,
  });
  const thresholds = thresholdsPath === undefined
    ? undefined
    : serviceLevelThresholdsSchema.parse(await readJson(thresholdsPath));
  const historicalReply = historicalReplyPath === undefined
    ? undefined
    : historicalReplyCampaignEvidenceV1Schema.parse(await readJson(historicalReplyPath));
  const thinRemediation = thinRemediationProofV1Schema.parse(await readJson(thinRemediationPath));
  const verification = verifyE2eCampaign(
    manifest,
    runs,
    expectedRevisions,
    thresholds,
    { ...(historicalReply === undefined ? {} : { historicalReply }), thinRemediation },
  );
  process.stdout.write(`${JSON.stringify(verification, undefined, 2)}\n`);
  if (!verification.passed) {
    process.exitCode = 1;
  }
}

export function parseCampaignArguments(args: readonly string[]): {
  readonly evidencePaths: readonly string[];
  readonly historicalReplyPath?: string;
  readonly manifestPath: string;
  readonly thinRemediationPath: string;
  readonly thresholdsPath?: string;
} {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const positional: string[] = [];
  let historicalReplyPath: string | undefined;
  let firstFlag: string | undefined;
  let thresholdsPath: string | undefined;
  let thinRemediationPath: string | undefined;
  for (let index = 0; index < normalized.length; index += 1) {
    const value = normalized[index]!;
    if (value === "--service-level-thresholds" || value === "--historical-reply" ||
      value === "--thin-remediation") {
      firstFlag ??= value;
      const path = normalized[index + 1];
      if (path === undefined || path.startsWith("--")) {
        const label = argumentLabel(value);
        throw new Error(`${label} requires one JSON path`);
      }
      if (value === "--service-level-thresholds") {
        if (thresholdsPath !== undefined) { throw new Error("Service-level thresholds are duplicated"); }
        thresholdsPath = path;
      } else if (value === "--historical-reply") {
        if (historicalReplyPath !== undefined) { throw new Error("Historical reply proof is duplicated"); }
        historicalReplyPath = path;
      } else {
        if (thinRemediationPath !== undefined) { throw new Error("Thin remediation proof is duplicated"); }
        thinRemediationPath = path;
      }
      index += 1;
    } else {
      if (firstFlag !== undefined) {
        const label = argumentLabel(firstFlag);
        throw new Error(`${label} must follow all campaign evidence paths`);
      }
      positional.push(value);
    }
  }
  const [manifestPath, ...evidencePaths] = positional;
  if (manifestPath === undefined || evidencePaths.length < 3 || thinRemediationPath === undefined) {
    throw new Error(
      "Usage: verify-campaign <manifest.json> <evidence.json> <evidence.json> <evidence.json> [...] "
      + "[--historical-reply <proof.json>] --thin-remediation <proof.json> "
      + "[--service-level-thresholds <thresholds.json>]",
    );
  }
  return {
    evidencePaths,
    ...(historicalReplyPath === undefined ? {} : { historicalReplyPath }),
    manifestPath,
    thinRemediationPath,
    ...(thresholdsPath === undefined ? {} : { thresholdsPath }),
  };
}

function argumentLabel(flag: string): string {
  return flag === "--service-level-thresholds" ? "Service-level thresholds"
    : flag === "--historical-reply" ? "Historical reply proof" : "Thin remediation proof";
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/verify-campaign.js") === true) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown campaign verifier failure";
    process.stderr.write(`Discord E2E campaign verification failed: ${message}\n`);
    process.exitCode = 1;
  });
}
