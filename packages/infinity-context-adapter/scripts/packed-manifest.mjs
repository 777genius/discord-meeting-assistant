import { readFile, rename, writeFile } from "node:fs/promises";

const manifestPath = new URL("../package.json", import.meta.url);
const backupPath = new URL("../.package.pack-backup.json", import.meta.url);
const operation = process.argv[2];

if (operation === "prepare") {
  const source = await readFile(manifestPath, "utf8");
  await writeFile(backupPath, source, { flag: "wx" });
  const parsed = /** @type {unknown} */ (JSON.parse(source));
  if (typeof parsed !== "object" || parsed === null || !("exports" in parsed)) {
    throw new Error("package manifest is invalid");
  }
  const manifest = /** @type {{dependencies?: unknown,
   * exports: Record<string, {types?: string}>,
   * optionalDependencies?: Record<string, string>}} */ (parsed);
  delete manifest.dependencies;
  manifest.exports["."].types = "./dist/index.d.ts";
  manifest.exports["./quality-campaign"].types = "./dist/quality-campaign/index.d.ts";
  manifest.exports["./quality-campaign/cli"].types =
    "./dist/quality-campaign/production-cli.d.ts";
  manifest.optionalDependencies = {
    "@discord-meeting/meeting-core": "0.1.0",
    "@huggingface/tokenizers": "0.1.3",
    "@infinity-context/sdk": "0.1.0",
    "@infinity-context/sdk-v2": "0.2.0",
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} else if (operation === "restore") {
  await rename(backupPath, manifestPath);
} else {
  throw new Error("packed manifest operation must be prepare or restore");
}
