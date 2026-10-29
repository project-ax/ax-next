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
  only up to the same cap. Once its parent issue list is full, it no longer
  collects branch-error trees (TASK-963, synchronous and async paths). An
  array over its `.max()` or `.length()`, or a set
  over its `.max()` or `.size()`, now reports only the size issue and does not
  parse its elements. That is upstream zod 4.6.6's behaviour
  ([PR #6652](https://github.com/colinhacks/zod/pull/6652), commit
  `a0ebf970f2d752e5f58527cd2942ff48be4f46bd`). An oversized collection now
  aborts the parse, so a `.refine()` or `.superRefine()` on it, or on any schema
  that contains it, no longer runs. A union with such an option now fails as
  `invalid_union` instead of adopting that option's `too_big`. The parse still
  fails either way.
- **The zod 4 core under `zod/v4`** (`v4/core/schemas`), which
  `@modelcontextprotocol/sdk` uses to parse what remote MCP and OAuth servers
  send. Arrays, tuples, records, objects (declared keys and catchall), maps and
  sets stop taking their elements' issues once they hold 100. The sync JIT path
  for declared object keys is not capped; it is bounded by the schema's own
  shape, so a sync parse can report a few more issues than an async one.
- When the v4 cap drops a hard failure (a wrong type, not a soft check like
  `.min()`), the collection still counts as aborted. Upstream's `capSize` does
  the same. So a `.refine()`, `.transform()` or `.pipe()` never reads input that
  failed with a hard error. After soft failures only, they still run, exactly
  as unpatched.

The first issue always lands, so a failed parse is still a normal `ZodError`
and `safeParse` still returns `success: false`. Valid input parses exactly as
before. Apart from the size short-circuit above, a parse with 100 issues or
fewer reports exactly what it did before.

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
- `scripts/__tests__/zod-audit-exception.test.js` checks the patch registration,
  the single installed 3.25.76 directory, the zod 4 security floor and the v3
  schema API in workspace and standalone research manifests.

The patch adds no install script, no dependency and no network access.

## When to remove it

Remove the patch once no package uses zod 3 and nothing resolves `zod/v4` from
it. Remove its `patchedDependencies` entry, the audit exception and the
exception-specific assertions with it. Moving to zod 4 alone does not bring the
cap with it. The explicit `.max()` limits on our untrusted lists (TASK-945)
replace the cap only for the lists they sit on. A list nested inside another
list's elements, like `tool_result.content` inside a turn's content blocks, is
then bounded only by the 4 MiB frame. Bound those another way before removing
the patch, or carry an equivalent one.

Not covered here:

- zod 4.6.7 keeps upstream behaviour. It comes in through `ai`, `@ai-sdk/*`,
  better-auth and the AI-SDK runner's MCP SDK. Since TASK-944, the runner
  validates `tools/call` results with the SDK's loose `ResultSchema` and caps
  every connector answer (8 MiB for `tools/call`, 2 MiB otherwise). Its
  Since TASK-962, `tools/list` pages must also fit 16,384 values and 32
  container levels before the SDK's schema runs. Output-schema validation
  stops on the first error, and model-stream events are capped at 2 MiB.
  These bound the known remote-input paths without patching that Zod copy.
- `@anthropic-ai/claude-agent-sdk` bundles its own zod in `sdk.mjs`.
- The cap is per issue list, not per parse. A plain `z.union` gives each option
  its own list and keeps every option's list when they all fail, so unions
  nested inside collections multiply the bound. One level of that reaches
  untrusted input: `tool_result.content` (a string or an array) inside every
  content-block list (`event.turn-end`, `event.chat-end`,
  `POST /api/chat/messages`). At that one level we measured 10,200 retained
  issues and a 3.2 MB `error.message` for a 25 KB turn-end before TASK-963,
  and about 0.5 s of CPU for a
  4 MiB frame whose junk is spread over 16,000 blocks. A second level
  multiplies it again: about 1,000,000 issues and a 370 MB message from 2 MB
  of input, with 100 elements per list. Don't add a second level of
  plain-union nesting on untrusted input. IPC now returns a bounded code/path
  summary without serializing `ZodError.message`. The new v3 guard avoids
  discarded branch trees after the parent fills; this is still not a single
  global issue budget for an entire nested parse.
- `dem-memory/` is a standalone research project outside the pnpm workspace.
  It installs its own unpatched zod 3.25.76 from its own `package-lock.json`.
  Its manifest is checked for v3 API compatibility. Its separate npm install
  is not inspected by the workspace's issue-cap or installed-version checks.
  No workspace package depends on it, and it isn't in any image.
