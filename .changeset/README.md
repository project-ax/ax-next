# Changesets

This directory tracks per-package version bumps. Each plugin in `packages/` and each preset in `presets/` version independently (per the v2 architecture: **independent semver per plugin**).

## Adding a changeset

When you make a change that should produce a release, run:

```bash
pnpm changeset
```

It prompts for which packages changed, what severity (patch / minor / major), and a summary. The result is a markdown file in this directory committed alongside your PR.

## Releasing

1. `pnpm version-packages` — consumes all pending changesets, bumps versions, updates changelogs.
2. Review the diff.
3. `pnpm release` — builds and publishes.

## What counts as what

- **Patch** — internal fix, no hook surface change.
- **Minor** — new hook subscription, new optional config field, backward-compatible additions.
- **Major** — any hook-surface breaking change (signature, field rename, removal). Triggers boundary review (see `CLAUDE.md`).

## Why independent semver

A bugfix in `@ax/sandbox-docker` shouldn't bump `@ax/storage-postgres`. Each plugin evolves on its own cadence. Cross-cutting changes that touch many plugins are still one PR (monorepo) but produce one changeset per affected package.
