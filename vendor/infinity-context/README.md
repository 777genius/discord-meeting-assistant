# Infinity Context SDK reviewed source workspace

`.upstream` is an ignored, sparse Git source workspace for the official
Infinity Context repository. The reviewable `prepare-official-sdk.mjs` script
fetches and checks out exact commit
`b77b490cebbf9d80d4204425df3d795b4866ea19`. Consumers install the retained,
immutable official `npm pack` artifact under `artifacts/`; the script rebuilds
that artifact from `packages/infinity_context_ts_sdk` and verifies that both
copies have the exact pinned SHA-256 and SRI. No SDK implementation is copied
into repository source.

Reviewed provenance:

- repository: `https://github.com/777genius/infinity-context.git`
- commit: `b77b490cebbf9d80d4204425df3d795b4866ea19`
- package tree: `ac25c12c4733953bf7a4882d5c2c4476589455f2`
- canonical package-source archive SHA-256:
  `4d96f50ae01f9000e9ac4c50eaa61b4d875c3a452aed58f7e2efe1d69ee8d08d`
- package manifest SHA-256:
  `a646c42b1f8948b0f1b81d3d988f79b4f2c64616a1c5e2711648b2686ce1e135`
- package lock SHA-256:
  `068b3129a4ccd449c50cdc6a72755dbae3d4a977c5a468565e2f3841529cac0e`
- reproducible official npm package tarball SHA-256:
  `2e4bcced4df632a7953c7ff767a4076ce6cfff1aa4469a40e8b36659f29a90c8`
- reproducible official npm package tarball integrity:
  `sha512-YurXjgFGoRxwc5zJghj69ZFyZx8WLS1ucvgVvV2EFjZMCATxr9YrJW1ueeyLqwkaLKnO1JEvbTpqn7Q8K33b+A==`

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
INFINITY_CONTEXT_SEMANTIC_E2E_SERVICE_REVISION=b77b490cebbf9d80d4204425df3d795b4866ea19 \
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
