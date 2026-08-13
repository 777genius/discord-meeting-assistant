import { z } from "zod";

import type {
  DiscordIdentityProbeTarget,
  DiscordRoleIdentityExpectation,
  DiscordRoleIdentityProbe,
} from "./hosted-discord-identity-producer.js";

const maximumOutputBytes = 16_384;
const defaultTimeoutMs = 10_000;
const internalEntrypoint = "/app/apps/meeting-platform/src/run-hosted-discord-identity-probe.ts";
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const discordIdSchema = z.string().regex(/^\d{17,20}$/u);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);

export interface HostedRemoteDiscordProbeBinding {
  readonly containerId: string;
  readonly host: string;
  readonly imageDigestSha256: string;
  readonly sourceRevision: string;
}

export interface TrustedRemoteContainerTarget {
  readonly composeProject: string;
  readonly composeService: string;
  readonly workingDirectory: string;
}

export interface BoundedRemoteContainerProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

/**
 * SSH/container boundary owned by composition. Implementations must first prove
 * that the named running container still has the pinned image and revision,
 * then execute `args` inside it without a shell and enforce both supplied bounds.
 */
export interface BoundedRemoteContainerProcessPort {
  execute(request: Readonly<{
    args: readonly string[];
    binding: HostedRemoteDiscordProbeBinding;
    maximumOutputBytes: number;
    signal?: AbortSignal;
    target: TrustedRemoteContainerTarget;
    timeoutMs: number;
  }>): Promise<BoundedRemoteContainerProcessResult>;
}

const outputSchema = z.object({
  authenticatedUserId: discordIdSchema,
  binding: z.object({
    containerId: identifierSchema,
    imageDigestSha256: sha256Schema,
    sourceRevision: sourceRevisionSchema,
  }).strict(),
  bot: z.literal(true),
  kind: z.literal("hosted-remote-discord-identity-probe-result"),
  schemaVersion: z.literal(1),
  target: z.object({
    guildId: discordIdSchema,
    publicationChannelId: discordIdSchema,
    voiceChannelId: discordIdSchema,
  }).strict(),
  tokenCustody: z.object({
    generationId: identifierSchema,
    mode: z.literal(0o400),
    ownerUid: z.number().int().nonnegative(),
    path: z.string().startsWith("/").max(4_096),
  }).strict(),
}).strict();

/**
 * Remote Botik identity adapter. The token never crosses this boundary: the
 * pinned Meeting Platform CLI reads it and calls Discord from inside the container.
 */
export class HostedRemoteDiscordIdentityProbe implements DiscordRoleIdentityProbe {
  readonly #binding: HostedRemoteDiscordProbeBinding;

