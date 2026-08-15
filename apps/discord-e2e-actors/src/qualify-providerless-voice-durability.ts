import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { hostedCampaignReleaseReferenceV1Schema } from
  "./hosted-campaign-release-reference.js";
import { qualifyProviderlessVoiceDurability } from
  "./providerless-voice-durability-qualification.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const releasePath = requiredFlag(args, "--release-reference");
  const sourceRevision = requiredFlag(args, "--source-revision");
  const outputPath = requiredFlag(args, "--output");
  const release = hostedCampaignReleaseReferenceV1Schema.parse(
    JSON.parse(await readFile(releasePath, "utf8")) as unknown,
  );
  const evidence = qualifyProviderlessVoiceDurability({ release, sourceRevision });
  await writeCreateOnly(outputPath, evidence);
  process.stdout.write(`${JSON.stringify({
    artifactSha256: evidence.artifactSha256,
    executionMode: evidence.executionMode,
    outputPath,
    simulatedDurationMs: evidence.simulatedDurationMs,
    status: "passed",
  })}\n`);
}

function requiredFlag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing required ${name}`);
  }
  return value;
}

async function writeCreateOnly(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith(
  "/qualify-providerless-voice-durability.js",
) === true) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown durability failure";
    process.stderr.write(`Providerless voice durability qualification failed: ${message}\n`);
    process.exitCode = 1;
  });
}
