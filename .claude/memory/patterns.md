# Patterns

## Patterns (do these)

- `2026-04-23` — When adding a new service hook, fill in the boundary-review block in the PR description (alternate impl / leaky field names / subscriber risk / wire surface). If you can't name an alternate impl, it probably shouldn't be a hook yet.
- `2026-04-23` — When scaffolding a plugin that touches fs/net/process/untrusted input, drop a `SECURITY.md` in the package directory at scaffold time, not later. Week 3's `packages/storage-sqlite/SECURITY.md` is the template.
- `2026-04-23` — For ESM "am I the main module?" checks, use `import { pathToFileURL } from 'node:url'` and compare `import.meta.url === pathToFileURL(process.argv[1]).href`. `require.main === module` doesn't exist under ESM.
- `2026-04-29` — When reading a Claude Agent SDK jsonl by sessionId, glob `<HOME>/.claude/projects/*/<sessionId>.jsonl` rather than reconstructing the encoded-cwd directory. The SDK encodes `realpath(cwd)`, not the literal cwd, so any symlink (e.g. macOS `/var` → `/private/var`) breaks reconstruction. SessionId is unique across project dirs.
- `2026-04-29` — When parsing SDK jsonl, whitelist turn-bearing entry types (`user`/`assistant`/`tool`) rather than blacklisting bookkeeping types. The SDK adds new bookkeeping kinds (`queue-operation`, `last-prompt`, `attachment`) over time; a blacklist drifts.
- `2026-05-03` — When a PR wires a new plugin into the k8s preset, the chart-shape test (`deploy/charts/ax-next/__tests__/env-shape.test.ts`) is the contract that catches missed env-var stamping. The test scans `presets/k8s/src/index.ts` for `env.*` reads and asserts both directions against the rendered deployment. Run it; if it fails, the chart's env block is incomplete — fix in the same PR.
- `2026-05-03` — Subcommands that need an HTTP front door should register routes via `http:register-route` against `@ax/http-server`, not spin up their own `http.createServer`. Mirror the channel-web / auth-oidc / teams pattern: a plugin with `manifest.calls: ['http:register-route']`, routes registered in `init()`. Multiple listeners on the same pod cause `EADDRINUSE` collisions and bypass the http-server's CSRF / body-cap subscribers.

## Anti-Patterns (don't do these)

- `2026-04-23` — Don't put backend-specific field names in hook payloads (`sha`, `bucket`, `pod_name`, `table`, `rowid`). If the name only makes sense for one impl, rename before subscribers depend on it.
- `2026-04-23` — Don't land "we'll wire it later" infrastructure. Either a live caller reaches it in the same PR or it doesn't merge. Symmetric API pairs (`get`/`set`) with a documented near-term consumer are the narrow exception.
