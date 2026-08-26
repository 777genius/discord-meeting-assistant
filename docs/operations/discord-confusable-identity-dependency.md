# Discord confusable identity dependency

The Discord adapter owns Unicode identity skeleton mapping. Meeting Knowledge
consumes only its narrow deterministic skeleton port; the mapping dependency
does not enter core domain code.

The reviewed registry package is pinned exactly as `confusables@1.1.1`. On
2026-08-26 the npm `latest` tag was `1.1.1`. Registry and tarball inspection
recorded:

- license: MIT;
- runtime, optional, and peer dependencies: none;
- install lifecycle scripts: none (`prepublishOnly` is publishing-only);
- published files: 20;
- unpacked size: 107,866 bytes;
- SHA-1: `d3aafa1666d13a3a2fa9483bf556f641588d9a02`;
- npm integrity:
  `sha512-BzFtzUrufackm00Wb2zvrZV0ItRqPdWaUprU5FXHeZiJRrOWxGmXmQl/muGTF9EQl+MdBXz+Irk99meskGZmXw==`;
- source repository: `https://github.com/gc/confusables`.

The strict workspace catalog and lockfile retain the exact version and
integrity. Runtime admission fails closed when configured aliases have no
skeleton authority, collide across owners, or an identity-like token reaches
the same skeleton without certain mapping.
