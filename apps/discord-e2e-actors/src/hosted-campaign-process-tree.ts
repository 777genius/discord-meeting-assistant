import { spawnSync, type ChildProcess } from "node:child_process";

export function signalHostedChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || !isChildTreeAlive(child)) {return;}
  try {
    if (process.platform === "win32") { child.kill(signal); }
    else { process.kill(-child.pid, signal); }
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code !== "ESRCH" && !(code === "EPERM" && process.platform === "darwin")) {throw error;}
  }
}

export async function waitForHostedChildTreeExit(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (!isChildTreeAlive(child)) {return true;}
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    await new Promise((resolve) => {setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now())));});
    if (!isChildTreeAlive(child)) {return true;}
  }
  return !isChildTreeAlive(child);
}

function isChildTreeAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) {return false;}
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
    return process.platform === "win32" || processGroupHasExecutableMember(child.pid);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ESRCH" || (code === "EPERM" && process.platform === "darwin")) {return false;}
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) { return undefined; }
  return typeof error.code === "string" ? error.code : undefined;
}

function processGroupHasExecutableMember(processGroupId: number): boolean {
  if (process.platform !== "darwin" && process.platform !== "linux") { return true; }
  const result = spawnSync("/bin/ps", ["-axo", "pgid=,stat="], {encoding: "utf8", shell: false, timeout: 1_000});
  if (result.status !== 0 || result.error !== undefined) { return true; }
  return result.stdout.split("\n").some((line) => {
    const match = /^\s*(\d+)\s+(\S+)/u.exec(line); const state = match?.[2];
    return match?.[1] === String(processGroupId) && state !== undefined && !state.startsWith("Z");
  });
}
