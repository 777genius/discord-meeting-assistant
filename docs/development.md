# Development

[Documentation](README.md) · [Botik](../README.md)

Use Node.js `24.18.0` and pnpm `11.18.0`:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

For faster feedback use `pnpm run check:changed` while editing and
`pnpm run check:fast` before handoff. Read the
[dependency rules](architecture/dependency-rules.md) before changing code.
