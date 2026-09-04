import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";

const FLOCK_PATH = "/usr/bin/flock";
const LOCK_WAIT_SECONDS = "30";

export async function acquireLedgerFlock(lock: FileHandle): Promise<void> {
  const child = spawn(FLOCK_PATH, ["--exclusive", "--timeout", LOCK_WAIT_SECONDS, "3"], {
    shell: false, stdio: ["ignore", "ignore", "ignore", lock.fd] });
  const timeout = setTimeout(() => {child.kill("SIGKILL");},
    (Number(LOCK_WAIT_SECONDS) + 1) * 1_000);
  try {
    const result = await new Promise<{ readonly code: number | null; readonly signal: string | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {resolve({ code, signal });});
      });
    if (result.code !== 0) {
      throw new Error("budget ledger serialization is unavailable");
    }
  } catch (error) {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {child.once("close", () => {resolve();});});
    }
    throw error;
  } finally {clearTimeout(timeout);}
}
