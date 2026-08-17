import type { Readable } from "node:stream";

import {
  publishConversationThinkingCueObserverReady,
  waitForConversationAnswerOrThinkingCuePlaybackIntent,
  waitForConversationAnswerPlaybackIntent,
  type ConversationAnswerPlaybackIntent,
} from "./conversation-voice-turn-id-source.js";

export const maximumAuthorizedConversationThinkingCueCount = 2;

export function assertCanAuthorizeConversationThinkingCue(authorizedCueCount: number): void {
  if (!Number.isInteger(authorizedCueCount) || authorizedCueCount < 0 ||
    authorizedCueCount >= maximumAuthorizedConversationThinkingCueCount) {
    throw new Error("Addressed answer emitted more than two thinking cue intents");
  }
}

export function waitForConversationVoiceCorrelationWhileGuardingAudio<Value>(input: {
  readonly isPacketAudible: (packet: Uint8Array) => boolean;
  readonly resolveCorrelation: (signal: AbortSignal) => Promise<Value>;
  readonly stream: Readable;
}): Promise<Value> {
  if (input.stream.destroyed || input.stream.readableEnded) {
    return Promise.reject(new Error(
      "Configured Craig audio stream closed before runtime turn correlation",
    ));
  }
  return new Promise<Value>((resolve, reject) => {
    const cancellation = new AbortController();
    let settled = false;
    const cleanup = (): void => {
      input.stream.pause();
      input.stream.off("data", onData);
      input.stream.off("end", onEnd);
      input.stream.off("error", onError);
    };
    const succeed = (correlation: Value): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(correlation);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      cancellation.abort();
      reject(error);
    };
    const onData = (chunk: unknown): void => {
      try {
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("Configured Craig audio stream emitted a non-binary packet");
        }
        if (input.isPacketAudible(chunk)) {
          throw new Error(
            "Configured Craig emitted audible audio before runtime turn correlation was confirmed",
          );
        }
      } catch (error: unknown) {
        fail(error);
      }
    };
    const onEnd = (): void => {
      fail(new Error("Configured Craig audio stream ended before runtime turn correlation"));
    };
    const onError = (error: unknown): void => {
      fail(new Error(
        "Configured Craig audio stream failed before runtime turn correlation",
        { cause: error },
      ));
    };
    input.stream.pause();
    input.stream.once("end", onEnd);
    input.stream.once("error", onError);
    input.stream.on("data", onData);
    input.stream.resume();
    void Promise.resolve()
      .then(() => input.resolveCorrelation(cancellation.signal))
      .then(succeed, fail);
  });
}


export function drainAuthorizedConversationCue(input: {
  readonly isPacketAudible: (packet: Uint8Array) => boolean;
  readonly maximumDurationMilliseconds: number;
  readonly minimumDurationMilliseconds: number;
  readonly onFirstAudiblePacket?: () => void;
  readonly signal?: AbortSignal;
  readonly silenceMilliseconds: number;
  readonly stream: Readable;
}): Promise<void> {
  if (input.minimumDurationMilliseconds <= 0 ||
    input.minimumDurationMilliseconds > input.maximumDurationMilliseconds) {
    return Promise.reject(new Error("Authorized thinking cue duration bounds are invalid"));
  }
  if (input.stream.destroyed || input.stream.readableEnded) {
    return Promise.reject(new Error(
      "Configured Craig audio stream closed before authorized thinking cue playback",
    ));
  }
  return new Promise<void>((resolve, reject) => {
    let firstAudibleAt: number | undefined;
    let settled = false;
    let silence: ReturnType<typeof setTimeout> | undefined;
    const maximum = setTimeout(() => {
      fail(new Error("Authorized thinking cue exceeded its bounded playback duration"));
    }, input.maximumDurationMilliseconds);
    const cleanup = (): void => {
      clearTimeout(maximum);
      if (silence !== undefined) {
        clearTimeout(silence);
      }
      input.stream.pause();
      input.stream.off("data", onData);
      input.stream.off("end", onEnd);
      input.stream.off("error", onError);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const succeed = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
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
          throw new Error("Configured Craig audio stream emitted a non-binary packet");
        }
        if (!input.isPacketAudible(chunk)) {
          return;
        }
        if (firstAudibleAt === undefined) {
          firstAudibleAt = Date.now();
          input.onFirstAudiblePacket?.();
        }
        if (silence !== undefined) {
          clearTimeout(silence);
        }
        const minimumRemaining = firstAudibleAt +
          input.minimumDurationMilliseconds - Date.now();
        silence = setTimeout(
          succeed,
          Math.max(input.silenceMilliseconds, minimumRemaining),
        );
      } catch (error: unknown) {
        fail(error);
      }
    };
    const onAbort = (): void => {
      fail(new Error("Authorized thinking cue drain was cancelled"));
    };
    const onEnd = (): void => {
      fail(new Error("Configured Craig audio stream ended during authorized thinking cue playback"));
    };
    const onError = (error: unknown): void => {
      fail(new Error("Configured Craig audio stream failed during authorized thinking cue playback", {
        cause: error,
      }));
    };
    input.stream.pause();
    input.stream.once("end", onEnd);
    input.stream.once("error", onError);
    input.stream.on("data", onData);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted === true) {
      onAbort();
      return;
    }
    input.stream.resume();
    // Silence is meaningful only after an audible cue packet because only that path starts
    // the silence timer. No-audio cues therefore fail at the bounded maximum.
  });
}


