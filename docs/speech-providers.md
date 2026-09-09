# Speech providers

[Documentation](README.md) · [Botik](../README.md)

Batch transcription uses the original recording; live transcription produces
captions during the call. Select them independently:

| Mode | Deepgram | ElevenLabs |
| --- | --- | --- |
| Batch | `deepgram-nova-3` | `elevenlabs-scribe-v2` |
| Live | `deepgram-nova-3` | `elevenlabs-scribe-v2-realtime` |

Set `VOICETEXT_BATCH_PROFILE` and `VOICETEXT_LIVE_PROFILE` in your deployment
configuration. Both default to Deepgram, so the default setup needs a Deepgram key.
If you only have an ElevenLabs key, set the batch profile to
`elevenlabs-scribe-v2` and the live profile to `elevenlabs-scribe-v2-realtime`
before starting the services.

Recognition languages and quality depend on the provider and model. Tests cover
synthetic Russian/English audio and Discord sequential speech, overlap and
reconnection. See the [results and limits](../infra/deployment/oss-acceptance.md).
English, Russian and Ukrainian display labels are separate from speech recognition
support; Ukrainian speech has not been qualified.
