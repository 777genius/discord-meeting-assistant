import type { CraigLifecycleEvent } from "@discord-meeting/craig-gateway-contracts";

import type { LifecycleIngressResult } from "./contracts.js";
import { finalizeAuthoritative, type AuthoritativeReadyEvent } from "./recording-ingress-authoritative-finalization.js";
import { RecordingIngressError } from "./errors.js";
import {
  abortIfRequested,
  addActorToRoster,
  canonicalLifecycleEvent,
  ensureRecordingIdentity,
  normalizeActorRoster,
  observeActorInRoster,
  sameActorRoster,
  sameActorRosterIds,
  sha256,
  storedEvent,
} from "./recording-ingress-invariants.js";
import { RecordingIngressRuntime } from "./recording-ingress-runtime.js";
import type { AbortedRecordingState, CompletedRecordingState, RecordingSpoolState, StoredIdentityProvenance } from "./spool.js";

type TrustedLifecycleEvent = Extract<CraigLifecycleEvent, { readonly schemaVersion: 3 }>;

interface LifecycleIngressInput {
  readonly digest: string;
  readonly event: CraigLifecycleEvent;
  readonly runtime: RecordingIngressRuntime;
  readonly signal: AbortSignal | undefined;
}

export async function ingestLifecycleEvent(
  runtime: RecordingIngressRuntime,
  event: CraigLifecycleEvent,
  options: { readonly signal?: AbortSignal } = {},
): Promise<LifecycleIngressResult> {
  abortIfRequested(options.signal);
  const digest = sha256(JSON.stringify(canonicalLifecycleEvent(event)));
  return runtime.exclusive(event.recordingId, () =>
    ingestLockedLifecycleEvent({ digest, event, runtime, signal: options.signal }),
  );
}

async function ingestLockedLifecycleEvent(input: LifecycleIngressInput): Promise<LifecycleIngressResult> {
  abortIfRequested(input.signal);
  const completed = await input.runtime.spool.readCompleted(input.event.recordingId);
  if (completed !== undefined) {
    if (completed.lifecycleSchemaVersion !== input.event.schemaVersion) {
      throw new RecordingIngressError(
        "conflicting-duplicate",
        "recording lifecycle schema version cannot change",
      );
    }
    return replayCompleted(input, completed);
  }
  const aborted = await input.runtime.spool.readAborted(input.event.recordingId);
  if (aborted !== undefined) {
    ensureLifecycleSchemaVersion(aborted, input.event);
    return replayAborted(input, aborted);
  }
  const state = await input.runtime.spool.readRecording(input.event.recordingId);
  if (state === undefined) {
    return startRecording(input);
  }
  ensureRecordingIdentity(state, input.event);
  ensureLifecycleSchemaVersion(state, input.event);
  if (state.status === "aborted") {
    return replayAborted(input, await input.runtime.spool.archiveAborted(state));
  }
  const replay = state.events.find(({ eventId }) => eventId === input.event.eventId);
  if (replay !== undefined) {
    return replayExistingEvent(input, state, replay.digest);
  }
  if (input.event.type === "recording.artifact_ready") {
    throw new RecordingIngressError(
      "unsupported-event",
      "recording.artifact_ready is outbound evidence, not an ingress command",
    );
  }
  if (input.event.type === "recording.authoritative_ready") {
    return acceptAuthoritativeReady(input, state, input.event);
  }
  return acceptActiveLifecycleEvent(input, state);
}

async function replayCompleted(
  input: LifecycleIngressInput,
  completed: CompletedRecordingState,
): Promise<LifecycleIngressResult> {
  ensureRecordingIdentity(completed, input.event);
  const replay = completed.events.find(({ eventId }) => eventId === input.event.eventId);
  if (replay === undefined) {
    throw new RecordingIngressError("invalid-state", "recording is already finalized");
  }
  if (replay.digest !== input.digest) {
    throw new RecordingIngressError(
      "conflicting-duplicate",
      "lifecycle event ID was replayed with different content",
    );
  }
  await input.runtime.cleanupAfterSuccess(input.event.recordingId);
  return input.event.type === "recording.authoritative_ready"
    ? finalizedResult(completed, completed.recording, true)
    : { kind: "accepted", recordingId: completed.recordingId, replayed: true };
}

