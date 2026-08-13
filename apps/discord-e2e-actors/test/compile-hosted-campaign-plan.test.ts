import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  compileHostedCampaignPlanCli,
  parseHostedCampaignPlanCompilerArguments,
  readStablePrivateJson,
} from "../src/compile-hosted-campaign-plan.js";
import { parseHostedCampaignPlan } from "../src/hosted-campaign-run-config.js";

const definition = () => ({
  answerFirstPacketMilliseconds: 4_000,
  campaignId: "campaign-compiler-test",
  campaignRoot: "/private/e2e/campaigns",
  clockPreflightPath: "/private/e2e/clock/preflight.json",
  fixtureManifestPath: "/private/e2e/fixtures/manifest.json",
  recordingPlaybackOrigin: "https://recordings.test.example",
  remote: {
    composeFile: "/srv/discord-meeting/source/infra/deployment/compose.yaml",
    environmentFile: "/srv/discord-meeting/source.env",
    sourceRoot: "/srv/discord-meeting/source",
  },
  revisions: {
    craig: "a".repeat(40), meetingPlatform: "b".repeat(40),
    pipecat: "c".repeat(40), subscriptionRuntime: "d".repeat(40),
  },
  runIds: ["compiler-run-1", "compiler-run-2", "compiler-run-3"],
  schemaVersion: 1,
  secretDirectory: "/run/secrets/discord-e2e",
  speakerFixtures: { a: "/private/e2e/fixtures/speaker-a.ogg", b: "/private/e2e/fixtures/speaker-b.ogg" },
  serviceLevelThresholdsPath: "/private/e2e/fixtures/service-level-thresholds.json",
  supplementalManifestPath: "/private/e2e/fixtures/supplemental-manifest.json",
});

const bindings = () => ({
  runs: [1, 2, 3].map((ordinal) => ({
    remoteAttestationPath: `/tmp/discord-e2e-attestations/compiler-run-${ordinal}.json`,
  })),
  schemaVersion: 1,
});

describe("hosted campaign plan compiler CLI", () => {
  it("compiles private inputs into one create-only private executable plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-plan-compiler-"));
    const definitionPath = join(root, "definition.json");
    const bindingsPath = join(root, "bindings.json");
    const outputPath = join(root, "plans", "campaign.json");
    await writePrivateJson(definitionPath, definition());
    await writePrivateJson(bindingsPath, bindings());

    await compileHostedCampaignPlanCli([
      "--definition", definitionPath, "--bindings", bindingsPath, "--output", outputPath,
    ]);

    expect((await lstat(dirname(outputPath))).mode & 0o777).toBe(0o700);
    expect((await lstat(outputPath)).mode & 0o777).toBe(0o600);
    expect(parseHostedCampaignPlan(JSON.parse(await readFile(outputPath, "utf8")) as unknown).runs)
      .toHaveLength(3);
    await expect(compileHostedCampaignPlanCli([
      "--definition", definitionPath, "--bindings", bindingsPath, "--output", outputPath,
    ])).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects symlinked, permissive, and hard-linked private inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-plan-input-"));
    const path = join(root, "input.json");
    await writePrivateJson(path, definition());
    const linkedPath = join(root, "linked.json");
    await import("node:fs/promises").then(({ link }) => link(path, linkedPath));
    await expect(readStablePrivateJson(path)).rejects.toThrow(/single-link/u);

    const permissivePath = join(root, "permissive.json");
    await writePrivateJson(permissivePath, definition());
    await chmod(permissivePath, 0o644);
    await expect(readStablePrivateJson(permissivePath)).rejects.toThrow(/0600/u);

    const symlinkPath = join(root, "symlink.json");
    await symlink(permissivePath, symlinkPath);
    await expect(readStablePrivateJson(symlinkPath)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("rejects a private input not owned by the current process user", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-plan-owner-"));
    const path = join(root, "input.json");
    await writePrivateJson(path, definition());
    const actualUid = (await lstat(path)).uid;
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1);
    try {
      await expect(readStablePrivateJson(path)).rejects.toThrow(/owned by the current user/u);
    } finally {
      getuid.mockRestore();
    }
  });

  it("accepts arguments in any order but rejects duplicates and relative paths", () => {
    expect(parseHostedCampaignPlanCompilerArguments([
      "--output", "/private/out.json", "--bindings", "/private/bindings.json",
      "--definition", "/private/definition.json",
    ])).toEqual({
      bindingsPath: "/private/bindings.json",
      definitionPath: "/private/definition.json",
      outputPath: "/private/out.json",
    });
    expect(() => parseHostedCampaignPlanCompilerArguments([
      "--definition", "relative.json", "--bindings", "/private/bindings.json",
      "--output", "/private/out.json",
    ])).toThrow(/absolute/u);
    expect(() => parseHostedCampaignPlanCompilerArguments([
      "--definition", "/one.json", "--definition", "/two.json", "--output", "/out.json",
    ])).toThrow(/unique/u);
  });
});

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
}
