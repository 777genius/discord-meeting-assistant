import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

const manifestMaximumBytes = 64 * 1_024;
const maximumCueBytes = 192_000;
const pcmChunkBytes = 3_840;
const safeIdentifier = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const safePcmFile = /^[a-z0-9][a-z0-9_-]{0,63}\.pcm$/u;
const safeVoiceId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const sha256 = /^[0-9a-f]{64}$/u;

interface ManifestCue {
  readonly cueId: string;
  readonly locale: "en" | "ru";
  readonly pcmFile: string;
  readonly sha256: string;
  readonly text: string;
}

interface LoadedCue {
  readonly cueId: string;
  readonly pcmChunks: readonly Uint8Array[];
}

export interface SelectedParticipantGreetingCue extends LoadedCue {
  readonly playbackAttemptId: string;
}

/** Preloads checksum-pinned greeting speech for immediate first-join playback. */
export class FileParticipantGreetingCueRegistry {
  private constructor(
    private readonly cuesBySpeech: ReadonlyMap<string, LoadedCue>,
    private readonly voiceProfileId: string,
  ) {}

  public static async load(
    configuredRoot: string,
    expectedVoiceProfileId: string,
    expectedVoiceId: string,
  ): Promise<FileParticipantGreetingCueRegistry> {
    const root = normalizeRoot(configuredRoot);
    await assertDirectory(root);
    const manifestBytes = await readRegularFile(
      `${root}/manifest.json`,
      "greeting cue manifest",
    );
    if (manifestBytes.byteLength > manifestMaximumBytes) {
      throw new Error("Greeting cue manifest exceeds the maximum size");
    }
    const manifest = parseManifest(parseJson(manifestBytes));
    if (
      manifest.voiceProfileId !== expectedVoiceProfileId ||
      manifest.voiceId !== expectedVoiceId
    ) {
      throw new Error("Greeting cue voice does not match runtime configuration");
    }
    const entries = await Promise.all(manifest.cues.map(async (cue) => [
      speechKey(cue.locale, cue.text),
      await loadCue(root, cue),
    ] as const));
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new Error("Greeting cue manifest contains duplicate speech");
    }
    return new FileParticipantGreetingCueRegistry(
      new Map(entries),
      manifest.voiceProfileId,
    );
  }

  public select(input: {
    readonly locale: "en" | "ru";
    readonly meetingId: string;
    readonly participantId: string;
    readonly speech: string;
    readonly voiceProfileId: string;
  }): SelectedParticipantGreetingCue | null {
    if (input.voiceProfileId !== this.voiceProfileId) {
      return null;
    }
    const cue = this.cuesBySpeech.get(speechKey(input.locale, input.speech));
    if (cue === undefined) {
      return null;
    }
    const attemptSource = JSON.stringify([
      "participant-greeting-cue:v1",
      input.meetingId,
      input.participantId,
      cue.cueId,
    ]);
    return Object.freeze({
      cueId: cue.cueId,
      pcmChunks: Object.freeze(cue.pcmChunks.map((chunk) => chunk.slice())),
      playbackAttemptId:
        `participant-greeting-cue-v1-${createHash("sha256").update(attemptSource).digest("hex")}`,
    });
  }
}

async function loadCue(root: string, cue: ManifestCue): Promise<LoadedCue> {
  const bytes = new Uint8Array(
    await readRegularFile(`${root}/${cue.pcmFile}`, `greeting cue ${cue.cueId}`),
  );
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumCueBytes ||
    bytes.byteLength % 2 !== 0
  ) {
    throw new Error(`Greeting cue ${cue.cueId} has invalid PCM length`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== cue.sha256) {
    throw new Error(`Greeting cue ${cue.cueId} checksum does not match`);
  }
  const pcmChunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += pcmChunkBytes) {
    pcmChunks.push(bytes.slice(offset, offset + pcmChunkBytes));
  }
  return Object.freeze({
    cueId: cue.cueId,
    pcmChunks: Object.freeze(pcmChunks),
  });
}

async function assertDirectory(path: string): Promise<void> {
  const descriptor = await lstat(path);
  if (!descriptor.isDirectory() || descriptor.isSymbolicLink()) {
    throw new Error("Greeting cue root must be a non-symlink directory");
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
    throw new Error("Greeting cue root must be an absolute path without traversal");
  }
  return root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
}

function parseManifest(value: unknown): {
  readonly cues: readonly ManifestCue[];
  readonly voiceId: string;
  readonly voiceProfileId: string;
} {
  if (!isRecord(value)) {
    throw new Error("Greeting cue manifest must be an object");
  }
  assertKeys(value, ["audio", "cues", "version", "voiceId", "voiceProfileId"]);
  if (!isRecord(value.audio)) {
    throw new Error("Greeting cue manifest has invalid audio metadata");
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
    !safeIdentifier.test(value.voiceProfileId) ||
    !Array.isArray(value.cues) ||
    value.cues.length === 0 ||
    value.cues.length > 128
  ) {
    throw new Error("Greeting cue manifest metadata is invalid");
  }
  return {
    cues: Object.freeze(value.cues.map(parseCue)),
    voiceId: value.voiceId,
    voiceProfileId: value.voiceProfileId,
  };
}

function parseCue(value: unknown): ManifestCue {
  if (!isRecord(value)) {
    throw new Error("Greeting cue manifest entry must be an object");
  }
  assertKeys(value, ["cueId", "locale", "pcmFile", "sha256", "text"]);
  if (
    typeof value.cueId !== "string" ||
    !safeIdentifier.test(value.cueId) ||
    (value.locale !== "en" && value.locale !== "ru") ||
    typeof value.pcmFile !== "string" ||
    !safePcmFile.test(value.pcmFile) ||
    typeof value.sha256 !== "string" ||
    !sha256.test(value.sha256) ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0 ||
    value.text.length > 200
  ) {
    throw new Error("Greeting cue manifest entry is invalid");
  }
  return Object.freeze({
    cueId: value.cueId,
    locale: value.locale,
    pcmFile: value.pcmFile,
    sha256: value.sha256,
    text: value.text.normalize("NFKC").trim(),
  });
}

function speechKey(locale: "en" | "ru", speech: string): string {
  return `${locale}\0${speech.normalize("NFKC").trim()}`;
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Greeting cue manifest must contain valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).toSorted();
  const allowed = expected.toSorted();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error("Greeting cue manifest contains unexpected fields");
  }
}
