# Infinity Context SDK reviewed source workspace

`.upstream` is an ignored, sparse Git source workspace for the official
Infinity Context repository. The reviewable `prepare-official-sdk.mjs` script
fetches and checks out exact commit
`249245a98bdae6d357c586aa078374c2a9da728c`. Consumers install the retained,
immutable official `npm pack` artifact under `artifacts/`; the script rebuilds
that artifact from `packages/infinity_context_ts_sdk` and verifies that both
copies have the exact pinned SHA-256 and SRI. No SDK implementation is copied
into repository source.

Reviewed provenance:

- repository: `https://github.com/777genius/infinity-context.git`
- commit: `249245a98bdae6d357c586aa078374c2a9da728c`
- package tree: `a2ed97138f1d52e33aa04de6efe17c4726baf19e`
- reviewed source bundle SHA-256:
  `0168c397b761950e9dd5e7d2586516c773287f0bd101d8900cff961608b358bd`
- canonical package-source archive SHA-256:
  `4ce4b9b2319e2015e8a4c9e81263ff23ae024e468bd6ae4523ee8b0ac95eb97c`
- package manifest SHA-256:
  `020c37993fc2749dd55649b2649d35e79570c1b43757a67ee16618de15be6ccd`
- package lock SHA-256:
  `068b3129a4ccd449c50cdc6a72755dbae3d4a977c5a468565e2f3841529cac0e`
- reproducible official npm package tarball SHA-256:
  `8727f751aed94769de8e7aec93ea0b927479a4ab501b3b01c31c2472b6cebc7f`
- reproducible official npm package tarball integrity:
  `sha512-V2RCQKfJ3XMiIXQ7B3F+wvGAu9RJeRYGnDaRIVdT890tLvv0asviGpmsyyM5El7JuNjgPKI+TpdygaoKjxYSDw==`

Run `node vendor/infinity-context/prepare-official-sdk.mjs` before installing
the main workspace. It verifies every digest above, installs from the official
package lock, invokes the package's official build and export checks, and
re-packs the reviewed package to prove the exact SHA-256 and SRI. The
generated workspace remains reviewable with Git while staying outside the
repository patch. The retained tarball is the production dependency boundary.
Production image builds run the same verification with `--cleanup-source`
after installing that tarball. This removes the temporary sparse checkout,
including its `.git` provenance metadata, so it cannot enter the runtime image.
Production indexing and serving remain fail-closed unless the service reports
the source-pinned revision, dense embedding profile, and tokenizer-conformant
instance digest configured by the activation. The instance digest is an
endpoint echo, not an independent semantic authority.

Production semantic retrieval has a separate qualification command. It is
destructive only within an operator-confirmed disposable service and deletes
its synthetic 421-turn corpus before returning:

```bash
INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE=YES_DELETE_ALL_TEST_DATA \
INFINITY_CONTEXT_SEMANTIC_E2E_URL=https://disposable-infinity.example/ \
INFINITY_CONTEXT_SEMANTIC_E2E_TOKEN=... \
INFINITY_CONTEXT_SEMANTIC_E2E_EMBEDDING_PROFILE=reviewed-real-profile-v1 \
INFINITY_CONTEXT_SEMANTIC_E2E_EMBEDDING_PROFILE_DIGEST_SHA256=sha256:... \
INFINITY_CONTEXT_SEMANTIC_E2E_SERVICE_REVISION=249245a98bdae6d357c586aa078374c2a9da728c \
pnpm --filter @discord-meeting/infinity-context-adapter run test:semantic-service
```

The command refuses deterministic, mock, or non-production embedding profiles
and emits one
`meeting_knowledge.infinity_semantic_qualification.v1` JSON manifest only after
recall@5 is 1.0 for all seven frozen positional questions and remote absence is
verified. This evidence measures quality but does not replace the source pin or
tokenizer conformance activation checks.

The in-memory `DisposableInfinityEndpoint` under the adapter's test directory
is only an official-SDK transport contract fixture. Its results are never live
qualification evidence and can never populate the retained qualification
manifest pin. A real disposable service must produce separately retained,
content-addressed evidence before production activation can be enabled.
