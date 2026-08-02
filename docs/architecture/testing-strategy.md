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
   can enter incremental-summary evidence;
7. after five minutes, captions and the preliminary summary edit one stable
   Discord message and expose exact runtime token/cost telemetry;
8. final transcription preserves Discord speaker identity and timestamps;
9. summary topics, action owner/deadline, and evidence turn references are validated;
10. publishing replaces the live draft in exactly the same Discord thread/message;
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
