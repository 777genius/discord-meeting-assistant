import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

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

export class FileSecretReader implements SecretReader {
  readonly #directory: string;

  public constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  public async read(account: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(account)) {
      throw new Error("Invalid Discord bot secret account name");
    }
    const path = resolve(this.#directory, account);
    if (!path.startsWith(`${this.#directory}/`)) {
      throw new Error("Discord bot secret path escaped its directory");
    }

    let metadata;
    let contents: string;
    try {
      metadata = await stat(path);
      if (!metadata.isFile() || metadata.size < 50 || metadata.size > 4_096) {
        throw new Error("invalid secret file");
      }
      if ((metadata.mode & 0o077) !== 0) {
        throw new Error("insecure secret file permissions");
      }
      contents = await readFile(path, "utf8");
    } catch {
      throw new Error(`Missing or unsafe Discord bot token file for account ${account}`);
    }
    const parsed = discordBotTokenSchema.safeParse(contents);
    if (!parsed.success) {
      throw new Error(`Invalid Discord bot token file for account ${account}`);
    }
    return parsed.data;
  }
}
