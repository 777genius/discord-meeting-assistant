---
id: ADR-0003
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0003: Versioned engineering foundation

Status: Accepted

Date: 2026-08-02

## Context

Architecture rules must fail during development and CI rather than depend on
review memory. The reusable engineering foundation provides deterministic pnpm
declaration checks, closed source-dependency evidence, and shared TypeScript and
Oxlint presets without owning product architecture.

## Decision

Use exact `@agent-teams/engineering-foundation` version `0.6.0` as a development-
only registry dependency. Enable `workspace.dependency-declarations`,
`architecture.source-dependencies`, `documentation.local-references`, and
`quality.suppression-governance` through strict YAML configuration. The source
graph uses schema v2 with explicit entrypoints for every boundary, and local
documentation references use GitHub-compatible anchors under `architecture`,
`docs`, and `infra`. Suppression governance starts without a grandfather
allowlist: each future line-scoped exception needs accountable ownership, an
accepted reason, and a bounded expiry.

Adopt `repository.agent-workflow` with repository-owned changed, fast, and full
checks so coding tools share one deterministic preflight contract. Keep the full
`check` command authoritative in CI.

Do not activate the opt-in maintainability presets until the existing source and
test violations are decomposed without a grandfather allowlist. Keep
deterministic scaffolding disabled until a qualified product composition exists;
the built-in composition is a conformance fixture, not a product architecture
template.

Pin Node 24.18, pnpm 11.18, TypeScript 7.0.2, Oxlint 1.76, Nx 23.1.1, ast-grep
0.45, and Knip 6.31 through the strict exact pnpm catalog. CI must prove registry
mode and a frozen lockfile.

Consumer-owned boundary IDs, roots, allowed edges, bounded contexts, ADRs, and
business invariants stay in this repository. Product runtime code never imports
the foundation.

## Consequences

- New source under a governed root fails when it is unclassified or imports an
  undeclared edge.
- Unregistered, broad, stale, expired, or protected-rule suppressions fail the
  Foundation gate.
- Changed-file checks accelerate feedback but never replace the complete CI gate.
- Maintainability budgets become blocking only after the repository passes them
  without permanent exclusions for existing code.
- Foundation upgrades are explicit exact-version changes with full local checks.
- Repository-specific rules remain local rather than leaking into the reusable
  foundation.
