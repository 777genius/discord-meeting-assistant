import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect } from "vitest";

export async function assertInstalledTokenizer(installed: {
  readonly consumerRoot: string; readonly files: readonly string[];
}): Promise<void> {
  const require = createRequire(import.meta.url);
  const tokenizerModules = join(installed.consumerRoot, "node_modules", "@huggingface");
  await mkdir(tokenizerModules, { recursive: true });
  await symlink(dirname(dirname(require.resolve("@huggingface/tokenizers"))),
    join(tokenizerModules, "tokenizers"), "dir");
  const packageRoot = join(installed.consumerRoot, "node_modules", "@discord-meeting",
    "infinity-context-adapter");
  const installedRoot = join(await realpath(installed.consumerRoot), "node_modules",
    "@discord-meeting", "infinity-context-adapter");
  for (const filename of ["tokenizer.json", "tokenizer_config.json", "conformance.v1.json",
    "LICENSE.apache-2.0.txt", "NOTICE", "PROVENANCE.md"]) {
    const asset = `assets/paraphrase-multilingual-minilm-l12-v2-e8f8c211/${filename}`;
    expect(installed.files).toContain(asset);
    expect(await realpath(join(packageRoot, asset))).toBe(join(installedRoot, asset));
  }
  const modulePath = join(packageRoot, "dist", "pinned-multilingual-minilm-tokenizer.js");
  expect(await realpath(modulePath)).toBe(join(installedRoot, "dist",
    "pinned-multilingual-minilm-tokenizer.js"));
  const { PinnedMultilingualMiniLmTokenizer } = await import(pathToFileURL(modulePath).href) as
    typeof import("../src/pinned-multilingual-minilm-tokenizer.js");
  const tokenizer = new PinnedMultilingualMiniLmTokenizer();
  expect(tokenizer.profile.maxInputTokens).toBe(128);
  expect(tokenizer.profile.inputBudget?.maximumBodyTokens).toBe(72);
  expect(tokenizer.countTokens("word ".repeat(126))).toBe(128);
  expect(tokenizer.countTokens("word ".repeat(127))).toBe(129);
  expect(tokenizer.countBodyTokens("WORD ".repeat(70))).toBe(72);
  const title = `mkevidence1.${"A".repeat(43)}`;
  expect(() => tokenizer.assertDocumentInput(title, "word ".repeat(70))).not.toThrow();
  expect(() => tokenizer.assertDocumentInput(title, "word ".repeat(127)))
    .toThrow("historical document embedding input exceeds the qualified maximum");
}

export async function assertInstalledManifest(installed: {
  readonly consumerRoot: string; readonly files: readonly string[];
}): Promise<void> {
  expect(installed.files.some((value) => value.includes("test-support") ||
    value.includes("stale-generated"))).toBe(false);
  const manifest = JSON.parse(await readFile(join(installed.consumerRoot, "node_modules",
    "@discord-meeting", "infinity-context-adapter", "package.json"), "utf8")) as unknown;
  expect(JSON.stringify(manifest)).not.toMatch(/workspace:|catalog:/u);
}
