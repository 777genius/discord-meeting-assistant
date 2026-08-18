import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import {
  type ConversationThinkingCue,
  type ConversationThinkingCuePort,
  type ConversationThinkingCueRequest,
  type ConversationPortResult,
} from "@discord-meeting/meeting-core/conversation";

const manifestFileName = "manifest.json";
const manifestMaximumBytes = 64 * 1_024;
const pcmChunkBytes = 3_840;
const cueGroups = [
  "ruAcknowledgement",
  "ruDeliberation",
  "enAcknowledgement",
  "enDeliberation",
  "neutralAcknowledgement",
] as const;
const cueIdentifier = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const pcmRelativePath = /^(?:[a-z0-9][a-z0-9_-]{0,63}\/)*[a-z0-9][a-z0-9_-]{0,63}\.pcm$/u;

type CueGroup = (typeof cueGroups)[number];

interface ManifestCue {
  readonly cueId: string;
  readonly pcmFile: string;
  readonly sha256: string;
}

interface LoadedCue {
  readonly cueId: string;
  readonly pcmChunks: readonly Uint8Array[];
  readonly pcmSha256: string;
}

type CueGroups<Value> = { readonly [Group in CueGroup]: readonly Value[] };

type CueManifest = CueGroups<ManifestCue> & {
  readonly voiceId: string;
  readonly voiceProfileId: string;
};

/**
 * Preloaded cue assets. The manifest declares raw 48 kHz, mono, signed
 * little-endian PCM, because raw PCM has no self-describing header.
 */
export class FileConversationThinkingCueRegistry
  implements ConversationThinkingCuePort
{
  private constructor(
    private readonly cues: CueGroups<LoadedCue>,
    private readonly voiceProfileId: string,
  ) {}

  public static async load(
    configuredRoot: string,
    expectedVoiceProfileId: string,
    expectedVoiceId: string,
  ): Promise<FileConversationThinkingCueRegistry> {
    const root = normalizeRoot(configuredRoot);
    await assertDirectory(root);
    const manifestPath = `${root}/${manifestFileName}`;
    const manifestBytes = await readRegularFile(manifestPath, "thinking cue manifest");
    if (manifestBytes.byteLength > manifestMaximumBytes) {
      throw new Error("Thinking cue manifest exceeds the maximum size");
    }

    const manifest = parseManifest(parseJson(manifestBytes));
    if (manifest.voiceProfileId !== expectedVoiceProfileId) {
      throw new Error("Thinking cue voice profile does not match runtime configuration");
    }
    if (manifest.voiceId !== expectedVoiceId) {
      throw new Error("Thinking cue voice ID does not match runtime configuration");
    }
    const cueIds = new Set<string>();
    const pcmFiles = new Set<string>();
    for (const group of cueGroups) {
      for (const cue of manifest[group]) {
        if (cueIds.has(cue.cueId) || pcmFiles.has(cue.pcmFile)) {
          throw new Error("Thinking cue manifest contains duplicate cue assets");
        }
        cueIds.add(cue.cueId);
        pcmFiles.add(cue.pcmFile);
      }
    }

    const cues = {
      ruAcknowledgement: await loadCueGroup(root, manifest.ruAcknowledgement),
      ruDeliberation: await loadCueGroup(root, manifest.ruDeliberation),
      enAcknowledgement: await loadCueGroup(root, manifest.enAcknowledgement),
      enDeliberation: await loadCueGroup(root, manifest.enDeliberation),
      neutralAcknowledgement: await loadCueGroup(
        root,
        manifest.neutralAcknowledgement,
      ),
    } as const;
    return new FileConversationThinkingCueRegistry(
      cues,
      manifest.voiceProfileId,
    );
  }

  public async select(
    request: ConversationThinkingCueRequest,
  ): Promise<ConversationPortResult<ConversationThinkingCue | null>> {
    if (request.voiceProfileId !== this.voiceProfileId) {
      return { ok: true, value: null };
    }
    const group = groupForRequest(request.locale, request.stage);
    if (group === null) {
      return { ok: true, value: null };
    }
    const cues = this.cues[group];
    const cue = cues[stableCueIndex(request, group, cues.length)]!;

    return {
      ok: true,
      value: Object.freeze({
        cueId: cue.cueId,
        pcmChunks: Object.freeze(cue.pcmChunks.map((chunk) => chunk.slice())),
        playbackAttemptId: playbackAttemptId(request, cue.cueId),
        pcmSha256: cue.pcmSha256,
      }),
    };
  }

}

