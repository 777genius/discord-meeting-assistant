import { z } from "zod";
import { createHash } from "node:crypto";
import { digest, id, revision, time } from "./oss-campaign-profile.js";
import { requireEvidence as check } from "./oss-campaign-artifacts.js";

const segmentShape = {
  startMs: time, durationMs: time, text: z.string().max(65536),
  confidence: z.number().min(0).max(1).optional()
};
const message = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"), sessionId: z.uuid(),
    model: z.enum(["nova-3", "scribe_v2_realtime"]), provider: z.enum(["deepgram", "elevenlabs"])
  }).strict(),
  z.object({ type: z.literal("ack"), seq: time.positive() }).strict(),
  z.object({ type: z.literal("partial"), segment: z.object(segmentShape).strict().nullable() }).strict(),
  z.object({ type: z.enum(["final", "segment_final"]), ...segmentShape }).strict(),
  z.object({
    type: z.literal("finalize_complete"), sawResult: z.boolean(),
    status: z.enum(["flushed", "no_provider", "timeout"])
  }).strict(),
  z.object({ type: z.enum(["error", "usage_update", "resumed"]) }).strict(),
]);
const event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("opening"), meetingId: id, speakerId: id, clientSessionId: z.uuid() }).strict(),
  z.object({
    type: z.literal("audio_send"), seq: time.positive(), packetId: id, sha256: digest,
    size: time.min(2).max(1275), toc: time.max(255), relativeTimeMs: time, durationSamples48Khz: z.literal(960)
  }).strict(),
  z.object({ type: z.enum(["audio_sent", "audio_accepted"]), seq: time.positive() }).strict(),
  z.object({ type: z.enum(["finalize_send", "finalize_sent", "terminated", "failure", "success"]) }).strict(),
  z.object({ type: z.literal("close"), code: time }).strict(),
  z.object({ type: z.literal("transcript_emitted"), startMs: time, endMs: time, text: z.string().min(1).max(65536), isFinal: z.boolean() }).strict(),
  z.object({ type: z.literal("received"), message }).strict(),
]);
const base = { index: time.positive(), atMs: time };
const header = z.object({
  ...base, type: z.literal("capture_start"), kind: z.literal("oss-native-live-v1"),
  project: z.literal("vtoss-test-oss-8f49a06-r1"), revision
}).strict();
const rowSchema = z.object({ ...base, session: z.uuid(), event }).strict();
const seal = z.object({ ...base, type: z.literal("capture_seal"), priorSha256: digest }).strict();
export type NativeLiveRow = z.infer<typeof rowSchema>;

// Advisory failure metadata only. Never consumed by acceptance or campaign PASS.
const collectionDiagnosticSchema = z.object({
  kind: z.literal("oss-collection-diagnostic-v1"),
  stage: z.enum(["publication", "prefix", "retention", "assembly", "native-parse", "live-session", "quality", "receipt"]),
  reason: z.enum(["PUBLICATION_FAILED", "PREFIX_MISMATCH", "RETENTION_FAILED", "ASSEMBLY_FAILED",
    "NATIVE_INVALID", "SESSION_INVALID", "PROVIDER_ERROR", "ZERO_PARTIAL", "QUALITY_FAILED", "RECEIPT_FAILED"]),
  sessionOrdinal: z.number().int().min(1).max(100).optional(),
  rowIndex: z.number().int().min(1).max(1000000).optional()
}).strict();
type CollectionDiagnostic = z.infer<typeof collectionDiagnosticSchema>;
export class OssCollectionDiagnosticError extends Error {
  public constructor(detail: string, public readonly diagnostic: CollectionDiagnostic) { super(detail); }
}
export function collectionFailureDiagnostic(error: unknown, stage: CollectionDiagnostic["stage"]): CollectionDiagnostic {
  if (error instanceof OssCollectionDiagnosticError) {
    const parsed = collectionDiagnosticSchema.safeParse(error.diagnostic);
    if (parsed.success) { return parsed.data; }
  }
  const reasons = { publication: "PUBLICATION_FAILED", prefix: "PREFIX_MISMATCH", retention: "RETENTION_FAILED",
    assembly: "ASSEMBLY_FAILED", "native-parse": "NATIVE_INVALID", "live-session": "SESSION_INVALID",
    quality: "QUALITY_FAILED", receipt: "RECEIPT_FAILED" } as const;
  return collectionDiagnosticSchema.parse({ kind: "oss-collection-diagnostic-v1", stage, reason: reasons[stage] });
}

