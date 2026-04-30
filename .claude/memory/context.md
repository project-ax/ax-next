# Project context

Confirmed facts about ax-next. Not opinions.

- `2026-04-23` — `@ax/cli` is the only package allowed to import sibling plugins; enforced by `eslint.config.mjs` exception. All other inter-plugin communication goes through the hook bus.
- `2026-04-23` — Storage hook payload contract is `{ key: string, value: Uint8Array }` — opaque bytes, no backend vocab. Any `table`/`bucket`/`rowid` field would leak.
- `2026-04-23` — pnpm 10 requires `pnpm.onlyBuiltDependencies` allowlist for packages with postinstall scripts (e.g. `better-sqlite3` prebuild-install). Without the allowlist, the build silently skips the postinstall and the package fails to load at runtime.
- `2026-04-23` — E2E tests invoke the CLI as `node dist/main.js <args>`, not `pnpm exec ax-next`. Shebang + `chmod +x` are present but tests use node directly to avoid pnpm bin-link flakiness.
- `2026-04-23` — Week 3 shipped as PR #2 (merged). Week 1–2 kernel shipped as PR #1.
- `2026-04-29` — Claude Agent SDK 0.2.119 encodes the project-dir name as `realpath(cwd)` with `/` → `-`, NOT the literal cwd string. On macOS `/var/...` becomes `-private-var-...`. Don't reconstruct the path; glob `<HOME>/.claude/projects/*/<sessionId>.jsonl`.
- `2026-04-29` — SDK 0.2.119 with `settingSources: []` still writes outside `<HOME>/.claude/projects/`: `<HOME>/.claude.json` (~20KB cache: GrowthBook flags, anon userID, migrationVersion, model-cost cache), `<HOME>/.claude/backups/.claude.json.backup.<ts>` (accumulates per spawn), `<HOME>/.claude/policy-limits.json`. None are secrets, but workspace persistence should ignore everything outside `.claude/projects/`.
- `2026-04-29` — SDK 0.2.119 jsonl entry types include non-turn records: `queue-operation`, `last-prompt`, `attachment` (e.g. `skill_listing` injected by the SDK even with `settingSources: []`). A `runner:read-transcript` parser must whitelist `user`/`assistant`/`tool`, not blacklist.
- `2026-04-29` — ax-next has no production data and never will need a schema migration that preserves rows. Existing `_v1` table suffixes (`conversations_v1_*`, `audit_v1_*`) are stable identifiers, NOT version pointers. ALTER TABLE in place is correct for every schema change; no v1→v2 split, ever. (See decisions.md 2026-04-29 entry.)
