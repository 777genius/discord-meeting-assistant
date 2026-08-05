import { spawn } from "node:child_process";

import type { SshDeploymentProbeSettings } from "./ssh-deployment-probe-validation.js";

export async function runDockerComposeProbe(
  options: SshDeploymentProbeSettings,
  service: "meeting-platform" | "postgres",
  args: readonly string[],
): Promise<string> {
  const compose = [
    "docker",
    "compose",
    "--env-file",
    options.envFile,
    "-f",
    options.composeFile,
    "-p",
    options.projectName,
    "exec",
    "-T",
    ...(service === "meeting-platform" ? ["-w", "/app/apps/meeting-platform"] : []),
    service,
    ...args,
  ];
  const command = `cd ${shellQuote(options.sourceRoot)} && ${compose.map(shellQuote).join(" ")}`;
  return runSshProbe(options, command);
}

export async function runRemoteProbe(
  options: SshDeploymentProbeSettings,
  args: readonly string[],
): Promise<string> {
  return runSshProbe(options, args.map(shellQuote).join(" "));
}

export function parseLastJsonLine(output: string): unknown {
  const line = output.trim().split("\n").at(-1);
  if (line === undefined || line.length === 0) {
    throw new Error("remote evidence probe returned no JSON");
  }
  return JSON.parse(line) as unknown;
}

function runSshProbe(options: SshDeploymentProbeSettings, command: string): Promise<string> {
  return runProcess(
    "ssh",
    ["-o", "BatchMode=yes", "--", options.host, command],
    options.timeoutMs,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runProcess(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`evidence probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 16 * 1_024 * 1_024) {
        child.kill("SIGTERM");
        reject(new Error("evidence probe output exceeded 16 MiB"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`evidence probe failed (${String(code)}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}
