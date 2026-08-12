import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";

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
    let contents: string;
    try {
      const currentUserId = process.getuid?.();
      if (currentUserId === undefined) {
        throw new Error("file secret ownership is unsupported on this platform");
      }
      const pathMetadata = await lstat(this.#directory);
      if (pathMetadata.isSymbolicLink()) {
        throw new Error("secret directory must not be a symbolic link");
      }

      const directory = await open(
        this.#directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const directoryMetadata = await directory.stat();
        if (
          !directoryMetadata.isDirectory()
          || directoryMetadata.uid !== currentUserId
          || (directoryMetadata.mode & 0o077) !== 0
          || directoryMetadata.dev !== pathMetadata.dev
          || directoryMetadata.ino !== pathMetadata.ino
        ) {
          throw new Error("unsafe secret directory");
        }

        const secretPath = process.platform === "linux"
          ? join("/proc/self/fd", String(directory.fd), account)
          : join(this.#directory, account);
        const secret = await open(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const metadata = await secret.stat();
          if (
            !metadata.isFile()
            || metadata.uid !== currentUserId
            || metadata.size < 50
            || metadata.size > 4_096
            || (metadata.mode & 0o077) !== 0
          ) {
            throw new Error("unsafe secret file");
          }

          const currentDirectoryMetadata = await lstat(this.#directory);
          if (
            currentDirectoryMetadata.isSymbolicLink()
            || currentDirectoryMetadata.dev !== directoryMetadata.dev
            || currentDirectoryMetadata.ino !== directoryMetadata.ino
          ) {
            throw new Error("secret directory changed while opening the token");
          }
          const buffer = Buffer.alloc(4_097);
          const { bytesRead } = await secret.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 4_096) {
            throw new Error("secret file grew beyond the size limit");
          }
          contents = buffer.toString("utf8", 0, bytesRead);
        } finally {
          await secret.close();
        }
      } finally {
        await directory.close();
      }
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
