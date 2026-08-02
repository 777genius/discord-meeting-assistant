import { createHash } from "node:crypto";

import type {
  FinalTranscriptionPort,
  FinalTranscriptionRequest,
  GeneratedTranscript,
  PortResult,
  SpeakerAudioReferenceSnapshot,
  TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core";

import {
  systemVoicetextPacingScheduler,
  type VoicetextPacingScheduler,
} from "./audio-pacing.js";
import {
  toVoicetextPortFailure,
  VoicetextAdapterError,
  VoicetextTransportError,
} from "./errors.js";
import type {
  CompleteOggArtifactReader,
  CompleteOggAudioArtifact,
} from "./ogg-artifact-reader.js";
import type {
  CompleteOggToPcmTranscoder,
  MonoPcmS16Le16KhzAudio,
} from "./pcm-transcoder.js";
import {
  parseServerMessage,
  type VoicetextConfigMessage,
  type VoicetextFinalSegment,
  type VoicetextServerMessage,
} from "./protocol.js";
import type {
  VoicetextWebSocketConnection,
  VoicetextWebSocketConnector,
} from "./websocket-connector.js";
import { WsVoicetextWebSocketConnector } from "./ws-websocket-connector.js";

const mebibyte = 1_024 * 1_024;
const pcmBytesPerSecond = 16_000 * 2;
const backendMaximumAudioBytesPerSecond = 256_000;
const backendMaximumAudioFrameBytes = 65_536;
const defaultMaximumAudioBytesPerSecond = 224_000;
const neverAbortedSignal = new AbortController().signal;

export interface VoicetextFinalTranscriptionOptions {
  readonly artifactReadTimeoutMs?: number;
  readonly audioAckTimeoutMs?: number;
  readonly audioFrameBytes?: number;
  readonly endpoint: string;
  readonly finalizeTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly keyterms?: readonly string[];
  readonly language?: string;
  readonly maxArtifactBytesPerSpeaker?: number;
  readonly maxAudioBytesPerSecond?: number;
  readonly maxInboundFrameBytes?: number;
  readonly maxPcmBytesPerSpeaker?: number;
  readonly maxSegmentOverrunMs?: number;
  readonly maxSegmentsPerSpeaker?: number;
  readonly maxSpeakerTracks?: number;
  readonly maxTotalArtifactBytes?: number;
  readonly maxTotalPcmBytes?: number;
  readonly maxTranscriptCharsPerSegment?: number;
  readonly maxTranscriptCharsPerSpeaker?: number;
  readonly readyTimeoutMs?: number;
  readonly token: string;
  readonly transcodeTimeoutMs?: number;
}

export type CancellableVoicetextTranscriptionRequest = FinalTranscriptionRequest & {
  readonly signal?: AbortSignal;
};

interface ValidatedOptions {
  readonly artifactReadTimeoutMs: number;
  readonly audioAckTimeoutMs: number;
  readonly audioFrameBytes: number;
  readonly authorization: string;
  readonly endpoint: URL;
  readonly finalizeTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly keyterms: readonly string[];
  readonly language: string;
  readonly maxArtifactBytesPerSpeaker: number;
  readonly maxAudioBytesPerSecond: number;
  readonly maxInboundFrameBytes: number;
  readonly maxPcmBytesPerSpeaker: number;
  readonly maxSegmentOverrunMs: number;
  readonly maxSegmentsPerSpeaker: number;
  readonly maxSpeakerTracks: number;
  readonly maxTotalArtifactBytes: number;
  readonly maxTotalPcmBytes: number;
  readonly maxTranscriptCharsPerSegment: number;
  readonly maxTranscriptCharsPerSpeaker: number;
  readonly readyTimeoutMs: number;
  readonly transcodeTimeoutMs: number;
}

interface ProviderTurn {
  readonly endMs: number;
  readonly speakerId: string;
  readonly stableTurnId: string;
  readonly startMs: number;
  readonly text: string;
}

interface SessionCollector {
  readonly fingerprints: Set<string>;
  readonly segments: VoicetextFinalSegment[];
  totalCharacters: number;
}

export class VoicetextFinalTranscriptionAdapter implements FinalTranscriptionPort {
  private readonly options: ValidatedOptions;

  public constructor(
    private readonly artifactReader: CompleteOggArtifactReader,
    private readonly transcoder: CompleteOggToPcmTranscoder,
    options: VoicetextFinalTranscriptionOptions,
    private readonly connector: VoicetextWebSocketConnector = new WsVoicetextWebSocketConnector(),
    private readonly pacingScheduler: VoicetextPacingScheduler = systemVoicetextPacingScheduler,
  ) {
    this.options = validateOptions(options);
  }

  public async transcribe(
    request: CancellableVoicetextTranscriptionRequest,
  ): Promise<PortResult<GeneratedTranscript>> {
    try {
      return { ok: true, value: await this.transcribeOrThrow(request) };
    } catch (error: unknown) {
      if (request.signal?.aborted === true && !(error instanceof VoicetextAdapterError)) {
        return {
          ok: false,
          failure: toVoicetextPortFailure(new VoicetextAdapterError(
            "cancelled",
            "Voicetext transcription was cancelled",
            true,
            { cause: error },
          )),
        };
      }
      return { ok: false, failure: toVoicetextPortFailure(error) };
    }
  }

  private async transcribeOrThrow(
    request: CancellableVoicetextTranscriptionRequest,
  ): Promise<GeneratedTranscript> {
    validateRequest(request, this.options.maxSpeakerTracks);
    request.signal?.throwIfAborted();

    let totalArtifactBytes = 0;
    let totalPcmBytes = 0;
    const turns: ProviderTurn[] = [];
    for (const [speakerIndex, reference] of request.recording.speakerAudio.entries()) {
      const artifact = await this.readArtifact(reference, request.signal);
      totalArtifactBytes = addBoundedBytes(
        totalArtifactBytes,
        artifact.bytes.byteLength,
        this.options.maxTotalArtifactBytes,
        "Authoritative Ogg audio",
      );
      const pcm = await this.transcode(artifact, request.signal);
      totalPcmBytes = addBoundedBytes(
        totalPcmBytes,
        pcm.bytes.byteLength,
        this.options.maxTotalPcmBytes,
        "Transcoded PCM audio",
      );
      turns.push(...await this.transcribeSpeaker(
        pcm,
        reference,
        speakerIndex,
        request.idempotencyKey,
        request.signal,
      ));
    }

    const orderedTurns = turns.toSorted(compareTurns);
    if (new Set(orderedTurns.map(({ stableTurnId }) => stableTurnId)).size !== orderedTurns.length) {
      throw new VoicetextAdapterError("invalid_provider_response", "Voicetext produced duplicate turn identities", false);
    }
    return {
      transcriptId: stableId("transcript", request.idempotencyKey),
      turns: orderedTurns.map((turn): TranscriptTurnSnapshot => ({
        endMs: turn.endMs,
        speakerId: turn.speakerId,
        startMs: turn.startMs,
        text: turn.text,
        turnId: turn.stableTurnId,
      })),
      version: 1,
    };
  }

  private async readArtifact(
    reference: SpeakerAudioReferenceSnapshot,
    externalSignal: AbortSignal | undefined,
  ): Promise<CompleteOggAudioArtifact> {
    const operation = operationSignal(externalSignal, this.options.artifactReadTimeoutMs);
    try {
      const artifact = await awaitWithSignal(this.artifactReader.read(reference.audioLocator, {
        maxBytes: this.options.maxArtifactBytesPerSpeaker,
        signal: operation.signal,
      }), operation.signal);
      validateArtifact(artifact, this.options.maxArtifactBytesPerSpeaker);
      return artifact;
    } catch (error: unknown) {
      throw classifyOperationError(error, externalSignal, operation.timeoutSignal, "artifact_read_failed");
    }
  }

  private async transcode(
    artifact: CompleteOggAudioArtifact,
    externalSignal: AbortSignal | undefined,
  ): Promise<MonoPcmS16Le16KhzAudio> {
    const operation = operationSignal(externalSignal, this.options.transcodeTimeoutMs);
    try {
      const pcm = await awaitWithSignal(this.transcoder.transcode(artifact.bytes, {
        maxOutputBytes: this.options.maxPcmBytesPerSpeaker,
        signal: operation.signal,
      }), operation.signal);
      validatePcm(pcm, this.options.maxPcmBytesPerSpeaker);
      return pcm;
    } catch (error: unknown) {
      throw classifyOperationError(error, externalSignal, operation.timeoutSignal, "transcode_failed");
    }
  }

  private async transcribeSpeaker(
    pcm: MonoPcmS16Le16KhzAudio,
    reference: SpeakerAudioReferenceSnapshot,
    speakerIndex: number,
    idempotencyKey: string,
    externalSignal: AbortSignal | undefined,
  ): Promise<readonly ProviderTurn[]> {
    const connect = operationSignal(externalSignal, this.options.handshakeTimeoutMs);
    let socket: VoicetextWebSocketConnection;
    try {
      socket = await awaitWithSignal(this.connector.connect({
        authorization: this.options.authorization,
        endpoint: new URL(this.options.endpoint),
        handshakeTimeoutMs: this.options.handshakeTimeoutMs,
        maxInboundFrameBytes: this.options.maxInboundFrameBytes,
        signal: connect.signal,
      }), connect.signal);
    } catch (error: unknown) {
      throw classifyOperationError(error, externalSignal, connect.timeoutSignal, "transport_error");
    }

    let completed = false;
    try {
      const config: VoicetextConfigMessage = {
        capabilities: ["finalize_ack"],
        channels: 1,
        client_session_id: stableUuid(idempotencyKey, String(speakerIndex + 1)),
        encoding: "pcm_s16le",
        ...(this.options.keyterms.length === 0 ? {} : { keyterms: this.options.keyterms }),
        language: this.options.language,
        protocol_v: 2,
        provider: "deepgram",
        sample_rate: 16_000,
        type: "config",
      };
      await this.sendText(socket, config, externalSignal, this.options.readyTimeoutMs);
      const collector: SessionCollector = { fingerprints: new Set(), segments: [], totalCharacters: 0 };
      await this.waitForReady(socket, externalSignal);

      const pacingStartedAtMs = this.readPacingTime();
      let expectedSequence = 0;
      for (let offset = 0; offset < pcm.bytes.byteLength; offset += this.options.audioFrameBytes) {
        const end = Math.min(offset + this.options.audioFrameBytes, pcm.bytes.byteLength);
        const frame = pcm.bytes.subarray(offset, end);
        await this.paceAudio(offset, pacingStartedAtMs, externalSignal);
        expectedSequence += 1;
        await this.sendBinary(socket, frame, externalSignal);
        await this.waitForAck(socket, expectedSequence, collector, externalSignal);
      }

      await this.sendText(socket, { type: "finalize" }, externalSignal, this.options.finalizeTimeoutMs);
      await this.waitForFinalizeComplete(socket, collector, externalSignal);
      await this.sendText(socket, { type: "close" }, externalSignal, this.options.finalizeTimeoutMs);
      await socket.close(1_000, "finalized");
      completed = true;
      return this.mapSegments(
        collector.segments,
        pcm.bytes.byteLength,
        reference,
        speakerIndex,
        idempotencyKey,
      );
    } finally {
      if (!completed) {
        socket.terminate();
      }
    }
  }

  private async paceAudio(
    sentBytes: number,
    startedAtMs: number,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const signal = externalSignal ?? neverAbortedSignal;
    const targetElapsedMs = sentBytes * 1_000 / this.options.maxAudioBytesPerSecond;
    let previousTimeMs = startedAtMs;
    try {
      for (;;) {
        signal.throwIfAborted();
        const nowMs = this.readPacingTime();
        if (nowMs < previousTimeMs) {
          throw new VoicetextAdapterError("protocol_error", "Voicetext pacing clock moved backwards", false);
        }
        const remainingMs = targetElapsedMs - (nowMs - startedAtMs);
        if (remainingMs <= 0) {
          return;
        }
        previousTimeMs = nowMs;
        await awaitWithSignal(this.pacingScheduler.sleep(Math.ceil(remainingMs), signal), signal);
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        throw new VoicetextAdapterError("cancelled", "Voicetext transcription was cancelled", true, { cause: error });
      }
      if (error instanceof VoicetextAdapterError) {
        throw error;
      }
      throw new VoicetextAdapterError("transport_error", "Voicetext audio pacing failed", true, { cause: error });
    }
  }

  private readPacingTime(): number {
    const nowMs = this.pacingScheduler.nowMs();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new VoicetextAdapterError("protocol_error", "Voicetext pacing clock returned an invalid time", false);
    }
    return nowMs;
  }

  private async waitForReady(
    socket: VoicetextWebSocketConnection,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const operation = operationSignal(externalSignal, this.options.readyTimeoutMs);
    try {
      for (;;) {
        const message = await this.receive(socket, operation.signal);
        if (message.type === "ready") {
          return;
        }
        if (message.type === "error") {
          throw serverError(message);
        }
        if (message.type !== "usage_update" && message.type !== "partial") {
          throw new VoicetextAdapterError("protocol_error", `Voicetext sent ${message.type} before ready`, false);
        }
      }
    } catch (error: unknown) {
      throw classifyOperationError(error, externalSignal, operation.timeoutSignal, "transport_error");
    }
  }

  private async waitForAck(
    socket: VoicetextWebSocketConnection,
    expectedSequence: number,
    collector: SessionCollector,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const operation = operationSignal(externalSignal, this.options.audioAckTimeoutMs);
    try {
      for (;;) {
        const message = await this.receive(socket, operation.signal);
        if (message.type === "ack") {
          if (message.seq !== expectedSequence) {
            throw new VoicetextAdapterError("protocol_error", "Voicetext acknowledged audio out of order", false);
          }
          return;
        }
        this.collectInterleaved(message, collector, "audio acknowledgement");
      }
    } catch (error: unknown) {
      throw classifyOperationError(error, externalSignal, operation.timeoutSignal, "transport_error");
    }
  }

  private async waitForFinalizeComplete(
    socket: VoicetextWebSocketConnection,
    collector: SessionCollector,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const operation = operationSignal(externalSignal, this.options.finalizeTimeoutMs);
    try {
      for (;;) {
        const message = await this.receive(socket, operation.signal);
        if (message.type === "finalize_complete") {
          if (message.status === "timeout") {
            throw new VoicetextAdapterError("timeout", "Voicetext finalize did not flush provider results", true);
          }
          if (message.status === "no_provider" || !message.sawResult) {
            throw new VoicetextAdapterError("provider_error", "Voicetext provider did not confirm finalization", true);
          }
          return;
        }
        this.collectInterleaved(message, collector, "finalize_complete");
      }
    } catch (error: unknown) {
      throw classifyOperationError(error, externalSignal, operation.timeoutSignal, "transport_error");
    }
  }

  private collectInterleaved(
    message: VoicetextServerMessage,
    collector: SessionCollector,
    expected: string,
  ): void {
    if (message.type === "partial" || message.type === "usage_update") {
      return;
    }
    if (message.type === "final" || message.type === "segment_final") {
      collectFinalSegment(message, collector, this.options);
      return;
    }
    if (message.type === "error") {
      throw serverError(message);
    }
    throw new VoicetextAdapterError("protocol_error", `Voicetext sent ${message.type} while waiting for ${expected}`, false);
  }

  private async receive(
    socket: VoicetextWebSocketConnection,
    signal: AbortSignal,
  ): Promise<VoicetextServerMessage> {
    const frame = await socket.receive(signal);
    if (frame.type === "close") {
      throw new VoicetextTransportError("closed", "Voicetext closed before finalization completed", { closeCode: frame.code });
    }
    if (frame.type === "binary") {
      throw new VoicetextAdapterError("protocol_error", "Voicetext returned an unexpected binary frame", false);
    }
    return parseServerMessage(frame.data, this.options.maxTranscriptCharsPerSegment);
  }

  private async sendText(
    socket: VoicetextWebSocketConnection,
    message: object,
    externalSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    const operation = operationSignal(externalSignal, timeoutMs);
    try {
      await awaitWithSignal(socket.sendText(JSON.stringify(message), operation.signal), operation.signal);
    } catch (error: unknown) {
      throw classifyOperationError(error, externalSignal, operation.timeoutSignal, "transport_error");
    }
  }

  private async sendBinary(
    socket: VoicetextWebSocketConnection,
    frame: Uint8Array,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    const operation = operationSignal(externalSignal, this.options.audioAckTimeoutMs);
    try {
      await awaitWithSignal(socket.sendBinary(frame, operation.signal), operation.signal);
    } catch (error: unknown) {
      throw classifyOperationError(error, externalSignal, operation.timeoutSignal, "transport_error");
    }
  }

  private mapSegments(
    segments: readonly VoicetextFinalSegment[],
    pcmBytes: number,
    reference: SpeakerAudioReferenceSnapshot,
    speakerIndex: number,
    idempotencyKey: string,
  ): readonly ProviderTurn[] {
    const audioDurationMs = Math.floor(pcmBytes / pcmBytesPerSecond * 1_000);
    let previousEndMs = -1;
    return segments.flatMap((segment, segmentIndex): readonly ProviderTurn[] => {
      const text = segment.text.trim();
      if (text.length === 0) {
        return [];
      }
      if (segment.durationMs < 1 || segment.startMs < previousEndMs) {
        throw new VoicetextAdapterError("invalid_provider_response", "Voicetext final segments are overlapping or out of order", false);
      }
      const relativeEndMs = addSafeIntegers(segment.startMs, segment.durationMs);
      if (relativeEndMs > audioDurationMs + this.options.maxSegmentOverrunMs) {
        throw new VoicetextAdapterError("invalid_provider_response", "Voicetext final segment exceeds the speaker audio duration", false);
      }
      previousEndMs = relativeEndMs;
      const startMs = addSafeIntegers(reference.timelineOffsetMs, segment.startMs);
      const endMs = addSafeIntegers(reference.timelineOffsetMs, relativeEndMs);
      return [{
        endMs,
        speakerId: reference.speakerId,
        stableTurnId: stableId("turn", idempotencyKey, String(speakerIndex + 1), String(segmentIndex + 1)),
        startMs,
        text,
      }];
    });
  }
}

