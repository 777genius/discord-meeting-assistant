import type { VoicePacketBatch } from "@discord-meeting/craig-gateway-contracts";

import type { PacketBatchIngressResult } from "./contracts.js";
import { RecordingIngressError } from "./errors.js";
import { appendPendingLivePackets } from "./live-delivery-outbox.js";
import { appendJournal, journalPacketIdentity } from "./journal.js";
import {
  abortIfRequested,
  decodePacket,
  ensureRecordingIdentity,
  journalPacketFingerprint,
  type DecodedPacket,
} from "./recording-ingress-invariants.js";
import {
  type CachedJournalIndex,
  RecordingIngressRuntime,
} from "./recording-ingress-runtime.js";
import { spoolToken, type RecordingSpoolState, type StoredSpeaker } from "./spool.js";

interface DecodedPacketBatch {
  readonly identity: DecodedPacket;
  readonly packets: readonly DecodedPacket[];
}

interface JournalIndexSnapshot {
  readonly indexes: ReadonlyMap<string, CachedJournalIndex>;
  readonly opusBytes: number;
  readonly packetCount: number;
}

interface PacketAcceptance {
  readonly acceptedBySpeaker: ReadonlyMap<string, readonly DecodedPacket[]>;
  readonly acceptedBytesBySpeaker: ReadonlyMap<string, number>;
  readonly duplicatePackets: number;
}

interface LockedPacketBatchInput {
  readonly identity: DecodedPacket;
  readonly packets: readonly DecodedPacket[];
  readonly runtime: RecordingIngressRuntime;
  readonly signal: AbortSignal | undefined;
}

export async function ingestPacketBatch(
  runtime: RecordingIngressRuntime,
  batch: VoicePacketBatch,
  options: { readonly signal?: AbortSignal } = {},
): Promise<PacketBatchIngressResult> {
  abortIfRequested(options.signal);
  const decoded = decodePacketBatch(
    batch,
    runtime.limits.maxOpusBytesPerPacket,
    runtime.limits.maxPacketsPerBatch,
    runtime.limits.maxBatchOpusBytes,
  );
  return runtime.exclusive(
    decoded.identity.recordingId,
    () => ingestLockedPacketBatch({ ...decoded, runtime, signal: options.signal }),
  );
}

function decodePacketBatch(
  batch: VoicePacketBatch,
  maxOpusBytesPerPacket: number,
  maxPacketsPerBatch: number,
  maxBatchOpusBytes: number,
): DecodedPacketBatch {
  if (batch.packets.length === 0 || batch.packets.length > maxPacketsPerBatch) {
    throw new RecordingIngressError("limit-exceeded", "voice packet batch is invalid or too large");
  }
  const packets = batch.packets.map((packet) => decodePacket(packet, maxOpusBytesPerPacket));
  const [identity] = packets;
  if (identity === undefined) {
    throw new RecordingIngressError("invalid-input", "voice packet batch is empty");
  }
  const totalOpusBytes = packets.reduce((total, packet) => total + packet.opus.byteLength, 0);
  if (totalOpusBytes > maxBatchOpusBytes) {
    throw new RecordingIngressError(
      "limit-exceeded",
      "voice packet batch exceeds the configured byte limit",
    );
  }
  assertPacketBatchIdentity(packets, identity);
  return { identity, packets };
}

function assertPacketBatchIdentity(
  packets: readonly DecodedPacket[],
  identity: DecodedPacket,
): void {
  for (const packet of packets) {
    if (
      packet.recordingId !== identity.recordingId ||
      packet.guildId !== identity.guildId ||
      packet.channelId !== identity.channelId
    ) {
      throw new RecordingIngressError(
        "invalid-input",
        "one packet batch must belong to one recording, guild and channel",
      );
    }
  }
}

async function ingestLockedPacketBatch(input: LockedPacketBatchInput): Promise<PacketBatchIngressResult> {
  const { identity, packets, runtime, signal } = input;
  abortIfRequested(signal);
  const activeState = await readActiveRecording(runtime, identity);
  const state = await ensureSpeakers(runtime, activeState, packets);
  const snapshot = await loadJournalIndexes(runtime, state);
  const acceptance = acceptPackets({ packets, runtime, signal, snapshot });
  // Persist delivery admission before journal append so either crash boundary leaves replay.
  await appendPendingLivePackets(runtime, [...acceptance.acceptedBySpeaker.values()].flat());
  await appendAcceptedPackets({ acceptance, runtime, signal, snapshot, state });
  return {
    acceptedPackets: packets.length - acceptance.duplicatePackets,
    duplicatePackets: acceptance.duplicatePackets,
    recordingId: state.recordingId,
  };
}

