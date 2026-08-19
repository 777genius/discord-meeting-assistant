import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  LiveDiscordMessageInput,
  LiveDiscordProjectionContainerInput,
  LiveDiscordProjectionMessages,
  LiveDiscordProjectionReader,
  NormalizedLiveDiscordProjection,
} from "./live-discord-observer.js";
import { createObservedMeetingProjectionMarkers } from "./live-discord-projection-marker-contract.js";
import {
  playbackCandidateSnapshotSha256,
  retainFirstSeenCandidates,
  type SanitizedPlaybackCandidate,
} from "./live-discord-playback-candidate-retention.js";

export interface LiveDiscordPollTiming {
  readonly epochMilliseconds: number;
  readonly monotonicMilliseconds: number;
}

export interface LiveDiscordPlaybackLinkClock {
  now(): LiveDiscordPollTiming;
  wait(milliseconds: number): Promise<void>;
}

export interface LiveDiscordPlaybackReadinessProof {
  readonly capabilitySha256: string;
  readonly messageId: string;
  readonly readinessExpectation: "already-ready" | "processing-to-ready";
  readonly recordingId: string;
  readonly status: "ready";
  readonly statuses: readonly ("processing" | "ready")[];
  readonly trackCount: number;
}

export interface LiveDiscordPlaybackReadinessProbe {
  prove(input: {
    readonly messageId: string;
    readonly recordingId?: string;
    readonly recordingPlaybackUrl: string;
  }): Promise<LiveDiscordPlaybackReadinessProof>;
}

export interface LiveDiscordPlaybackRecordingIdentity {
  readonly meetingId: string;
  readonly recordingId: string;
}

export interface LiveDiscordPlaybackRecordingIdentitySource {
  read(): Promise<LiveDiscordPlaybackRecordingIdentity | undefined>;
}