export function qualifyNativeSessions(sessions: ReadonlyMap<string, NativeLiveRow[]>) {
  return [...sessions.values()].map((rows, index) => {
    try { return qualifyNativeSession(rows); }
    catch (error) {
      throw new OssCollectionDiagnosticError("Native session qualification failed",
        { ...collectionFailureDiagnostic(error, "live-session"), sessionOrdinal: index + 1 });
    }
  });
}

/** Parse the exact native journal bytes, not an operator-normalized report.
 * Returns every discovered session, including failures; qualification is separate.
 */
export function collectNativeLive(bytes: Buffer, expectedRevision: string) {
  check(bytes.length > 0 && bytes.length <= 256 * 1024 * 1024 && bytes.at(-1) === 10,
    "Missing, oversized or truncated native live journal");
  const lines = bytes.toString("utf8").split("\n");
  lines.pop();
  check(lines.length >= 2 && lines.length <= 1000000, "Invalid native journal row bound");

  const start = header.parse(parse(lines[0]!));
  check(start.index === 1 && start.revision === expectedRevision, "Native journal revision mismatch");
  const end = seal.parse(parse(lines.at(-1)!));
  const prefix = bytes.subarray(0, bytes.length - Buffer.byteLength(lines.at(-1)!) - 1);
  check(end.index === lines.length && end.priorSha256 === createHash("sha256").update(prefix).digest("hex"),
    "Native journal seal/integrity mismatch");
  const sessions = new Map<string, NativeLiveRow[]>();
  let atMs = start.atMs;
  for (let index = 1; index < lines.length - 1; index++) {
    let sessionOrdinal: number | undefined;
    try {
      const row = rowSchema.parse(parse(lines[index]!));
      sessionOrdinal = [...sessions.keys()].indexOf(row.session) + 1 || sessions.size + 1;
      check(row.index === index + 1 && row.atMs >= atMs && row.atMs <= end.atMs,
        "Native journal sequence/time gap");
      atMs = row.atMs;
      const rows = sessions.get(row.session) ?? [];
      check(rows.length > 0 ? row.event.type !== "opening" : row.event.type === "opening",
        "Native journal missing/duplicate session opening");
      rows.push(row);
      sessions.set(row.session, rows);
      check(sessions.size <= 100, "Native session bound exceeded");
    } catch {
      throw new OssCollectionDiagnosticError("Native journal row invalid", {
        kind: "oss-collection-diagnostic-v1", stage: "native-parse", reason: "NATIVE_INVALID",
        rowIndex: index + 1, ...(sessionOrdinal === undefined || sessionOrdinal > 100 ? {} : { sessionOrdinal })
      });
    }
  }
  check(end.atMs >= atMs, "Native capture seal predates events");
  return { start, end, sessions };
}

/** Strictly ordered native send intents, acknowledgements, accepted effects and
 * finalize/close. send promises may settle after the corresponding receive event.
 */