function validateOptions(options: VoicetextFinalTranscriptionOptions): ValidatedOptions {
  const endpoint = validateEndpoint(options.endpoint);
  const token = requireNonEmpty(options.token, "token");
  if (token.length > 8_192 || containsAsciiControlCharacter(token)) {
    throw new VoicetextAdapterError("invalid_input", "token is invalid", false);
  }
  const language = requireNonEmpty(options.language ?? "ru", "language");
  if (language.length > 10 || !/^[a-z0-9-]+$/iu.test(language)) {
    throw new VoicetextAdapterError("invalid_input", "language must be an ASCII language code up to 10 characters", false);
  }
  const maxArtifactBytesPerSpeaker = integerOption(options.maxArtifactBytesPerSpeaker, 512 * mebibyte, 1, 4_096 * mebibyte, "maxArtifactBytesPerSpeaker");
  const maxPcmBytesPerSpeaker = evenIntegerOption(options.maxPcmBytesPerSpeaker, 512 * mebibyte, 2, 4_096 * mebibyte, "maxPcmBytesPerSpeaker");
  const maxAudioBytesPerSecond = evenIntegerOption(
    options.maxAudioBytesPerSecond,
    defaultMaximumAudioBytesPerSecond,
    pcmBytesPerSecond,
    backendMaximumAudioBytesPerSecond,
    "maxAudioBytesPerSecond",
  );
  const audioFrameBytes = evenIntegerOption(
    options.audioFrameBytes,
    32_000,
    2,
    Math.min(backendMaximumAudioFrameBytes, maxAudioBytesPerSecond),
    "audioFrameBytes",
  );
  return {
    artifactReadTimeoutMs: timeoutOption(options.artifactReadTimeoutMs, 60_000, "artifactReadTimeoutMs"),
    audioAckTimeoutMs: timeoutOption(options.audioAckTimeoutMs, 10_000, "audioAckTimeoutMs"),
    audioFrameBytes,
    authorization: `Bearer ${token}`,
    endpoint,
    finalizeTimeoutMs: timeoutOption(options.finalizeTimeoutMs, 10_000, "finalizeTimeoutMs"),
    handshakeTimeoutMs: timeoutOption(options.handshakeTimeoutMs, 10_000, "handshakeTimeoutMs"),
    keyterms: normalizeKeyterms(options.keyterms),
    language,
    maxArtifactBytesPerSpeaker,
    maxAudioBytesPerSecond,
    maxInboundFrameBytes: integerOption(options.maxInboundFrameBytes, 256 * 1_024, 1_024, 4 * mebibyte, "maxInboundFrameBytes"),
    maxPcmBytesPerSpeaker,
    maxSegmentOverrunMs: integerOption(options.maxSegmentOverrunMs, 2_000, 0, 60_000, "maxSegmentOverrunMs"),
    maxSegmentsPerSpeaker: integerOption(options.maxSegmentsPerSpeaker, 10_000, 1, 100_000, "maxSegmentsPerSpeaker"),
    maxSpeakerTracks: integerOption(options.maxSpeakerTracks, 64, 1, 256, "maxSpeakerTracks"),
    maxTotalArtifactBytes: integerOption(options.maxTotalArtifactBytes, 2_048 * mebibyte, maxArtifactBytesPerSpeaker, 8_192 * mebibyte, "maxTotalArtifactBytes"),
    maxTotalPcmBytes: evenIntegerOption(options.maxTotalPcmBytes, 2_048 * mebibyte, maxPcmBytesPerSpeaker, 8_192 * mebibyte, "maxTotalPcmBytes"),
    maxTranscriptCharsPerSegment: integerOption(options.maxTranscriptCharsPerSegment, 16_384, 1, 1_000_000, "maxTranscriptCharsPerSegment"),
    maxTranscriptCharsPerSpeaker: integerOption(options.maxTranscriptCharsPerSpeaker, 1_000_000, 1, 10_000_000, "maxTranscriptCharsPerSpeaker"),
    readyTimeoutMs: timeoutOption(options.readyTimeoutMs, 30_000, "readyTimeoutMs"),
    transcodeTimeoutMs: timeoutOption(options.transcodeTimeoutMs, 300_000, "transcodeTimeoutMs"),
  };
}

function validateEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error: unknown) {
    throw new VoicetextAdapterError("invalid_input", "endpoint must be an absolute WSS URL", false, { cause: error });
  }
  if (endpoint.protocol !== "wss:" || endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.hash.length > 0 || endpoint.search.length > 0) {
    throw new VoicetextAdapterError("invalid_input", "endpoint must be a credential-free WSS URL without query or fragment", false);
  }
  return endpoint;
}

function validateRequest(request: FinalTranscriptionRequest, maxSpeakerTracks: number): void {
  requireNonEmpty(request.idempotencyKey, "idempotencyKey");
  requireNonEmpty(request.meetingId, "meetingId");
  requireNonEmpty(request.recording.recordingId, "recording.recordingId");
  requireNonEmpty(request.recording.manifestLocator, "recording.manifestLocator");
  if (request.recording.speakerAudio.length < 1 || request.recording.speakerAudio.length > maxSpeakerTracks) {
    throw new VoicetextAdapterError("invalid_input", `recording must contain between 1 and ${maxSpeakerTracks} speaker tracks`, false);
  }
  const locators = new Set<string>();
  const speakers = new Set<string>();
  for (const reference of request.recording.speakerAudio) {
    requireNonEmpty(reference.audioLocator, "speakerAudio.audioLocator");
    requireNonEmpty(reference.speakerId, "speakerAudio.speakerId");
    requireNonNegativeInteger(reference.timelineOffsetMs, "speakerAudio.timelineOffsetMs");
    if (locators.has(reference.audioLocator) || speakers.has(reference.speakerId)) {
      throw new VoicetextAdapterError("invalid_input", "speaker audio locators and speaker IDs must be unique", false);
    }
    locators.add(reference.audioLocator);
    speakers.add(reference.speakerId);
  }
}

