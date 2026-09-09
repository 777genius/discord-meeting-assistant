# OSS VoiceText delivery acceptance - 2026-09-09

## What is ready

The core self-hosted flow records Discord audio, transcribes original per-speaker
recordings, optionally streams live captions, and publishes the authoritative
transcript with a minimal transcript outline. It uses operator-owned bot tokens
and speech-provider keys.
Rich generated summaries and spoken answers are separate optional capabilities.

Start with the [Compose installation](oss-meeting-topology.md). The test VM,
Canary controller and hosted development workers are not application prerequisites.

## Verified Discord campaign

Campaign `oss-9e56ad38-9210-4855-9c53-55005a9f991d` passed sequential speech,
overlap and reconnect in a private guild with official bots and synthetic audio.
The root-runtime collector exited zero and created `oss-discord-stt-trusted-pass-v1`.
Its receipt SHA-256 is
`f4d16e5db800e1f501a72041b4cbd10c8041624afd94ba8fa39ff5bb194ed568`.
All 69 archive artifact hashes were checked. Original recordings, final/live
transcripts, timestamps, required terms, quality thresholds, transcript-linked
outline and Discord publication were verified. Nine post-call stages succeeded
on attempt one. All six live sessions succeeded without errors and sent finalize
exactly once; each scenario acknowledged 1,315 and 2,449 packets for its speakers.
Ten Compose services were healthy with zero restarts before the campaign, with
TLS and mounted-file provenance verified.

| Component | Qualified source | Merge commit |
| --- | --- | --- |
| Discord collector | `9b213f2da492daa58ef2f16da6ea3b2d0a16da18` | `d64d6a6e8c1d507dcbc0491c2f3cc747be703d65` |
| Gateway | `3e0ede3ec9086a45bc026f43191a998f2682fd6e` | `f00c93333012d405a6bc52314ede120b321b190a` |
| Craig | `7776b698f6bec26eff52cd383f4e5a7f3f429f42` | `6b16d3e9d8194cdbc0c232533dd14b0ec2bba4ea` |
| Canary controller | `877c46e97a56717af368c94fdd0d0772682da15e` | `0d5ddc969385a020cd83d2e28229a2cc891a02ba` |

The actual Platform image was built from
`9060193065e83503cab938773bf4e3f009b0924f`. Reviewed intervening changes preserve
its runtime; image labels were not changed to claim a newer build. Every merge
tree matched its checked PR head. Exact Discord CI run `34316822435` and Gateway
CI `34206637815` passed. Craig Build Apps `34213272480` and ESLint
`34213272398` passed at its qualified head, alongside independent reviews
with no blocker/high findings.

Public change and CI references:
[Discord #63](https://github.com/777genius/discord-meeting-assistant/pull/63),
[Gateway #1](https://github.com/777genius/voicetext-gateway/pull/1),
[Craig #7](https://github.com/777genius/craig-meeting-gateway/pull/7),
[Canary #19](https://github.com/777genius/voicetext-canary/pull/19).
Raw recordings and operational receipts remain retained operator evidence,
not downloadable public release assets. A hash identifies that record; it does
not independently prove an arbitrary user's deployment.

## Provider quality and limits

The [four-profile result table](voicetext-gateway.md#implemented-profile-mapping-and-qualification-status)
is the historical native campaign `8de7b998-a09f-4d9a-9c39-01dc33828eef` at gateway
`550ec217b3b549d7719aaa4a412d9ecbaf0a2f4b`. Its 26-second synthetic RU/EN fixture
passed Deepgram batch/live and ElevenLabs batch/live, including required terms,
timestamps and exactly-one operations. Independent review established applicability
to unchanged provider paths at the final gateway revision. The newer Discord
campaign used Deepgram; it was not a new ElevenLabs execution.

WER measures word errors and CER character errors against the fixture reference;
lower is better. Native thresholds were WER <= 35% and CER <= 25%; the Discord
suite required WER <= 35% and CER <= 20%, plus timing and speaker checks.
These are fixture results, not general meeting-accuracy promises. Mixed-provider
combinations and broader acoustic/language coverage are not qualified. Ukrainian
presentation does not establish Ukrainian speech recognition quality.

No credentials were published. Source scans passed; the retained scan's one
match was an AST-verified secret-directory variable reference, not a key.
Pipecat STT is future/unimplemented.
No versioned crate/container release is claimed: installation builds pinned source.
A new installation must validate its own keys, configuration, TLS and health;
follow the [receipt procedure](oss-discord-stt-campaign.md#locate-and-interpret-a-trusted-receipt)
when making a formal deployment qualification claim.