export function qualifyNativeSession(rows: readonly NativeLiveRow[]) {
  let rowIndex = rows[0]?.index;
  function checkSession(condition: unknown, detail: string, reason: CollectionDiagnostic["reason"] = "SESSION_INVALID"): asserts condition {
    if (!condition) {
      throw new OssCollectionDiagnosticError(detail, { kind: "oss-collection-diagnostic-v1",
        stage: "live-session", reason, ...(rowIndex === undefined ? {} : { rowIndex }) });
    }
  }
  const opening = rows[0]?.event;
  checkSession(opening?.type === "opening", "Native session opening required");
  const state: {
    ready: Extract<z.infer<typeof message>, { type: "ready" }> | undefined;
    sent: number; ack: number; accepted: number; finalized: number; finalizeSent: number;
    completed: boolean; closed: boolean; success: boolean; partials: number; finals: number;
  } = {
    ready: undefined, sent: 0, ack: 0, accepted: 0, finalized: 0, finalizeSent: 0,
    completed: false, closed: false, success: false, partials: 0, finals: 0
  };
  const sentEffects = new Set<number>();
  const packets = new Set<string>();
  let relativeTime = -1;
  for (const row of rows.slice(1)) {
    rowIndex = row.index;
    const e = row.event;
    checkSession(!state.success && e.type !== "failure" && e.type !== "terminated", "Failed or late native session event");
    switch (e.type) {
      case "opening": throw new Error("Duplicate native opening");
      case "audio_send": case "audio_sent": case "audio_accepted": acceptAudio(e); break;
      case "finalize_send": case "finalize_sent": finalize(e.type); break;
      case "received": receive(e.message); break;
      case "transcript_emitted":
        verifyEmission(e); break;
      case "close": close(e.code); break;
      case "success": succeed(); break;
    }
  }
  checkSession(state.success && state.ready, "Native session lacks successful terminal");
  verifyNativeTranscriptMapping(rows);
  return { ...opening, providerSessionId: state.ready.sessionId, rows };
  function succeed(): void {
    checkSession(state.closed && state.finalizeSent === 1 && state.partials > 0, "Native session incomplete",
      state.closed && state.finalizeSent === 1 && state.partials === 0 ? "ZERO_PARTIAL" : "SESSION_INVALID");
    state.success = true;
  }
  function close(code: number): void {
    checkSession(state.completed && !state.closed && code === 1000, "Native close failed");
    state.closed = true;
  }

  function receive(m: z.infer<typeof message>): void {
    checkSession(!state.closed && !state.completed, "Native receive after terminal");
    if (m.type === "ready") { checkSession(!state.ready && !state.sent, "Native duplicate ready"); state.ready = m; }
    else if (m.type === "ack") {
      checkSession(!state.finalized && m.seq === state.ack + 1 && m.seq <= state.sent, "Native acknowledgement mismatch"); state.ack++;
    } else if (m.type === "partial") { checkSession(state.ready && state.sent > 0 && m.segment !== null, "Invalid native partial"); state.partials++; }
    else if (m.type === "final" || m.type === "segment_final") {
      checkSession(state.ready && state.sent > 0 && m.durationMs > 0 && m.text.length > 0, "Invalid native final"); state.finals++;
    } else if (m.type === "finalize_complete") {
      verifyFinalizeComplete(m); state.completed = true;
    } else { checkSession(m.type !== "error", "Native provider error", "PROVIDER_ERROR"); }
  }
  function acceptAudio(e: Extract<NativeLiveRow["event"], { type: "audio_send" | "audio_sent" | "audio_accepted" }>): void {
    switch (e.type) {
      case "audio_send":
        checkSession(state.ready && !state.finalized && state.sent === state.accepted && e.seq === state.sent + 1 &&
          !packets.has(e.packetId) && e.relativeTimeMs > relativeTime &&
          (e.toc & 7) === 0 && opusDurationMs(e.toc) === 20, "Native audio ordering mismatch");
        packets.add(e.packetId); relativeTime = e.relativeTimeMs; state.sent++; break;
      case "audio_sent":
        checkSession(e.seq <= state.sent && !sentEffects.has(e.seq), "Native send completion mismatch");
        sentEffects.add(e.seq); break;
      case "audio_accepted":
        checkSession(e.seq === state.accepted + 1 && e.seq <= state.ack && sentEffects.has(e.seq), "Native accepted audio mismatch");
        state.accepted++; break;
    }
  }
  function finalize(type: "finalize_send" | "finalize_sent"): void {
    switch (type) {
      case "finalize_send":
        checkSession(state.ready && !state.finalized && state.sent > 0 && state.sent === state.accepted && state.ack === state.sent,
          "Native finalize ordering mismatch"); state.finalized++; break;
      case "finalize_sent": checkSession(state.finalized === 1 && !state.finalizeSent, "Native duplicate finalize send"); state.finalizeSent++; break;
    }
  }
  function verifyFinalizeComplete(m: Extract<z.infer<typeof message>, { type: "finalize_complete" }>): void {
    checkSession(state.finalized === 1 && m.status === "flushed" && m.sawResult && state.finals > 0,
      "Native finalize failed");
  }

  function verifyEmission(e: Extract<NativeLiveRow["event"], { type: "transcript_emitted" }>): void {
    checkSession(state.ready && !state.completed && !state.closed && e.endMs > e.startMs, "Invalid emitted native transcript");
  }

}

