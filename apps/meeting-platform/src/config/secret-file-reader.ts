import { lstat, readFile } from "node:fs/promises";

export async function readSecretFile(path: string): Promise<string> {
  const descriptor = await lstat(path);
  if (
    !descriptor.isFile() ||
    descriptor.isSymbolicLink() ||
    descriptor.size > 65_536
  ) {
    throw new Error("Secret path must be a small regular non-symlink file");
  }
  const value = (await readFile(path, "utf8")).trim();
  if (value.length === 0 || value.includes("\0")) {
    throw new Error("Secret file must contain a non-empty text value");
  }
  return value;
}
