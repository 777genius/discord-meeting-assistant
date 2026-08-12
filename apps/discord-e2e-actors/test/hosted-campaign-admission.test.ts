import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  inspectHostedCampaignAdmission,
  verifyHostedCampaignAdmissionReceipt,
  writeCreateOnlyAdmissionReceipt,
} from "../src/hosted-campaign-admission.js";
import { parseHostedAdmissionArguments } from "../src/run-hosted-campaign-admission.js";

const fixtureRoot = new URL("./fixtures/", import.meta.url);
const accounts = ["sut", "speaker-a", "speaker-b", "conversation-observer", "speaker-d"] as const;
const capabilities = [
  "clock-preflight", "conversation-greeting-readiness", "craig-test-identity", "remote-test-isolation",
  "revision-qualified-containers", "voicetext-semantic-canary",
] as const;

describe("hosted campaign admission", () => {
  it("validates local inputs but remains blocked when remote claims have no evidence", async () => {
    const setup = await arrange();
    const receipt = await inspectHostedCampaignAdmission({
      bindings: setup.bindings, definition: setup.definition, minimumFreeBytes: 1, plan: setup.plan,
    }, () => 1_786_579_200_000);

    expect(receipt.status).toBe("blocked");
    expect(receipt.missingCapabilities).toEqual(capabilities);
    expect(receipt.secretAccountsValidated).toEqual(accounts);
    expect(verifyHostedCampaignAdmissionReceipt(receipt)).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toContain("x".repeat(50));
  });

  it("does not mistake arbitrary digest-bound files for trusted remote evidence", async () => {
    const setup = await arrange();
    const evidence = await Promise.all(capabilities.filter((capability) => capability !== "conversation-greeting-readiness").map(async (capability) => {
      const path = join(setup.root, `${capability}.json`);
      await writePrivate(path, JSON.stringify({ capability, testOnly: true }));
      return { capability, path, sha256: digest(await readFile(path)) };
    }));
    const receipt = await inspectHostedCampaignAdmission({
      bindings: setup.bindings, definition: setup.definition,
      minimumFreeBytes: 1,
      plan: setup.plan,
      remoteEvidence: { capabilities: evidence, schemaVersion: 1 },
    });
    expect(receipt.status).toBe("blocked");
    expect(receipt.missingCapabilities).toEqual(capabilities);

    const receiptPath = join(setup.root, "admission.json");
    await writeCreateOnlyAdmissionReceipt(receiptPath, receipt);
    await expect(writeCreateOnlyAdmissionReceipt(receiptPath, receipt)).rejects.toMatchObject({ code: "EEXIST" });
    expect((await readFile(receiptPath, "utf8")).includes(receipt.receiptSha256)).toBe(true);
  });

  it("rejects a plan that was not compiled from the exact definition and bindings", async () => {
    const setup = await arrange();
    await expect(inspectHostedCampaignAdmission({
      bindings: setup.bindings,
      definition: setup.definition,
      minimumFreeBytes: 1,
      plan: { ...setup.plan, thresholds: { answerFirstPacketMilliseconds: 4_001 } },
    })).rejects.toThrow("does not match the definition and bindings");
  });

  it("rejects fixture tampering, unsafe secret files, and receipt tampering", async () => {
    const fixtureSetup = await arrange();
    await writeFile(fixtureSetup.definition.speakerFixtures.a, "tampered", { mode: 0o600 });
    await expect(inspectHostedCampaignAdmission({ bindings: fixtureSetup.bindings, definition: fixtureSetup.definition, minimumFreeBytes: 1, plan: fixtureSetup.plan }))
      .rejects.toThrow("digest mismatch");

    const secretSetup = await arrange();
    await chmod(join(secretSetup.definition.secretDirectory, "conversation-observer"), 0o644);
    await expect(inspectHostedCampaignAdmission({ bindings: secretSetup.bindings, definition: secretSetup.definition, minimumFreeBytes: 1, plan: secretSetup.plan }))
      .rejects.toThrow("Missing or unsafe");

    const validSetup = await arrange();
    const receipt = await inspectHostedCampaignAdmission({ bindings: validSetup.bindings, definition: validSetup.definition, minimumFreeBytes: 1, plan: validSetup.plan });
    expect(() => verifyHostedCampaignAdmissionReceipt({ ...receipt, campaignId: "changed" }))
      .toThrow("digest is invalid");
  });

  it("parses a closed command surface", () => {
    expect(parseHostedAdmissionArguments([
      "--definition", "/private/definition.json", "--receipt", "/private/receipt.json",
      "--bindings", "/private/bindings.json", "--plan", "/private/plan.json", "--minimum-free-bytes", "1048576",
    ])).toEqual({ bindingsPath: "/private/bindings.json", definitionPath: "/private/definition.json", minimumFreeBytes: 1_048_576, planPath: "/private/plan.json", receiptPath: "/private/receipt.json" });
    expect(() => parseHostedAdmissionArguments(["--definition", "/a", "--definition", "/b"]))
      .toThrow("Usage");
  });
});

