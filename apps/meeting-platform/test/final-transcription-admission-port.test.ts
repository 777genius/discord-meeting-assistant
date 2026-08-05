import type {
  FinalTranscriptionPort,
  FinalTranscriptionRequest,
  GeneratedTranscript,
  PortResult,
} from "@discord-meeting/meeting-core";
import { describe, expect, it, vi } from "vitest";

import { InProcessFinalTranscriptionAdmissionPort } from "../src/application/final-transcription-admission-port.js";

const successfulTranscript: PortResult<GeneratedTranscript> = {
  ok: true,
  value: { transcriptId: "transcript-1", turns: [], version: 1 },
};

describe("InProcessFinalTranscriptionAdmissionPort", () => {
  it("admits one whole final transcription at a time and transfers the slot FIFO", async () => {
    const first = deferred<PortResult<GeneratedTranscript>>();
    const second = deferred<PortResult<GeneratedTranscript>>();
    const pendingByMeeting = new Map([
      ["meeting-1", first],
      ["meeting-2", second],
    ]);
    const delegate = {
      transcribe: vi.fn(async (transcriptionRequest: FinalTranscriptionRequest) => {
        const pending = pendingByMeeting.get(transcriptionRequest.meetingId);
        if (pending === undefined) {
          throw new Error("unexpected meeting");
        }
        return await pending.promise;
      }),
    } satisfies FinalTranscriptionPort;
    const subject = new InProcessFinalTranscriptionAdmissionPort(delegate, 1);

    const firstAttempt = subject.transcribe(request("meeting-1"));
    await waitForCalls(() => delegate.transcribe.mock.calls.length, 1);
    const secondAttempt = subject.transcribe(request("meeting-2"));
    await Promise.resolve();
    expect(delegate.transcribe).toHaveBeenCalledTimes(1);

    first.resolve(successfulTranscript);
    await expect(firstAttempt).resolves.toEqual(successfulTranscript);
    await waitForCalls(() => delegate.transcribe.mock.calls.length, 2);
    second.resolve(successfulTranscript);
    await expect(secondAttempt).resolves.toEqual(successfulTranscript);
    expect(delegate.transcribe.mock.calls.map(([value]) => value.meetingId)).toEqual([
      "meeting-1",
      "meeting-2",
    ]);
  });

  it("removes a cancelled queued meeting without consuming the next slot", async () => {
    const first = deferred<PortResult<GeneratedTranscript>>();
    const delegate = {
      transcribe: vi.fn(async () => await first.promise),
    } satisfies FinalTranscriptionPort;
    const subject = new InProcessFinalTranscriptionAdmissionPort(delegate, 1);
    const firstAttempt = subject.transcribe(request("meeting-1"));
    await waitForCalls(() => delegate.transcribe.mock.calls.length, 1);

    const controller = new AbortController();
    const cancellation = new Error("job cancelled");
    const cancelledAttempt = subject.transcribe(request("meeting-2", controller.signal));
    controller.abort(cancellation);
    await expect(cancelledAttempt).rejects.toBe(cancellation);

    first.resolve(successfulTranscript);
    await expect(firstAttempt).resolves.toEqual(successfulTranscript);
    await expect(subject.transcribe(request("meeting-3"))).resolves.toEqual(successfulTranscript);
    expect(delegate.transcribe).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-positive admission capacity", () => {
    const delegate = { transcribe: vi.fn(async () => successfulTranscript) } satisfies FinalTranscriptionPort;

    expect(() => new InProcessFinalTranscriptionAdmissionPort(delegate, 0)).toThrow(
      "maximumConcurrentMeetings must be a positive integer",
    );
  });
});

function request(meetingId: string, signal?: AbortSignal): FinalTranscriptionRequest {
  return {
    idempotencyKey: `transcription:${meetingId}`,
    meetingId,
    recording: {
      manifestLocator: "s3://recordings/manifest.json",
      recordingId: `recording:${meetingId}`,
      speakerAudio: [{
        audioLocator: `s3://recordings/${meetingId}.ogg`,
        speakerId: "speaker-1",
        timelineOffsetMs: 0,
      }],
    },
    ...(signal === undefined ? {} : { signal }),
  };
}

function deferred<Value>(): Deferred<Value> {
  let resolveDeferred!: (value: Value) => void;
  let rejectDeferred!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, reject: rejectDeferred, resolve: resolveDeferred };
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: Value) => void;
}

async function waitForCalls(callCount: () => number, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (callCount() === expected) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`expected ${String(expected)} transcription calls`);
}