export interface ObserveLiveDiscordPlaybackLinkInput {
  readonly durationMilliseconds: number;
  readonly pollIntervalMs: number;
  readonly projectionMarkers: readonly string[];
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
  readiness: z.object({
    capabilitySha256: z.string().regex(/^[a-f\d]{64}$/u),
    messageId: identifierSchema,
    readinessExpectation: z.enum(["already-ready", "processing-to-ready"]),
    recordingId: identifierSchema,
    status: z.literal("ready"),
    statuses: z.array(z.enum(["processing", "ready"])).min(1).max(601),
    trackCount: z.number().int().min(1).max(11),
  }).strict().superRefine((readiness, context) => {
    if (readiness.statuses.at(-1) !== "ready" ||
      readiness.statuses.slice(0, -1).some((status) => status !== "processing")) {
      context.addIssue({ code: "custom", message: "Playback readiness statuses must terminate processing with ready" });
    }
    if ((readiness.readinessExpectation === "already-ready" && readiness.statuses.length !== 1) ||
      (readiness.readinessExpectation === "processing-to-ready" &&
        !readiness.statuses.slice(0, -1).includes("processing"))) {
      context.addIssue({ code: "custom", message: "Playback readiness statuses do not match their expectation" });
    }
  }),
  messageId: identifierSchema,
  observerArmedAt: pollTimingSchema,
  pollIntervalMs: safeNonnegativeIntegerSchema.refine((value) => value > 0),
  projectionMarker: identifierSchema,
  timingProvenance: z.object({
    candidateSnapshotSha256: z.string().regex(/^[a-f\d]{64}$/u),
    kind: z.literal("first-observed-then-ready"),
    readinessCompletedAt: pollTimingSchema,
    readinessStartedAt: pollTimingSchema,
    recordingIdentityBoundAt: pollTimingSchema,
  }).strict(),
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
  if (
    proof.timingProvenance.readinessStartedAt.epochMilliseconds < proof.firstSeenPollCompletedAt.epochMilliseconds ||
    proof.timingProvenance.readinessStartedAt.monotonicMilliseconds < proof.firstSeenPollCompletedAt.monotonicMilliseconds ||
    proof.timingProvenance.readinessCompletedAt.epochMilliseconds < proof.timingProvenance.readinessStartedAt.epochMilliseconds ||
    proof.timingProvenance.readinessCompletedAt.monotonicMilliseconds < proof.timingProvenance.readinessStartedAt.monotonicMilliseconds ||
    proof.timingProvenance.recordingIdentityBoundAt.epochMilliseconds < proof.timingProvenance.readinessCompletedAt.epochMilliseconds ||
    proof.timingProvenance.recordingIdentityBoundAt.monotonicMilliseconds < proof.timingProvenance.readinessCompletedAt.monotonicMilliseconds
  ) {
    context.addIssue({ code: "custom", message: "Playback readiness provenance timing moved backwards" });
  }
  if (
    proof.readiness.capabilitySha256 !== proof.link.capabilitySha256 ||
    proof.readiness.messageId !== proof.messageId ||
    proof.readiness.recordingId !== proof.recordingId
  ) {
    context.addIssue({ code: "custom", message: "Playback readiness proof is not bound to the observed link" });
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
  readinessProbe: LiveDiscordPlaybackReadinessProbe,
  identitySource: LiveDiscordPlaybackRecordingIdentitySource,
): Promise<LiveDiscordPlaybackLinkProof> {
  validateInput(input);
  const observerArmedAt = validatedTiming(clock.now(), "observer arm");
  const deadline = observerArmedAt.monotonicMilliseconds + input.durationMilliseconds;
  assertSafeNonnegativeInteger(deadline, "observation deadline");
  const candidates = new Map<string, SanitizedPlaybackCandidate>();

  for (;;) {
    const pollStartedAt = validatedTiming(clock.now(), "poll start");
    assertTimingNotBefore(pollStartedAt, observerArmedAt, "poll start");
    const projectionMessages = await reader.poll({
      createdSinceMilliseconds: observerArmedAt.epochMilliseconds,
      resultChannelId: input.resultChannelId,
    });
    const pollCompletedAt = validatedTiming(clock.now(), "poll completion");
    assertTimingNotBefore(pollCompletedAt, pollStartedAt, "poll completion");

    await retainFirstSeenCandidates({ clock, exactPlaybackLink, input, observerArmedAt, pollCompletedAt,
      pollStartedAt, projectionMessages, readinessProbe, retained: candidates, sameContainer });
    const identity = await identitySource.read();
    if (identity !== undefined) {
      const recordingIdentityBoundAt = validatedTiming(clock.now(), "recording identity binding");
      assertTimingNotBefore(recordingIdentityBoundAt, pollCompletedAt, "recording identity binding");
      const bound = exactBoundCandidate(input, identity, projectionMessages, candidates);
      if (bound !== undefined) {
        const { candidate, current, marker } = bound;
        const observed = exactPlaybackLink(current.message);
        if (observed === undefined || observed.proof.capabilitySha256 !== candidate.capabilitySha256 ||
          playbackCandidateSnapshotSha256(current) !== candidate.snapshotSha256) {
          throw new Error("First-seen playback link was edited after its broken first visibility");
        }
        const { proof: link } = observed;
        const readiness = candidate.readiness;
        assertReadinessBinding(readiness, identity.recordingId, current.message.id, link.capabilitySha256);
        return Object.freeze({
          schemaVersion: 1 as const,
          runId: requiredText(input.runId, "run ID"),
          recordingId: requiredText(identity.recordingId, "recording ID"),
          projectionMarker: marker,
          sutApplicationId: requiredText(input.sutApplicationId, "SUT application ID"),
          resultChannelId: requiredText(input.resultChannelId, "result channel ID"),
          messageId: requiredText(current.message.id, "message ID"),
          container: freezeContainer(current.container),
          observerArmedAt,
          firstSeenPollStartedAt: candidate.firstSeenPollStartedAt,
          firstSeenPollCompletedAt: candidate.firstSeenPollCompletedAt,
          pollIntervalMs: input.pollIntervalMs,
          link,
          readiness: {
            ...readiness,
            statuses: [...readiness.statuses],
          },
          timingProvenance: Object.freeze({
            candidateSnapshotSha256: candidate.snapshotSha256,
            kind: "first-observed-then-ready" as const,
            readinessCompletedAt: candidate.readinessCompletedAt,
            readinessStartedAt: candidate.readinessStartedAt,
            recordingIdentityBoundAt,
          }),
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

function exactBoundCandidate(
  input: ObserveLiveDiscordPlaybackLinkInput,
  identity: LiveDiscordPlaybackRecordingIdentity,
  projections: readonly LiveDiscordProjectionMessages[],
  retained: ReadonlyMap<string, SanitizedPlaybackCandidate>,
): { readonly candidate: SanitizedPlaybackCandidate; readonly current: { readonly container: LiveDiscordProjectionContainerInput; readonly message: LiveDiscordMessageInput }; readonly marker: string } | undefined {
  requiredText(identity.meetingId, "meeting ID");
  requiredText(identity.recordingId, "recording ID");
  const projectionMarkers = input.projectionMarkers.length === 0
    ? createObservedMeetingProjectionMarkers(identity.meetingId, input.resultChannelId)
    : input.projectionMarkers;
  const matches = projections.flatMap(({ container, messages }) => {
    if (!sameContainer(container, input.container)) {return [];}
    return messages.flatMap((message) => {
      if (message.authorId !== input.sutApplicationId) {return [];}
      const markers = projectionMarkers.filter((marker) => messageHasExactMarker(message, marker));
      return markers.map((marker) => ({ candidate: retained.get(message.id), current: { container, message }, marker }));
    }).filter((match): match is { candidate: SanitizedPlaybackCandidate; current: { container: LiveDiscordProjectionContainerInput; message: LiveDiscordMessageInput }; marker: string } => match.candidate !== undefined);
  });
  if (matches.length > 1) {
    throw new Error("Live Discord playback link observation found duplicate exact marker candidates");
  }
  return matches[0];
}

function messageHasExactMarker(message: LiveDiscordMessageInput, marker: string): boolean {
  // This is the production marker metadata contract, not a playback URL. It is
  // exact-equality matched and never used as retained link evidence.
  const markerUrl = `${projectionMarkerUrlBase}${encodeURIComponent(marker)}`;
  return message.embeds.some((embed) => embed.footerText === marker || embed.url === markerUrl);
}

function exactPlaybackLink(
  message: LiveDiscordMessageInput,
): { readonly proof: LiveDiscordPlaybackLinkProof["link"]; readonly rawUrl: string } | undefined {
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

function playbackLinksIn(
  text: string,
): readonly { readonly proof: LiveDiscordPlaybackLinkProof["link"]; readonly rawUrl: string }[] {
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
        proof: Object.freeze({
          origin: url.origin,
          pathname: url.pathname,
          capabilitySha256: createHash("sha256").update(capability, "utf8").digest("hex"),
        }),
        rawUrl,
      })];
    } catch {
      return [];
    }
  });
}

function assertReadinessBinding(
  proof: LiveDiscordPlaybackReadinessProof,
  recordingId: string,
  messageId: string,
  capabilitySha256: string,
): void {
  if (
    proof.trackCount < 1 || proof.trackCount > 11 ||
    proof.recordingId !== recordingId || proof.messageId !== messageId ||
    proof.capabilitySha256 !== capabilitySha256
  ) {
    throw new Error("Playback readiness proof is not bound to the exact observed recording link");
  }
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
  for (const marker of input.projectionMarkers) {requiredText(marker, "projection marker");}
  if (new Set(input.projectionMarkers).size !== input.projectionMarkers.length) {
    throw new Error("Live Discord projection markers must be unique");
  }
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
