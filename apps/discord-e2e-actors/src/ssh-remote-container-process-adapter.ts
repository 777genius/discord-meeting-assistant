import { spawn } from "node:child_process";

import { z } from "zod";

import type {
  BoundedRemoteContainerProcessPort,
  BoundedRemoteContainerProcessResult,
  HostedRemoteDiscordProbeBinding,
} from "./hosted-remote-discord-identity-probe.js";

const composeProject = "discord-meeting-assistant";
const composeService = "meeting-platform";
const containerWorkingDirectory = "/app/apps/meeting-platform";
const containerFormat = `{"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}},"composeService":{{json (index .Config.Labels "com.docker.compose.service")}},"containerId":{{json .Id}},"imageId":{{json .Image}},"running":{{json .State.Running}},"testOnly":{{json (index .Config.Labels "e2e.test-only")}}}`;
const imageFormat = `{"imageId":{{json .Id}},"repositoryDigests":{{json .RepoDigests}},"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}`;

const hostSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u);
const containerIdSchema = z.string().regex(/^[a-f\d]{64}$/u);
const imageIdSchema = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const repositoryDigestSchema = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const containerOutputSchema = z.object({
  composeProject: z.literal(composeProject),
  composeService: z.literal(composeService),
  containerId: containerIdSchema,
  imageId: imageIdSchema,
  running: z.literal(true),
  testOnly: z.literal("true"),
}).strict();
const imageOutputSchema = z.object({
  imageId: imageIdSchema,
  repositoryDigests: z.array(repositoryDigestSchema).min(1),
  sourceRevision: sourceRevisionSchema,
}).strict();

export interface BoundedRemoteCommandRequest {
  readonly args: readonly string[];
  readonly host: string;
  readonly maximumOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface BoundedRemoteCommandPort {
  execute(request: BoundedRemoteCommandRequest): Promise<BoundedRemoteContainerProcessResult>;
}

/**
 * Proves the immutable identity and test-only labels of a running Meeting
 * Platform container before executing the caller's exact argv in that container.
 */
export class SshRemoteContainerProcessAdapter implements BoundedRemoteContainerProcessPort {
  public constructor(
    private readonly remote: BoundedRemoteCommandPort = { execute: runBoundedSshCommand },
    private readonly now: () => number = Date.now,
  ) {}

  public async execute(request: Parameters<BoundedRemoteContainerProcessPort["execute"]>[0]) {
    assertRequestBounds(request);
    const startedAt = this.now();
    let remainingOutputBytes = request.maximumOutputBytes;
    const run = async (args: readonly string[]): Promise<BoundedRemoteContainerProcessResult> => {
      const elapsedMs = Math.max(0, this.now() - startedAt);
      const timeoutMs = request.timeoutMs - elapsedMs;
      if (timeoutMs < 1) {
        throw new Error("Remote container process timed out during provenance inspection");
      }
      const result = await this.remote.execute({
        args,
        host: request.binding.host,
        maximumOutputBytes: remainingOutputBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        timeoutMs,
      });
      remainingOutputBytes -= byteLength(result);
      if (remainingOutputBytes < 0) {
        throw new Error("Remote container process exceeded its output bound");
      }
      return result;
    };

    const container = containerOutputSchema.parse(parseSuccessfulJson(
      await run(["docker", "inspect", "--format", containerFormat, request.binding.containerId]),
      "container",
    ));
    assertContainerBinding(container, request.binding);

    const image = imageOutputSchema.parse(parseSuccessfulJson(
      await run(["docker", "image", "inspect", "--format", imageFormat, container.imageId]),
      "image",
    ));
    assertImageBinding(image, container.imageId, request.binding);

    return run([
      "docker", "exec", "-i", "-w", containerWorkingDirectory,
      container.containerId,
      ...request.args,
    ]);
  }
}

function assertContainerBinding(
  container: z.infer<typeof containerOutputSchema>,
  binding: HostedRemoteDiscordProbeBinding,
): void {
  if (container.containerId !== binding.containerId) {
    throw new Error("Running container ID does not match the requested binding");
  }
}

function assertImageBinding(
  image: z.infer<typeof imageOutputSchema>,
  containerImageId: string,
  binding: HostedRemoteDiscordProbeBinding,
): void {
  const expectedDigest = `@sha256:${binding.imageDigestSha256}`;
  if (image.imageId !== containerImageId
    || image.sourceRevision !== binding.sourceRevision
    || !image.repositoryDigests.some((digest) => digest.endsWith(expectedDigest))) {
    throw new Error("Running container image does not match the requested digest and source revision");
  }
}

function parseSuccessfulJson(result: BoundedRemoteContainerProcessResult, subject: string): unknown {
  if (result.timedOut || result.signal !== null || result.exitCode !== 0 || result.stderr.length !== 0) {
    throw new Error(`Remote ${subject} provenance inspection failed`);
  }
  const lines = result.stdout.split("\n");
  if (lines.at(-1) === "") {lines.pop();}
  if (lines.length !== 1 || lines[0] === undefined || lines[0].length === 0) {
    throw new Error(`Remote ${subject} provenance inspection returned a non-canonical envelope`);
  }
  try {
    return JSON.parse(lines[0]) as unknown;
  } catch (error) {
    throw new Error(`Remote ${subject} provenance inspection returned invalid JSON`, { cause: error });
  }
}

function assertRequestBounds(request: Parameters<BoundedRemoteContainerProcessPort["execute"]>[0]): void {
  request.signal?.throwIfAborted();
  hostSchema.parse(request.binding.host);
  containerIdSchema.parse(request.binding.containerId);
  sourceRevisionSchema.parse(request.binding.sourceRevision);
  z.string().regex(/^[a-f\d]{64}$/u).parse(request.binding.imageDigestSha256);
  z.number().int().positive().parse(request.maximumOutputBytes);
  z.number().int().positive().parse(request.timeoutMs);
  z.array(z.string().min(1).refine((value) => !value.includes("\0"))).min(1).parse(request.args);
}

function byteLength(result: BoundedRemoteContainerProcessResult): number {
  return Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
}

export function runBoundedSshCommand(
  request: BoundedRemoteCommandRequest,
): Promise<BoundedRemoteContainerProcessResult> {
  const host = hostSchema.parse(request.host);
  request.signal?.throwIfAborted();
  const command = request.args.map(shellQuote).join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "--", host, command], {
      env: sshProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let exceededOutput = false;
    let settled = false;
    let terminating = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let hardStopTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void): void => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(hardStopTimer);
      request.signal?.removeEventListener("abort", abort);
      settle();
    };
    const terminate = (): void => {
      if (terminating || settled) {return;}
      terminating = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        hardStopTimer = setTimeout(() => {
          finish(() => reject(new Error("Remote command process did not exit after SIGKILL")));
        }, 5_000);
        hardStopTimer.unref();
      }, 1_000);
      killTimer.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    timeout.unref();
    const abort = (): void => {terminate();};
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted === true) {abort();}
    const retain = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > request.maximumOutputBytes) {
        exceededOutput = true;
        terminate();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => { retain(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { retain(stderr, chunk); });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("close", (exitCode, signal) => {
      finish(() => {
        if (exceededOutput) {
          reject(new Error("Remote command exceeded its output bound"));
          return;
        }
        resolve({
          exitCode,
          signal,
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
          timedOut,
        });
      });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sshProcessEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "LANG", "LC_ALL", "PATH", "SSH_AUTH_SOCK"] as const) {
    const value = process.env[name];
    if (value !== undefined) {environment[name] = value;}
  }
  return environment;
}