async function readActiveRecording(
  runtime: RecordingIngressRuntime,
  identity: DecodedPacket,
): Promise<RecordingSpoolState> {
  if ((await runtime.spool.readCompleted(identity.recordingId)) !== undefined) {
    runtime.forgetJournalIndexes(identity.recordingId);
    throw new RecordingIngressError("invalid-state", "recording is already finalized");
  }
  const aborted = await runtime.spool.readAborted(identity.recordingId);
  if (aborted !== undefined) {
    ensureRecordingIdentity(aborted, identity);
    await runtime.spool.cleanupActive(identity.recordingId);
    runtime.forgetJournalIndexes(identity.recordingId);
    throw new RecordingIngressError("invalid-state", "recording is already aborted");
  }
  const state = await runtime.spool.readRecording(identity.recordingId);
  if (state === undefined) {
    throw new RecordingIngressError("invalid-state", "meeting.started must precede audio packets");
  }
  ensureRecordingIdentity(state, identity);
  if (state.status !== "active") {
    if (state.status === "aborted") {
      await runtime.spool.archiveAborted(state);
      runtime.forgetJournalIndexes(identity.recordingId);
    }
    throw new RecordingIngressError(
      "invalid-state",
      `cannot append packets while recording is ${state.status}`,
    );
  }
  return state;
}

async function ensureSpeakers(
  runtime: RecordingIngressRuntime,
  state: RecordingSpoolState,
  packets: readonly DecodedPacket[],
): Promise<RecordingSpoolState> {
  const incomingSpeakerIds = [...new Set(packets.map(({ speakerId }) => speakerId))].toSorted();
  const knownSpeakerIds = new Set(state.speakers.map(({ speakerId }) => speakerId));
  const newSpeakers = incomingSpeakerIds
    .filter((speakerId) => !knownSpeakerIds.has(speakerId))
    .map<StoredSpeaker>((speakerId) => ({
      fileToken: spoolToken("speaker-v1", speakerId),
      speakerId,
    }));
  if (state.speakers.length + newSpeakers.length > runtime.limits.maxSpeakersPerRecording) {
    throw new RecordingIngressError(
      "limit-exceeded",
      "recording exceeds the configured speaker limit",
    );
  }
  if (newSpeakers.length === 0) {
    return state;
  }
  const updated = {
    ...state,
    speakers: [...state.speakers, ...newSpeakers].toSorted((left, right) =>
      left.speakerId.localeCompare(right.speakerId),
    ),
  };
  // The speaker-to-hashed-file mapping is durable before its first append.
  await runtime.spool.writeRecording(updated);
  return updated;
}

async function loadJournalIndexes(
  runtime: RecordingIngressRuntime,
  state: RecordingSpoolState,
): Promise<JournalIndexSnapshot> {
  const indexes = new Map<string, CachedJournalIndex>();
  let packetCount = 0;
  let opusBytes = 0;
  for (const speaker of state.speakers) {
    const index = await runtime.journalIndex(state.recordingId, speaker);
    indexes.set(speaker.speakerId, index);
    packetCount += index.packetCount;
    opusBytes += index.opusBytes;
  }
  return { indexes, opusBytes, packetCount };
}

function acceptPackets(input: {
  readonly packets: readonly DecodedPacket[];
  readonly runtime: RecordingIngressRuntime;
  readonly signal: AbortSignal | undefined;
  readonly snapshot: JournalIndexSnapshot;
}): PacketAcceptance {
  const acceptedBySpeaker = new Map<string, DecodedPacket[]>();
  const acceptedBytesBySpeaker = new Map<string, number>();
  const acceptedFingerprints = new Map<string, Map<string, string>>();
  let duplicatePackets = 0;
  let recordingPacketCount = input.snapshot.packetCount;
  let recordingOpusBytes = input.snapshot.opusBytes;
  for (const packet of input.packets) {
    abortIfRequested(input.signal);
    const duplicate = acceptPacket({
      acceptedBySpeaker,
      acceptedBytesBySpeaker,
      acceptedFingerprints,
      packet,
      runtime: input.runtime,
      snapshot: input.snapshot,
    });
    if (duplicate) {
      duplicatePackets += 1;
      continue;
    }
    recordingPacketCount += 1;
    recordingOpusBytes += packet.opus.byteLength;
    assertRecordingLimits(input.runtime, recordingPacketCount, recordingOpusBytes);
  }
  return { acceptedBySpeaker, acceptedBytesBySpeaker, duplicatePackets };
}

