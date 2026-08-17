import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { FileConversationThinkingCueRegistry } from "../src/adapters/outbound/file-conversation-thinking-cue-registry.js";

const temporaryRoots: string[] = [];

type CueGroup =
  | "ruAcknowledgement"
  | "ruDeliberation"
  | "enAcknowledgement"
  | "enDeliberation"
  | "neutralAcknowledgement";
type ManifestCue = {
  readonly cueId: string;
  readonly pcmFile: string;
  readonly sha256: string;
};
const testVoiceId = "test-voice-id";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function cueManifest(groups: Partial<Record<CueGroup, readonly ManifestCue[]>> = {}) {
  return {
    audio: {
      channels: 1,
      format: "pcm_s16le",
      sampleRateHz: 48_000,
    },
    groups: {
      enAcknowledgement: groups.enAcknowledgement ?? [
        manifestCue("en-ack-one", "en-ack-one.pcm", 3),
        manifestCue("en-ack-two", "en-ack-two.pcm", 4),
      ],
      enDeliberation: groups.enDeliberation ?? [
        manifestCue("en-think-one", "en-think-one.pcm", 6),
      ],
      neutralAcknowledgement: groups.neutralAcknowledgement ?? [
        manifestCue("neutral-ack-one", "neutral-ack-one.pcm", 5),
      ],
      ruAcknowledgement: groups.ruAcknowledgement ?? [
        manifestCue("ru-ack-one", "ru-ack-one.pcm", 1, 2),
        manifestCue("ru-ack-two", "ru-ack-two.pcm", 2),
      ],
      ruDeliberation: groups.ruDeliberation ?? [
        manifestCue("ru-think-one", "ru-think-one.pcm", 7),
      ],
    },
    version: 3,
    voiceId: testVoiceId,
    voiceProfileId: "test-voice",
  } as const;
}

function pcm(seed: number, frames = 1): Uint8Array {
  return Uint8Array.from(
    { length: 3_840 * frames },
    (_, index) => (seed + index) % 256,
  );
}

function manifestCue(
  cueId: string,
  pcmFile: string,
  seed: number,
  frames = 1,
): ManifestCue {
  return {
    cueId,
    pcmFile,
    sha256: createHash("sha256").update(pcm(seed, frames)).digest("hex"),
  };
}

async function cueRoot(input: {
  readonly files?: Readonly<Record<string, Uint8Array>>;
  readonly manifest?: unknown;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meeting-platform-thinking-cues-"));
  temporaryRoots.push(root);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify(input.manifest ?? cueManifest()),
  );
  const files = input.files ?? {
    "en-ack-one.pcm": pcm(3),
    "en-ack-two.pcm": pcm(4),
    "en-think-one.pcm": pcm(6),
    "neutral-ack-one.pcm": pcm(5),
    "ru-ack-one.pcm": pcm(1, 2),
    "ru-ack-two.pcm": pcm(2),
    "ru-think-one.pcm": pcm(7),
  };
  await Promise.all(
    Object.entries(files).map(async ([name, bytes]) =>
      writeFile(join(root, name), bytes),
    ),
  );
  return root;
}

async function select(
  registry: FileConversationThinkingCueRegistry,
  locale: string,
  meetingId: string,
  turnId: string,
  voiceProfileId = "test-voice",
  stage: "acknowledgement" | "deliberation" = "acknowledgement",
) {
  const result = await registry.select({
    locale,
    meetingId,
    stage,
    turnId,
    voiceProfileId,
  });
  if (!result.ok || result.value === null) {
    throw new Error("thinking cue was unexpectedly unavailable");
  }
  return result.value;
}

