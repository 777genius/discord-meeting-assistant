import type {
  VoicetextCanaryRunnerInputV1,
  VoicetextCanaryRunnerV1,
} from "./hosted-voicetext-semantic-canary-producer.js";

const maximumOutputBytes = 1_048_576;
const maximumTeardownReserveMs = 1_000;

export interface BoundedContainerProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

/** Outer process boundary. Implementations must enforce the supplied timeout and byte cap. */
export interface BoundedContainerProcessPort {
  execute(request: Readonly<{
    args: readonly string[];
    executable: string;
    maximumOutputBytes: number;
    signal?: AbortSignal;
    timeoutMs: number;
  }>): Promise<BoundedContainerProcessResult>;
}

export class HostedVoicetextCanaryContainerRunnerV1 implements VoicetextCanaryRunnerV1 {
  public constructor(
    private readonly process: BoundedContainerProcessPort,
    private readonly executable = "docker",
  ) {}

  public async run(input: VoicetextCanaryRunnerInputV1): Promise<unknown> {
    const internalDeadlineMs = internalDeadlineFromOuterTimeout(input.timeoutMs);
    const result = await this.process.execute({
      args: [
        "exec", "-i", "-w", "/app/apps/meeting-platform", input.binding.containerId,
        "/app/apps/meeting-platform/node_modules/.bin/tsx",
        "/app/apps/meeting-platform/src/run-voicetext-semantic-canary.ts",
        "--fixture", input.fixturePath,
        "--fixture-sha256", input.binding.fixtureSha256,
        "--campaign", input.binding.campaignId,
        "--deadline-ms", String(internalDeadlineMs),
        "--plan-sha256", input.binding.planSha256,
        "--source-revision", input.binding.sourceRevision,
        "--image-digest-sha256", input.binding.imageDigestSha256,
        "--batch-origin", input.endpoint.batch.origin,
        "--batch-path", input.endpoint.batch.path,
        "--live-origin", input.endpoint.live.origin,
        "--live-path", input.endpoint.live.path,
        "--json",
      ],
      executable: this.executable,
      maximumOutputBytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.timeoutMs,
    });
    if (result.timedOut) {throw new Error("Voicetext semantic canary container timed out");}
    if (result.signal !== null) {throw new Error(`Voicetext semantic canary container exited on ${result.signal}`);}
    if (result.exitCode !== 0) {throw new Error(`Voicetext semantic canary container failed with exit code ${String(result.exitCode)}`);}
    return parseStrictJsonOutput(result.stdout, result.stderr);
  }
}

function internalDeadlineFromOuterTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 2 || timeoutMs > 300_000) {
    throw new Error("Voicetext semantic canary timeout cannot reserve bounded teardown time");
  }
  return timeoutMs - Math.min(maximumTeardownReserveMs, Math.max(1, Math.floor(timeoutMs / 10)));
}

function parseStrictJsonOutput(stdout: string, stderr: string): unknown {
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maximumOutputBytes) {
    throw new Error("Voicetext semantic canary output exceeded 1 MiB");
  }
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") {lines.pop();}
  if (lines.length !== 1 || lines[0] === undefined || lines[0].length === 0
    || lines[0].startsWith("\uFEFF") || stderr.length !== 0) {
    throw new Error("Voicetext semantic canary returned a non-canonical output envelope");
  }
  try {
    return JSON.parse(lines[0]) as unknown;
  } catch (error) {
    throw new Error("Voicetext semantic canary returned invalid JSON", { cause: error });
  }
}
