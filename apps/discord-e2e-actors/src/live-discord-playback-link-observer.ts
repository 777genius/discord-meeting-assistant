import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  LiveDiscordMessageInput,
  LiveDiscordProjectionContainerInput,
  LiveDiscordProjectionMessages,
  LiveDiscordProjectionReader,
  NormalizedLiveDiscordProjection,
} from "./live-discord-observer.js";

export interface LiveDiscordPollTiming {
  readonly epochMilliseconds: number;
  readonly monotonicMilliseconds: number;
}

export interface LiveDiscordPlaybackLinkClock {
  now(): LiveDiscordPollTiming;
  wait(milliseconds: number): Promise<void>;
}

export interface ObserveLiveDiscordPlaybackLinkInput {
  readonly durationMilliseconds: number;
  readonly pollIntervalMs: number;
  readonly projectionMarker: string;
  readonly recordingId: string;
  readonly resultChannelId: string;
  readonly runId: string;
  readonly sutApplicationId: string;
  readonly container: NormalizedLiveDiscordProjection["container"];
}

const identifierSchema = z.string().trim().min(1);
const safeNonnegativeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a nonnegative safe integer",
);
const pollTimingSchema = z.object({
  epochMilliseconds: safeNonnegativeIntegerSchema,
  monotonicMilliseconds: safeNonnegativeIntegerSchema,
}).strict();
const projectionContainerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel-message"), parentChannelId: identifierSchema }).strict(),
  z.object({
    id: identifierSchema,
    kind: z.literal("thread"),
    name: identifierSchema,
    parentId: identifierSchema,
  }).strict(),
]);

export const liveDiscordPlaybackLinkProofSchema = z.object({
  container: projectionContainerSchema,
  firstSeenPollCompletedAt: pollTimingSchema,
  firstSeenPollStartedAt: pollTimingSchema,
  link: z.object({
    capabilitySha256: z.string().regex(/^[a-f\d]{64}$/u),
    origin: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    }, "Expected an exact HTTPS origin"),
    pathname: z.literal("/recordings/playback"),
  }).strict(),
  messageId: identifierSchema,
  observerArmedAt: pollTimingSchema,
  pollIntervalMs: safeNonnegativeIntegerSchema.refine((value) => value > 0),
  projectionMarker: identifierSchema,
  recordingId: identifierSchema,
  resultChannelId: identifierSchema,
  runId: identifierSchema,
  schemaVersion: z.literal(1),
  sutApplicationId: identifierSchema,
}).strict().superRefine((proof, context) => {
  if (
    proof.firstSeenPollStartedAt.epochMilliseconds < proof.observerArmedAt.epochMilliseconds ||
    proof.firstSeenPollStartedAt.monotonicMilliseconds < proof.observerArmedAt.monotonicMilliseconds ||
    proof.firstSeenPollCompletedAt.epochMilliseconds < proof.firstSeenPollStartedAt.epochMilliseconds ||
    proof.firstSeenPollCompletedAt.monotonicMilliseconds < proof.firstSeenPollStartedAt.monotonicMilliseconds
  ) {
    context.addIssue({ code: "custom", message: "Live Discord proof timing moved backwards" });
  }
});

export type LiveDiscordPlaybackLinkProof = z.infer<typeof liveDiscordPlaybackLinkProofSchema>;

const projectionMarkerUrlBase = "https://meeting-platform.invalid/projection/";
const markdownLinkPattern = /\[[^\]]*\]\((https:\/\/[^\s)]+)\)/gu;

