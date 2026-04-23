# Mistakes

One entry per mistake. Graduates to `## Resolved` after two subsequent sessions avoid it. Never deleted.

- `2026-04-23` — **Shebang alone isn't enough for `pnpm exec` / direct invocation.** `@ax/cli` `dist/main.js` had `#!/usr/bin/env node` but was not executable; `pnpm exec ax-next` failed. Fix: `chmod +x dist/main.js` in the postbuild script (commit 3488654). Next time: when scaffolding a CLI package, add the chmod to postbuild at scaffold time.
- `2026-04-23` — **`require.main === module` doesn't work in ESM.** `@ax/cli` main-module guard misfired under ESM. Fix: use `pathToFileURL(process.argv[1]).href === import.meta.url` (commit 87246cc). Next time: any ESM entry-point pattern uses `pathToFileURL`, not CJS idioms.
- `2026-04-23` — **kysely `^0.27.4` pulled GHSA-wmrf / GHSA-8cpq advisories.** Bumped to `^0.28.14` post-merge (commit 957288b). Next time: before pinning a new dep, run `pnpm audit` or check `npm view <pkg> --json` for advisories on the target version range, not just latest.