function validateArtifact(artifact: unknown, maxBytes: number): asserts artifact is CompleteOggAudioArtifact {
  if (
    typeof artifact !== "object"
    || artifact === null
    || !("complete" in artifact)
    || artifact.complete !== true
    || !("container" in artifact)
    || artifact.container !== "ogg"
    || !("bytes" in artifact)
    || !(artifact.bytes instanceof Uint8Array)
  ) {
    throw new VoicetextAdapterError("invalid_input", "artifact reader must return one complete Ogg track", false);
  }
  if (artifact.bytes.byteLength < 4 || artifact.bytes.byteLength > maxBytes || Buffer.from(artifact.bytes.subarray(0, 4)).toString("ascii") !== "OggS") {
    throw new VoicetextAdapterError("invalid_input", "authoritative speaker artifact is not a bounded Ogg stream", false);
  }
}

function validatePcm(pcm: unknown, maxBytes: number): asserts pcm is MonoPcmS16Le16KhzAudio {
  if (
    typeof pcm !== "object"
    || pcm === null
    || !("channels" in pcm)
    || pcm.channels !== 1
    || !("sampleRate" in pcm)
    || pcm.sampleRate !== 16_000
    || !("encoding" in pcm)
    || pcm.encoding !== "pcm_s16le"
    || !("bytes" in pcm)
    || !(pcm.bytes instanceof Uint8Array)
  ) {
    throw new VoicetextAdapterError("transcode_failed", "transcoder returned the wrong PCM format", false);
  }
  if (pcm.bytes.byteLength < 2 || pcm.bytes.byteLength > maxBytes || pcm.bytes.byteLength % 2 !== 0) {
    throw new VoicetextAdapterError("transcode_failed", "transcoder returned invalid or oversized pcm_s16le audio", false);
  }
}

