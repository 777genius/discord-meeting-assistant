import { execFile } from "node:child_process";

import { z } from "zod";

const discordBotTokenSchema = z.string().trim().min(50).regex(/^\S+$/u);

interface SecretReader {
  read(account: string): Promise<string>;
}

export class MacOsKeychainSecretReader implements SecretReader {
  constructor(private readonly service: string) {}

  read(account: string): Promise<string> {
    if (process.platform !== "darwin") {
      return Promise.reject(new Error("The real Discord actor harness requires macOS Keychain"));
    }

    return new Promise<string>((resolve, reject) => {
      execFile(
        "security",
        ["find-generic-password", "-w", "-s", this.service, "-a", account],
        { encoding: "utf8", maxBuffer: 16_384 },
        (error, standardOutput) => {
          if (error !== null) {
            reject(new Error(`Missing Discord bot token in Keychain account ${account}`));
            return;
          }
          const parsed = discordBotTokenSchema.safeParse(standardOutput);
          if (!parsed.success) {
            reject(new Error(`Invalid Discord bot token in Keychain account ${account}`));
            return;
          }
          resolve(parsed.data);
        },
      );
    });
  }
}
