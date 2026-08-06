# Pipecat conversation runtime

This is the provider-neutral infrastructure sidecar for the versioned
`ConversationRuntimeService` contract. It deliberately owns no Meeting Core
business policy, Discord transport, durable memory, or provider secrets outside
its own composition.

The checked-in gRPC code is generated from the repository-owned contract:

```text
../../packages/conversation-runtime-contracts/proto/conversation_runtime.proto
```

Local commands:

```text
uv sync --frozen --all-groups
uv run python tools/generate_contract.py
uv run ruff check .
uv run pyright
uv run lint-imports
uv run python tools/check_no_suppressions.py
uv run pytest
```

The production entrypoint requires `PIPECAT_RUNTIME_BEARER_TOKEN_FILE`. The
`deterministic-e2e` profile is intentionally rejected when the runtime
environment is `production`.

Profiles are selected only in composition:

- `deterministic-e2e`: CI/local providerless streaming with the real Pipecat
  pipeline and a checked-in PCM speech fixture;
- `local-russian`: Ollama plus a separately operated Piper HTTP service;
- `elevenlabs-multilingual`: stateless `gpt-5.6-luna` generation through the
  authenticated Subscription Runtime port plus Pipecat's ElevenLabs adapter
  using qualified RU/EN-capable TTS models. `eleven_flash_v2_5` is the
  low-latency default; `eleven_multilingual_v2` is the higher-fidelity option.
  The legacy `elevenlabs-russian` profile name resolves to this same composition.

Switching from local speech to ElevenLabs requires only
`PIPECAT_RUNTIME_PROFILE`, the matching `PIPECAT_RUNTIME_PROFILE_ID`,
`PIPECAT_RUNTIME_ELEVENLABS_VOICE_ID`, optional
`PIPECAT_RUNTIME_ELEVENLABS_MODEL`, an API key secret file, and the internal
Subscription Runtime address/token/deadline settings. `auto` locale leaves
language selection to the multilingual model; explicit supported locales use
Pipecat's language registry with a base-language fallback. Provider types and
credentials never cross the gRPC contract.

Production conversation turns use a server-streaming text port. Deltas are
decoded from the exact structured `answer`, buffered into speech phrases, and
sent to TTS before the final response completes. A bounded pipeline keyed by
meeting, voice profile, and locale keeps Pipecat and ElevenLabs connected across
sequential turns. Interruption cancels only the active context; shutdown,
eviction, or fatal failure closes the worker. The final attestation must exactly
match all provisional text before the turn can complete.
