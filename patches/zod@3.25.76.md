# zod 3.25.76: bounded issue lists

`zod@3.25.76` is patched for
[GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
A collection schema builds one issue object per failing element, so one large
untrusted payload can exhaust memory. zod 3 has no fixed release (TASK-938).

## What the patch changes

zod 3.25.76 ships two engines. Both are patched, in their ESM (`.js`) and
CommonJS (`.cjs`) builds.

- **The v3 API** (`import { z } from 'zod'`), which every ax-next package uses.
  `addIssueToContext` (`v3/helpers/parseUtil`) stops adding issues once an issue
  list holds 100. `ZodUnion` (`v3/types`) copies a near-miss option's issues
  only up to the same cap. An array over its `.max()` or `.length()`, or a set
  over its `.max()` or `.size()`, now reports only the size issue and does not
  parse its elements. That is upstream zod 4.6.6's behaviour
  ([PR #6652](https://github.com/colinhacks/zod/pull/6652), commit
  `a0ebf970f2d752e5f58527cd2942ff48be4f46bd`).
- **The zod 4 core under `zod/v4`** (`v4/core/schemas`), which
  `@modelcontextprotocol/sdk` uses to parse what remote MCP and OAuth servers
  send. Arrays, tuple rests, records, object catchalls, maps and sets stop
  taking their elements' issues once they hold 100. When the cap drops a hard
  failure (a wrong type, not a soft check like `.min()`), the collection still
  counts as aborted, so no later `.refine()`, `.transform()` or `.pipe()` reads
  input that failed validation. Upstream's `capSize` does the same.

The first issue always lands, so a failed parse is still a normal `ZodError`
and `safeParse` still returns `success: false`. Valid input parses exactly as
before. A parse with 100 issues or fewer reports exactly what it did before.

The cap goes further than upstream. zod 4.6.6 and later stop early only for
collections that declare a size limit. An unbounded `z.array()` still builds an
issue per failing element there, and most of our untrusted arrays have no
`.max()`.

`src/*.ts` in the package is not patched. Node never loads it: it is reachable
only through the `@zod/source` export condition, which nothing in this repo sets.

## How it is guarded

`pnpm audit` checks version numbers and cannot see a local patch, so
`GHSA-mrhx-c7xc-m3w5` stays in `pnpm.auditConfig.ignoreGhsas`. Two tests make
that safe, and CI runs both on every PR.

- `scripts/__tests__/zod-issue-bound.test.js` loads the installed copy the way
  three boundary packages do (HTTP, IPC and MCP), in all four flavors (`zod`
  and `zod/v4`, ESM and CommonJS), and checks the cap. Two child processes
  parse 1,000,000 bad elements inside a 96 MB heap. It fails on an unpatched
  3.25.76.
- `scripts/__tests__/zod-audit-exception.test.js` checks three things: the
  patch is registered, every zod 3 in the tree is this one 3.25.76 directory,
  and every zod 4 is at 4.6.6 or later.

The patch adds no install script, no dependency and no network access.

## When to remove it

Remove the patch once no package uses zod 3 and nothing resolves `zod/v4` from
it. Remove its `patchedDependencies` entry, the audit exception and the
exception-specific assertions with it. Moving to zod 4 alone does not bring the
cap with it, so keep explicit `.max()` limits on untrusted arrays, or carry an
equivalent patch.

Not covered here:

- zod 4.6.7 keeps upstream behaviour. It comes in through `ai`, `@ai-sdk/*`,
  better-auth and the AI-SDK runner's MCP SDK.
- `@anthropic-ai/claude-agent-sdk` bundles its own zod in `sdk.mjs`.
- The cap is per issue list, not per parse. A plain `z.union` gives each option
  its own list and keeps every option's list when they all fail, so unions
  nested inside collections multiply the bound: about 30,000 issues at two
  levels with 100 elements each, and roughly 3 million at three levels. Nothing
  we parse today nests that way (no `z.lazy`, and our untrusted schemas use
  discriminated unions, which share one list). Don't build deep plain-union
  nesting on untrusted input.
- `dem-memory/` is a standalone research project outside the pnpm workspace.
  It installs its own unpatched zod 3.25.76 from its own `package-lock.json`.
  Neither guard can see it, no workspace package depends on it, and it isn't
  in any image.