  public constructor(
    private readonly process: BoundedRemoteContainerProcessPort,
    binding: HostedRemoteDiscordProbeBinding,
    private readonly timeoutMs = defaultTimeoutMs,
  ) {
    this.#binding = parseBinding(binding);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Remote Discord identity probe timeout must be a positive safe integer");
    }
  }

  public async probe(
    expectation: DiscordRoleIdentityExpectation,
    target: DiscordIdentityProbeTarget,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof toIdentity>> {
    assertRemoteExpectation(expectation);
    const result = await this.process.execute({
      args: buildInternalArgs(expectation, target, this.#binding),
      binding: this.#binding,
      maximumOutputBytes,
      ...(signal === undefined ? {} : { signal }),
      target: {
        composeProject: "discord-meeting-assistant",
        composeService: "meeting-platform",
        workingDirectory: "/app/apps/meeting-platform",
      },
      timeoutMs: this.timeoutMs,
    });
    assertSuccessfulProcess(result);
    const output = outputSchema.parse(parseCanonicalJsonLine(result.stdout));
    assertExactOutput(output, expectation, target, this.#binding);
    return toIdentity(output, expectation);
  }
}

function buildInternalArgs(
  expectation: DiscordRoleIdentityExpectation,
  target: DiscordIdentityProbeTarget,
  binding: HostedRemoteDiscordProbeBinding,
): readonly string[] {
  return Object.freeze([
    "/app/apps/meeting-platform/node_modules/.bin/tsx", internalEntrypoint,
    "--application-id", expectation.applicationId,
    "--token-file", expectation.tokenFile.path,
    "--token-owner-uid", String(expectation.tokenFile.ownerUid),
    "--guild-id", target.guildId,
    "--voice-channel-id", target.voiceChannelId,
    "--publication-channel-id", target.publicationChannelId,
    "--container-id", binding.containerId,
    "--image-digest-sha256", binding.imageDigestSha256,
    "--source-revision", binding.sourceRevision,
    "--json",
  ]);
}

function parseBinding(value: HostedRemoteDiscordProbeBinding): HostedRemoteDiscordProbeBinding {
  return Object.freeze(z.object({
    containerId: identifierSchema,
    host: identifierSchema,
    imageDigestSha256: sha256Schema,
    sourceRevision: sourceRevisionSchema,
  }).strict().parse(value));
}

function assertRemoteExpectation(expectation: DiscordRoleIdentityExpectation): void {
  if (expectation.tokenFile.scope !== "remote-deployment-secret") {
    throw new Error("Remote Discord identity probe requires remote token custody");
  }
}

function assertSuccessfulProcess(result: BoundedRemoteContainerProcessResult): void {
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maximumOutputBytes) {
    throw new Error("Remote Discord identity probe output exceeded 16 KiB");
  }
  if (result.timedOut) {throw new Error("Remote Discord identity probe timed out");}
  if (result.signal !== null) {throw new Error(`Remote Discord identity probe exited on ${result.signal}`);}
  if (result.exitCode !== 0) {
    throw new Error(`Remote Discord identity probe failed with exit code ${String(result.exitCode)}`);
  }
  if (result.stderr.length !== 0) {
    throw new Error("Remote Discord identity probe wrote to stderr");
  }
}

function parseCanonicalJsonLine(stdout: string): unknown {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") {lines.pop();}
  if (lines.length !== 1 || lines[0] === undefined || lines[0].length === 0
    || lines[0].startsWith("\uFEFF")) {
    throw new Error("Remote Discord identity probe returned a non-canonical output envelope");
  }
  try {
    return JSON.parse(lines[0]) as unknown;
  } catch (error) {
    throw new Error("Remote Discord identity probe returned invalid JSON", { cause: error });
  }
}

function assertExactOutput(
  output: z.infer<typeof outputSchema>,
  expectation: DiscordRoleIdentityExpectation,
  target: DiscordIdentityProbeTarget,
  binding: HostedRemoteDiscordProbeBinding,
): void {
  if (output.authenticatedUserId !== expectation.applicationId
    || output.binding.containerId !== binding.containerId
    || output.binding.imageDigestSha256 !== binding.imageDigestSha256
    || output.binding.sourceRevision !== binding.sourceRevision
    || JSON.stringify(output.target) !== JSON.stringify(target)
    || output.tokenCustody.path !== expectation.tokenFile.path
    || output.tokenCustody.ownerUid !== expectation.tokenFile.ownerUid) {
    throw new Error("Remote Discord identity result does not match the pinned identity, target, or deployment");
  }
}

function toIdentity(
  output: z.infer<typeof outputSchema>,
  expectation: DiscordRoleIdentityExpectation,
) {
  if (expectation.tokenFile.scope !== "remote-deployment-secret") {
    throw new Error("Remote Discord identity probe requires remote token custody");
  }
  return Object.freeze({
    applicationId: expectation.applicationId,
    authenticatedUserId: output.authenticatedUserId,
    bot: true as const,
    tokenFile: {
      ...expectation.tokenFile,
      generationId: output.tokenCustody.generationId,
      mode: output.tokenCustody.mode,
    },
    verificationSource: "discord-current-application-and-user" as const,
  });
}
