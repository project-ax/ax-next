# Project context

Confirmed facts about ax-next. Not opinions.

- `2026-04-23` — `@ax/cli` is the only package allowed to import sibling plugins; enforced by `eslint.config.mjs` exception. All other inter-plugin communication goes through the hook bus.
- `2026-04-23` — Storage hook payload contract is `{ key: string, value: Uint8Array }` — opaque bytes, no backend vocab. Any `table`/`bucket`/`rowid` field would leak.
- `2026-04-23` — pnpm 10 requires `pnpm.onlyBuiltDependencies` allowlist for packages with postinstall scripts (e.g. `better-sqlite3` prebuild-install). Without the allowlist, the build silently skips the postinstall and the package fails to load at runtime.
- `2026-04-23` — E2E tests invoke the CLI as `node dist/main.js <args>`, not `pnpm exec ax-next`. Shebang + `chmod +x` are present but tests use node directly to avoid pnpm bin-link flakiness.
- `2026-04-23` — Week 3 shipped as PR #2 (merged). Week 1–2 kernel shipped as PR #1.
