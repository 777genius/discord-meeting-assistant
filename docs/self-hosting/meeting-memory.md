# Meeting memory and grounded replies

[Self-hosting](README.md)

Memory is an advanced, release-gated capability. The default deployment does
not serve Retrieval V2 answers. Connecting an index or enabling a boolean does
not make historical question answering ready. Use this page to distinguish the
available setup from the remaining qualification requirements.

## Scenario 1: reply to a final meeting message

Local Final Reply is off by default. Its deployment prerequisites are:

1. Keep `DISCORD_PUBLICATION_MODE=message`.
2. Enable Message Content intent on the publication Discord application.
3. Generate a separate 32-byte base64 key (or 64-character lowercase hexadecimal
   key), store it as `secrets/platform/meeting-knowledge-principal-key`, owner
   `10001:10001`, mode `0400`.
4. Set `MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED=true`.
5. Configure the generation runtime from [AI summaries](ai-summaries.md).

These settings enable the local reply entry point and principal protection;
they do not unlock historical retrieval. Verify permissions, source evidence
and the exact enabled path in your private deployment before offering it to users.
See [Local Final Reply design](../decisions/0030-local-final-reply.md).

## Scenario 2: connect an external historical index

Infinity Context is separately deployed. It is not included in the base stack.
You need its qualified service revision, embedding profile, provider token and
the reviewed activation manifest for the Platform release you deploy.

Store `infinity-context-token` and a separate `infinity-context-topology-key`
under `secrets/platform`, owned by `10001:10001`, mode `0400`. Generate the topology
key with 48 random bytes encoded as base64. Keep it stable: rotating it changes
remote opaque identities and requires a planned migration.

Set the following non-secret environment values:

```dotenv
INFINITY_CONTEXT_URL=https://your-qualified-infinity-service.example
INFINITY_CONTEXT_REQUEST_TIMEOUT_MS=10000
INFINITY_CONTEXT_OPERATION_TIMEOUT_MS=300000
INFINITY_CONTEXT_ACTIVATION=REVIEWED_RELEASE_ACTIVATION_JSON
```

The placeholder is intentionally not executable. Obtain the activation from
the reviewed release evidence; do not fabricate hashes or copy a historical
attestation as proof for a different deployment. The service URL has no embedded
credentials, query or fragment. `localhost` inside Platform means Platform's
container, not the host or another service.

Append `-f infra/deployment/compose.infinity-context.yaml` after the base three
Compose files in the verified startup command. This configures the provider;
it does not supply qualification or enable answer serving by itself. The full
[provider compatibility contract](../../infra/deployment/README.md#infinity-context-historical-memory)
lists required capability fields, SDK/service pins and timeout bounds.

## Scenario 3: historical or grounded voice answers

Do not raise rollout, manufacture qualification files or enable grounded voice
merely to get past a startup check. Retrieval V2 defaults to zero rollout and
has no production V2 provider binding composed in the default deployment.
Two-hour serving requires evidence bound to the exact release and rollout epoch;
the required production-model repetitions and accepted receipts must exist first.

The base VoiceText overlay also removes the actor-keyring and grounded-voice
epoch settings. Advanced grounded-voice activation therefore needs a reviewed
composition change, not just more values in `.env`.

Until the gates are satisfied, advertise recording/transcription and separately
configured conversation, not generally available long-term meeting memory.
Indexing can continue while answer serving is unavailable only when indexing is
enabled and projection qualification succeeds. Failed provider qualification
disables indexing. Deletion remains separately eligible, but remote work still
requires a reachable, transport-qualified provider.

## Verification and rollback

Inspect capability/qualification warnings and confirm the exact operation you
intend to expose actually succeeds against accepted transcript evidence. An
HTTP health response, indexed document count or synthetic unit test is not a
recall/answer-quality measurement. The [retrieval baseline](../operations/meeting-memory-retrieval-baseline.md)
and [limits ledger](../operations/meeting-knowledge-limits-ledger.md) explain the
retained evidence and its dates.

Keep migrations and serving gates together. Migration 0032 prevents old epoch-2
workers from serving bound jobs. Do not downgrade to an incompatible binary or
edit persisted request bindings. Follow the release's stop-first migration and
rollback instructions; preserve databases and original recordings.
