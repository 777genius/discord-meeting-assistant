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
for every configured profile, proving client encoding, response parsing, ACK
pacing, finalization, and the ordered close boundary without contacting a speech
provider.

The exact-head black-box gate is different: it is authenticated and
provider-backed. It requires all four variables below and may send the supplied
Ogg fixture to the gateway's configured speech providers:

- `VOICETEXT_GATEWAY_E2E_HTTP_ORIGIN`
- `VOICETEXT_GATEWAY_E2E_WS_ORIGIN`
- `VOICETEXT_GATEWAY_E2E_TOKEN`
- `VOICETEXT_GATEWAY_E2E_OGG_FIXTURE`

Run it with `pnpm --filter @discord-meeting/voicetext-adapter
test:gateway-exact-head` only in an explicitly approved provider test
environment. Passing in-process conformance does not prove provider acoustic
quality. This repository does not retain exact-revision English/Russian
quality evidence for all four batch/live profiles, and neither gate establishes
private-guild acceptance; those require separately retained provider canaries
and the official-bot Discord campaign.

The legacy streaming-final adapter uploads Deepgram-compatible mono `pcm_s16le`
audio through VoiceText protocol v2. Uploads are ACK-driven and paced to
`224000` bytes/second by default, below the backend's `256000` bytes/second
token-bucket rate.

## Memory boundary

This version does not transcode as a streaming pipeline. The complete bounded
Ogg track is read into memory, then ffmpeg's complete bounded PCM output is
materialized in memory before WebSocket frames are uploaded. The per-speaker and
total byte limits are therefore production safety boundaries, not estimates.
