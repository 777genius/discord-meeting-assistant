import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import type {
  ConversationFarewellCue,
  ConversationFarewellCueRegistry,
} from "@discord-meeting/meeting-core/conversation";

const manifestMaximumBytes = 16 * 1_024;
const maximumCueBytes = 192_000;
const pcmChunkBytes = 3_840;
const safeIdentifier = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const safeVoiceId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const safePcmFile = /^[a-z0-9][a-z0-9_-]{0,63}\.pcm$/u;
const sha256 = /^[0-9a-f]{64}$/u;

interface ManifestCue {
  readonly cueId: string;
  readonly pcmFile: string;
  readonly sha256: string;
}

interface LoadedCue {
  readonly assetSha256: string;
  readonly cueId: string;
  readonly pcmChunks: readonly Uint8Array[];
}

/** Preloads two short, checksum-pinned 48 kHz mono PCM farewell phrases. */
export class FileConversationFarewellCueRegistry
  implements ConversationFarewellCueRegistry
{
  private constructor(
    private readonly cues: Readonly<Record<"en" | "ru", LoadedCue>>,
    private readonly voiceProfileId: string,
  ) {}

  public static async load(
    configuredRoot: string,
    expectedVoiceProfileId: string,
    expectedVoiceId: string,
  ): Promise<FileConversationFarewellCueRegistry> {
    const root = normalizeRoot(configuredRoot);
    await assertDirectory(root);
    const manifestBytes = await readRegularFile(
      `${root}/manifest.json`,
      "farewell cue manifest",
    );
    if (manifestBytes.byteLength > manifestMaximumBytes) {
      throw new Error("Farewell cue manifest exceeds the maximum size");
    }
    const manifest = parseManifest(parseJson(manifestBytes));
    if (
      manifest.voiceProfileId !== expectedVoiceProfileId ||
      manifest.voiceId !== expectedVoiceId
    ) {
      throw new Error("Farewell cue voice does not match runtime configuration");
    }
    return new FileConversationFarewellCueRegistry(
      {
        en: await loadCue(root, manifest.en),
        ru: await loadCue(root, manifest.ru),
      },
      manifest.voiceProfileId,
    );
  }

  public select(input: {
    readonly locale: "en" | "ru";
    readonly meetingId: string;
    readonly voiceProfileId: string;
  }): ConversationFarewellCue | null {
    if (input.voiceProfileId !== this.voiceProfileId) {
      return null;
    }
    const cue = this.cues[input.locale];
    const attemptSource = JSON.stringify([
      "conversation-farewell-cue:v1",
      input.meetingId,
      input.locale,
      cue.cueId,
    ]);
    return Object.freeze({
      assetSha256: cue.assetSha256,
      cueId: cue.cueId,
      pcmChunks: Object.freeze(cue.pcmChunks.map((chunk) => chunk.slice())),
      playbackAttemptId: `farewell-cue-v1-${createHash("sha256").update(attemptSource).digest("hex")}`,
    });
  }
}

async function loadCue(root: string, cue: ManifestCue): Promise<LoadedCue> {
  const bytes = new Uint8Array(
    await readRegularFile(`${root}/${cue.pcmFile}`, `farewell cue ${cue.cueId}`),
  );
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumCueBytes ||
    bytes.byteLength % 2 !== 0
  ) {
    throw new Error(`Farewell cue ${cue.cueId} has invalid PCM length`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== cue.sha256) {
    throw new Error(`Farewell cue ${cue.cueId} checksum does not match`);
  }
  const pcmChunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += pcmChunkBytes) {
    pcmChunks.push(bytes.slice(offset, offset + pcmChunkBytes));
  }
  return Object.freeze({
    assetSha256: digest,
    cueId: cue.cueId,
    pcmChunks: Object.freeze(pcmChunks),
  });
}

async function assertDirectory(path: string): Promise<void> {
  const descriptor = await lstat(path);
  if (!descriptor.isDirectory() || descriptor.isSymbolicLink()) {
    throw new Error("Farewell cue root must be a non-symlink directory");
  }
}

async function readRegularFile(path: string, subject: string): Promise<Buffer> {
  const descriptor = await lstat(path);
  if (!descriptor.isFile() || descriptor.isSymbolicLink()) {
    throw new Error(`${subject} must be a regular non-symlink file`);
  }
  return readFile(path);
}

function normalizeRoot(root: string): string {
  if (!root.startsWith("/") || root.includes("\0") || root.split("/").includes("..")) {
    throw new Error("Farewell cue root must be an absolute path without traversal");
  }
  return root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
}

function parseManifest(value: unknown): {
  readonly en: ManifestCue;
  readonly ru: ManifestCue;
  readonly voiceId: string;
  readonly voiceProfileId: string;
} {
  if (!isRecord(value)) {
    throw new Error("Farewell cue manifest must be an object");
  }
  assertKeys(value, ["audio", "en", "ru", "version", "voiceId", "voiceProfileId"]);
  if (!isRecord(value.audio)) {
    throw new Error("Farewell cue manifest has invalid audio metadata");
  }
  assertKeys(value.audio, ["channels", "format", "sampleRateHz"]);
  if (
    value.version !== 1 ||
    value.audio.channels !== 1 ||
    value.audio.format !== "pcm_s16le" ||
    value.audio.sampleRateHz !== 48_000 ||
    typeof value.voiceId !== "string" ||
    !safeVoiceId.test(value.voiceId) ||
    typeof value.voiceProfileId !== "string" ||
    !safeIdentifier.test(value.voiceProfileId)
  ) {
    throw new Error("Farewell cue manifest has invalid voice identity");
  }
  return Object.freeze({
    en: parseCue(value.en, "en"),
    ru: parseCue(value.ru, "ru"),
    voiceId: value.voiceId,
    voiceProfileId: value.voiceProfileId,
  });
}

function parseCue(value: unknown, locale: string): ManifestCue {
  if (!isRecord(value)) {
    throw new Error(`Farewell cue ${locale} must be an object`);
  }
  assertKeys(value, ["cueId", "pcmFile", "sha256"]);
  if (
    typeof value.cueId !== "string" ||
    !safeIdentifier.test(value.cueId) ||
    typeof value.pcmFile !== "string" ||
    !safePcmFile.test(value.pcmFile) ||
    typeof value.sha256 !== "string" ||
    !sha256.test(value.sha256)
  ) {
    throw new Error(`Farewell cue ${locale} is invalid`);
  }
  return Object.freeze({
    cueId: value.cueId,
    pcmFile: value.pcmFile,
    sha256: value.sha256,
  });
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const present = Object.keys(value);
  if (present.length !== expected.length || present.some((key) => !expected.includes(key))) {
    throw new Error("Farewell cue manifest has an unsupported shape");
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Farewell cue manifest must be valid UTF-8 JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
