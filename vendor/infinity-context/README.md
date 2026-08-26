# Infinity Context official SDK artifacts

The production dependency is the independently reviewed immutable
`artifacts/infinity-context-sdk-0.2.0.tgz`, not an SDK source path. Its exact
package identity, SHA-256, SRI, and packed manifest digest are checked by:

```bash
node vendor/infinity-context/prepare-official-sdk.mjs
```

The check is offline and never creates, fetches, rebuilds, or replaces the
reviewed artifact. The SDK source commit recorded for review traceability is
`4ea98c141770666dcbae3d46f9dddb2b974b5879`; consumer provenance is bound to
the tarball and packed `@infinity-context/sdk@0.2.0` metadata.

The predecessor `0.1.0` package remains the dependency of existing indexing,
deletion, and V1 search consumers during composition cutover. Only the new
package-local Retrieval V2 slice resolves the reviewed 0.2.0 artifact, under a
consumer alias that prevents an accidental upgrade of those V1 consumers.
