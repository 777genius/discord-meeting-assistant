import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { VoicetextAdapterError } from "./errors.js";
import type {
  CompleteOggToPcmTranscoder,
  MonoPcmS16Le16KhzAudio,
  PcmTranscodeOptions,
} from "./pcm-transcoder.js";

const defaultTimeoutMs = 300_000;
const defaultMaximumStderrBytes = 64 * 1_024;
const inputChunkBytes = 64 * 1_024;

export interface FfmpegPcmTranscoderOptions {
  readonly executablePath?: string;
  readonly maxStderrBytes?: number;
  readonly timeoutMs?: number;
}

export type FfmpegProcessSpawner = (
  executable: string,
  commandArguments: readonly string[],
) => ChildProcessWithoutNullStreams;

interface ValidatedFfmpegOptions {
  readonly executablePath: string;
  readonly maxStderrBytes: number;
  readonly timeoutMs: number;
}

export class FfmpegPcmTranscoder implements CompleteOggToPcmTranscoder {
  private readonly options: ValidatedFfmpegOptions;

  public constructor(
    options: FfmpegPcmTranscoderOptions = {},
    private readonly spawnProcess: FfmpegProcessSpawner = defaultSpawn,
  ) {
    this.options = validateOptions(options);
  }

  public async transcode(
    completeOgg: Uint8Array,
    options: PcmTranscodeOptions,
  ): Promise<MonoPcmS16Le16KhzAudio> {
    if (completeOgg.byteLength === 0) {
      throw new VoicetextAdapterError("invalid_input", "Ogg audio must not be empty", false);
    }
    if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 2) {
      throw new VoicetextAdapterError("invalid_input", "maxOutputBytes must be a positive bounded PCM size", false);
    }
    options.signal.throwIfAborted();

    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const signal = AbortSignal.any([options.signal, timeoutSignal]);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(this.options.executablePath, ffmpegArguments);
    } catch (error: unknown) {
      throw new VoicetextAdapterError("transcode_failed", "ffmpeg could not be started", false, { cause: error });
    }

    const output: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (rawChunk: Buffer | Uint8Array) => {
      const chunk = Buffer.from(rawChunk);
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        child.kill("SIGKILL");
        return;
      }
      output.push(chunk);
    });
    child.stderr.on("data", (rawChunk: Buffer | Uint8Array) => {
      if (stderrBytes >= this.options.maxStderrBytes) {
        return;
      }
      const chunk = Buffer.from(rawChunk);
      const retained = chunk.subarray(0, this.options.maxStderrBytes - stderrBytes);
      stderrBytes += retained.byteLength;
      stderr.push(retained);
    });

    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const inputWrite = pipeline(
        Readable.from(chunkInput(completeOgg)),
        child.stdin,
        { signal },
      );
      const exit = waitForExit(child);
      const [exitResult, inputResult] = await Promise.all([
        exit,
        inputWrite.then(() => null, (error: unknown) => error),
      ]);

      if (options.signal.aborted) {
        throw new VoicetextAdapterError("cancelled", "Voicetext audio transcoding was cancelled", true, { cause: options.signal.reason });
      }
      if (timeoutSignal.aborted) {
        throw new VoicetextAdapterError("timeout", "Voicetext audio transcoding timed out", true);
      }
      if (outputBytes > options.maxOutputBytes) {
        throw new VoicetextAdapterError("limit_exceeded", "Transcoded PCM audio exceeded its configured byte limit", false);
      }
      if (exitResult.error !== undefined) {
        throw new VoicetextAdapterError("transcode_failed", "ffmpeg process failed", false, { cause: exitResult.error });
      }
      if (exitResult.code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        throw new VoicetextAdapterError(
          "transcode_failed",
          detail.length === 0 ? "ffmpeg rejected the Ogg audio" : `ffmpeg rejected the Ogg audio: ${detail}`,
          false,
        );
      }
      if (inputResult instanceof Error) {
        throw new VoicetextAdapterError("transcode_failed", "ffmpeg input stream failed", false, { cause: inputResult });
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }

    const bytes = Buffer.concat(output);
    if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
      throw new VoicetextAdapterError("transcode_failed", "ffmpeg returned invalid pcm_s16le audio", false);
    }
    return {
      bytes: Uint8Array.from(bytes),
      channels: 1,
      encoding: "pcm_s16le",
      sampleRate: 16_000,
    };
  }
}

const ffmpegArguments = Object.freeze([
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "ogg",
  "-i",
  "pipe:0",
  "-map_metadata",
  "-1",
  "-vn",
  "-sn",
  "-dn",
  "-ac",
  "1",
  "-ar",
  "16000",
  "-f",
  "s16le",
  "pipe:1",
]);

function defaultSpawn(
  executable: string,
  commandArguments: readonly string[],
): ChildProcessWithoutNullStreams {
  return spawn(executable, commandArguments, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function validateOptions(options: FfmpegPcmTranscoderOptions): ValidatedFfmpegOptions {
  const executablePath = options.executablePath?.trim() ?? "ffmpeg";
  if (executablePath.length === 0) {
    throw new VoicetextAdapterError("invalid_input", "ffmpeg executablePath must not be empty", false);
  }
  return {
    executablePath,
    maxStderrBytes: integerOption(options.maxStderrBytes, defaultMaximumStderrBytes, 1_024, 1_024 * 1_024, "maxStderrBytes"),
    timeoutMs: integerOption(options.timeoutMs, defaultTimeoutMs, 100, 3_600_000, "timeoutMs"),
  };
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

function* chunkInput(input: Uint8Array): Iterable<Buffer> {
  for (let offset = 0; offset < input.byteLength; offset += inputChunkBytes) {
    yield Buffer.from(input.buffer, input.byteOffset + offset, Math.min(inputChunkBytes, input.byteLength - offset));
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{
  readonly code: number | null;
  readonly error?: Error;
}> {
  return await new Promise((resolve) => {
    let processError: Error | undefined;
    child.once("error", (error) => {
      processError = error;
    });
    child.once("close", (code) => {
      resolve({ code, ...(processError === undefined ? {} : { error: processError }) });
    });
  });
}
