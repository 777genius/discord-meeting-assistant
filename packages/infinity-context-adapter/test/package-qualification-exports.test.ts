import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as packageRoot from "../src/index.js";

it("exposes final admission as the only root production qualification path", () => {
  expect(packageRoot).toHaveProperty("admitFinalCampaign");
  expect(packageRoot).not.toHaveProperty("createInfinitySemanticQualificationManifest");
  expect(packageRoot).not.toHaveProperty("infinitySemanticQualificationSchema");
});

describe("packed package qualification exports", () => {
  let consumerRoot: string;
  let temporaryRoot: string;

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "quality-packed-consumer-"));
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const adapterRoot = fileURLToPath(new URL("../", import.meta.url));
    const meetingCoreRoot = join(repositoryRoot, "packages", "meeting-core");
    const packedRoot = join(temporaryRoot, "packed");
    consumerRoot = join(temporaryRoot, "consumer");
    const adapterArchive = join(packedRoot, "infinity-context-adapter.tgz");
    const meetingCoreArchive = join(packedRoot, "meeting-core.tgz");
    const scriptFreeEnvironment = { ...process.env, npm_config_ignore_scripts: "true" };

    await mkdir(packedRoot, { recursive: true });
    await mkdir(consumerRoot, { recursive: true });
    execFileSync("pnpm", ["--dir", meetingCoreRoot, "pack", "--out", meetingCoreArchive], {
      env: scriptFreeEnvironment,
      stdio: "pipe",
    });
    execFileSync("pnpm", ["--dir", adapterRoot, "pack", "--out", adapterArchive], {
      env: scriptFreeEnvironment,
      stdio: "pipe",
    });
    await writeFile(join(consumerRoot, "package.json"), JSON.stringify({
      dependencies: {
        "@discord-meeting/infinity-context-adapter": `file:${adapterArchive}`,
      },
      private: true,
      type: "module",
    }));
    await writeFile(join(consumerRoot, "pnpm-workspace.yaml"), `packages:
  - "."
overrides:
  "@discord-meeting/meeting-core": ${JSON.stringify(`file:${meetingCoreArchive}`)}
  "@infinity-context/sdk": ${JSON.stringify(`file:${join(repositoryRoot,
    "vendor/infinity-context/artifacts/infinity-context-sdk-0.1.0-249245a9.tgz")}`)}
  "@infinity-context/sdk-v2": ${JSON.stringify(`file:${join(repositoryRoot,
    "vendor/infinity-context/artifacts/infinity-context-sdk-0.2.0.tgz")}`)}
`);
    execFileSync("pnpm", ["install", "--offline", "--ignore-scripts", "--prod",
      "--no-frozen-lockfile", "--network-concurrency=1"], {
      cwd: consumerRoot,
      env: scriptFreeEnvironment,
      stdio: "pipe",
    });
  });

  afterAll(async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  it("keeps legacy production qualification unavailable from the packed artifact", async () => {
    const probePath = join(consumerRoot, "probe.mts");
    await writeFile(probePath, `import * as api from "@discord-meeting/infinity-context-adapter";
if (typeof api.admitFinalCampaign !== "function") throw new Error("final admission missing");
if ("createInfinitySemanticQualificationManifest" in api ||
  "infinitySemanticQualificationSchema" in api) throw new Error("legacy qualification exported");
const enabledLegacyExports = Object.entries(api).filter(([, value]) =>
  typeof value === "object" && value !== null &&
  "productionSemanticQualification" in value &&
  value.productionSemanticQualification === true);
if (enabledLegacyExports.length !== 0) throw new Error("enabled legacy qualification exported");\n`);
    execFileSync(process.execPath, ["--import", import.meta.resolve("tsx/esm"), probePath], {
      cwd: consumerRoot,
      stdio: "pipe",
    });
  });
});