function stableCueIndex(
  request: ConversationThinkingCueRequest,
  group: CueGroup,
  cueCount: number,
): number {
  const source = JSON.stringify([
    "conversation-thinking-cue-selection:v2",
    request.meetingId,
    request.turnId,
    request.stage,
    group,
  ]);
  return createHash("sha256").update(source).digest().readUInt32BE(0) % cueCount;
}

async function assertDirectory(path: string): Promise<void> {
  const descriptor = await lstat(path);
  if (!descriptor.isDirectory() || descriptor.isSymbolicLink()) {
    throw new Error("Thinking cue root must be a non-symlink directory");
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  subject: string,
): void {
  const present = Object.keys(value);
  if (present.length !== keys.length || present.some((key) => !keys.includes(key))) {
    throw new Error(`${subject} has an unsupported shape`);
  }
}

function groupForRequest(
  locale: string,
  stage: ConversationThinkingCueRequest["stage"],
): CueGroup | null {
  const base = locale.trim().toLowerCase().split(/[-_]/u, 1)[0];
  if (base === "ru") {
    return stage === "acknowledgement"
      ? "ruAcknowledgement"
      : "ruDeliberation";
  }
  if (base === "en") {
    return stage === "acknowledgement"
      ? "enAcknowledgement"
      : "enDeliberation";
  }
  return stage === "acknowledgement" ? "neutralAcknowledgement" : null;
}

async function loadCueGroup(
  root: string,
  manifestCues: readonly ManifestCue[],
): Promise<readonly LoadedCue[]> {
  const loaded = await Promise.all(
    manifestCues.map(async (cue) => {
      const pcm = new Uint8Array(
        await readRegularFile(
          await resolvePcmPath(root, cue.pcmFile),
          `thinking cue ${cue.cueId}`,
        ),
      );
      if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
        throw new Error(`Thinking cue ${cue.cueId} must contain non-empty s16le PCM`);
      }
      const pcmSha256 = createHash("sha256").update(pcm).digest("hex");
      if (pcmSha256 !== cue.sha256) {
        throw new Error(`Thinking cue ${cue.cueId} SHA-256 does not match its manifest`);
      }
      return Object.freeze({
        cueId: cue.cueId,
        pcmChunks: Object.freeze(splitPcm(pcm)),
        pcmSha256,
      });
    }),
  );
  return Object.freeze(loaded);
}

function normalizeRoot(root: string): string {
  if (
    !root.startsWith("/") ||
    root.includes("\0") ||
    root.split("/").includes("..")
  ) {
    throw new Error("Thinking cue root must be an absolute path without traversal");
  }
  return root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
}

function parseCue(
  value: unknown,
  group: CueGroup,
  index: number,
): ManifestCue {
  if (!isRecord(value)) {
    throw new Error(`Thinking cue ${group}[${index}] must be an object`);
  }
  assertExactKeys(
    value,
    ["cueId", "pcmFile", "sha256"],
    `Thinking cue ${group}[${index}]`,
  );
  if (typeof value.cueId !== "string" || !cueIdentifier.test(value.cueId)) {
    throw new Error(`Thinking cue ${group}[${index}] has an invalid cueId`);
  }
  if (typeof value.pcmFile !== "string" || !pcmRelativePath.test(value.pcmFile)) {
    throw new Error(`Thinking cue ${group}[${index}] has an unsafe pcmFile`);
  }
  if (typeof value.sha256 !== "string" || !/^[a-f\d]{64}$/u.test(value.sha256)) {
    throw new Error(`Thinking cue ${group}[${index}] has an invalid SHA-256`);
  }
  return Object.freeze({
    cueId: value.cueId,
    pcmFile: value.pcmFile,
    sha256: value.sha256,
  });
}

