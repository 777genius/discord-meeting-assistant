# VoiceText adapter

This package is a client for a separately deployed VoiceText-compatible
speech-to-text service. It contains no provider backend or provider SDK, and
Meeting Platform gives it only the gateway URL, machine bearer token, and
explicit profile.

Batch and live profiles are independent:

- batch: `deepgram-nova-3` or `elevenlabs-scribe-v2`;
- live: `deepgram-nova-3` or `elevenlabs-scribe-v2-realtime`.

The canonical batch HTTP contract and response validation live in
[`voicetext-batch-client.ts`](src/voicetext-batch-client.ts). Profile identities
live in [`voicetext-batch-contract.ts`](src/voicetext-batch-contract.ts). The
live WebSocket messages and exact provider/model readiness fence live in
[`protocol.ts`](src/protocol.ts) and
[`voicetext-live-transcription-configuration.ts`](src/voicetext-live-transcription-configuration.ts).

The service must authenticate the bearer token, preserve idempotency, return
the selected contract/provider/model identity, and implement the bounded batch
and live schemas. The separate OSS Rust VoiceText Gateway is a compatible
backend. Its [Compose overlay](../../infra/deployment/compose.voicetext-gateway.yaml)
uses a checksum-verified Git context; this repository does not claim a released
gateway image.

## Qualification boundaries

The default package suite is providerless. Its in-process contract gateway
drives the production `FetchVoicetextBatchClient` and production live session
for every configured profile. It proves client encoding, response parsing, ACK
pacing, finalization, and ordered close without contacting a speech provider.
The fake gateway deliberately returns `synthetic speech`; that result is contract
evidence only and can never create provider qualification evidence.

A separate provider canary sends the real Opus speech packets extracted from the
pinned `apps/discord-e2e-actors/test/fixtures/speaker-a.ru-en.ogg` fixture
(SHA-256 `8e29a933ef95eaf1f149b150ff123f90a3276847fcd4941ccb6c55b24561b9d8`).
It selects one matched profile pair per run:

- `deepgram`: `deepgram-nova-3` batch and live;
- `elevenlabs`: `elevenlabs-scribe-v2` batch and
  `elevenlabs-scribe-v2-realtime` live.

The canary is skipped by normal local and CI tests. `test:gateway-provider-canary`
sets `VOICETEXT_GATEWAY_PROVIDER_CANARY_REQUIRED=1`, so every remaining input is
mandatory and absence fails before any network request. The canary requires:

- `VOICETEXT_GATEWAY_PROVIDER_CANARY_HTTP_ORIGIN`
- `VOICETEXT_GATEWAY_PROVIDER_CANARY_WS_ORIGIN`
- `VOICETEXT_GATEWAY_PROVIDER_CANARY_TOKEN`
- `VOICETEXT_GATEWAY_PROVIDER_CANARY_PROFILE` (`deepgram` or `elevenlabs`)
- `VOICETEXT_GATEWAY_PROVIDER_CANARY_FIXTURE`
- `VOICETEXT_GATEWAY_PROVIDER_CANARY_RUN_ID`
- `VOICETEXT_GATEWAY_PROVIDER_CANARY_IDENTITY_FILE`
- `VOICETEXT_GATEWAY_PROVIDER_CANARY_EXPECTED_IDENTITY_SHA256`
- `VOICETEXT_GATEWAY_PROVIDER_CANARY_EXPECTED_TREE`
- `VOICETEXT_GATEWAY_PROVIDER_CANARY_EXPECTED_IMAGE_DIGEST`
- `VOICETEXT_GATEWAY_PROVIDER_CANARY_RECEIPT`

The identity file is a create-only, same-owner, non-symlink mode-0400
observation from the approved deployment probe, not an operator claim copied
from Compose. Schema
`voicetext-gateway-running-identity` v1 binds the run ID, exact HTTP/WS origins,
running container ID, image ID, full repository image digest, pinned gateway
commit `7adb5bb4c5c063ba3973e8bc76a759ac8ea29bb4`, its Git tree, source repository,
and observation time. Its `identitySha256` is the SHA-256 of canonical JSON after
recursively sorting object keys and omitting that field. The independently
reviewed digest, commit, tree, image digest, origins, and run ID must all match
before the canary reads the fixture or makes a gateway request. The file is
read and verified again after provider work.

For both batch and live, a pass requires non-empty provider-derived text, all
five checked-in fixture terms, ordered positive timestamps bounded by fixture
duration plus 10 seconds, and rejection of the fake gateway text. Batch must
return one identical idempotent result. Live sends all 1,312 extracted speech
packets in real time; every send must be ACKed and `finalize()` must receive a
valid provider-result terminal before ordered close.

Only then does the test create (never replace) the mode-0600
`voicetext-gateway-provider-canary-receipt` v1 at
`VOICETEXT_GATEWAY_PROVIDER_CANARY_RECEIPT`. The receipt binds the complete
running identity and its digest, fixture digest/duration/packet count, exact
profile pair, expected-term digest, batch job and transcript digest/timestamps,
live transcript digest/timestamps, ACK count, finalization, run ID, and its own
canonical digest. An existing or partially retained path fails closed.

A passing receipt qualifies only the named profile pair, pinned fixture terms,
gateway commit/tree/image, and run. It does not qualify a language, general
acoustic quality, another provider/model, another image, or private-guild
acceptance. Run the canary once for each profile pair intended for release; do
not infer English, Russian, Ukrainian, or any other language coverage from the
fixture or contract value `multi`. Provider and Discord execution require the
separately approved credentialed environment.

The legacy streaming-final adapter uploads Deepgram-compatible mono `pcm_s16le`
audio through VoiceText protocol v2. Uploads are ACK-driven and paced to
`224000` bytes/second by default, below the backend's `256000` bytes/second
token-bucket rate.

## Memory boundary

This version does not transcode as a streaming pipeline. The complete bounded
Ogg track is read into memory, then ffmpeg's complete bounded PCM output is
materialized in memory before WebSocket frames are uploaded. The per-speaker and
total byte limits are therefore production safety boundaries, not estimates.
