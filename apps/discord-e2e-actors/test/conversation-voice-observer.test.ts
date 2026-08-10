import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConversationVoiceEvidence } from "../src/conversation-voice-evidence.js";
import {
  ConversationVoiceCaptureController,
  ConversationVoiceCaptureError,
  writeNewConversationVoiceEvidenceAtomically,
  type ConversationVoiceCaptureOptions,
  type ConversationVoiceOpusDecoder,
} from "../src/conversation-voice-observer.js";

const startedAt = {
  epochMilliseconds: 1_754_000_000_000,
  monotonicMilliseconds: 20_000,
} as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

describe("ConversationVoiceCaptureController", () => {
  it("records first Craig packet timing and bounded stereo PCM evidence", () => {
    const firstPcm = pcmPacket(1_024);
    const secondPcm = pcmPacket(-1_024);
    const controller = controllerFixture(new Map([
      [1, firstPcm],
      [2, secondPcm],
    ]));

    controller.start(startedAt);
    expect(controller.acceptPacket(packet(1, 20, 1))).toEqual({
      kind: "accepted",
      captureComplete: false,
    });
    expect(controller.acceptPacket(packet(2, 40, 2))).toEqual({
      kind: "accepted",
      captureComplete: true,
    });
    const capture = controller.complete(timestamp(45));

    expect(capture.acceptedDurationMilliseconds).toBe(40);
    expect(capture.acceptedPacketCount).toBe(2);
    expect(capture.firstPacketAt).toEqual(timestamp(20));
    expect(capture.pcm).toMatchObject({
      byteLength: 7_680,
      channels: 2,
      encoding: "s16le",
      rms: 1_024 / 32_768,
      sampleRateHertz: 48_000,
      sha256: createHash("sha256").update(firstPcm).update(secondPcm).digest("hex"),
    });
    expect(capture.pcm.nonSilence).toEqual({
      sampleCount: 3_840,
      sampleCountAboveThreshold: 3_840,
      sampleRatioAboveThreshold: 1,
      thresholdSample: 256,
    });
  });

  it("fails no-audio and incomplete-duration timeouts without synthesizing evidence", () => {
    const noAudio = controllerFixture(new Map());
    noAudio.start(startedAt);
    expectCaptureError(() => noAudio.complete(timestamp(1_000)), "no-audio");

    const incomplete = controllerFixture(new Map([[1, pcmPacket(1_024)]]));
    incomplete.start(startedAt);
    incomplete.acceptPacket(packet(1, 20, 1));
    expectCaptureError(() => incomplete.complete(timestamp(1_000)), "capture-timeout");
  });

  it("fails closed when decoded PCM exceeds its byte cap", () => {
    const controller = controllerFixture(new Map([
      [1, pcmPacket(1_024)],
      [2, pcmPacket(1_024, 11_520)],
    ]), {
      expectedDuration: { minimumMilliseconds: 60, maximumMilliseconds: 60 },
      maxPcmBytes: 11_520,
    });
    controller.start(startedAt);
    controller.acceptPacket(packet(1, 20, 1));

    expectCaptureError(
      () => controller.acceptPacket(packet(2, 40, 2)),
      "pcm-byte-limit-exceeded",
    );
  });

  it("ignores duplicate and late packets before decoding them", () => {
    let decodedPackets = 0;
    const decoder: ConversationVoiceOpusDecoder = {
      decode: () => {
        decodedPackets += 1;
        return pcmPacket(1_024);
      },
    };
    const controller = new ConversationVoiceCaptureController({
      captureTimeoutMilliseconds: 1_000,
      expectedDuration: { minimumMilliseconds: 100, maximumMilliseconds: 120 },
      maxPcmBytes: 23_040,
    }, decoder);
    controller.start(startedAt);

    expect(controller.acceptPacket(packet(1, 20, 1))).toMatchObject({ kind: "accepted" });
    expect(controller.acceptPacket(packet(1, 25, 1))).toEqual({ kind: "ignored-duplicate" });
    expect(controller.acceptPacket(packet(2, 1_001, 2))).toEqual({ kind: "ignored-late" });
    expect(decodedPackets).toBe(1);
  });

  it("rejects all-silent PCM even when packets satisfy the duration bound", () => {
    const controller = controllerFixture(new Map([[1, pcmPacket(0)]]), {
      expectedDuration: { minimumMilliseconds: 20, maximumMilliseconds: 20 },
      maxPcmBytes: 3_840,
    });
    controller.start(startedAt);
    controller.acceptPacket(packet(1, 20, 1));

    expectCaptureError(() => controller.complete(timestamp(25)), "silent-pcm");
  });
});

