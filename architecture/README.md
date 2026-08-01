# Executable architecture

This directory contains machine-readable architecture policy. Product semantics
remain in `docs/architecture` and accepted decisions in `docs/decisions`.

- `foundation/` owns consumer-specific dependency facts for the versioned
  engineering foundation.
- `ast-grep/` owns narrow structural rules that are not import-graph questions.

The current source-dependency scope intentionally contains only the real tooling
package. The first production package must extend the governed roots and add its
closed boundary classification in the same change. Production source may not land
outside a governed root.
