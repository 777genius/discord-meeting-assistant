import { expect, it, vi } from "vitest";
import { liveMeetingVocabulary, meetingVocabulary } from "../src/composition/meeting-vocabulary.js";
import { VoicetextLiveTranscriptionAdapter } from "@discord-meeting/voicetext-adapter";

const options = { endpoint: "ws://localhost", token: "synthetic-token-123456", profile: "elevenlabs-scribe-v2-realtime" as const };
const request = { meetingId: "m", speakerId: "s", idempotencyKey: "k", onTranscript: () => {} };
it("retains exact batch vocabulary and changes only the live phrase", () => {
  expect(meetingVocabulary).toEqual(["BullMQ", "Craig", "Craig recording", "Dima", "Discord", "Discord thread", "idempotency key", "Iliya", "landing page", "landing slug", "live Pipecat assistant", "Marina", "Mark", "Meeting Platform", "Nazar", "Pipecat", "PostgreSQL", "PostgreSQL pipeline", "QID", "Quanta", "Quanta ID", "Quanta Pages", "Redis", "Redis queue", "referral code", "referral link", "timestamp", "Vlad"]);
  expect(liveMeetingVocabulary).toEqual(meetingVocabulary.map(term => term === "live Pipecat assistant" ? "Pipecat assistant" : term));
  expect([..."Pipecat assistant"]).toHaveLength(17);
});
for (const keyterms of [liveMeetingVocabulary, ["a".repeat(20)], ["😀".repeat(20)], ["  Pipecat   assistant  "], ["a\u0085b"]]) {
  it(`admits normalized scalar vocabulary before connecting: ${keyterms[0]}`, async () => {
    const connect = vi.fn(async () => { throw new Error("connection reached"); });
    const adapter = new VoicetextLiveTranscriptionAdapter({ ...options, keyterms }, { connect });
    await expect(adapter.openSession(request)).rejects.toThrow("connection reached");
    expect(connect).toHaveBeenCalledTimes(1);
  });
}
for (const keyterms of [["a".repeat(21)], ["a".repeat(22)], ["😀".repeat(21)], meetingVocabulary, Array.from({ length: 51 }, (_, i) => String(i))]) {
  it(`rejects at OPEN without construction failure or connection: ${keyterms[0]}`, async () => {
    const connect = vi.fn();
    const adapter = new VoicetextLiveTranscriptionAdapter({ ...options, keyterms }, { connect });
    await expect(adapter.openSession(request)).rejects.toMatchObject({ code: "live_admission_rejected", retryable: false });
    expect(connect).not.toHaveBeenCalled();
  });
}
