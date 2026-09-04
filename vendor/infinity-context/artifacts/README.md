# Official Infinity Context SDK package artifacts

`infinity-context-sdk-0.2.4.tgz` is the independently reviewed, unmodified
official package artifact built from upstream source commit
`40704f193008f98c52ede93b68a44349907dd2cd`. Consumers bind to this immutable
artifact and its packed metadata, never to a mutable source checkout.

- package: `@infinity-context/sdk@0.2.4`
- release tag: `sdk-v0.2.4`
- tag object: `60933db64cdc5796b624d97f463b498b28ae3fca`
- reviewed source tree: `836cca4d0981f4df73922c5b982975fc9db25ec7`
- upstream package-lock SHA-256: `c27ee764041ac4e93fd3d19bbf4363590e3dc1641abe4d89c7cbb0cbfc8222da`
- SHA-256: `c838fab52ca10d57119f1964d3ab29d71a2c7194047e15a68a6e189af3779bde`
- SRI: `sha512-PpLM+eW84DRsNhYDvX02Y+v5hOCuQJMHJoNinyUwclHtizmpDEh4aBcRsCEvgqyQqYh2pD+zsu3VAZdKfbjKAg==`
- packed `package.json` SHA-256: `218762d671873968552ce568ae1a87bb651e5ca5017db4f6b2953252aa7ae67e`
- release manifest SHA-256: `8b675d4f4ee00b3effc4208fe24a65f6406b891d6c33d388dafd73ce4b7f71af`
- release verification receipt SHA-256: `4dff2fb23ddf2913332d033d0283b5268e24ce88eee7c854bc26e417ae1946cf`

`prepare-official-sdk.mjs` verifies all of these values offline. It does not
rebuild or silently regenerate the reviewed tarball.

The predecessor packages are retained for evidence only; 0.2.4 is the only active SDK artifact.

Release: https://github.com/777genius/infinity-context/releases/tag/sdk-v0.2.4

The uncommitted 0.2.3 artifacts were replaced; that predecessor remains available
from its immutable GitHub release. SDK 0.2.4 includes the upstream PR #59 deadline
compatibility fix. The consumer deadline E2E exercises per-request timeouts,
overall operation exhaustion, and caller cancellation without a timeout workaround.