export async function waitForAddressedAnswerPlaybackIntent(input: {
  readonly authenticatedBotId: string;
  readonly handshakeNotBeforeEpochMilliseconds: number;
  readonly isPacketAudible: (packet: Uint8Array) => boolean;
  readonly maximumThinkingCueDurationMilliseconds: number;
  readonly meetingId?: string;
  readonly playbackHandshakeRoot: string;
  readonly readyTimeoutMilliseconds: number;
  readonly runId: string;
  readonly sourceStream: Readable;
  readonly target: {
    readonly craigBotId: string;
    readonly guildId: string;
    readonly observerApplicationId: string;
    readonly voiceChannelId: string;
  };
}): Promise<ConversationAnswerPlaybackIntent> {
  const authorizedCueDigests: string[] = [];
  let cueMeetingId: string | undefined;
  let cueTurnId: string | undefined;
  for (;;) {
    const intent = await waitForConversationVoiceCorrelationWhileGuardingAudio({
      isPacketAudible: input.isPacketAudible,
      resolveCorrelation: (signal) => waitForConversationAnswerOrThinkingCuePlaybackIntent({
        ignoredIntentDigestSha256s: authorizedCueDigests,
        ...((cueMeetingId ?? input.meetingId) === undefined
          ? {}
          : { meetingId: cueMeetingId ?? input.meetingId }),
        notBeforeEpochMilliseconds: input.handshakeNotBeforeEpochMilliseconds,
        root: input.playbackHandshakeRoot,
        runId: input.runId,
        signal,
        timeoutMilliseconds: input.readyTimeoutMilliseconds,
      }),
      stream: input.sourceStream,
    });
    if (intent.kind === "answer") {
      if (cueMeetingId !== undefined &&
        (intent.meetingId !== cueMeetingId || intent.turnId !== cueTurnId)) {
        throw new Error("Thinking cue and addressed answer intents belong to different meetings or turns");
      }
      return intent;
    }
    if (cueMeetingId !== undefined &&
      (intent.meetingId !== cueMeetingId || intent.turnId !== cueTurnId)) {
      throw new Error("Authorized thinking cue intents belong to different meetings or turns");
    }
    assertCanAuthorizeConversationThinkingCue(authorizedCueDigests.length);
    cueMeetingId = intent.meetingId;
    cueTurnId = intent.turnId;
    const ready = await publishConversationThinkingCueObserverReady({
      authenticatedObserverBotId: input.authenticatedBotId,
      intent,
      intentObservedAt: new Date().toISOString(),
      root: input.playbackHandshakeRoot,
      target: input.target,
    });
    authorizedCueDigests.push(ready.intentDigestSha256);
    const cueDrainCancellation = new AbortController();
    const answerWaitCancellation = new AbortController();
    let cueAudioStarted = false;
    const cueDrain = drainAuthorizedConversationCue({
      isPacketAudible: input.isPacketAudible,
      maximumDurationMilliseconds: input.maximumThinkingCueDurationMilliseconds,
      minimumDurationMilliseconds: Math.ceil(intent.expectedPcmBytes / 96),
      onFirstAudiblePacket: () => { cueAudioStarted = true; },
      signal: cueDrainCancellation.signal,
      silenceMilliseconds: 300,
      stream: input.sourceStream,
    }).then(() => ({ kind: "cue-drained" as const }));
    const answerWait = waitForConversationAnswerPlaybackIntent({
      ignoredIntentDigestSha256s: authorizedCueDigests,
      meetingId: intent.meetingId,
      notBeforeEpochMilliseconds: input.handshakeNotBeforeEpochMilliseconds,
      root: input.playbackHandshakeRoot,
      runId: input.runId,
      signal: answerWaitCancellation.signal,
      timeoutMilliseconds: input.readyTimeoutMilliseconds,
    }).then((answerIntent) => ({ answerIntent, kind: "answer" as const }));
    try {
      const outcome = await Promise.race([cueDrain, answerWait]);
      if (outcome.kind === "cue-drained") {
        answerWaitCancellation.abort();
        await answerWait.catch(() => {});
        continue;
      }
      if (outcome.answerIntent.meetingId !== intent.meetingId ||
        outcome.answerIntent.turnId !== intent.turnId) {
        throw new Error("Thinking cue and addressed answer intents belong to different meetings or turns");
      }
      if (cueAudioStarted) {
        await cueDrain;
      } else {
        cueDrainCancellation.abort();
        await cueDrain.catch(() => {});
      }
      return outcome.answerIntent;
    } catch (error: unknown) {
      cueDrainCancellation.abort();
      answerWaitCancellation.abort();
      await Promise.allSettled([cueDrain, answerWait]);
      throw error;
    }
  }
}
