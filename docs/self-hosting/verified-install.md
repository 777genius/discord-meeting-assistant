# Verified fresh installation - 2026-09-10

[Self-hosting](README.md) · [Install](installation.md) · [Test limits](../../infra/deployment/oss-acceptance.md)

This is a measured test of the public source deployment, not a universal
performance promise. Botik revision
`f1cc6c5476ddcbbe4e9f4bc43744b801c3bf434c` ran on Linux x86_64 with 8 CPUs,
16.8 GB RAM, Docker 29.6.1, Compose 5.3.1 and Buildx 0.35.0.

The source checkout, databases, object storage and recording directories were
fresh. Existing official test Discord applications, a private test guild and
provider credentials were reused. Because bot identities cannot execute the
Manage Server command, the test imported one previously approved test-channel
route in place of the human `/setup-voice-bot` step. The transaction added only
that configuration: meetings, jobs and outbox rows remained empty. This proves a
fresh application/data deployment after Discord setup; it does not prove creating
Discord applications from scratch.

## Result

One sequential synthetic meeting completed without a manual queue replay:

- 10 runtime services stayed up with zero restarts;
- Craig retained two authoritative speaker tracks;
- final transcription produced 30 turns;
- Discord received the live draft and a separate final message;
- the final message contained summary and transcript attachments;
- the base `transcript-outline` summary was used, so no AI account or LLM usage
  was consumed.

The optional Subscription Runtime image was also built separately without being
started. BuildKit fetched public source from
[`777genius/ar`](https://github.com/777genius/ar) at exact revision
`83a7329f4383b05ac5c39356b79f82f029182d42`. The image contained
`@vioxen/subscription-runtime@0.1.0-main.28`, had no private registry/build secret,
and had no host mount over `/opt`. An authorized Codex subscription account pool
is still required to run AI summaries or voice answers.

## Measurements

| Measurement | Observed value |
| --- | ---: |
| Full observed installation, including disk cleanup and one recovered image race | 19 min 29 sec |
| Successful verified full build phase | 12 min 30 sec |
| Recovered edge build plus Compose create/health | 34.7 sec |
| Optional public-source AI sidecar build | 4 min 23 sec |
| Highest sampled stack memory during installation | 837 MiB |
| Successful meeting sampled stack peak | 706 MiB |
| Platform container cgroup peak | 281 MiB |
| Recording wall duration | 95.483 sec |
| Two speaker-track files | 797,644 bytes total |
| Recording manifest | 1,462 bytes |
| Final transcript attachment | 2,550 bytes |
| Final batch STT audio submitted | 105.54 sec across 2 jobs |
| Live STT input at the gateway | 75.30 sec across 3,765 packets |
| Final transcription pipeline time | 3.214 sec |

Deepgram processed the two speaker tracks independently: 26.24 and 79.30 seconds,
one attempt per job. Their total can exceed meeting wall time because speaker
tracks overlap. Live transcription was enabled for this scenario; the batch-job
duration above must not be presented as total provider billing for live plus
batch recognition. Both live WebSocket sessions finalized once and succeeded.
The provider did not expose billed live duration, so 75.30 seconds is the exact
audio packet duration observed at the gateway boundary, not a billing claim.

## Installation findings

The first build failed when Docker's own filesystem filled, even though the
separate deployment volume had free space. Five GiB free in Docker's shared,
cache-heavy root was not sufficient for this run. Check `DockerRootDir` and its
free space before building; this test does not establish a universal disk
minimum.

A later external cleanup removed one newly built edge image before Compose could
create its container. Only that missing image and the unproven create/health phase
were repeated. These recovery delays are included in the full observed time, so
12 min 30 sec is the more useful build measurement for this host. Existing image
and package caches were present, so this was a fresh source/data deployment rather
than a cache-cold VM benchmark.

The first synthetic attempt also stopped before audio because a fresh database
had no Discord route. This is expected until `/setup-voice-bot` succeeds; static
channel environment values intentionally do not override an authoritative empty
configuration. The successful result followed the imported, previously approved
test route described above.

Raw logs, credentials and private meeting artifacts are not public release
assets. Hash manifests and exact revisions bind the retained operator evidence;
they do not certify another server or provider account.
