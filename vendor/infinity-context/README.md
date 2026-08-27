# Infinity Context official SDK artifacts

The production dependency is the independently reviewed immutable
`artifacts/infinity-context-sdk-0.2.1.tgz`, not an SDK source path. Its exact
package identity, SHA-256, SRI, and packed manifest digest are checked by:

```bash
node vendor/infinity-context/prepare-official-sdk.mjs
```

The check is offline and never creates, fetches, rebuilds, or replaces the
reviewed artifact. The SDK source commit recorded for review traceability is
`e685b41a12e630b7e787fb2fa26b08c0eb6137d4`; consumer provenance is bound to
the tarball and packed `@infinity-context/sdk@0.2.1` metadata.

The 0.2.1 package is the single default SDK for indexing, deletion, retrieval, and reconciliation.
