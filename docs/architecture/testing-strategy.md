# Testing strategy

## Test layers

- Domain tests prove invariants, state transitions, value objects, overlap and
  evidence rules without mocks or infrastructure.
- Application tests exercise use cases through deterministic ports and fakes,
  including idempotency, cancellation, retry classification, and partial failure.
- Contract tests prove lifecycle, transcript, summary, and adapter compatibility.
- Craig lifecycle contract tests pin the producer's exact canonical bundle
  bytes and digest, parse every producer fixture with the consumer parser, and
  cover old/new spool overlap without upgrading a recording's generation.
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
late-chunk rejection, queue bounds, worker reuse after normal turns and
interruption, phrase streaming, terminal attestation, and exact additive
first-audio telemetry. A local Ollama/Piper profile qualifies
arbitrary Russian and English output separately.

Grounded conversation tests additionally keep candidate lookup text-free,
rehydrate the exact canonical turn locally, validate the complete structured
answer before literal TTS, and prove cancellation/replacement emits no late PCM.
The live-memory suite covers durable finalized-turn outbox replay, generation
watermarks, bounded hot-tail dedupe, cross-room denial, and restart backfill.
Historical recall@k is measured separately from answer generation on a
synthetic two-hour positional corpus. Count, absence, universal, and broad
questions must exercise every-block checkpoints and a complete coverage bitmap;
semantic extraction oracles include paraphrased decisions, RU/EN existence,
proven absence, duplicates, and contradictions beyond 256 turns. No lexical-only
selection or top-k result can satisfy those assertions. The required Meeting Knowledge
composition E2E uses disposable PostgreSQL and an HTTP endpoint fake reached
through the official Infinity Context SDK, and hard-fails when its infrastructure
prerequisites are unavailable. It covers restart/replay, local rehydration,
focused and exhaustive generation plans, late-corpus evidence beyond 256 turns,
supersession, ambiguous deletes, cross-room denial, and deletion with serving
and indexing disabled.

The multilingual V4 quality scorer measures only opaque upstream seed locators
before neighbor expansion. Recall@5 and complete final-answer recall gate
overall and independently for EN, RU, and mixed. A frozen set of 25
codename-free questions must achieve at least 23/25 Recall@5 and remain within
five percentage points of the named-anchor stratum. Citation admission is
reconstructed from exact canonical turns rehydrated locally; finalized
citation entailment is a separate 1/1 gate. Static fixture checks reject turn
IDs, long digest tokens, synthetic marker vocabulary, and gold identifiers.
Each outcome binds the canonical question ID, locale, and evaluation-text digest;
local evidence must come from its retrieved seed-or-neighbor locators, and prompt,
evidence-byte, and whole-transcript accounting is independently reconstructed.
Independent adjudication, not the generator, classifies factual claims. Every
target fact family freezes question-specific same-codename stale, contradictory,
wrong-room, and wrong-scope negatives.

Application tests use a controllable delay and preloaded staged PCM cue registry
to prove the 1.3-second neutral acknowledgement, the 3.2-second complex-request
cue, omission for simple prompts and unsupported locales, immediate cue
interruption, answer replacement, and that only real answer playback starts the
four-second guard. They also prove exact alias normalization, ordinary-mention
rejection, and the same-speaker transcript-time wake latch.
The provider-backed canary uses an isolated Subscription Runtime workspace and
the development ElevenLabs key; it records end-to-wake, wake-to-first-delta,
delta-to-first-PCM, and total first-audio latency for consecutive warm turns,
but is never required by the local or CI gate.

The providerless suite also drives Russian and English proactive greetings,
with and without configured participant names, through real gRPC, Pipecat, and
Craig WebSocket playback. Prepared Russian and English farewell assets bypass
LLM/TTS, traverse the same Craig playback transport, and must arrive
byte-for-byte with their pinned PCM checksums.

The private Discord observer is opt-in. It uses an official test bot, listens
only for the configured Craig bot in a private test channel, and retains bounded
audio evidence: first-packet timing, duration, packet count, PCM checksum,
and RMS/non-silence. Correlation IDs remain operator-supplied labels, while
cancellation and semantic transcript accuracy require separate qualification.

## Hosted private-guild campaign

The test-only hosted coordinator executes one compiled three-run graph:
sequential, overlap, then reconnect. The reconnect phase deterministically
captures an unknown-participant greeting, named Russian and English greetings,
the Speaker D greeting, an addressed answer, and one prepared farewell. Armed
receipts and create-only barriers replace timing sleeps. Finite children are
waited, stopped on failure or interruption, and must be torn down before the
single create-only pass receipt is published.

Recording identity enters later children only through the validated
recording-ready receipt. Each post-call replay uses a create-only v2 marker bound
to the exact run, recording, running container, image, and source revision.
Collection retains authoritative Craig/S3 evidence, stable before/after
deployment provenance, replay results, Discord publication evidence, recording
playback checks, and service-level source artifacts before the campaign verifier
can pass.

The playback-link observer is armed before reconnect publication can occur. At
the first visible possession link it immediately starts the hardened readiness
probe and retains only bounded sanitized digests, message/container identity,
the first-observed poll bracket, and the separate readiness request bracket.
This honestly proves first-observed-then-ready, not atomic readiness at the
instant of publication. The later create-only recording-ready receipt binds
that candidate to the exact meeting marker and recording without replacing its
first-seen timing; a missing, changed, ambiguous, stale, or failed candidate
fails closed. A stronger ready-at-first-visibility claim requires an atomic
publication-ready receipt and is outside this observer contract.

Local coordinator, graph, process-lifecycle, and evidence tests do not authorize
an external run. Admission recomputes the exact plan and fails closed before the
artifact lease or any child starts. Its consumer-owned remote-probe port returns
one closed, create-only, expiring receipt bound to the exact campaign and plan.
That receipt has four explicit sections: deployment safety, Discord identity,
Voicetext canary, and clock preflight. Operator-authored capability files are
retained declarations only and cannot authorize a campaign; an absent probe
always leaves admission blocked.

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
9. summary language follows the dominant transcript language, material acceptance
   details remain compact topic points, and action/evidence references are validated;
10. publishing creates one separate idempotent final message by default while
    retaining the live draft; compatibility mode replaces the live draft in the
    same Discord container/message. Both attach the complete authoritative transcript;
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