function opusDurationMs(toc: number): number {
  const config = toc >> 3;
  if (config >= 16) { return 2.5 * 2 ** (config & 3); }
  if (config >= 12) { return 10 * 2 ** (config & 1); }
  return [10, 20, 40, 60][config & 3]!;
}

/** Replay the adapter's reserved packet anchors and start-inclusive/end-exclusive
 * gap boundaries (VoicetextLiveTimeline). Qualification above proves every send
 * was ACKed and accepted. Reservation precedes send completion, so a provider
 * result may legitimately arrive before its audio_accepted journal effect. */
function verifyNativeTranscriptMapping(rows: readonly NativeLiveRow[]): void {
  const anchors: Array<{ provider: number; source: number }> = [];
  let cursor = 0, sourceEnd: number | undefined;
  const fingerprints = new Set<string>();
  let expected: Extract<NativeLiveRow["event"], { type: "transcript_emitted" }> | undefined;
  const map = (ms: number, boundary: "start" | "end") => {
    check(Number.isSafeInteger(ms * 48) && ms <= cursor, "Native provider segment exceeds accepted audio");
    const anchor = anchors.findLast(item => boundary === "start" ? item.provider <= ms : item.provider < ms)
      ?? anchors[0];
    check(anchor, "Native provider segment lacks accepted audio");
    return Math.round(anchor.source + ms - anchor.provider);
  };
  for (const { event: e } of rows) {
    if (expected) {
      check(e.type === "transcript_emitted" && e.startMs === expected.startMs && e.endMs === expected.endMs &&
        e.text === expected.text && e.isFinal === expected.isFinal, "Native provider/emitted timeline mismatch");
      expected = undefined;
      continue;
    }
    check(e.type !== "transcript_emitted", "Unmatched native emitted transcript");
    if (e.type === "audio_send") {
      if (sourceEnd !== e.relativeTimeMs) { anchors.push({ provider: cursor, source: e.relativeTimeMs }); }
      cursor += e.durationSamples48Khz / 48;
      sourceEnd = e.relativeTimeMs + e.durationSamples48Khz / 48;
    }
    if (e.type !== "received") { continue; }
    const m = e.message;
    const segment = m.type === "partial" ? m.segment :
      m.type === "final" || m.type === "segment_final" ? m : null;
    if (!segment || !segment.text.trim() || anchors.length === 0) { continue; }
    const isFinal = m.type !== "partial", text = segment.text.trim();
    const fingerprint = segment.startMs + "\0" + segment.durationMs + "\0" + text;
    if (isFinal && fingerprints.has(fingerprint)) { continue; }
    if (isFinal) { fingerprints.add(fingerprint); }
    expected = {
      type: "transcript_emitted", startMs: map(segment.startMs, "start"),
      endMs: map(segment.startMs + segment.durationMs, "end"), text, isFinal
    };
  }
  check(!expected, "Missing native emitted transcript");
}

function parse(line: string): unknown {
  check(Buffer.byteLength(line) <= 128 * 1024, "Native journal row exceeds bound");
  return JSON.parse(line) as unknown;
}
