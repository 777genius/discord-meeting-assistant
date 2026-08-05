# Suppression governance

Inline lint, type, and structural suppressions are temporary architecture
exceptions, not an alternative rule system. Every JavaScript or TypeScript
source file below `apps`, `packages`, or `tooling` is governed by Foundation's
`quality.suppression-governance` capability.

## Default policy

- Fix the diagnostic instead of suppressing it.
- File-wide, region-wide, unscoped ESLint, `@ts-ignore`, and `@ts-nocheck`
  directives are prohibited.
- Security, tenancy, tenant-isolation, architecture, and ambient clock,
  environment, randomness, or timer rules are not waivable.
- An allowed exception must suppress exact rule IDs on one line and have one
  matching entry in `architecture/foundation/suppression-governance.yaml`.
- A waiver must name an accountable repository owner, explain why an immediate
  fix is unsafe, reference an accepted decision or tracked remediation, and
  expire no later than 90 days after creation.
- Removing the source directive and its waiver is one change. Stale or expired
  waivers fail the Foundation gate.

## Review procedure

Before adding a waiver, record why changing the code would violate a stronger
invariant and obtain architecture review. Use a stable uppercase waiver ID,
repository-relative path, exact line and directive, exact rule list, owner,
reason, UTC creation and expiry dates, and a non-whitespace decision reference.

`waivers` remains empty while the repository has no approved exceptions. The
complete `pnpm run foundation:check` gate is authoritative.

## Python source

Foundation 0.6.0 discovers JavaScript and TypeScript source extensions only.
Python runtime source therefore uses separate Ruff, Pyright, Pytest, and import
boundary gates. Python suppression comments are prohibited unless equivalent
repository-owned governance is introduced by an accepted architecture decision.