function collectFinalSegment(
  message: VoicetextFinalSegment,
  collector: SessionCollector,
  options: ValidatedOptions,
): void {
  if (collector.segments.length >= options.maxSegmentsPerSpeaker) {
    throw new VoicetextAdapterError("limit_exceeded", "Voicetext returned too many final segments", false);
  }
  const fingerprint = `${message.startMs}:${message.durationMs}:${message.text}`;
  if (collector.fingerprints.has(fingerprint)) {
    return;
  }
  const totalCharacters = collector.totalCharacters + message.text.length;
  if (!Number.isSafeInteger(totalCharacters) || totalCharacters > options.maxTranscriptCharsPerSpeaker) {
    throw new VoicetextAdapterError("limit_exceeded", "Voicetext transcript exceeded its configured character limit", false);
  }
  collector.fingerprints.add(fingerprint);
  collector.segments.push(message);
  collector.totalCharacters = totalCharacters;
}

function serverError(message: Extract<VoicetextServerMessage, { readonly type: "error" }>): VoicetextAdapterError {
  switch (message.code) {
    case "RATE_LIMIT_EXCEEDED":
    case "TOO_MANY_SESSIONS":
      return new VoicetextAdapterError("rate_limited", "Voicetext rate limit was exceeded", true);
    case "LIMIT_EXCEEDED":
    case "PROVIDER_QUOTA_EXCEEDED":
      return new VoicetextAdapterError("quota_exceeded", "Voicetext transcription quota was exceeded", false);
    case "PROVIDER_ERROR":
    case "PROVIDER_UNAVAILABLE":
    case "INTERNAL_ERROR":
      return new VoicetextAdapterError("provider_error", "Voicetext provider is unavailable", true);
    case "BAD_REQUEST":
      return new VoicetextAdapterError("protocol_error", "Voicetext rejected the protocol request", false);
    default:
      return new VoicetextAdapterError("protocol_error", "Voicetext returned an unknown error code", false);
  }
}