async function replayAborted(
  input: LifecycleIngressInput,
  aborted: AbortedRecordingState,
): Promise<LifecycleIngressResult> {
  ensureRecordingIdentity(aborted, input.event);
  const replay = aborted.events.find(({ eventId }) => eventId === input.event.eventId);
  if (replay === undefined) {
    throw new RecordingIngressError("invalid-state", "recording is already aborted");
  }
  if (input.digest !== replay.digest) {
    throw new RecordingIngressError(
      "conflicting-duplicate",
      "lifecycle event ID was replayed with different content",
    );
  }
  await input.runtime.spool.cleanupActive(input.event.recordingId);
  input.runtime.forgetJournalIndexes(input.event.recordingId);
  return { kind: "aborted", recordingId: aborted.recordingId, replayed: true };
}

async function startRecording(input: LifecycleIngressInput): Promise<LifecycleIngressResult> {
  if (input.event.type !== "meeting.started") {
    throw new RecordingIngressError(
      "invalid-state",
      "meeting.started must be the first lifecycle event",
    );
  }
  const startedEvent = input.event;
  await input.runtime.reserveActiveRecordingCapacity(async () => {
    if ((await input.runtime.spool.activeRecordingCount()) >= input.runtime.limits.maxActiveRecordings) {
      throw new RecordingIngressError(
        "limit-exceeded",
        "active recording limit has been reached",
      );
    }
    const state: RecordingSpoolState = {
      actors: startedEvent.schemaVersion === 1
        ? null
        : normalizeActorRoster(startedEvent.actors),
      authoritativeTracks: [],
      channelId: startedEvent.channelId,
      events: [storedEvent(startedEvent, input.digest)],
      guildId: startedEvent.guildId,
      identityProvenance: startedEvent.schemaVersion === 3
        ? {
            actorObservationState: startedEvent.actorObservationState,
            actorSemanticsVersion: startedEvent.actorSemanticsVersion,
            producerCapabilityId: startedEvent.producerCapabilityId,
            producerRevision: startedEvent.producerRevision,
            rosterState: startedEvent.rosterState,
          }
        : null,
      lifecycleSchemaVersion: startedEvent.schemaVersion,
      pendingAuthoritativeTracks: [],
      recordingId: startedEvent.recordingId,
      schemaVersion: 3,
      speakers: [],
      startedAt: startedEvent.occurredAt,
      status: "active",
    };
    await input.runtime.spool.writeRecording(state);
  });
  return { kind: "accepted", recordingId: input.event.recordingId, replayed: false };
}

async function replayExistingEvent(
  input: LifecycleIngressInput,
  state: RecordingSpoolState,
  digest: string,
): Promise<LifecycleIngressResult> {
  if (digest !== input.digest) {
    throw new RecordingIngressError(
      "conflicting-duplicate",
      "lifecycle event ID was replayed with different content",
    );
  }
  if (input.event.type === "recording.authoritative_ready" && state.status === "finalizing") {
    const recording = await finalizeAuthoritative(input.runtime, state, input.event, input.signal);
    return finalizedResult(state, recording, true);
  }
  return { kind: "accepted", recordingId: state.recordingId, replayed: true };
}

