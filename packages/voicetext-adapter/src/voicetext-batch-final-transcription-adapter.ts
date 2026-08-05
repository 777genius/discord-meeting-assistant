import type {
  FinalTranscriptionPort,
  GeneratedTranscript,
  PortResult,
  TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core";

import {
  validateVoicetextBatchFinalTranscriptionOptions,
  validateVoicetextBatchFinalTranscriptionRequest,
  type CancellableVoicetextBatchTranscriptionRequest,
  type ValidatedVoicetextBatchFinalTranscriptionOptions,
  type VoicetextBatchFinalTranscriptionOptions,
} from "./voicetext-batch-final-transcription-configuration.js";
import { VoicetextAdapterError, toVoicetextPortFailure } from "./errors.js";
import type { CompleteOggArtifactReader } from "./ogg-artifact-reader.js";
import type { VoicetextBatchClient } from "./voicetext-batch-client.js";
import {
  compareVoicetextBatchTurns,
  stableVoicetextBatchId,
  type VoicetextBatchProviderTurn,
} from "./voicetext-batch-final-transcription-turns.js";
import {
  AuthoritativeArtifactFingerprintBook,
  systemVoicetextBatchPollingScheduler,
  VoicetextBatchSpeakerTranscriber,
  type VoicetextBatchPollingScheduler,
} from "./voicetext-batch-speaker-transcriber.js";

export type {
  CancellableVoicetextBatchTranscriptionRequest,
  VoicetextBatchFinalTranscriptionOptions,
} from "./voicetext-batch-final-transcription-configuration.js";
export type { VoicetextBatchPollingScheduler } from "./voicetext-batch-speaker-transcriber.js";

type SpeakerOutcome =
  | { readonly ok: true; readonly turns: readonly VoicetextBatchProviderTurn[] }
  | { readonly error: unknown; readonly ok: false };

export class VoicetextBatchFinalTranscriptionAdapter implements FinalTranscriptionPort {
  private readonly options: ValidatedVoicetextBatchFinalTranscriptionOptions;
  private readonly speakerTranscriber: VoicetextBatchSpeakerTranscriber;

  public constructor(
    client: VoicetextBatchClient,
    artifactReader: CompleteOggArtifactReader,
    options: VoicetextBatchFinalTranscriptionOptions,
    pollingScheduler: VoicetextBatchPollingScheduler = systemVoicetextBatchPollingScheduler,
  ) {
    this.options = validateVoicetextBatchFinalTranscriptionOptions(options);
    this.speakerTranscriber = new VoicetextBatchSpeakerTranscriber(
      client,
      artifactReader,
      this.options,
      pollingScheduler,
    );
  }

  public async transcribe(
    request: CancellableVoicetextBatchTranscriptionRequest,
  ): Promise<PortResult<GeneratedTranscript>> {
    try {
      return { ok: true, value: await this.transcribeOrThrow(request) };
    } catch (error: unknown) {
      if (request.signal?.aborted === true && !(error instanceof VoicetextAdapterError)) {
        return {
          failure: toVoicetextPortFailure(new VoicetextAdapterError(
            "cancelled",
            "Voicetext batch transcription was cancelled",
            true,
            { cause: error },
          )),
          ok: false,
        };
      }
      return { failure: toVoicetextPortFailure(error), ok: false };
    }
  }

  private async transcribeOrThrow(
    request: CancellableVoicetextBatchTranscriptionRequest,
  ): Promise<GeneratedTranscript> {
    validateVoicetextBatchFinalTranscriptionRequest(request, this.options);
    request.signal?.throwIfAborted();

    const failureAbort = new AbortController();
    const workSignal = request.signal === undefined
      ? failureAbort.signal
      : AbortSignal.any([request.signal, failureAbort.signal]);
    const artifactFingerprints = new AuthoritativeArtifactFingerprintBook();
    let firstFailure: { readonly error: unknown } | undefined;
    const outcomes = await mapVoicetextBatchWithConcurrency(
      request.recording.speakerAudio,
      this.options.maxConcurrency,
      workSignal,
      async (reference, speakerIndex): Promise<SpeakerOutcome> => {
        try {
          return {
            ok: true,
            turns: await this.speakerTranscriber.transcribe({
              artifactFingerprints,
              externalSignal: workSignal,
              reference,
              request,
              speakerIndex,
            }),
          };
        } catch (error: unknown) {
          if (firstFailure === undefined) {
            firstFailure = { error };
            failureAbort.abort(error);
          }
          return { error, ok: false };
        }
      },
    );
    if (firstFailure !== undefined) {
      throw firstFailure.error;
    }

    const turns = outcomes.flatMap((outcome) => outcome?.ok === true ? outcome.turns : [])
      .toSorted(compareVoicetextBatchTurns);
    if (new Set(turns.map(({ stableTurnId }) => stableTurnId)).size !== turns.length) {
      throw new VoicetextAdapterError(
        "invalid_provider_response",
        "Voicetext batch returned duplicate turn identities",
        false,
      );
    }
    return {
      transcriptId: stableVoicetextBatchId("transcript", request.idempotencyKey),
      turns: turns.map((turn): TranscriptTurnSnapshot => ({
        endMs: turn.endMs,
        speakerId: turn.speakerId,
        startMs: turn.startMs,
        text: turn.text,
        turnId: turn.stableTurnId,
      })),
      version: 1,
    };
  }
}

async function mapVoicetextBatchWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  signal: AbortSignal,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<readonly (Output | undefined)[]> {
  const results: Array<Output | undefined> = Array.from({ length: values.length });
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted) {
        return;
      }
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) {
        return;
      }
      const value = values[currentIndex];
      if (value === undefined) {
        throw new VoicetextAdapterError(
          "invalid_input",
          "missing bounded-concurrency work item",
          false,
        );
      }
      results[currentIndex] = await mapper(value, currentIndex);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
  return results;
}
