import { spawn } from "node:child_process";

import type { SshDeploymentProbeSettings } from "./ssh-deployment-probe-validation.js";

export class EvidenceProbeInterruptedError extends Error {
  public readonly exitCode: number;

  public constructor(public readonly signal: NodeJS.Signals) {
    super(`evidence probe interrupted by ${signal}`);
    this.name = "EvidenceProbeInterruptedError";
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

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

export async function runDockerContainerProbe(
  options: SshDeploymentProbeSettings,
  containerId: string,
  args: readonly string[],
): Promise<string> {
  return runRemoteProbe(options, [
    "docker",
    "exec",
    "-i",
    "-w",
    "/app/apps/meeting-platform",
    containerId,
    ...args,
  ]);
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
    const child = spawn(executable, [...args], {
      env: sshProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminationError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let hardStopTimer: ReturnType<typeof setTimeout> | undefined;
    const stopForSignal = (signal: NodeJS.Signals): void => {
      terminate(new EvidenceProbeInterruptedError(signal));
    };
    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(hardStopTimer);
      process.off("SIGINT", stopForSignal);
      process.off("SIGTERM", stopForSignal);
      settle();
    };
    const terminate = (error: Error): void => {
      if (terminationError !== undefined) {
        return;
      }
      terminationError = error;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        hardStopTimer = setTimeout(() => {
          finish(() => {
            reject(new Error("evidence probe process did not exit after SIGKILL"));
          });
        }, 5_000);
      }, 5_000);
    };
    const timeout = setTimeout(() => {
      terminate(new Error(`evidence probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    process.once("SIGINT", stopForSignal);
    process.once("SIGTERM", stopForSignal);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 16 * 1_024 * 1_024) {
        terminate(new Error("evidence probe output exceeded 16 MiB"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 16 * 1_024 * 1_024) {
        terminate(new Error("evidence probe output exceeded 16 MiB"));
      }
    });
    child.once("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.once("close", (code) => {
      if (terminationError !== undefined) {
        finish(() => {
          reject(terminationError);
        });
        return;
      }
      if (code !== 0) {
        finish(() => {
          reject(new Error(`evidence probe failed with exit code ${String(code)}`));
        });
        return;
      }
      finish(() => {
        resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });
  });
}

function sshProcessEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "LANG", "LC_ALL", "PATH", "SSH_AUTH_SOCK"] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}
