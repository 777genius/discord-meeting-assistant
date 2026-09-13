# Infinity Context official SDK artifacts

The installed dependency is the independently checked
`artifacts/infinity-context-sdk-0.3.1.tgz`, not an SDK source path. It is an
observed mutable, unpublished draft for explicit test-only Retrieval V3
qualification. It is not an immutable release and cannot satisfy production
release admission. Its exact package identity, every generated identity
inventory member, SHA-256, SRI, manifest, source lock, draft receipt, and
independently derived trusted-intake record are checked by:

```bash
node vendor/infinity-context/prepare-official-sdk.mjs
```

The check is offline and never creates, fetches, rebuilds, or replaces either
retained artifact. The draft SDK source commit is
`9e06b31c7e07d158ead3e0b4ba34b5371c8913f2`. The genuine historical 0.2.4
release evidence remains separately verified and continues to back the
production immutable-admission provenance and Retrieval V2 provenance.

Only an explicit test qualification may consume the V3 draft provenance.
