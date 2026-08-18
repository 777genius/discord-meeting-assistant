import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const child = new URL("./fixtures/pinned-tokenizer-child.ts", import.meta.url);
const tsxLoader = new URL(
  "../../../node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/loader.mjs",
  import.meta.url,
).href;

function run(cwd: string, environment: Readonly<Record<string, string>>): string {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, child.pathname],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...environment },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("pinned tokenizer process determinism", () => {
  it("emits byte-identical receipts across independent processes and locales", () => {
    const repositoryRoot = new URL("../../..", import.meta.url).pathname;
    const packageRoot = new URL("..", import.meta.url).pathname;

    const first = run(repositoryRoot, { LANG: "C", TZ: "UTC" });
    const second = run(packageRoot, { LANG: "uk_UA.UTF-8", TZ: "Europe/Kyiv" });

    expect(second).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      counts: [6, 7, 7, 6, 4, 12],
      runtime: {
        package: "@huggingface/tokenizers",
        version: "0.1.3",
      },
    });
  }, 20_000);
});