async function acceptAuthoritativeReady(
  input: LifecycleIngressInput,
  state: RecordingSpoolState,
  event: AuthoritativeReadyEvent,
): Promise<LifecycleIngressResult> {
  const actorKindConflicted = assertAuthoritativeReady(state, event);
  const identityProvenance = event.schemaVersion === 3
    ? evolveIdentityProvenance(state, event, actorKindConflicted, event.rosterState)
    : state.identityProvenance;
  const finalizingState: RecordingSpoolState = {
    ...state,
    endedAt: event.endedAt,
    events: [...state.events, storedEvent(event, input.digest)],
    finalEventDigest: input.digest,
    finalEventId: event.eventId,
    identityProvenance,
  };
  await input.runtime.spool.writeRecording(finalizingState);
  const recording = await finalizeAuthoritative(input.runtime, finalizingState, event, input.signal);
  return finalizedResult(finalizingState, recording, false);
}

function assertAuthoritativeReady(state: RecordingSpoolState, event: AuthoritativeReadyEvent): boolean {
  if (state.status !== "finalizing" || state.endedAt === undefined) {
    throw new RecordingIngressError(
      "invalid-state",
      "meeting.ended must precede authoritative-ready",
    );
  }
  const authoritativeEndedAt = Date.parse(event.endedAt);
  const lifecycleEndedAt = Date.parse(state.endedAt);
  const startedAt = Date.parse(state.startedAt);
  if (authoritativeEndedAt < startedAt || authoritativeEndedAt > lifecycleEndedAt + 60_000) {
    throw new RecordingIngressError(
      "invalid-state",
      "authoritative-ready endedAt is outside the recording lifecycle",
    );
  }
  if (event.trackCount !== state.authoritativeTracks.length) {
    throw new RecordingIngressError(
      "invalid-state",
      "authoritative-ready track count does not match durable uploads",
    );
  }
  if (state.pendingAuthoritativeTracks.length > 0) {
    throw new RecordingIngressError(
      "invalid-state",
      "authoritative-ready cannot finalize an upload with an unresolved write receipt",
    );
  }
  const finalActors = event.schemaVersion === 1 ? null : normalizeActorRoster(event.actors);
  if (!sameActorRoster(state.actors, finalActors)) {
    if (event.schemaVersion === 3 && sameActorRosterIds(state.actors, finalActors)) {
      return true;
    }
    throw new RecordingIngressError(
      "conflicting-duplicate",
      "authoritative-ready actor roster does not match the durable lifecycle roster",
    );
  }
  return false;
}

async function acceptActiveLifecycleEvent(
  input: LifecycleIngressInput,
  state: RecordingSpoolState,
): Promise<LifecycleIngressResult> {
  if (state.status !== "active") {
    throw new RecordingIngressError(
      "invalid-state",
      `cannot apply a new event while recording is ${state.status}`,
    );
  }
  if (state.events.length >= input.runtime.limits.maxLifecycleEventsPerRecording) {
    throw new RecordingIngressError(
      "limit-exceeded",
      "recording exceeds the lifecycle event replay limit",
    );
  }
  if (input.event.type === "meeting.started") {
    throw new RecordingIngressError(
      "conflicting-duplicate",
      "meeting.started cannot be rebound with a new event identity",
    );
  }
  const events = [...state.events, storedEvent(input.event, input.digest)];
  const actorObservation = applyActorObservation(state, input.event);
  const identityProvenance = input.event.schemaVersion === 3
    ? evolveIdentityProvenance(
        state,
        input.event,
        actorObservation.conflicted,
        state.identityProvenance?.rosterState ?? "unsealed",
      )
    : state.identityProvenance;
  const nextState: RecordingSpoolState = {
    ...state,
    actors: actorObservation.actors,
    identityProvenance,
  };
  if (input.event.type === "meeting.aborted") {
    return archiveAborted(input, nextState, events);
  }
  if (input.event.type === "meeting.ended") {
    return beginAuthoritativeFinalization(input, nextState, events);
  }
  await input.runtime.spool.writeRecording({ ...nextState, events });
  return { kind: "accepted", recordingId: state.recordingId, replayed: false };
}

