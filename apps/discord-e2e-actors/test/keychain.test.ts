import { describe, expect, it } from "vitest";

import { MacOsKeychainSecretReader } from "../src/keychain.js";

const validToken = `${"a".repeat(24)}.${"b".repeat(6)}.${"c".repeat(38)}`;

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
