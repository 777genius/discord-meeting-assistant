# ADR-0003: Versioned engineering foundation

Status: Accepted

Date: 2026-08-02

## Context

Architecture rules must fail during development and CI rather than depend on
review memory. The reusable engineering foundation provides deterministic pnpm
declaration checks, closed source-dependency evidence, and shared TypeScript and
Oxlint presets without owning product architecture.

## Decision

Use exact `@agent-teams/engineering-foundation` version `0.4.1` as a development-
only registry dependency. Enable both `workspace.dependency-declarations` and
`architecture.source-dependencies` through strict YAML configuration.

Pin Node 24.18, pnpm 11.18, TypeScript 7.0.2, Oxlint 1.76, Nx 23.1.1, ast-grep
0.45, and Knip 6.31 through the strict exact pnpm catalog. CI must prove registry
mode and a frozen lockfile.

Consumer-owned boundary IDs, roots, allowed edges, bounded contexts, ADRs, and
business invariants stay in this repository. Product runtime code never imports
the foundation.

## Consequences

- New source under a governed root fails when it is unclassified or imports an
  undeclared edge.
- Foundation upgrades are explicit exact-version changes with full local checks.
- Repository-specific rules remain local rather than leaking into the reusable
  foundation.
