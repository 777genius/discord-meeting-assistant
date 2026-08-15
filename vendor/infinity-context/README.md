# Infinity Context SDK reviewed source workspace

`.upstream` is an ignored, sparse Git source workspace for the official
Infinity Context repository. The reviewable `prepare-official-sdk.mjs` script
fetches and checks out exact commit
`897efd211151e9a81a7466fdd6be5cb067ddb8eb`. Consumers install the retained,
immutable official `npm pack` artifact under `artifacts/`; the script rebuilds
that artifact from `packages/infinity_context_ts_sdk` and verifies that both
copies have the exact pinned SHA-256 and SRI. No SDK implementation is copied
into repository source.

Reviewed provenance:

- repository: `https://github.com/777genius/infinity-context.git`
- commit: `897efd211151e9a81a7466fdd6be5cb067ddb8eb`
- package tree: `67a744b1accc0d4628c19f28849660bc917b8b62`
- canonical package-source archive SHA-256:
  `1aad93c1c9deea91f0c0ec750b99e91d1092e9d208751e11c6231badd5fbd9d2`
- package manifest SHA-256:
  `a646c42b1f8948b0f1b81d3d988f79b4f2c64616a1c5e2711648b2686ce1e135`
- package lock SHA-256:
  `068b3129a4ccd449c50cdc6a72755dbae3d4a977c5a468565e2f3841529cac0e`
- reproducible official npm package tarball SHA-256:
  `93ea6c98dec53c886250f3a3a06cb3825da27d1fc5ff73b85ab9633273e6bc1a`
- reproducible official npm package tarball integrity:
  `sha512-ohD89uSSlW7zT/BqaEufIBZ7EAVcq1LYAWn/rRel8EOyMAnq5DXSh3PqjYXAYJdE9WsHgLWx7Tysy9jAY7XaHw==`

Run `node vendor/infinity-context/prepare-official-sdk.mjs` before installing
the main workspace. It verifies every digest above, installs from the official
package lock, invokes the package's official build and export checks, and
re-packs the reviewed package to prove the exact SHA-256 and SRI. The
generated workspace remains reviewable with Git while staying outside the
repository patch. The retained tarball is the production dependency boundary.
Production indexing, serving, and deletion reconciliation additionally remain
fail-closed unless the exact retained live-service qualification manifest is
configured.

The in-memory `DisposableInfinityEndpoint` under the adapter's test directory
is only an official-SDK transport contract fixture. Its results are never live
qualification evidence and can never populate the retained qualification
manifest pin. A real disposable service must produce separately retained,
content-addressed evidence before production activation can be enabled.