const systemClock: LiveDiscordPlaybackLinkClock = {
  now: () => ({
    epochMilliseconds: Date.now(),
    monotonicMilliseconds: Number(process.hrtime.bigint() / 1_000_000n),
  }),
  wait: (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
};

export async function observeFirstSeenLiveDiscordPlaybackLink(
  input: ObserveLiveDiscordPlaybackLinkInput,
  reader: LiveDiscordProjectionReader,
  clock: LiveDiscordPlaybackLinkClock = systemClock,
): Promise<LiveDiscordPlaybackLinkProof> {
  validateInput(input);
  const observerArmedAt = validatedTiming(clock.now(), "observer arm");
  const deadline = observerArmedAt.monotonicMilliseconds + input.durationMilliseconds;
  assertSafeNonnegativeInteger(deadline, "observation deadline");

  while (true) {
    const pollStartedAt = validatedTiming(clock.now(), "poll start");
    assertTimingNotBefore(pollStartedAt, observerArmedAt, "poll start");
    const projectionMessages = await reader.poll({
      createdSinceMilliseconds: observerArmedAt.epochMilliseconds,
      resultChannelId: input.resultChannelId,
    });
    const pollCompletedAt = validatedTiming(clock.now(), "poll completion");
    assertTimingNotBefore(pollCompletedAt, pollStartedAt, "poll completion");

    const candidate = exactMarkerCandidate(input, projectionMessages);
    if (candidate !== undefined) {
      const link = exactPlaybackLink(candidate.message);
      if (link !== undefined) {
        return Object.freeze({
          schemaVersion: 1 as const,
          runId: requiredText(input.runId, "run ID"),
          recordingId: requiredText(input.recordingId, "recording ID"),
          projectionMarker: requiredText(input.projectionMarker, "projection marker"),
          sutApplicationId: requiredText(input.sutApplicationId, "SUT application ID"),
          resultChannelId: requiredText(input.resultChannelId, "result channel ID"),
          messageId: requiredText(candidate.message.id, "message ID"),
          container: freezeContainer(candidate.container),
          observerArmedAt,
          firstSeenPollStartedAt: pollStartedAt,
          firstSeenPollCompletedAt: pollCompletedAt,
          pollIntervalMs: input.pollIntervalMs,
          link,
        });
      }
    }

    const remainingMilliseconds = deadline - pollCompletedAt.monotonicMilliseconds;
    if (remainingMilliseconds <= 0) {
      throw new Error("Live Discord playback link was not observed before the deadline");
    }
    await clock.wait(Math.min(input.pollIntervalMs, remainingMilliseconds));
  }
}

function exactMarkerCandidate(
  input: ObserveLiveDiscordPlaybackLinkInput,
  projectionMessages: readonly LiveDiscordProjectionMessages[],
): { readonly container: LiveDiscordProjectionContainerInput; readonly message: LiveDiscordMessageInput } | undefined {
  const candidates = projectionMessages.flatMap(({ container, messages }) => {
    if (!sameContainer(container, input.container)) {
      return [];
    }
    return messages
      .filter((message) =>
        message.authorId === input.sutApplicationId &&
        messageHasExactMarker(message, input.projectionMarker)
      )
      .map((message) => ({ container, message }));
  });
  if (candidates.length > 1) {
    throw new Error("Live Discord playback link observation found duplicate exact marker candidates");
  }
  return candidates[0];
}

function messageHasExactMarker(message: LiveDiscordMessageInput, marker: string): boolean {
  // This is the production marker metadata contract, not a playback URL. It is
  // exact-equality matched and never used as retained link evidence.
  const markerUrl = `${projectionMarkerUrlBase}${encodeURIComponent(marker)}`;
  return message.embeds.some((embed) => embed.footerText === marker || embed.url === markerUrl);
}

function exactPlaybackLink(
  message: LiveDiscordMessageInput,
): LiveDiscordPlaybackLinkProof["link"] | undefined {
  const visibleText = [
    message.content,
    ...message.embeds.flatMap((embed) => [
      embed.title ?? "",
      embed.description ?? "",
      ...embed.fields.flatMap((field) => [field.name, field.value]),
    ]),
  ];
  const links = visibleText.flatMap(playbackLinksIn);
  if (links.length > 1) {
    throw new Error("Exact Live Discord marker candidate must contain exactly one valid playback URL");
  }
  return links[0];
}

function playbackLinksIn(text: string): readonly LiveDiscordPlaybackLinkProof["link"][] {
  return [...text.matchAll(markdownLinkPattern)].flatMap((match) => {
    const rawUrl = match[1];
    if (rawUrl === undefined) {
      return [];
    }
    try {
      const url = new URL(rawUrl);
      const capability = url.hash.slice(1);
      if (
        url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
        url.search !== "" || url.pathname !== "/recordings/playback" || capability.length === 0
      ) {
        return [];
      }
      return [Object.freeze({
        origin: url.origin,
        pathname: url.pathname,
        capabilitySha256: createHash("sha256").update(capability, "utf8").digest("hex"),
      })];
    } catch {
      return [];
    }
  });
}

function sameContainer(
  actual: LiveDiscordProjectionContainerInput,
  expected: NormalizedLiveDiscordProjection["container"],
): boolean {
  if (actual.kind !== expected.kind) {
    return false;
  }
  return actual.kind === "channel-message"
    ? expected.kind === "channel-message" && actual.parentChannelId === expected.parentChannelId
    : expected.kind === "thread" && actual.id === expected.id &&
      actual.parentId === expected.parentId && actual.name === expected.name;
}

function freezeContainer(
  container: LiveDiscordProjectionContainerInput,
): NormalizedLiveDiscordProjection["container"] {
  return container.kind === "channel-message"
    ? Object.freeze({ kind: "channel-message" as const, parentChannelId: container.parentChannelId })
    : Object.freeze({
      kind: "thread" as const,
      id: container.id,
      name: container.name,
      parentId: container.parentId,
    });
}

function validatedTiming(timing: LiveDiscordPollTiming, label: string): LiveDiscordPollTiming {
  assertSafeNonnegativeInteger(timing.epochMilliseconds, `${label} epoch`);
  assertSafeNonnegativeInteger(timing.monotonicMilliseconds, `${label} monotonic`);
  return Object.freeze({ ...timing });
}

function assertTimingNotBefore(
  actual: LiveDiscordPollTiming,
  earlier: LiveDiscordPollTiming,
  label: string,
): void {
  if (
    actual.epochMilliseconds < earlier.epochMilliseconds ||
    actual.monotonicMilliseconds < earlier.monotonicMilliseconds
  ) {
    throw new Error(`Live Discord ${label} timing moved backwards`);
  }
}

function assertSafeNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Live Discord ${label} must be a safe nonnegative integer`);
  }
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Live Discord ${label} must not be empty`);
  }
  return normalized;
}

function validateInput(input: ObserveLiveDiscordPlaybackLinkInput): void {
  requiredText(input.runId, "run ID");
  requiredText(input.recordingId, "recording ID");
  requiredText(input.projectionMarker, "projection marker");
  requiredText(input.sutApplicationId, "SUT application ID");
  requiredText(input.resultChannelId, "result channel ID");
  assertPositiveInteger(input.durationMilliseconds, "duration milliseconds");
  assertPositiveInteger(input.pollIntervalMs, "poll interval milliseconds");
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Live Discord ${label} must be a safe positive integer`);
  }
}
