# Disposable final-STT service

This stack is isolated under the Compose project `discord-meeting-speaches`,
binds only to loopback by default, and has no API-key setting. It is for local
or test-host transcription only; its named model cache contains no meeting
recordings.

The image is pinned to the immutable multi-platform digest for the official
Speaches `v0.9.0-rc.3` CPU release:

- `ghcr.io/speaches-ai/speaches:0.9.0-rc.3-cpu`
- `sha256:2163775b6df5e451a71200e8f675fed68dbd8ab184fc604453d549e486f22fd2`
- release source: <https://github.com/speaches-ai/speaches/releases/tag/v0.9.0-rc.3>

That release lock resolves `faster-whisper==1.1.1` and
`ctranslate2==4.5.0`. The current upstream faster-whisper release is `1.2.1`,
but replacing libraries inside the published Speaches image would make the
deployment unverified. Upgrade the complete image only after its provider
contract and Russian/mixed-language benchmark pass.

The disposable default is `Systran/faster-whisper-small` with CPU `int8`.
Production can set `SPEACHES_MODEL_ID` to a benchmarked multilingual model
without changing Meeting Core or the adapter. Leaving the adapter `language`
unset enables mixed-language detection; setting it to `ru` biases known-Russian
meetings. Vocabulary is sent as both standard `prompt` and Speaches `hotwords`.

```bash
docker compose --env-file .env.example up --detach --wait
curl --fail http://127.0.0.1:8000/health
docker compose down
```

Do not use `down --volumes` unless deleting the isolated model cache is
intentional.
