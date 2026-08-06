# Executable architecture

This directory contains machine-readable architecture policy. Product semantics
remain in `docs/architecture` and accepted decisions in `docs/decisions`.

- `foundation/` owns consumer-specific dependency facts for the versioned
  engineering foundation.
- `meeting-core-consumer-subpaths.json` closes Foundation 0.6.0's workspace
  package-subpath gap with explicit per-consumer feature allowlists.
- `ast-grep/` owns narrow structural rules that are not import-graph questions.

The source-dependency scope classifies every current production TypeScript root
fail-closed. New production source must extend the governed roots and add its
closed boundary classification in the same change. Production source may not
land outside a governed root.

The Meeting Core subpath verifier additionally scans all production source
roots. Any Meeting Core import outside a classified consumer root fails closed,
as does drift between its policy and the package export map.
