import type {
  FinalTranscriptionPort,
  FinalTranscriptionRequest,
} from "@discord-meeting/meeting-core/transcription";
import { describe, expect, it, vi } from "vitest";

import {
  DurableFinalTranscriptionRouter,
  elevenLabsVoicetextBatchExecutionBinding,
  legacyFinalTranscriptionExecutionBinding,
  legacyVoicetextBatchExecutionBinding,
  selectedFinalTranscriptionExecutionBinding,
  speachesFinalTranscriptionExecutionBinding,
  supportedFinalTranscriptionExecutionBindings,
  voicetextBatchExecutionBinding,
} from "../src/composition/transcription.js";

const request = {
  idempotencyKey: "transcription-1",
  meetingId: "meeting-1",
  recording: {
    manifestLocator: "s3://recordings/meeting-1/manifest.json",
    recordingId: "recording-1",
    speakerAudio: [],
  },
} satisfies FinalTranscriptionRequest;

describe("DurableFinalTranscriptionRouter", () => {
  it("maps both supported profiles to stable composition-owned bindings", () => {
    expect(voicetextBatchExecutionBinding("deepgram-nova-3"))
      .toBe(legacyVoicetextBatchExecutionBinding);
    expect(voicetextBatchExecutionBinding("elevenlabs-scribe-v2"))
      .toBe(elevenLabsVoicetextBatchExecutionBinding);
  });

  it("maps initial migration work to the historical top-level backend", () => {
    expect(legacyFinalTranscriptionExecutionBinding({
      transcriptionProvider: "voicetext",
    })).toBe(legacyVoicetextBatchExecutionBinding);
    expect(legacyFinalTranscriptionExecutionBinding({
      transcriptionProvider: "speaches",
    })).toBe(speachesFinalTranscriptionExecutionBinding);
  });

  it("selects new VoiceText work independently from frozen legacy work", () => {
    const config = {
      transcriptionProvider: "voicetext" as const,
      voicetext: { batchProfile: "elevenlabs-scribe-v2" as const },
    };
    expect(selectedFinalTranscriptionExecutionBinding(config))
      .toBe(elevenLabsVoicetextBatchExecutionBinding);
    expect(legacyFinalTranscriptionExecutionBinding(config))
      .toBe(legacyVoicetextBatchExecutionBinding);
    expect(supportedFinalTranscriptionExecutionBindings(config)).toEqual(new Set([
      legacyVoicetextBatchExecutionBinding,
      elevenLabsVoicetextBatchExecutionBinding,
    ]));
    expect(supportedFinalTranscriptionExecutionBindings({ transcriptionProvider: "speaches" }))
      .toEqual(new Set([speachesFinalTranscriptionExecutionBinding]));
  });

  it.each([
    [legacyVoicetextBatchExecutionBinding, "deepgram"],
    [elevenLabsVoicetextBatchExecutionBinding, "elevenlabs"],
  ] as const)("routes %s to only the pinned delegate", async (binding, expected) => {
    const deepgram = successfulDelegate("deepgram");
    const elevenlabs = successfulDelegate("elevenlabs");
    const router = new DurableFinalTranscriptionRouter(
      { getTranscriptionExecutionBinding: async () => binding },
      new Map([
        [legacyVoicetextBatchExecutionBinding, deepgram],
        [elevenLabsVoicetextBatchExecutionBinding, elevenlabs],
      ]),
    );

    await expect(router.transcribe(request)).resolves.toMatchObject({
      ok: true,
      value: { transcriptId: expected },
    });
    expect(deepgram.transcribe).toHaveBeenCalledTimes(expected === "deepgram" ? 1 : 0);
    expect(elevenlabs.transcribe).toHaveBeenCalledTimes(expected === "elevenlabs" ? 1 : 0);
  });

  it("fails closed for an unknown binding without invoking a provider", async () => {
    const delegate = successfulDelegate("unused");
    const router = new DurableFinalTranscriptionRouter(
      { getTranscriptionExecutionBinding: async () => "unknown:v1" },
      new Map([[legacyVoicetextBatchExecutionBinding, delegate]]),
    );

    await expect(router.transcribe(request)).resolves.toEqual({
      failure: {
        code: "FINAL_TRANSCRIPTION_BINDING_UNSUPPORTED",
        message: "The durable final transcription binding is unsupported",
        retryable: false,
      },
      ok: false,
    });
    expect(delegate.transcribe).not.toHaveBeenCalled();
  });

  it("fails closed for a missing binding without invoking a provider", async () => {
    const delegate = successfulDelegate("unused");
    const router = new DurableFinalTranscriptionRouter(
      { getTranscriptionExecutionBinding: async (): Promise<string | undefined> => { return; } },
      new Map([[legacyVoicetextBatchExecutionBinding, delegate]]),
    );

    await expect(router.transcribe(request)).resolves.toEqual({
      failure: {
        code: "FINAL_TRANSCRIPTION_BINDING_MISSING",
        message: "The durable final transcription binding is missing",
        retryable: false,
      },
      ok: false,
    });
    expect(delegate.transcribe).not.toHaveBeenCalled();
  });

  it("preserves binding-store transport failures for the worker retry path", async () => {
    const delegate = successfulDelegate("unused");
    const transportFailure = new Error("database unavailable");
    const router = new DurableFinalTranscriptionRouter(
      { getTranscriptionExecutionBinding: async () => { throw transportFailure; } },
      new Map([[legacyVoicetextBatchExecutionBinding, delegate]]),
    );

    await expect(router.transcribe(request)).rejects.toBe(transportFailure);
    expect(delegate.transcribe).not.toHaveBeenCalled();
  });
});

function successfulDelegate(transcriptId: string): FinalTranscriptionPort & {
  readonly transcribe: ReturnType<typeof vi.fn>;
} {
  return {
    transcribe: vi.fn(async () => ({
      ok: true as const,
      value: { transcriptId, turns: [], version: 1 },
    })),
  };
}
