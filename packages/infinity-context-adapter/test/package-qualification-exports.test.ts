import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, it } from "vitest";

import * as packageRoot from "../src/index.js";

it("exposes final admission as the only root production qualification path", () => {
  expect(packageRoot).toHaveProperty("admitFinalCampaign");
  expect(packageRoot).not.toHaveProperty("createInfinitySemanticQualificationManifest");
  expect(packageRoot).not.toHaveProperty("infinitySemanticQualificationSchema");
});

it("keeps the legacy production manifest unavailable to an installed consumer", async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "quality-installed-consumer-"));
  const installedPath = join(consumerRoot, "node_modules", "@discord-meeting",
    "infinity-context-adapter");
  await mkdir(dirname(installedPath), { recursive: true });
  await symlink(new URL("..", import.meta.url), installedPath, "dir");
  const probePath = join(consumerRoot, "probe.mts");
  await writeFile(probePath, `import * as api from "@discord-meeting/infinity-context-adapter";
if (typeof api.admitFinalCampaign !== "function") throw new Error("final admission missing");
if ("createInfinitySemanticQualificationManifest" in api ||
  "infinitySemanticQualificationSchema" in api) throw new Error("legacy qualification exported");\n`);
  expect(() => execFileSync(process.execPath, ["--import", import.meta.resolve("tsx/esm"), probePath], {
    cwd: consumerRoot, stdio: "pipe" })).not.toThrow();
});
