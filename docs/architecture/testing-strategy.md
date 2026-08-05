# Testing strategy

## Test layers

- Domain tests prove invariants, state transitions, value objects, overlap and
  evidence rules without mocks or infrastructure.
- Application tests exercise use cases through deterministic ports and fakes,
  including idempotency, cancellation, retry classification, and partial failure.
- Contract tests prove lifecycle, transcript, summary, and adapter compatibility.
- Adapter integration tests use disposable PostgreSQL, object storage, queue,
  STT, and Discord-compatible test infrastructure.
- End-to-end tests cover only the critical summary-first workflow and recovery
  boundaries.

The same behavioral fixtures should run first through in-memory fakes and later
through concrete adapters. A real provider test never substitutes for a
deterministic failure test.

Property tests use Foundation's versioned seed-bank and replay contracts. CI
runs the committed seeds; a failing counterexample can be reproduced by passing
its normalized `FAST_CHECK_REPLAY` evidence instead of inventing a new random
seed.

## Providerless conversation E2E

The default conversation suite needs no TTS API key. It uses a deterministic
streaming LLM and spoken PCM fixture behind real Pipecat processors, then proves
Node/Python gRPC, Craig WebSocket playback, PCM-to-Opus framing, cancellation,
late-chunk rejection, and queue bounds. A local Ollama/Piper profile qualifies
arbitrary Russian and English output separately.

Application tests use a controllable delay and preloaded staged PCM cue registry
to prove the 1.3-second neutral acknowledgement, the 3.2-second complex-request
cue, omission for simple prompts and unsupported locales, immediate cue
interruption, answer replacement, and that only real answer playback starts the
four-second guard. They also prove exact alias normalization, ordinary-mention
rejection, and the same-speaker transcript-time wake latch.
The provider-backed canary uses an isolated Subscription Runtime workspace and
the development ElevenLabs key; it records cold/warm end-of-turn to first-audio
latency but is never required by the local or CI gate.

The private Discord observer is opt-in. It uses an official test bot, listens
only for the configured Craig bot in a private test channel, and retains bounded
audio evidence: first-packet timing, duration, packet count, PCM checksum,
and RMS/non-silence. Correlation IDs remain operator-supplied labels, while
cancellation and semantic transcript accuracy require separate qualification.

## Summary-first E2E

The critical flow is:

1. official test bots join a private test voice channel;
2. synthetic speaker fixtures include sequential and overlapping speech;
3. Craig produces the original multitrack recording;
4. Craig restart recovery cooks and uploads checksummed speaker tracks from that
   original, while an intentionally incomplete live tee is never finalized;
5. live Opus packet boundaries reach streaming transcription without a decode and
   re-encode step;
6. mutable partials update speaker-attributed captions, while only finalized turns
   can enter incremental-summary evidence and finalized caption history remains
   visible within Discord's message limits;
7. the first caption opens one stable Discord message, later captions edit it,
   and after five minutes the preliminary summary joins the same projection
   with measured or explicitly bounded runtime token/cost telemetry;
8. final transcription preserves Discord speaker identity and timestamps;
9. summary topics, action owner/deadline, and evidence turn references are validated;
10. publishing replaces the live draft in exactly the same Discord
    container/message while retaining a bounded authoritative transcript timeline;
11. a save/enqueue crash is recovered from the PostgreSQL outbox;
12. rerunning each stage produces no duplicate business effect.

Transcript assertions use WER/CER thresholds, required terminology, exact speaker
IDs, timestamp tolerance, and overlap checks. Summary assertions are deterministic
schema and evidence checks; an LLM judge may supplement but never replace them.

## Safety

Real Discord E2E runs only with official bot applications, test-only tokens, a
private guild, synthetic audio, and isolated storage. Local and CI defaults use
fakes. External E2E should be a separately selectable or scheduled suite so a
Discord outage cannot hide local regressions.