function classifyOperationError(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  fallbackCode: "artifact_read_failed" | "transcode_failed" | "transport_error",
): unknown {
  if (externalSignal?.aborted === true) {
    return new VoicetextAdapterError("cancelled", "Voicetext transcription was cancelled", true, { cause: error });
  }
  if (timeoutSignal.aborted) {
    return new VoicetextAdapterError("timeout", `Voicetext ${fallbackCode.replaceAll("_", " ")} timed out`, true, { cause: error });
  }
  if (error instanceof VoicetextAdapterError || error instanceof VoicetextTransportError) {
    return error;
  }
  return new VoicetextAdapterError(fallbackCode, `Voicetext ${fallbackCode.replaceAll("_", " ")}`, fallbackCode !== "transcode_failed", { cause: error });
}

function operationSignal(externalSignal: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
} {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: externalSignal === undefined ? timeoutSignal : AbortSignal.any([externalSignal, timeoutSignal]),
    timeoutSignal,
  };
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
        return value;
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
        return error;
      },
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function normalizeKeyterms(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) {
    return [];
  }
  if (values.length > 256) {
    throw new VoicetextAdapterError("invalid_input", "keyterms cannot contain more than 256 terms", false);
  }
  const normalized = [...new Set(values.map((value) => value.trim()))];
  if (normalized.some((value) => value.length < 1 || value.length > 128) || normalized.join("").length > 8_192) {
    throw new VoicetextAdapterError("invalid_input", "keyterms are invalid or exceed their configured bound", false);
  }
  return Object.freeze(normalized);
}

