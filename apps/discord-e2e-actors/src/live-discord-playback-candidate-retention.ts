import { createHash } from "node:crypto";

import type {
  LiveDiscordPlaybackLinkClock,
  LiveDiscordPlaybackReadinessProbe,
  LiveDiscordPlaybackReadinessProof,
  LiveDiscordPollTiming,
  ObserveLiveDiscordPlaybackLinkInput,
} from "./live-discord-playback-link-observer.js";
import type {
  LiveDiscordMessageInput,
  LiveDiscordProjectionContainerInput,
  LiveDiscordProjectionMessages,
} from "./live-discord-observer.js";

export interface SanitizedPlaybackCandidate {
  readonly capabilitySha256: string;
  readonly firstSeenPollCompletedAt: LiveDiscordPollTiming;
  readonly firstSeenPollStartedAt: LiveDiscordPollTiming;
  readonly messageId: string;
  readonly readiness: LiveDiscordPlaybackReadinessProof;
  readonly readinessCompletedAt: LiveDiscordPollTiming;
  readonly readinessStartedAt: LiveDiscordPollTiming;
  readonly snapshotSha256: string;
}

const maximumUnboundPlaybackCandidates = 32;

export async function retainFirstSeenCandidates(context: {
  readonly input: ObserveLiveDiscordPlaybackLinkInput;
  readonly observerArmedAt: LiveDiscordPollTiming;
  readonly pollCompletedAt: LiveDiscordPollTiming;
  readonly pollStartedAt: LiveDiscordPollTiming;
  readonly projectionMessages: readonly LiveDiscordProjectionMessages[];
  readonly readinessProbe: LiveDiscordPlaybackReadinessProbe;
  readonly clock: LiveDiscordPlaybackLinkClock;
  readonly retained: Map<string, SanitizedPlaybackCandidate>;
  readonly exactPlaybackLink: (message: LiveDiscordMessageInput) => {
    readonly proof: { readonly capabilitySha256: string };
    readonly rawUrl: string;
  } | undefined;
  readonly sameContainer: (
    actual: LiveDiscordProjectionContainerInput,
    expected: ObserveLiveDiscordPlaybackLinkInput["container"],
  ) => boolean;
}): Promise<void> {
  const observed = context.projectionMessages.flatMap(({ container, messages }) => {
    if (!context.sameContainer(container, context.input.container)) {return [];}
    return messages.flatMap((message) => {
      if (message.authorId !== context.input.sutApplicationId ||
        !wasCreatedOrEditedAfterArm(message, context.observerArmedAt.epochMilliseconds)) {return [];}
      const link = context.exactPlaybackLink(message);
      return link === undefined ? [] : [{ container, link, message }];
    });
  });
  for (const current of observed) {
    const snapshotSha256 = playbackCandidateSnapshotSha256(current);
    const first = context.retained.get(current.message.id);
    if (first !== undefined) {
      if (first.snapshotSha256 !== snapshotSha256 ||
        first.capabilitySha256 !== current.link.proof.capabilitySha256) {
        throw new Error("First-seen playback link was edited after its broken first visibility");
      }
      continue;
    }
    if (context.retained.size >= maximumUnboundPlaybackCandidates) {
      throw new Error("Live Discord playback-link candidate retention limit was exceeded");
    }
    const readinessStartedAt = validatedTiming(context.clock.now(), "readiness start");
    assertTimingNotBefore(readinessStartedAt, context.pollCompletedAt, "readiness start");
    const readiness = await context.readinessProbe.prove({
      messageId: current.message.id, recordingPlaybackUrl: current.link.rawUrl,
    });
    const readinessCompletedAt = validatedTiming(context.clock.now(), "readiness completion");
    assertTimingNotBefore(readinessCompletedAt, readinessStartedAt, "readiness completion");
    assertReadiness(readiness, current.message.id, current.link.proof.capabilitySha256);
    context.retained.set(current.message.id, Object.freeze({
      capabilitySha256: current.link.proof.capabilitySha256,
      firstSeenPollCompletedAt: context.pollCompletedAt,
      firstSeenPollStartedAt: context.pollStartedAt,
      messageId: current.message.id, readiness: Object.freeze({ ...readiness }), readinessCompletedAt,
      readinessStartedAt, snapshotSha256,
    }));
  }
}

function validatedTiming(timing: LiveDiscordPollTiming, label: string): LiveDiscordPollTiming {
  if (!Number.isSafeInteger(timing.epochMilliseconds) || timing.epochMilliseconds < 0 ||
    !Number.isSafeInteger(timing.monotonicMilliseconds) || timing.monotonicMilliseconds < 0) {
    throw new Error(`Live Discord ${label} must be a safe nonnegative timing`);
  }
  return Object.freeze({ ...timing });
}

function assertTimingNotBefore(actual: LiveDiscordPollTiming, earlier: LiveDiscordPollTiming, label: string): void {
  if (actual.epochMilliseconds < earlier.epochMilliseconds ||
    actual.monotonicMilliseconds < earlier.monotonicMilliseconds) {
    throw new Error(`Live Discord ${label} timing moved backwards`);
  }
}

export function playbackCandidateSnapshotSha256(candidate: {
  readonly container: LiveDiscordProjectionContainerInput;
  readonly message: LiveDiscordMessageInput;
}): string {
  return createHash("sha256").update(JSON.stringify({
    container: candidate.container, message: candidate.message,
  }), "utf8").digest("hex");
}

function wasCreatedOrEditedAfterArm(message: LiveDiscordMessageInput, armedAt: number): boolean {
  return message.createdAtMilliseconds >= armedAt ||
    (message.editedAtMilliseconds !== null && message.editedAtMilliseconds >= armedAt);
}

function assertReadiness(proof: LiveDiscordPlaybackReadinessProof, messageId: string, digest: string): void {
  if (proof.trackCount < 1 || proof.trackCount > 11 || proof.messageId !== messageId ||
    proof.capabilitySha256 !== digest) {
    throw new Error("Playback readiness proof is not bound to the exact observed recording link");
  }
}
