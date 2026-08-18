import { z } from "zod";

import type { BoundedRemoteContainerProcessPort } from "./hosted-remote-discord-identity-probe.js";
import type {
  VoicetextCanaryRunnerInputV1,
  VoicetextCanaryRunnerV1,
} from "./hosted-voicetext-semantic-canary-producer.js";

const maximumOutputBytes = 1_048_576;
const maximumTeardownReserveMs = 1_000;
const canaryEntrypoint = "/app/apps/meeting-platform/src/run-voicetext-semantic-canary.ts";
const tsxEntrypoint = "/app/apps/meeting-platform/node_modules/.bin/tsx";
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const absolutePathSchema = z.string().startsWith("/").max(4_096).refine((value) => !value.includes("\0"));
const endpointPathSchema = z.string().regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u);
const exactOriginSchema = (protocol: "https:" | "wss:") => z.url().refine((value) => {
  const endpoint = new URL(value);
  return endpoint.protocol === protocol && endpoint.origin === value;
});

const inputSchema = z.object({
  binding: z.object({
    campaignId: identifierSchema,
    containerId: z.string().regex(/^[a-f\d]{64}$/u),
    fixtureSha256: sha256Schema,
    host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u),
    imageDigestSha256: sha256Schema,
    planSha256: sha256Schema,
    sourceRevision: sourceRevisionSchema,
    transcriptExpectationSha256: sha256Schema,
  }).strict(),
  endpoint: z.object({
    batch: z.object({ origin: exactOriginSchema("https:"), path: endpointPathSchema }).strict(),
    live: z.object({ origin: exactOriginSchema("wss:"), path: endpointPathSchema }).strict(),
  }).strict(),
  fixturePath: absolutePathSchema,
  requiredTerms: z.array(z.string().min(1).max(100).refine((term) => term.trim() === term))
    .min(1).max(100).refine((terms) => new Set(terms).size === terms.length),
  profiles: z.object({
    batch: z.enum(["deepgram-nova-3", "elevenlabs-scribe-v2"]),
    live: z.enum(["deepgram-nova-3", "elevenlabs-scribe-v2-realtime"]),
  }).strict(),
  signal: z.instanceof(AbortSignal).optional(),
  timeoutMs: z.number().int().min(2).max(300_000),
}).strict();

/** Runs the pinned semantic canary inside an already provenance-bound remote test container. */
export class HostedRemoteVoicetextCanaryRunnerV1 implements VoicetextCanaryRunnerV1 {
  public constructor(private readonly process: BoundedRemoteContainerProcessPort) {}

  public async run(rawInput: VoicetextCanaryRunnerInputV1): Promise<unknown> {
    const input = inputSchema.parse({
      binding: rawInput.binding,
      endpoint: rawInput.endpoint,
      fixturePath: rawInput.fixturePath,
      profiles: rawInput.profiles,
      ...(rawInput.signal === undefined ? {} : { signal: rawInput.signal }),
      timeoutMs: rawInput.timeoutMs,
    });
    input.signal?.throwIfAborted();
    const result = await this.process.execute({
      args: buildCanaryArgs(input, internalDeadlineFromOuterTimeout(input.timeoutMs)),
      binding: {
        containerId: input.binding.containerId,
        host: input.binding.host,
        imageDigestSha256: input.binding.imageDigestSha256,
        sourceRevision: input.binding.sourceRevision,
      },
      maximumOutputBytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      target: {
        composeProject: "discord-meeting-assistant",
        composeService: "meeting-platform",
        workingDirectory: "/app/apps/meeting-platform",
      },
      timeoutMs: input.timeoutMs,
    });
    assertSuccessfulResult(result);
    return parseCanonicalJsonLine(result.stdout);
  }
}

function buildCanaryArgs(
  input: z.infer<typeof inputSchema>,
  internalDeadlineMs: number,
): readonly string[] {
  return Object.freeze([
    tsxEntrypoint, canaryEntrypoint,
    "--fixture", input.fixturePath,
    "--fixture-sha256", input.binding.fixtureSha256,
    "--campaign", input.binding.campaignId,
    "--deadline-ms", String(internalDeadlineMs),
    "--plan-sha256", input.binding.planSha256,
    "--source-revision", input.binding.sourceRevision,
    "--image-digest-sha256", input.binding.imageDigestSha256,
    "--batch-origin", input.endpoint.batch.origin,
    "--batch-path", input.endpoint.batch.path,
    "--batch-profile", input.profiles.batch,
    "--keyterms-json", JSON.stringify(input.requiredTerms),
    "--live-origin", input.endpoint.live.origin,
    "--live-path", input.endpoint.live.path,
    "--live-profile", input.profiles.live,
    "--json",
  ]);
}

function internalDeadlineFromOuterTimeout(timeoutMs: number): number {
  return timeoutMs - Math.min(maximumTeardownReserveMs, Math.max(1, Math.floor(timeoutMs / 10)));
}

function assertSuccessfulResult(result: Awaited<ReturnType<BoundedRemoteContainerProcessPort["execute"]>>): void {
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maximumOutputBytes) {
    throw new Error("Remote Voicetext semantic canary output exceeded 1 MiB");
  }
  if (result.timedOut) {throw new Error("Remote Voicetext semantic canary timed out");}
  if (result.signal !== null) {throw new Error(`Remote Voicetext semantic canary exited on ${result.signal}`);}
  if (result.exitCode !== 0) {
    throw new Error(`Remote Voicetext semantic canary failed with exit code ${String(result.exitCode)}`);
  }
  if (result.stderr.length !== 0) {throw new Error("Remote Voicetext semantic canary wrote to stderr");}
}

function parseCanonicalJsonLine(stdout: string): unknown {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") {lines.pop();}
  if (lines.length !== 1 || lines[0] === undefined || lines[0].length === 0
    || lines[0].startsWith("\uFEFF")) {
    throw new Error("Remote Voicetext semantic canary returned a non-canonical output envelope");
  }
  try {
    return JSON.parse(lines[0]) as unknown;
  } catch (error) {
    throw new Error("Remote Voicetext semantic canary returned invalid JSON", { cause: error });
  }
}
