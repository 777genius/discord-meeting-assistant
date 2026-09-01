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

Recognition language coverage depends on the selected provider and model. Only
English and Russian provider flows are qualified. Contract compatibility does
not establish final private-guild acceptance; that requires the separate live
Discord campaign to pass.

The legacy streaming-final adapter uploads Deepgram-compatible mono `pcm_s16le`
audio through VoiceText protocol v2. Uploads are ACK-driven and paced to
`224000` bytes/second by default, below the backend's `256000` bytes/second
token-bucket rate.

## Memory boundary

This version does not transcode as a streaming pipeline. The complete bounded
Ogg track is read into memory, then ffmpeg's complete bounded PCM output is
materialized in memory before WebSocket frames are uploaded. The per-speaker and
total byte limits are therefore production safety boundaries, not estimates.
