import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectNativeLive, qualifyNativeSessions, collectionFailureDiagnostic, qualifyNativeSession, type NativeLiveRow } from "../src/oss-native-live-collection.js";
import { verifyNativeCampaignSources, verifyNativeTranscriptIdentity } from "../src/oss-native-campaign-sources.js";
import { verifyOssQuality } from "../src/oss-campaign-quality.js";
import { fixtureManifestV1Schema } from "../src/e2e-fixture-manifest-schema.js";
import { loadArchive, sha256 } from "../src/oss-campaign-artifacts.js";
import { campaignFixture } from "./oss-campaign-fixture.js";

function session(offset = 1000, speakerId = "speaker-a") {
  const events: NativeLiveRow["event"][] = [
    { type: "opening", meetingId: "meeting", speakerId, clientSessionId: "00000000-0000-4000-8000-000000000001" },
    { type: "received", message: { type: "ready", sessionId: "00000000-0000-4000-8000-000000000002", provider: "deepgram", model: "nova-3" } },
  ];
  for (const [i, relativeTimeMs] of [offset, offset + 20, offset + 2000].entries()) {
    const seq = i + 1;
    events.push({
      type: "audio_send", seq, packetId: `packet-${seq}`, sha256: "a".repeat(64),
      size: 20, toc: 8, relativeTimeMs, durationSamples48Khz: 960
    },
      { type: "received", message: { type: "ack", seq } }, { type: "audio_sent", seq }, { type: "audio_accepted", seq });
  }
  const result = (startMs: number, durationMs: number, mappedStart: number, mappedEnd: number, text: string, isFinal: boolean) => {
    events.push({
      type: "received", message: isFinal ? { type: "segment_final", startMs, durationMs, text } :
        { type: "partial", segment: { startMs, durationMs, text } }
    },
      { type: "transcript_emitted", startMs: mappedStart, endMs: mappedEnd, text: text.trim(), isFinal });
  };
  result(0, 40, offset, offset + 40, " first ", false);
  result(0, 40, offset, offset + 40, " first ", true);
  // Same provider final is suppressed, including the final/segment_final alias.
  events.push({ type: "received", message: { type: "final", startMs: 0, durationMs: 40, text: "first" } });
  result(40, 20, offset + 2000, offset + 2020, "second", true);
  events.push({ type: "finalize_send" }, { type: "finalize_sent" },
    { type: "received", message: { type: "finalize_complete", status: "flushed", sawResult: true } },
    { type: "close", code: 1000 }, { type: "success" });
  return events.map((event, index): NativeLiveRow => ({
    event, index: index + 1, atMs: 900000 + index,
    session: "00000000-0000-4000-8000-000000000003"
  }));
}

describe("native accepted packet timeline", () => {
  it("maps gap boundaries and deduplicated finals without treating journal wall time as offsets", () => {
    expect(qualifyNativeSession(session()).speakerId).toBe("speaker-a");
    expect(qualifyNativeSession(session(350000)).speakerId).toBe("speaker-a");
  });
  it("resets the provider cursor per reconnect and independently maps overlapping speakers", () => {
    for (const rows of [session(), session(1020, "speaker-b"), session(5000)]) {
      expect(() => qualifyNativeSession(rows)).not.toThrow();
    }
  });
  it.each(["shift", "gap", "dropped", "ack", "missing", "extra", "text", "reconnect", "overlap"])("rejects %s corruption", kind => {
    let rows = session(kind === "reconnect" ? 5000 : 1000, kind === "overlap" ? "speaker-b" : "speaker-a");
    if (["shift", "reconnect", "overlap"].includes(kind)) {
      // A matching forged downstream ledger cannot repair this source mismatch.
      rows.forEach(({ event }) => { if (event.type === "transcript_emitted") { event.startMs += 500; event.endMs += 500; } });
    }
    if (kind === "gap") { rows.forEach(({ event }) => { if (event.type === "audio_send" && event.seq === 3) { event.relativeTimeMs = 1040; } }); }
    if (kind === "dropped") { rows = rows.filter(({ event }) => !(event.type === "audio_send" && event.seq === 2)); }
    if (kind === "ack") { rows = rows.filter(({ event }) => !(event.type === "received" && event.message.type === "ack" && event.message.seq === 2)); }
    if (kind === "missing") { rows = rows.filter(({ event }) => event.type !== "transcript_emitted"); }
    if (kind === "extra") { rows.splice(-4, 0, rows.find(({ event }) => event.type === "transcript_emitted")!); }
    if (kind === "text") { rows.forEach(({ event }) => { if (event.type === "transcript_emitted") { event.text = "forged"; } }); }
    expect(() => qualifyNativeSession(rows)).toThrow();
  });
  it("accepts a synchronous result before the send and accepted effects settle", () => {
    const rows = session();
    const sendIndex = rows.findIndex(({ event }) => event.type === "audio_send" && event.seq === 3);
    const resultIndex = rows.findIndex(({ event }) => event.type === "received" && event.message.type === "partial");
    const result = rows.splice(resultIndex, 2);
    rows.splice(sendIndex + 1, 0, ...result);
    expect(() => qualifyNativeSession(rows)).not.toThrow();
  });
  it("rejects provider duration beyond accepted packets even when emission agrees", () => {
    const rows = session();
    for (const { event } of rows) {
      if (event.type === "received" && event.message.type === "segment_final" && event.message.startMs === 40) { event.message.durationMs = 40; }
      if (event.type === "transcript_emitted" && event.text === "second") { event.endMs += 20; }
    }
    expect(() => qualifyNativeSession(rows)).toThrow(/exceeds accepted audio/u);
  });
  it("maps a segment spanning a source gap", () => {
    const rows = session();
    for (const { event } of rows) {
      if (event.type === "received" && event.message.type === "segment_final" && event.message.startMs === 40) {
        event.message.startMs = 20; event.message.durationMs = 40;
      }
      if (event.type === "transcript_emitted" && event.text === "second") { event.startMs = 1020; }
    }
    expect(() => qualifyNativeSession(rows)).not.toThrow();
  });
});

