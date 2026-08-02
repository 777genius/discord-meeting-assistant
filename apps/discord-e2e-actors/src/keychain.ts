import { execFileSync } from "node:child_process";

import { z } from "zod";

const discordBotTokenSchema = z.string().trim().min(50).regex(/^\S+$/u);

interface SecretReader {
  read(account: string): Promise<string>;
}

type KeychainCommand = (arguments_: readonly string[]) => string;

const runSecurityCommand: KeychainCommand = (arguments_) =>
  execFileSync("security", arguments_, {
    encoding: "utf8",
    maxBuffer: 16_384,
    timeout: 10_000,
  });

export class MacOsKeychainSecretReader implements SecretReader {
  constructor(
    private readonly service: string,
    private readonly command: KeychainCommand = runSecurityCommand,
  ) {}

  read(account: string): Promise<string> {
    if (process.platform !== "darwin") {
      return Promise.reject(new Error("The real Discord actor harness requires macOS Keychain"));
    }

    let standardOutput: string;
    try {
      standardOutput = this.command([
        "find-generic-password",
        "-w",
        "-s",
        this.service,
        "-a",
        account,
      ]);
    } catch {
      return Promise.reject(
        new Error(`Missing Discord bot token in Keychain account ${account}`),
      );
    }
    const parsed = discordBotTokenSchema.safeParse(standardOutput);
    if (!parsed.success) {
      return Promise.reject(
        new Error(`Invalid Discord bot token in Keychain account ${account}`),
      );
    }
    return Promise.resolve(parsed.data);
  }
}