function acceptPacket(input: {
  readonly acceptedBySpeaker: Map<string, DecodedPacket[]>;
  readonly acceptedBytesBySpeaker: Map<string, number>;
  readonly acceptedFingerprints: Map<string, Map<string, string>>;
  readonly packet: DecodedPacket;
  readonly runtime: RecordingIngressRuntime;
  readonly snapshot: JournalIndexSnapshot;
}): boolean {
  const journalIndex = input.snapshot.indexes.get(input.packet.speakerId);
  if (journalIndex === undefined) {
    throw new RecordingIngressError("corrupt-spool", "speaker mapping is missing");
  }
  const accepted = input.acceptedBySpeaker.get(input.packet.speakerId) ?? [];
  const fingerprints = input.acceptedFingerprints.get(input.packet.speakerId) ??
    new Map<string, string>();
  const identity = journalPacketIdentity(input.packet);
  const fingerprint = journalPacketFingerprint(input.packet);
  const duplicateFingerprint = journalIndex.packetFingerprintsByIdentity.get(identity) ??
    fingerprints.get(identity);
  if (duplicateFingerprint !== undefined) {
    if (duplicateFingerprint !== fingerprint) {
      throw new RecordingIngressError(
        "conflicting-duplicate",
        "packet identity was replayed with different content",
      );
    }
    return true;
  }
  const acceptedOpusBytes =
    (input.acceptedBytesBySpeaker.get(input.packet.speakerId) ?? 0) + input.packet.opus.byteLength;
  assertSpeakerLimits(input.runtime, journalIndex, accepted.length + 1, acceptedOpusBytes);
  accepted.push(input.packet);
  input.acceptedBySpeaker.set(input.packet.speakerId, accepted);
  input.acceptedBytesBySpeaker.set(input.packet.speakerId, acceptedOpusBytes);
  fingerprints.set(identity, fingerprint);
  input.acceptedFingerprints.set(input.packet.speakerId, fingerprints);
  return false;
}

function assertSpeakerLimits(
  runtime: RecordingIngressRuntime,
  index: CachedJournalIndex,
  acceptedPacketCount: number,
  acceptedOpusBytes: number,
): void {
  if (
    index.packetCount + acceptedPacketCount > runtime.limits.maxPacketsPerSpeaker ||
    index.opusBytes + acceptedOpusBytes > runtime.limits.maxSpeakerOpusBytes
  ) {
    throw new RecordingIngressError(
      "limit-exceeded",
      "recording exceeds a configured packet or byte limit",
    );
  }
}

function assertRecordingLimits(
  runtime: RecordingIngressRuntime,
  packetCount: number,
  opusBytes: number,
): void {
  if (
    packetCount > runtime.limits.maxPacketsPerRecording ||
    opusBytes > runtime.limits.maxRecordingOpusBytes
  ) {
    throw new RecordingIngressError(
      "limit-exceeded",
      "recording exceeds a configured packet or byte limit",
    );
  }
}

async function appendAcceptedPackets(input: {
  readonly acceptance: PacketAcceptance;
  readonly runtime: RecordingIngressRuntime;
  readonly signal: AbortSignal | undefined;
  readonly snapshot: JournalIndexSnapshot;
  readonly state: RecordingSpoolState;
}): Promise<void> {
  for (const speaker of input.state.speakers) {
    const accepted = input.acceptance.acceptedBySpeaker.get(speaker.speakerId) ?? [];
    if (accepted.length === 0) {
      continue;
    }
    abortIfRequested(input.signal);
    const index = input.snapshot.indexes.get(speaker.speakerId);
    if (index === undefined) {
      throw new RecordingIngressError("corrupt-spool", "speaker journal index is missing");
    }
    const appendedJournalBytes = await appendSpeakerPackets({
      accepted,
      runtime: input.runtime,
      speaker,
      state: input.state,
    });
    updateJournalIndex(
      index,
      accepted,
      appendedJournalBytes,
      input.acceptance.acceptedBytesBySpeaker.get(speaker.speakerId) ?? 0,
    );
    input.runtime.noteJournalAppend(input.state.recordingId, speaker.speakerId, index, accepted.length);
  }
}

async function appendSpeakerPackets(input: {
  readonly accepted: readonly DecodedPacket[];
  readonly runtime: RecordingIngressRuntime;
  readonly speaker: StoredSpeaker;
  readonly state: RecordingSpoolState;
}): Promise<number> {
  try {
    return await appendJournal(
      input.runtime.spool.speakerJournalPath(input.state.recordingId, input.speaker.fileToken),
      input.accepted,
    );
  } catch (error) {
    // A failed append can have an unknown durable outcome. Force the next retry
    // to rescan and repair the journal before deduplicating.
    input.runtime.forgetJournalIndexes(input.state.recordingId);
    throw error;
  }
}

function updateJournalIndex(
  index: CachedJournalIndex,
  accepted: readonly DecodedPacket[],
  appendedJournalBytes: number,
  acceptedOpusBytes: number,
): void {
  for (const packet of accepted) {
    index.packetFingerprintsByIdentity.set(
      journalPacketIdentity(packet),
      journalPacketFingerprint(packet),
    );
  }
  index.journalBytes += appendedJournalBytes;
  index.opusBytes += acceptedOpusBytes;
  index.packetCount += accepted.length;
}
