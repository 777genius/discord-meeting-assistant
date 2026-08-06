import { readdir } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const alwaysIgnoredDirectoryNames = new Set([".git", "node_modules"]);
const generatedDirectoryNames = new Set([".nx", "coverage", "dist"]);

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function isProductionSource(relativePath: string): boolean {
  if (!sourceExtensions.has(extname(relativePath))) {
    return false;
  }
  const segments = relativePath.split("/");
  return segments[0] === "infra" || segments.includes("src");
}

export async function collectProductionSourceFiles(
  repositoryRoot: string,
  searchRoots: readonly string[],
): Promise<readonly string[]> {
  const files: string[] = [];

  const shouldIgnoreDirectory = (absolutePath: string, name: string): boolean => {
    if (alwaysIgnoredDirectoryNames.has(name)) {
      return true;
    }
    const relativePath = normalizePath(relative(repositoryRoot, absolutePath));
    const segments = relativePath.split("/");
    const isInsideSource = segments[0] === "infra" || segments.includes("src");
    return !isInsideSource && (generatedDirectoryNames.has(name) || name.startsWith("."));
  };

  const visit = async (absolutePath: string): Promise<void> => {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = resolve(absolutePath, entry.name);
      if (entry.isDirectory() && shouldIgnoreDirectory(entryPath, entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        const relativePath = normalizePath(relative(repositoryRoot, entryPath));
        if (isProductionSource(relativePath)) {
          files.push(relativePath);
        }
      }
    }
  };

  for (const searchRoot of searchRoots) {
    await visit(resolve(repositoryRoot, searchRoot));
  }
  return files.toSorted();
}
