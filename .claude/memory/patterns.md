# Patterns

## Patterns (do these)

- `2026-04-23` — When adding a new service hook, fill in the boundary-review block in the PR description (alternate impl / leaky field names / subscriber risk / wire surface). If you can't name an alternate impl, it probably shouldn't be a hook yet.
- `2026-04-23` — When scaffolding a plugin that touches fs/net/process/untrusted input, drop a `SECURITY.md` in the package directory at scaffold time, not later. Week 3's `packages/storage-sqlite/SECURITY.md` is the template.
- `2026-04-23` — For ESM "am I the main module?" checks, use `import { pathToFileURL } from 'node:url'` and compare `import.meta.url === pathToFileURL(process.argv[1]).href`. `require.main === module` doesn't exist under ESM.

## Anti-Patterns (don't do these)

- `2026-04-23` — Don't put backend-specific field names in hook payloads (`sha`, `bucket`, `pod_name`, `table`, `rowid`). If the name only makes sense for one impl, rename before subscribers depend on it.
- `2026-04-23` — Don't land "we'll wire it later" infrastructure. Either a live caller reaches it in the same PR or it doesn't merge. Symmetric API pairs (`get`/`set`) with a documented near-term consumer are the narrow exception.
