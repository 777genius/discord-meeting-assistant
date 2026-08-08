import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";

import type { RuntimeReadinessInspectorPort } from "./types.js";

export interface FileRuntimeReadinessInspectorOptions {
  readonly authJsonPaths: readonly string[];
  readonly isolatedCwd: string;
  readonly localEncryptionKeyFile: string;
  readonly stateRoot: string;
}

export class FileRuntimeReadinessInspector
  implements RuntimeReadinessInspectorPort
{
  public constructor(
    private readonly options: FileRuntimeReadinessInspectorOptions,
  ) {}

  public async inspect(): Promise<void> {
    for (const path of [
      ...this.options.authJsonPaths,
      this.options.localEncryptionKeyFile,
    ]) {
      const secretStat = await lstat(path);
      if (!secretStat.isFile() || secretStat.isSymbolicLink()) {
        throw new Error("Subscription runtime secret input is not a regular file");
      }
      if ((secretStat.mode & 0o077) !== 0 || (await realpath(path)) !== path) {
        throw new Error("Subscription runtime secret input is not private");
      }
      await access(path, constants.R_OK);
    }

    for (const path of [this.options.stateRoot, this.options.isolatedCwd]) {
      const pathStat = await lstat(path);
      if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
        throw new Error("Subscription runtime private directory is unavailable");
      }
      await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
      if ((await realpath(path)) !== path) {
        throw new Error("Subscription runtime private directory must be canonical");
      }
    }
  }
}
