import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const aliases = {
  "test:semantic-quality-v4:real-adjudicate": "adjudicate",
  "test:semantic-quality-v4:real-cleanup": "cleanup-absence",
  "test:semantic-quality-v4:real-execute": "execute",
  "test:semantic-quality-v4:real-final-admission": "final-admission",
  "test:semantic-quality-v4:real-preflight": "preflight",
  "test:semantic-quality-v4:real-retention": "retention",
  "test:semantic-quality-v4:real-status": "status",
} as const;

describe("installed quality campaign package commands", () => {
  it("forward the command and both paths without an argv separator", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      readonly scripts: Record<string, string>;
    };
    const fixtureParent = await mkdtemp(join(tmpdir(), "quality-command-aliases-test-only-"));
    const fixtureRoot = join(fixtureParent, "fixture project with spaces");
    await mkdir(fixtureRoot);
    await writeFile(join(fixtureRoot, "capture-argv.mjs"),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.ARGV_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(join(fixtureRoot, "package.json"), `${JSON.stringify({
      name: "quality-command-aliases-test-only",
      private: true,
      scripts: {
        "quality-campaign": "node capture-argv.mjs",
        ...Object.fromEntries(Object.keys(aliases).map((alias) => [alias, manifest.scripts[alias]])),
      },
    }, null, 2)}\n`);

    const phasePath = join(fixtureRoot, "phase inputs", "production phase.json");
    const statusPath = join(fixtureRoot, "status receipts", "create only status.json");
    const packageRunner = process.env.npm_execpath ?? "pnpm";
    for (const [alias, command] of Object.entries(aliases)) {
      const capturePath = join(fixtureRoot, `${command}-argv.json`);
      await execute(packageRunner, ["run", alias, phasePath, statusPath], {
        cwd: fixtureRoot,
        env: { ...process.env, ARGV_CAPTURE_PATH: capturePath },
        timeout: 10_000,
      });
      expect(JSON.parse(await readFile(capturePath, "utf8"))).toEqual([
        command,
        phasePath,
        statusPath,
      ]);
    }
  }, 60_000);
});