async function arrange() {
  const root = await mkdtemp(join(tmpdir(), "hosted-admission-"));
  const fixtures = join(root, "fixtures");
  const secretDirectory = join(root, "secrets");
  await Promise.all([fixtures, secretDirectory].map(async (path) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { mode: 0o700 });
  }));
  const manifest = fixtureManifestShape.parse(
    JSON.parse(await readFile(new URL("manifest.v1.json", fixtureRoot), "utf8")),
  );
  for (const fixture of manifest.fixtures) {
    for (const relativePath of [fixture.audioPath, fixture.sourcePath]) {
      await writePrivate(join(fixtures, relativePath.split("/").at(-1)!), await readFile(new URL(relativePath.split("/").at(-1)!, fixtureRoot)));
      if (relativePath === fixture.audioPath) {fixture.audioPath = relativePath.split("/").at(-1)!;}
      else {fixture.sourcePath = relativePath.split("/").at(-1)!;}
    }
  }
  const fixtureManifestPath = join(fixtures, "manifest.json");
  await writePrivate(fixtureManifestPath, JSON.stringify(manifest));
  const supplemental = supplementalShape.parse(
    JSON.parse(await readFile(new URL("supplemental-voice-playback.v1.json", fixtureRoot), "utf8")),
  );
  const supplementalName = supplemental.fixture.path.split("/").at(-1)!;
  supplemental.fixture.path = supplementalName;
  await writePrivate(join(fixtures, supplementalName), await readFile(new URL(supplementalName, fixtureRoot)));
  const supplementalManifestPath = join(fixtures, "supplemental.json");
  await writePrivate(supplementalManifestPath, JSON.stringify(supplemental));
  const thresholdsPath = join(fixtures, "thresholds.json");
  await writePrivate(thresholdsPath, JSON.stringify({
    "join-to-greeting-first-packet": 4_000,
    "question-end-to-answer-first-packet": 4_000,
    "recording-end-to-discord-first-seen": 30_000,
  }));
  await Promise.all(accounts.map((account) => writePrivate(join(secretDirectory, account), `${"x".repeat(60)}.${account}`)));
  const definition = {
    answerFirstPacketMilliseconds: 4_000, campaignId: "campaign-admission-test",
    campaignRoot: join(root, "campaigns"), clockPreflightPath: join(root, "clock.json"),
    fixtureManifestPath, recordingPlaybackOrigin: "https://recordings.test.example",
    remote: { composeFile: "/srv/test/compose.yml", environmentFile: "/srv/test/.env", sourceRoot: "/srv/test/source" },
    revisions: { craig: "a".repeat(40), meetingPlatform: "b".repeat(40), pipecat: "c".repeat(40), subscriptionRuntime: "d".repeat(40) },
    runIds: ["run-1", "run-2", "run-3"], schemaVersion: 1, secretDirectory,
    speakerFixtures: { a: join(fixtures, manifest.fixtures[0]!.audioPath), b: join(fixtures, manifest.fixtures[1]!.audioPath) },
    serviceLevelThresholdsPath: thresholdsPath, supplementalManifestPath,
  } as const;
  const bindings = { runs: [1, 2, 3].map((ordinal) => ({ remoteAttestationPath: `/tmp/discord-e2e-attestations/run-${ordinal}.json` })), schemaVersion: 1 } as const;
  const { buildResolvedHostedCampaignPlanV1 } = await import("../src/hosted-campaign-plan-builder.js");
  const plan = buildResolvedHostedCampaignPlanV1(definition, bindings);
  return { bindings, definition, plan, root };
}

async function writePrivate(path: string, contents: string | Buffer): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const fixtureManifestShape = z.object({
  fixtures: z.array(z.object({ audioPath: z.string(), sourcePath: z.string() }).passthrough()),
}).passthrough();
const supplementalShape = z.object({ fixture: z.object({ path: z.string() }).passthrough() }).passthrough();
