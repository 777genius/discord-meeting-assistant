import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSecretReader, MacOsKeychainSecretReader } from "../src/keychain.js";

const validToken = `${"a".repeat(24)}.${"b".repeat(6)}.${"c".repeat(38)}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

describe("MacOsKeychainSecretReader", () => {
  it.runIf(process.platform === "darwin")(
    "reads one bounded Keychain coordinate without exposing the token elsewhere",
    async () => {
      const calls: string[][] = [];
      const reader = new MacOsKeychainSecretReader("discord-e2e", (arguments_) => {
        calls.push([...arguments_]);
        return `${validToken}\n`;
      });

      await expect(reader.read("speaker-a")).resolves.toBe(validToken);
      expect(calls).toEqual([
        [
          "find-generic-password",
          "-w",
          "-s",
          "discord-e2e",
          "-a",
          "speaker-a",
        ],
      ]);
    },
  );

  it.runIf(process.platform === "darwin")(
    "maps command and token-shape failures to safe account-scoped errors",
    async () => {
      const unavailable = new MacOsKeychainSecretReader("discord-e2e", () => {
        throw new Error("secret command detail");
      });
      const malformed = new MacOsKeychainSecretReader("discord-e2e", () => "short");

      await expect(unavailable.read("speaker-a")).rejects.toThrow(
        "Missing Discord bot token in Keychain account speaker-a",
      );
      await expect(malformed.read("speaker-b")).rejects.toThrow(
        "Invalid Discord bot token in Keychain account speaker-b",
      );
    },
  );
});

describe("FileSecretReader", () => {
  it("reads a private regular secret file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "discord-e2e-secrets-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "speaker-a"), `${validToken}\n`, { mode: 0o600 });

    await expect(new FileSecretReader(directory).read("speaker-a")).resolves.toBe(validToken);
  });

  it("returns a stable private-file generation without deriving it from secret bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "discord-e2e-secrets-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "speaker-a"), `${validToken}\n`, { mode: 0o600 });
    const reader = new FileSecretReader(directory);

    const first = await reader.readPrivateFile("speaker-a");
    const second = await reader.readPrivateFile("speaker-a");
    expect(first).toMatchObject({
      account: "speaker-a", mode: 0o600, ownerUid: process.getuid?.(),
      path: join(directory, "speaker-a"), secret: validToken,
    });
    expect(first.generationId).toBe(second.generationId);
    expect(first.generationId).toMatch(/^file-[a-f\d]{64}$/u);
    expect(first.generationId).not.toContain(validToken);
  });

  it("rejects traversal, malformed tokens, and group-readable files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "discord-e2e-secrets-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "speaker-a"), "short", { mode: 0o600 });
    await writeFile(join(directory, "speaker-b"), `${validToken}\n`, { mode: 0o600 });
    await chmod(join(directory, "speaker-b"), 0o640);
    const reader = new FileSecretReader(directory);

    await expect(reader.read("../speaker-a")).rejects.toThrow("Invalid");
    await expect(reader.read("speaker-a")).rejects.toThrow("Missing or unsafe");
    await expect(reader.read("speaker-b")).rejects.toThrow("Missing or unsafe");
  });

  it("rejects an unsafe or symlinked secret directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "discord-e2e-secrets-parent-"));
    temporaryDirectories.push(parent);
    const directory = join(parent, "private");
    const directoryLink = join(parent, "private-link");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "speaker-a"), `${validToken}\n`, { mode: 0o600 });
    await symlink(directory, directoryLink, "dir");

    await expect(new FileSecretReader(directoryLink).read("speaker-a")).rejects.toThrow(
      "Missing or unsafe",
    );
    await chmod(directory, 0o750);
    await expect(new FileSecretReader(directory).read("speaker-a")).rejects.toThrow(
      "Missing or unsafe",
    );
  });

  it("rejects a symlinked token even when its target is private and valid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "discord-e2e-secrets-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "real-token"), `${validToken}\n`, { mode: 0o600 });
    await symlink(join(directory, "real-token"), join(directory, "speaker-a"));

    await expect(new FileSecretReader(directory).read("speaker-a")).rejects.toThrow(
      "Missing or unsafe",
    );
  });
});
