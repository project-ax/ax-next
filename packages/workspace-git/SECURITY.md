# Security — `@ax/workspace-git`

This package is a thin in-process wrapper around `@ax/workspace-git-core`. It exists so single-pod / local-CLI deployments can register the four `workspace:*` service hooks against a local `repoRoot` directly, without going through HTTP. The substantive code — path validation, mutex, blob/tree/commit writes, defensive copies — lives in the core.

## Where the security walk lives

The `security-checklist` walk for everything this package transitively does is in [`@ax/workspace-git-core/SECURITY.md`](../workspace-git-core/SECURITY.md). That file covers all three threat models (sandbox / prompt injection / supply chain) for the actual implementation. Read it; this wrapper adds nothing to that picture.

## What the wrapper itself adds

Almost nothing. `createWorkspaceGitPlugin(config)` builds a `Plugin` whose `init({ bus })` calls `registerWorkspaceGitHooks(bus, { repoRoot: config.repoRoot })`. The `repoRoot` config string is passed straight through; the wrapper doesn't read it, validate it, or store it elsewhere.

The only thing this wrapper "owns" from a security standpoint is the manifest — it declares the four hooks the core registers (`workspace:apply`, `workspace:read`, `workspace:list`, `workspace:diff`) so the kernel knows what surface this plugin exposes. The manifest doesn't grant capability; it documents it.

## Known limits

- **Unique writer per `gitdir`.** This wrapper assumes the host process is the unique writer to `<repoRoot>/repo.git`. That's trivially true for the local-CLI case (one process, one repo). If you point two host processes at the same `repoRoot`, the in-process mutex inside the core stops being sufficient and you'll get races. Use `@ax/workspace-git-http` (multi-replica deployments) instead.
- All other limits live with the implementation. See the core's SECURITY.md.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
