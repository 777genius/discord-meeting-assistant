# Infinity Context official SDK artifacts

The production dependency is the independently reviewed immutable
`artifacts/infinity-context-sdk-0.2.4.tgz`, not an SDK source path. Its exact
package identity, SHA-256, SRI, and packed manifest digest are checked by:

```bash
node vendor/infinity-context/prepare-official-sdk.mjs
```

The check is offline and never creates, fetches, rebuilds, or replaces the
reviewed artifact. The SDK source commit recorded for review traceability is
`40704f193008f98c52ede93b68a44349907dd2cd`; consumer provenance is bound to
the tarball, release manifest, verification receipt, and packed
`@infinity-context/sdk@0.2.4` metadata.

The 0.2.4 package is the single default SDK for indexing, deletion, retrieval, and reconciliation.
