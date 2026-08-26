# Official Infinity Context SDK package artifacts

`infinity-context-sdk-0.2.0.tgz` is the independently reviewed, unmodified
official package artifact built from upstream source commit
`4ea98c141770666dcbae3d46f9dddb2b974b5879`. Consumers bind to this immutable
artifact and its packed metadata, never to a mutable source checkout.

- package: `@infinity-context/sdk@0.2.0`
- SHA-256: `ecaa837b0a07ff31a786d070c6c0c34acf3b919241928ed75af5645541b790b2`
- SRI: `sha512-c/qRsUrKGOm7fxUZh5o7Vkg5AAuCg2UeyftZsBbcOpFKUqrmMRALjwQAJpLqhlNh3NKrWcRvZZZMUvkXJmnVQQ==`
- packed `package.json` SHA-256: `d1c84a8c9e1eeb9987247616731fd3b3d7ad3002b9a84607c36cd60f8c642367`

`prepare-official-sdk.mjs` verifies all of these values offline. It does not
rebuild or silently regenerate the reviewed tarball.

The predecessor `0.1.0` artifact remains retained while existing V1 adapter
behavior is preserved through composition cutover.