describe("conversation voice evidence publication", () => {
  it("atomically creates a new evidence file and refuses to replace it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conversation-voice-evidence-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "capture.json");
    const evidence = evidenceFixture();

    await writeNewConversationVoiceEvidenceAtomically(outputPath, evidence);
    const original = await readFile(outputPath, "utf8");
    await expect(writeNewConversationVoiceEvidenceAtomically(outputPath, evidence))
      .rejects.toMatchObject({ code: "output-exists" });

    expect(await readFile(outputPath, "utf8")).toBe(original);
    expect(JSON.parse(original)).toMatchObject({
      capture: { cancellation: { status: "not-observed" } },
      correlation: {
        provenance: "operator-supplied",
        verification: "not-run",
      },
      schemaVersion: 3,
      transcriptVerification: { status: "not-run" },
    });
  });
});

function controllerFixture(
  pcmByPacket: ReadonlyMap<number, Uint8Array>,
  overrides: Partial<ConversationVoiceCaptureOptions> = {},
): ConversationVoiceCaptureController {
  return new ConversationVoiceCaptureController({
    captureTimeoutMilliseconds: 1_000,
    expectedDuration: { minimumMilliseconds: 40, maximumMilliseconds: 60 },
    maxPcmBytes: 11_520,
    ...overrides,
  }, {
    decode: (opusPacket) => {
      const pcm = pcmByPacket.get(opusPacket[0] ?? -1);
      if (pcm === undefined) {
        throw new Error("synthetic packet missing PCM");
      }
      return pcm;
    },
  });
}

function evidenceFixture() {
  const controller = controllerFixture(new Map([
    [1, pcmPacket(1_024)],
    [2, pcmPacket(-1_024)],
  ]));
  controller.start(startedAt);
  controller.acceptPacket(packet(1, 20, 1));
  controller.acceptPacket(packet(2, 40, 2));
  const capture = controller.complete(timestamp(45));
  return createConversationVoiceEvidence({
    attemptId: "attempt-1",
    authenticatedBotId: "22222222222222222",
    capture,
    captureTimeoutMilliseconds: 1_000,
    craigBotId: "1533224474609057793",
    expectedDuration: { minimumMilliseconds: 40, maximumMilliseconds: 60 },
    guildId: "11111111111111111",
    maxPcmBytes: 11_520,
    observerApplicationId: "22222222222222222",
    privateTestGuildConfirmed: true,
    purpose: "addressed-answer",
    recordingId: "recording-1",
    runId: "run-1",
    turnId: "turn-1",
    voiceChannelId: "33333333333333333",
  });
}

function expectCaptureError(
  operation: () => unknown,
  code: ConversationVoiceCaptureError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ConversationVoiceCaptureError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code} capture error`);
}

function packet(sequence: number, elapsedMilliseconds: number, packetId: number) {
  return {
    opusPacket: Uint8Array.of(packetId),
    sequence,
    timing: timestamp(elapsedMilliseconds),
  };
}

function pcmPacket(sample: number, byteLength = 3_840): Uint8Array {
  const pcm = new Uint8Array(byteLength);
  const data = new DataView(pcm.buffer);
  for (let offset = 0; offset < byteLength; offset += 2) {
    data.setInt16(offset, sample, true);
  }
  return pcm;
}

function timestamp(elapsedMilliseconds: number) {
  return {
    epochMilliseconds: startedAt.epochMilliseconds + elapsedMilliseconds,
    monotonicMilliseconds: startedAt.monotonicMilliseconds + elapsedMilliseconds,
  };
}
