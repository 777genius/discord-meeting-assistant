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
4. final transcription preserves Discord speaker identity and timestamps;
5. summary schema, action owner, and evidence turn references are validated;
6. publishing creates or updates exactly one Discord thread;
7. rerunning each stage produces no duplicate business effect.

Transcript assertions use WER/CER thresholds, required terminology, exact speaker
IDs, timestamp tolerance, and overlap checks. Summary assertions are deterministic
schema and evidence checks; an LLM judge may supplement but never replace them.

## Safety

Real Discord E2E runs only with official bot applications, test-only tokens, a
private guild, synthetic audio, and isolated storage. Local and CI defaults use
fakes. External E2E should be a separately selectable or scheduled suite so a
Discord outage cannot hide local regressions.