function applyActorObservation(
  state: RecordingSpoolState,
  event: CraigLifecycleEvent,
): { readonly actors: RecordingSpoolState["actors"]; readonly conflicted: boolean } {
  if (event.type !== "participant.joined" && event.type !== "participant.left") {
    return { actors: state.actors, conflicted: false };
  }
  if (event.schemaVersion === 3) {
    return observeActorInRoster(state.actors ?? [], event.actor);
  }
  return {
    actors: event.schemaVersion === 2
      ? addActorToRoster(state.actors ?? [], event.actor)
      : state.actors,
    conflicted: false,
  };
}

function evolveIdentityProvenance(
  state: RecordingSpoolState,
  event: TrustedLifecycleEvent,
  actorKindConflicted: boolean,
  rosterState: "sealed" | "unsealed",
): StoredIdentityProvenance {
  const current = state.identityProvenance;
  if (current === null) {
    throw new RecordingIngressError(
      "corrupt-spool",
      "trusted lifecycle event has no durable producer provenance",
    );
  }
  const producerIdentityConflicted =
    current.actorSemanticsVersion !== event.actorSemanticsVersion ||
    current.producerCapabilityId !== event.producerCapabilityId ||
    current.producerRevision !== event.producerRevision ||
    (event.type === "recording.authoritative_ready" && rosterState !== "sealed");
  return {
    ...current,
    actorObservationState:
      current.actorObservationState === "conflicted" ||
      event.actorObservationState === "conflicted" ||
      actorKindConflicted ||
      producerIdentityConflicted
        ? "conflicted"
        : "consistent",
    rosterState,
  };
}

function ensureLifecycleSchemaVersion(
  state: RecordingSpoolState,
  event: CraigLifecycleEvent,
): void {
  if (state.lifecycleSchemaVersion !== event.schemaVersion) {
    throw new RecordingIngressError(
      "conflicting-duplicate",
      "recording lifecycle schema version cannot change",
    );
  }
}

function finalizedResult(
  state: Pick<RecordingSpoolState, "actors" | "channelId" | "guildId" | "identityProvenance" | "lifecycleSchemaVersion">,
  recording: Extract<LifecycleIngressResult, { readonly kind: "finalized" }>["recording"],
  replayed: boolean,
): Extract<LifecycleIngressResult, { readonly kind: "finalized" }> {
  return {
    actors: state.actors === null
      ? null
      : state.actors.map((actor) => ({ actorId: actor.actorId, kind: actor.kind })),
    identityProvenance: state.identityProvenance === null
      ? null
      : { ...state.identityProvenance },
    kind: "finalized",
    lifecycleGeneration: state.lifecycleSchemaVersion,
    recording,
    replayed,
    source: { roomId: state.channelId, scopeId: state.guildId },
  };
}

async function archiveAborted(
  input: LifecycleIngressInput,
  state: RecordingSpoolState,
  events: RecordingSpoolState["events"],
): Promise<LifecycleIngressResult> {
  const aborted: AbortedRecordingState = {
    ...state,
    endedAt: input.event.occurredAt,
    events,
    status: "aborted",
  };
  await input.runtime.spool.archiveAborted(aborted);
  input.runtime.forgetJournalIndexes(state.recordingId);
  return { kind: "aborted", recordingId: state.recordingId, replayed: false };
}

async function beginAuthoritativeFinalization(
  input: LifecycleIngressInput,
  state: RecordingSpoolState,
  events: RecordingSpoolState["events"],
): Promise<LifecycleIngressResult> {
  const finalizing: RecordingSpoolState = {
    ...state,
    endedAt: input.event.occurredAt,
    events,
    finalEventDigest: input.digest,
    finalEventId: input.event.eventId,
    status: "finalizing",
  };
  await input.runtime.spool.writeRecording(finalizing);
  // Packet ingestion is closed once finalization starts. Release the per-packet
  // deduplication index before waiting for authoritative Craig artifacts, which
  // may be retried much later.
  input.runtime.forgetJournalIndexes(state.recordingId);
  return { kind: "accepted", recordingId: state.recordingId, replayed: false };
}
