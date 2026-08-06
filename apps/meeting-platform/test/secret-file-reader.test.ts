import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readSecretFile } from "../src/config/secret-file-reader.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) =>
      rm(root, { force: true, recursive: true })
    ),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meeting-platform-secret-"));
  temporaryRoots.push(root);
  return root;
}

describe("readSecretFile", () => {
  it("reads and trims a small regular file", async () => {
    const root = await temporaryRoot();
    const path = join(root, "secret");
    await writeFile(path, "  secure-value\n");

    await expect(readSecretFile(path)).resolves.toBe("secure-value");
  });

  it("rejects symlinks and non-regular paths", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source");
    const link = join(root, "link");
    const directory = join(root, "directory");
    await writeFile(source, "secure-value");
    await symlink(source, link);
    await mkdir(directory);

    await expect(readSecretFile(link)).rejects.toThrow(
      "small regular non-symlink file",
    );
    await expect(readSecretFile(directory)).rejects.toThrow(
      "small regular non-symlink file",
    );
  });

  it("rejects oversized, empty, and NUL-containing values", async () => {
    const root = await temporaryRoot();
    const oversized = join(root, "oversized");
    const empty = join(root, "empty");
    const withNull = join(root, "with-null");
    await writeFile(oversized, Buffer.alloc(65_537, 97));
    await writeFile(empty, " \n");
    await writeFile(withNull, "secure\0value");

    await expect(readSecretFile(oversized)).rejects.toThrow(
      "small regular non-symlink file",
    );
    await expect(readSecretFile(empty)).rejects.toThrow(
      "non-empty text value",
    );
    await expect(readSecretFile(withNull)).rejects.toThrow(
      "non-empty text value",
    );
  });
});