function timeoutOption(value: number | undefined, fallback: number, field: string): number {
  return integerOption(value, fallback, 100, 3_600_000, field);
}

function integerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new VoicetextAdapterError("invalid_input", `${field} must be an integer between ${minimum} and ${maximum}`, false);
  }
  return candidate;
}

function evenIntegerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const candidate = integerOption(value, fallback, minimum, maximum, field);
  if (candidate % 2 !== 0) {
    throw new VoicetextAdapterError("invalid_input", `${field} must be aligned to a pcm_s16le sample`, false);
  }
  return candidate;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new VoicetextAdapterError("invalid_input", `${field} must not be empty`, false);
  }
  return normalized;
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VoicetextAdapterError("invalid_input", `${field} must be a non-negative safe integer`, false);
  }
}

function addBoundedBytes(total: number, added: number, maximum: number, subject: string): number {
  const next = total + added;
  if (!Number.isSafeInteger(next) || next > maximum) {
    throw new VoicetextAdapterError("limit_exceeded", `${subject} exceeded its configured total byte limit`, false);
  }
  return next;
}

function addSafeIntegers(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new VoicetextAdapterError("invalid_provider_response", "Voicetext returned a timestamp outside the supported range", false);
  }
  return result;
}

function compareTurns(left: ProviderTurn, right: ProviderTurn): number {
  return left.startMs - right.startMs || left.endMs - right.endMs || left.speakerId.localeCompare(right.speakerId) || left.stableTurnId.localeCompare(right.stableTurnId);
}

function stableId(kind: string, idempotencyKey: string, ...parts: readonly string[]): string {
  return [kind, "v1", encodeIdentityPart(idempotencyKey), ...parts.map(encodeIdentityPart)].join(":");
}

function encodeIdentityPart(value: string): string {
  return `${value.length}:${value}`;
}

function stableUuid(...parts: readonly string[]): string {
  const bytes = createHash("sha256").update(parts.map(encodeIdentityPart).join(":"), "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
