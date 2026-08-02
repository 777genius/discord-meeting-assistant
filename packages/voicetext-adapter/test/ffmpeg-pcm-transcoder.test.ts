import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { FfmpegPcmTranscoder, type FfmpegProcessSpawner } from "../src/ffmpeg-pcm-transcoder.js";
import { VoicetextAdapterError } from "../src/errors.js";

describe("FfmpegPcmTranscoder", () => {
  it("uses bounded pipe I/O and the exact mono 16k pcm_s16le conversion", async () => {
    const invocations: Array<{ commandArguments: readonly string[]; executable: string }> = [];
    const spawner: FfmpegProcessSpawner = (executable, commandArguments) => {
      invocations.push({ commandArguments, executable });
      return fakeProcess({ output: Uint8Array.from([1, 0, 2, 0]) });
    };
    const transcoder = new FfmpegPcmTranscoder({ executablePath: "/opt/ffmpeg" }, spawner);

    const result = await transcoder.transcode(oggBytes(), {
      maxOutputBytes: 8,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      bytes: Uint8Array.from([1, 0, 2, 0]),
      channels: 1,
      encoding: "pcm_s16le",
      sampleRate: 16_000,
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.executable).toBe("/opt/ffmpeg");
    expect(invocations[0]?.commandArguments).toEqual(expect.arrayContaining([
      "-f", "ogg", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
    ]));
  });

  it("kills ffmpeg and fails closed when PCM exceeds its bound", async () => {
    const transcoder = new FfmpegPcmTranscoder({}, () => fakeProcess({ output: new Uint8Array(6) }));

    await expect(transcoder.transcode(oggBytes(), {
      maxOutputBytes: 4,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "limit_exceeded",
      retryable: false,
    });
  });

  it("propagates cancellation and terminates an in-flight ffmpeg process", async () => {
    let killed = false;
    const process = fakeProcess({
      finishOnInput: false,
      onKill: () => {
        killed = true;
      },
    });
    const transcoder = new FfmpegPcmTranscoder({}, () => process);
    const controller = new AbortController();
    const pending = transcoder.transcode(oggBytes(), {
      maxOutputBytes: 8,
      signal: controller.signal,
    });
    controller.abort(new Error("cancel fixture"));

    await expect(pending).rejects.toEqual(expect.objectContaining<Partial<VoicetextAdapterError>>({
      code: "cancelled",
      retryable: true,
    }));
    expect(killed).toBe(true);
  });
});

interface FakeProcessOptions {
  readonly finishOnInput?: boolean;
  readonly onKill?: () => void;
  readonly output?: Uint8Array;
}

function fakeProcess(options: FakeProcessOptions): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    stderr,
    stdin,
    stdout,
  });
  let closed = false;
  const close = (code: number | null, signal: NodeJS.Signals | null) => {
    if (closed) {
      return;
    }
    closed = true;
    Object.assign(child, { exitCode: code, signalCode: signal });
    queueMicrotask(() => child.emit("close", code, signal));
  };
  Object.assign(child, {
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      options.onKill?.();
      stdin.destroy();
      stdout.end();
      stderr.end();
      close(null, signal);
      return true;
    },
  });
  if (options.finishOnInput !== false) {
    stdin.once("finish", () => {
      stdout.end(options.output ?? Uint8Array.from([0, 0]));
      stderr.end();
      close(0, null);
    });
  }
  return child;
}

function oggBytes(): Uint8Array {
  return Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 1]);
}
