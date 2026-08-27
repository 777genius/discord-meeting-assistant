# Official Infinity Context SDK package artifacts

`infinity-context-sdk-0.2.1.tgz` is the independently reviewed, unmodified
official package artifact built from upstream source commit
`e685b41a12e630b7e787fb2fa26b08c0eb6137d4`. Consumers bind to this immutable
artifact and its packed metadata, never to a mutable source checkout.

- package: `@infinity-context/sdk@0.2.1`
- SHA-256: `aae17e2817b198f0f5e4151cdf023fb013370c12a58fe3245ccd92ba5d6b4166`
- SRI: `sha512-lCIL90wIF9dSme7qhMVdjN/ey+SAGCrmraKc3mak5oyer6ye7ZxbUBPMaCBBApr3+HTO8HduTtUPtqUPbrhJ/A==`
- packed `package.json` SHA-256: `146308a393c2e2f2961da477581b15da900c8b16a6e1ff4530ed8aec6057e70b`

`prepare-official-sdk.mjs` verifies all of these values offline. It does not
rebuild or silently regenerate the reviewed tarball.

The predecessor package is drained; 0.2.1 is the only active SDK artifact.
