import type { Readable } from "node:stream";

import { ConversationVoiceCaptureController } from "./conversation-voice-capture-controller.js";
import { ConversationVoiceCaptureError } from "./conversation-voice-capture-types.js";
import type {
  ConversationVoiceCaptureSummary,
  ConversationVoiceCaptureTimestamp,
} from "./conversation-voice-observer.js";

export interface ConversationVoiceCaptureClock {
  now(): ConversationVoiceCaptureTimestamp;
}

export function captureConversationVoiceFromOpenStream(input: {
  readonly captureTimeoutMilliseconds: number;
  readonly clock: ConversationVoiceCaptureClock;
  readonly controller: ConversationVoiceCaptureController;
  readonly firstPacketTimeoutMilliseconds: number;
  readonly isPacketAudible?: (packet: Uint8Array) => boolean;
  readonly stream: Readable;
}): Promise<ConversationVoiceCaptureSummary> {
  if (input.stream.destroyed) {
    return Promise.reject(new ConversationVoiceCaptureError(
      "no-audio",
      "Conversation voice receiver stream is not open",
    ));
  }
  return new Promise<ConversationVoiceCaptureSummary>((resolve, reject) => {
    let captureTimeout: ReturnType<typeof setTimeout> | undefined;
    let sequence = 0;
    let settled = false;
    const firstPacketTimeout = setTimeout(() => {
      fail(new ConversationVoiceCaptureError(
        "no-audio",
        "Conversation voice capture received no Craig audio before the readiness timeout",
      ));
    }, input.firstPacketTimeoutMilliseconds);
    const cleanup = (): void => {
      clearTimeout(firstPacketTimeout);
      if (captureTimeout !== undefined) {
        clearTimeout(captureTimeout);
      }
      input.stream.off("data", onData);
      input.stream.off("end", onEnd);
      input.stream.off("error", onError);
    };
    const succeed = (capture: ConversationVoiceCaptureSummary): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(capture);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: unknown): void => {
      try {
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("Conversation voice receiver emitted a non-binary packet");
        }
        if (sequence === 0 && input.isPacketAudible !== undefined && !input.isPacketAudible(chunk)) {
          return;
        }
        const timing = input.clock.now();
        if (sequence === 0) {
          clearTimeout(firstPacketTimeout);
          input.controller.start(timing);
          captureTimeout = setTimeout(() => {
            try {
              succeed(input.controller.complete(input.clock.now()));
            } catch (error) {
              fail(error);
            }
          }, input.captureTimeoutMilliseconds);
        }
        const result = input.controller.acceptPacket({
          opusPacket: chunk,
          sequence: sequence + 1,
          timing,
        });
        sequence += 1;
        if (result.kind === "accepted" && result.captureComplete) {
          succeed(input.controller.complete(input.clock.now()));
        }
      } catch (error) {
        fail(error);
      }
    };
    const onEnd = (): void => {
      if (sequence === 0) {
        fail(new ConversationVoiceCaptureError(
          "no-audio",
          "Conversation voice receiver ended before the first Craig audio packet",
        ));
        return;
      }
      try {
        succeed(input.controller.complete(input.clock.now()));
      } catch (error) {
        fail(error);
      }
    };
    const onError = (): void => {
      fail(new Error("Conversation voice receiver stream failed"));
    };
    input.stream.on("data", onData);
    input.stream.once("end", onEnd);
    input.stream.once("error", onError);
  });
}