function parseCueGroup(value: unknown, group: CueGroup): readonly ManifestCue[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Thinking cue group ${group} must be non-empty`);
  }
  return Object.freeze(value.map((cue, index) => parseCue(cue, group, index)));
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("Thinking cue manifest is not valid JSON");
  }
}

function parseManifest(value: unknown): CueManifest {
  if (!isRecord(value)) {
    throw new Error("Thinking cue manifest must be an object");
  }
  assertExactKeys(
    value,
    ["version", "voiceId", "voiceProfileId", "audio", "groups"],
    "Thinking cue manifest",
  );
  if (value.version !== 3) {
    throw new Error("Thinking cue manifest version must be 3");
  }
  if (typeof value.voiceProfileId !== "string" || !cueIdentifier.test(value.voiceProfileId)) {
    throw new Error("Thinking cue manifest voiceProfileId is invalid");
  }
  if (typeof value.voiceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.voiceId)) {
    throw new Error("Thinking cue manifest voiceId is invalid");
  }
  if (!isRecord(value.audio)) {
    throw new Error("Thinking cue manifest audio must be an object");
  }
  assertExactKeys(
    value.audio,
    ["format", "sampleRateHz", "channels"],
    "Thinking cue manifest audio",
  );
  if (
    value.audio.format !== "pcm_s16le" ||
    value.audio.sampleRateHz !== 48_000 ||
    value.audio.channels !== 1
  ) {
    throw new Error("Thinking cue manifest audio must be 48 kHz mono pcm_s16le");
  }
  if (!isRecord(value.groups)) {
    throw new Error("Thinking cue manifest groups must be an object");
  }
  assertExactKeys(value.groups, cueGroups, "Thinking cue manifest groups");
  return Object.freeze({
    ruAcknowledgement: parseCueGroup(
      value.groups.ruAcknowledgement,
      "ruAcknowledgement",
    ),
    ruDeliberation: parseCueGroup(
      value.groups.ruDeliberation,
      "ruDeliberation",
    ),
    enAcknowledgement: parseCueGroup(
      value.groups.enAcknowledgement,
      "enAcknowledgement",
    ),
    enDeliberation: parseCueGroup(
      value.groups.enDeliberation,
      "enDeliberation",
    ),
    neutralAcknowledgement: parseCueGroup(
      value.groups.neutralAcknowledgement,
      "neutralAcknowledgement",
    ),
    voiceId: value.voiceId,
    voiceProfileId: value.voiceProfileId,
  });
}

function playbackAttemptId(
  request: ConversationThinkingCueRequest,
  cueId: string,
): string {
  const source = JSON.stringify([
    "conversation-thinking-cue:v2",
    request.meetingId,
    request.turnId,
    request.stage,
    cueId,
  ]);
  return `thinking-cue-v2-${createHash("sha256").update(source).digest("hex")}`;
}

async function readRegularFile(path: string, subject: string): Promise<Buffer> {
  const descriptor = await lstat(path);
  if (!descriptor.isFile() || descriptor.isSymbolicLink()) {
    throw new Error(`${subject} must be a regular non-symlink file`);
  }
  return await readFile(path);
}

async function resolvePcmPath(root: string, pcmFile: string): Promise<string> {
  const segments = pcmFile.split("/");
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = `${directory}/${segment}`;
    const descriptor = await lstat(directory);
    if (!descriptor.isDirectory() || descriptor.isSymbolicLink()) {
      throw new Error("Thinking cue PCM parent must be a non-symlink directory");
    }
  }
  return `${directory}/${segments[segments.length - 1]!}`;
}

function splitPcm(pcm: Uint8Array): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.byteLength; offset += pcmChunkBytes) {
    chunks.push(pcm.slice(offset, offset + pcmChunkBytes));
  }
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