describe("FileConversationThinkingCueRegistry", () => {
  it("preloads the shipped RU, EN, and neutral ElevenLabs assets", async () => {
    const root = fileURLToPath(new URL("../assets/thinking-cues", import.meta.url));
    const registry = await FileConversationThinkingCueRegistry.load(
      root,
      "elevenlabs-multilingual",
      "jqcCZkN6Knx8BJ5TBdYR",
    );

    const russian = await select(
      registry,
      "ru-RU",
      "shipped-assets",
      "turn-ru",
      "elevenlabs-multilingual",
    );
    const english = await select(
      registry,
      "en-US",
      "shipped-assets",
      "turn-en",
      "elevenlabs-multilingual",
    );
    const neutral = await select(
      registry,
      "uk-UA",
      "shipped-assets",
      "turn-neutral",
      "elevenlabs-multilingual",
    );

    expect(russian.cueId).toBe("ru-seichas");
    expect(english.cueId).toBe("en-one-sec");
    expect(neutral.cueId).toBe("neutral-hmm");
    expect([russian, english, neutral].every((cue) => cue.pcmChunks.length > 0)).toBe(
      true,
    );
    expect(russian.pcmSha256).toBe(
      "a7c34115e4f70377035211e6cbdc5e6a48c0eaa60d291442d3f5e37a552faa30",
    );
  });

  it("preloads exact and base RU/EN cues with a neutral locale fallback", async () => {
    const root = await cueRoot();
    const registry = await FileConversationThinkingCueRegistry.load(
      root,
      "test-voice",
      testVoiceId,
    );

    const russian = await select(registry, "ru", "meeting-ru", "turn-1");
    expect(russian.cueId).toBe("ru-ack-one");
    expect(russian.pcmChunks.map((chunk) => chunk.byteLength)).toEqual([3_840, 3_840]);
    expect((await select(registry, "ru-RU", "meeting-ru-base", "turn-1")).cueId).toBe(
      "ru-ack-one",
    );
    expect((await select(registry, "en", "meeting-en", "turn-1")).cueId).toBe("en-ack-one");
    expect((await select(registry, "en-GB", "meeting-en-base", "turn-1")).cueId).toBe(
      "en-ack-one",
    );
    expect((await select(registry, "uk-UA", "meeting-neutral", "turn-1")).cueId).toBe(
      "neutral-ack-one",
    );
    expect(
      (await select(registry, "ru", "meeting-ru-think", "turn-1", "test-voice", "deliberation")).cueId,
    ).toBe("ru-think-one");
    expect(
      await registry.select({
        locale: "uk-UA",
        meetingId: "meeting-neutral-think",
        stage: "deliberation",
        turnId: "turn-1",
        voiceProfileId: "test-voice",
      }),
    ).toEqual({ ok: true, value: null });

    const stable = await select(registry, "ru-RU", "stable-meeting", "stable-turn");
    const sameRegistryRepeated = await select(
      registry,
      "ru-RU",
      "stable-meeting",
      "stable-turn",
    );
    const reloaded = await FileConversationThinkingCueRegistry.load(
      root,
      "test-voice",
      testVoiceId,
    );
    const repeated = await select(reloaded, "ru-RU", "stable-meeting", "stable-turn");
    expect(sameRegistryRepeated.cueId).toBe(stable.cueId);
    expect(sameRegistryRepeated.playbackAttemptId).toBe(stable.playbackAttemptId);
    expect(stable.playbackAttemptId).toBe(repeated.playbackAttemptId);
    expect(stable.playbackAttemptId.length).toBeLessThanOrEqual(128);

    const firstChunk = russian.pcmChunks[0];
    if (firstChunk === undefined) {
      throw new Error("fixture did not produce a PCM chunk");
    }
    firstChunk[0] = 0;
    await rm(join(root, "ru-ack-one.pcm"));
    const freshSelection = await select(registry, "ru", "meeting-preloaded", "turn-1");
    expect(freshSelection.pcmChunks[0]?.[0]).toBe(1);
  });

  it("selects deterministically by turn identity across replay and restart", async () => {
    const registry = await FileConversationThinkingCueRegistry.load(
      await cueRoot(),
      "test-voice",
      testVoiceId,
    );

    const selected = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        select(registry, "ru", "meeting-1", `turn-${index + 1}`),
      ),
    );
    const replayed = await select(registry, "ru", "meeting-1", "turn-1");
    expect(replayed).toEqual(selected[0]);
    expect(new Set(selected.map((cue) => cue.cueId))).toEqual(
      new Set(["ru-ack-one", "ru-ack-two"]),
    );

    const reloaded = await FileConversationThinkingCueRegistry.load(
      await cueRoot(),
      "test-voice",
      testVoiceId,
    );
    const afterRestart = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        select(reloaded, "ru", "meeting-1", `turn-${8 - index}`),
      ),
    );
    expect(afterRestart.toReversed()).toEqual(selected);
  });

  it("fails closed for a mismatched voice profile", async () => {
    const root = await cueRoot();
    await expect(
      FileConversationThinkingCueRegistry.load(root, "another-voice", testVoiceId),
    ).rejects.toThrow("voice profile does not match");
    await expect(
      FileConversationThinkingCueRegistry.load(root, "test-voice", "another-voice-id"),
    ).rejects.toThrow("voice ID does not match");

    const registry = await FileConversationThinkingCueRegistry.load(
      root,
      "test-voice",
      testVoiceId,
    );
    await expect(
      registry.select({
        locale: "ru",
        meetingId: "meeting-1",
        stage: "acknowledgement",
        turnId: "turn-1",
        voiceProfileId: "another-voice",
      }),
    ).resolves.toEqual({ ok: true, value: null });
  });

  it("accepts safe relative PCM paths beneath the cue root", async () => {
    const root = await cueRoot({
      manifest: cueManifest({
        ruAcknowledgement: [manifestCue("ru-ack-one", "audio/ru-ack-one.pcm", 1)],
      }),
    });
    await mkdir(join(root, "audio"));
    await writeFile(join(root, "audio/ru-ack-one.pcm"), pcm(1));

    const registry = await FileConversationThinkingCueRegistry.load(
      root,
      "test-voice",
      testVoiceId,
    );
    expect((await select(registry, "ru", "meeting-1", "turn-1")).cueId).toBe("ru-ack-one");
  });

  it("fails closed for malformed manifests and path traversal", async () => {
    const malformed = await cueRoot({ manifest: "not a manifest" });
    await expect(FileConversationThinkingCueRegistry.load(malformed, "test-voice", testVoiceId)).rejects.toThrow(
      "Thinking cue manifest must be an object",
    );

    const traversal = await cueRoot({
      manifest: cueManifest({
        ruAcknowledgement: [{
          cueId: "ru-ack-one",
          pcmFile: "../outside.pcm",
          sha256: "a".repeat(64),
        }],
      }),
    });
    await expect(FileConversationThinkingCueRegistry.load(traversal, "test-voice", testVoiceId)).rejects.toThrow(
      "unsafe pcmFile",
    );
  });

  it("fails closed for symlinked, non-regular, and odd PCM assets", async () => {
    const symlinked = await cueRoot();
    await writeFile(join(symlinked, "source.pcm"), pcm(7));
    await rm(join(symlinked, "ru-ack-one.pcm"));
    await symlink("source.pcm", join(symlinked, "ru-ack-one.pcm"));
    await expect(FileConversationThinkingCueRegistry.load(symlinked, "test-voice", testVoiceId)).rejects.toThrow(
      "regular non-symlink file",
    );

    const nonRegular = await cueRoot();
    await rm(join(nonRegular, "ru-ack-one.pcm"));
    await mkdir(join(nonRegular, "ru-ack-one.pcm"));
    await expect(FileConversationThinkingCueRegistry.load(nonRegular, "test-voice", testVoiceId)).rejects.toThrow(
      "regular non-symlink file",
    );

    const oddPcm = await cueRoot();
    await writeFile(join(oddPcm, "ru-ack-one.pcm"), Uint8Array.of(1, 2, 3));
    await expect(FileConversationThinkingCueRegistry.load(oddPcm, "test-voice", testVoiceId)).rejects.toThrow(
      "non-empty s16le PCM",
    );
  });

  it("rejects corrupt same-length PCM instead of trusting its byte count", async () => {
    const root = await cueRoot();
    const corrupt = pcm(1, 2);
    corrupt[corrupt.length - 1] = (corrupt.at(-1) ?? 0) ^ 0xff;
    await writeFile(join(root, "ru-ack-one.pcm"), corrupt);

    await expect(
      FileConversationThinkingCueRegistry.load(root, "test-voice", testVoiceId),
    ).rejects.toThrow("SHA-256 does not match its manifest");
  });
});