it("independently scores finalized live text, terms, timing, speaker and overlap for every scenario", async () => {
  const root = await mkdtemp(join(tmpdir(), "oss-live-quality-"));
  try {
    const f = await campaignFixture(root);
    const manifest = fixtureManifestV1Schema.parse(JSON.parse(f.manifestBytes.toString()));
    for (const [i, original] of f.runs.entries()) {
      expect(() => { verifyOssQuality(original, manifest, f.actors[i]); }).not.toThrow();
      for (const kind of ["unrelated", "terms", "timeline", "missing", "duplicate", "speaker", "overlap"]) {
        const run = structuredClone(original);
        // Fixture batch/live share objects; break that alias before mutating live.
        run.liveTurns = structuredClone(original.liveTurns);
        const turn = run.liveTurns[0]!;
        if (kind === "unrelated") { turn.text = "unrelated"; turn.endMs = turn.startMs + 20; }
        if (kind === "terms") { turn.text = turn.text.replaceAll("PostgreSQL", "database"); }
        if (kind === "timeline") { turn.startMs += 4000; }
        if (kind === "missing") { run.liveTurns.pop(); }
        if (kind === "duplicate") { run.liveTurns.push({ ...turn }); }
        if (kind === "speaker") { turn.speakerId = "unknown"; }
        if (kind === "overlap") {
          if (i === 0) { run.liveTurns[1]!.startMs = turn.startMs; }
          else { turn.endMs = run.liveTurns[1]!.startMs; }
        }
        expect(run.transcript).toEqual(original.transcript);
        expect(() => { verifyOssQuality(run, manifest, f.actors[i]); }, `${i}: ${kind}`).toThrow();
      }
    }
    // Reconnect may create multiple finalized speaker sessions. Score their ordered
    // final turns once, independently of session cardinality and mutable partials.
    const reconnect = structuredClone(f.runs[2]!);
    reconnect.liveTurns = structuredClone(reconnect.liveTurns);
    const first = reconnect.liveTurns.shift()!;
    const words = first.text.split(" "), middle = Math.floor(words.length / 2);
    const boundary = Math.floor((first.startMs + first.endMs) / 2);
    reconnect.liveTurns.push({ ...first, endMs: boundary, text: words.slice(0, middle).join(" ") },
      { ...first, turnId: "reconnected-final", startMs: boundary, text: words.slice(middle).join(" ") });
    expect(() => { verifyOssQuality(reconnect, manifest, f.actors[2]); }).not.toThrow();
    const run = f.runs[0]!;
    await f.save();
    const archive = await loadArchive(f.planPath, root);
    const rows = session();
    rows.forEach((row, i) => {
      row.index = i + 2; row.atMs = run.startedAtMs + i;
      if (row.event.type === "opening") { row.event.meetingId = run.meetingId; }
      if (row.event.type === "transcript_emitted") { row.event.startMs += 500; row.event.endMs += 500; }
    });
    const forgedRun = {
      ...run, liveTurns: rows.flatMap(({ event }) => event.type === "transcript_emitted" && event.isFinal ? [{
        turnId: `live-turn:v1:${sha256([run.meetingId, "speaker-a", event.startMs, event.endMs, event.text].join("\0")).slice(0, 24)}`,
        speakerId: "speaker-a", startMs: event.startMs, endMs: event.endMs, text: event.text,
      }] : [])
    };
    const journal = (kind: string, content: unknown[]) => {
      const prefix = [JSON.stringify({
        index: 1, atMs: 0, type: "capture_start", kind,
        ...(kind === "oss-native-live-v1" ? { project: f.plan.target.project } : {}),
        revision: f.plan.target.platformRevision
      }), ...content.map(row => JSON.stringify(row))].join("\n") + "\n";
      return Buffer.from(prefix + JSON.stringify({
        index: content.length + 2, atMs: run.terminalAtMs,
        type: "capture_seal", priorSha256: sha256(prefix)
      }) + "\n");
    };
    const journals = new Map([["live", journal("oss-native-live-v1", rows)], ["postcall", journal("oss-native-post-call-v1", [])]]);
    expect(() => verifyNativeCampaignSources({
      ...archive,
      index: {
        ...archive.index, nativeSources: {
          livePath: "live", postCallPath: "postcall", deploymentPaths: [],
          runs: [{ runId: run.runId, snapshots: [], publications: [], originalsPath: "unused" }]
        }
      },
      bytes: path => journals.get(path) ?? archive.bytes(path),
    }, [forgedRun])).toThrow(/Native provider\/emitted timeline mismatch/u);
    const source = {
      snapshot: {
        revision: 19, recording: { recordingId: run.recordingId },
        transcript: { transcriptId: run.transcript.transcriptId, recordingId: run.recordingId, version: 1 }
      }
    };
    expect(() => { verifyNativeTranscriptIdentity(source, run); }).not.toThrow();
    expect(() => {
      verifyNativeTranscriptIdentity({
        snapshot: {
          ...source.snapshot,
          transcript: { ...source.snapshot.transcript, version: 2 }
        }
      },
        { ...run, transcript: { ...run.transcript, version: "2" } });
    }).not.toThrow();
    for (const transcript of [{ ...source.snapshot.transcript, version: 19 },
    { ...source.snapshot.transcript, recordingId: "wrong" }, { transcriptId: run.transcript.transcriptId }]) {
      expect(() => { verifyNativeTranscriptIdentity({ snapshot: { ...source.snapshot, transcript } }, run); }).toThrow();
    }
    expect(() => { verifyNativeTranscriptIdentity(source, { ...run, transcript: { ...run.transcript, version: "19" } }); }).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);

it.each(["provider-error", "zero-partial"])("diagnoses actual sealed native %s failure without granting acceptance", kind => {
  let rows = session();
  if (kind === "provider-error") {
    const index = rows.findIndex(row => row.event.type === "finalize_send");
    rows = [...rows.slice(0, index), { ...rows[index]!, event: { type: "received", message: { type: "error" } } },
      { ...rows[index + 1]!, event: { type: "failure" } }];
  } else {
    rows = rows.filter(({ event }) => !(event.type === "received" && event.message.type === "partial") &&
      !(event.type === "transcript_emitted" && !event.isFinal));
  }
  const allRows = [...session().map(row => ({ ...row, session: "00000000-0000-4000-8000-000000000004" })), ...rows];
  allRows.forEach((row, index) => { row.index = index + 2; row.atMs = 1000 + index; });
  const revision = "a".repeat(40);
  const prefix = [JSON.stringify({ index: 1, atMs: 0, type: "capture_start", kind: "oss-native-live-v1",
    project: "vtoss-test-oss-8f49a06-r1", revision }), ...allRows.map(row => JSON.stringify(row))].join("\n") + "\n";
  const bytes = Buffer.from(prefix + JSON.stringify({ index: allRows.length + 2, atMs: 1000000,
    type: "capture_seal", priorSha256: sha256(prefix) }) + "\n");
  const parsed = collectNativeLive(bytes, revision);
  let failure: unknown;
  try { qualifyNativeSessions(parsed.sessions); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect(collectionFailureDiagnostic(failure, "assembly")).toEqual({ kind: "oss-collection-diagnostic-v1",
    stage: "live-session", reason: kind === "provider-error" ? "PROVIDER_ERROR" : "ZERO_PARTIAL",
    sessionOrdinal: 2, rowIndex: kind === "provider-error" ? rows.at(-2)!.index : rows.at(-1)!.index });
});
it("never serializes arbitrary collector errors", () => {
  for (const stage of ["publication", "prefix", "assembly", "quality"] as const) {
    const diagnostic = collectionFailureDiagnostic(new Error("https://synthetic.invalid/SYNTHETIC_SECRET_TOKEN"), stage);
    expect(diagnostic.stage).toBe(stage);
    expect(JSON.stringify(diagnostic)).not.toMatch(/synthetic|https/u);
  }
});

it("keeps native-v1 strict and sanitizes malicious error fields at the parser boundary", () => {
  const rows = session().slice(0, 2);
  rows.forEach((row, index) => { row.index = index + 2; });
  const prefix = [JSON.stringify({ index: 1, atMs: 0, type: "capture_start", kind: "oss-native-live-v1",
    project: "vtoss-test-oss-8f49a06-r1", revision: "a".repeat(40) }),
    ...rows.map(row => JSON.stringify(row)), JSON.stringify({ ...rows[1], index: 4,
      event: { type: "received", message: { type: "error", code: "SYNTHETIC_SECRET_TOKEN", message: "https://synthetic.invalid/token" } }
    })].join("\n") + "\n";
  const bytes = Buffer.from(prefix + JSON.stringify({ index: 5, atMs: 1000000,
    type: "capture_seal", priorSha256: sha256(prefix) }) + "\n");
  let failure: unknown;
  try { collectNativeLive(bytes, "a".repeat(40)); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect(collectionFailureDiagnostic(failure, "assembly")).toEqual({ kind: "oss-collection-diagnostic-v1",
    stage: "native-parse", reason: "NATIVE_INVALID", rowIndex: 4 });
  expect(String(failure)).not.toMatch(/SYNTHETIC_SECRET_TOKEN|synthetic.invalid/u);
});
