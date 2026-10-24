# TASK-938 "Patch zod 3 against GHSA-mrhx-c7xc-m3w5" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failing zod parse stops collecting issues at 100 in every engine zod 3.25.76 ships, so one large untrusted payload can no longer allocate an issue object per element. The audit ignore stays, and two guards make it safe.

**Architecture:** One `pnpm patch` of zod@3.25.76, registered in the root `package.json` `pnpm.patchedDependencies`, changes six built files, ESM and CommonJS. The v3 API (`zod`, used by all ~49 of our packages) caps each issue list at 100 in `addIssueToContext` and in `ZodUnion`'s near-miss copy. It also gets zod 4.6.6's size short-circuit: an array over `.max()`/`.length()`, or a set over `.max()`/`.size()`, reports only the size issue. The zod 4 core under `zod/v4` is what `@modelcontextprotocol/sdk` uses on remote MCP and OAuth responses; there, every collection stops taking element issues at 100. A new scripts-suite test loads the installed copy the way three boundary packages do and checks the cap, including in two 96 MB-heap child processes. The existing audit guard pins the patch.

**Tech Stack:** pnpm 10.33.2 (`pnpm patch` / `pnpm patch-commit`), zod 3.25.76 (the v3 API plus the embedded zod 4.0 core), vitest 5 (`pnpm test:scripts` = `vitest run --root scripts`), Node 24.

**Spec:** the TASK-938 card body (dispatch file `/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/386b12a8-02d6-45fd-a50d-1e78eb04cac6/scratchpad/dispatch/card-938.md`) and `.claude/memory/decisions/2026-10-23-TASK-938.md`. Rows 1–2 there come from deps PR #1025; the "TASK-938 plan" rows are this plan's decisions. Read them before Task 2. Every number below marked MEASURED was measured by the planner at 15f71a4d5 (darwin, node 24.19.0), against the installed packages and a scratchpad copy of the patched package. `node_modules` was only read, never edited.

**Validated artifacts (byte-identical to the blocks in this plan):** `/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/386b12a8-02d6-45fd-a50d-1e78eb04cac6/scratchpad/TASK-938-planner/`:

| File | sha256 |
|---|---|
| `zod-3.25.76-TASK-938.diff` | `e709ded198c67afe0120d7945491d04933f05622ab04d9d531e4bb169bb82a18` |
| `zod-issue-bound.test.js` | `a35467697d41d9cb70e71920b7055975c9536f3d3d386c1366c00699110c1c5e` |
| `zod-audit-exception.test.js` | `5ab9957aeb70c4453c537bb1b290971f28146745da13a4a39bad94dcb688c45f` |
| `mutate.mjs` | the planner's mutation harness; it needs the planner's scratch layout, so treat it as a record and don't run it |

## Global Constraints

- **Worktree:** every command runs in `/Users/vpulim/dev/ai/ax-next/.claude/worktrees/agent-a46e6c9b4f90b3c4d`. Run git one command at a time (no `&&` chains) and spell paths out literally.
- **Never hand-edit** `pnpm-lock.yaml`, anything under `node_modules/`, or `patches/zod@3.25.76.patch`. pnpm writes all three (`pnpm patch-commit`). To change the patch, run `pnpm patch zod@3.25.76` again: once a patch is registered, pnpm starts the edit directory from the patched files. Edit, then `pnpm patch-commit` again. A leftover non-empty `node_modules/.pnpm_patches/zod@3.25.76` makes `pnpm patch` fail with `EDIT_DIR_NOT_EMPTY`; delete it first.
- **Exactly six files are patched**, all built JavaScript: `v3/helpers/parseUtil.js`, `v3/helpers/parseUtil.cjs`, `v3/types.js`, `v3/types.cjs`, `v4/core/schemas.js`, `v4/core/schemas.cjs`. Never `src/*.ts`. Node never loads it, because it is reachable only under the `@zod/source` export condition, and nothing in this repo sets that (grepped).
- **The cap is 100 everywhere**: `MAX_ISSUES` in the patch and `CAP` in the test.
- **Single-file test runs:** `pnpm test:scripts <name>`, with no `--` (vitest's positional filter). Check that the summary line says `Test Files 1 …`.
- **TDD:** Task 1's test goes in red before Task 2's patch. Its failures must be the ones listed in Task 1 Step 2.
- **No Docker** for Tasks 1–4. The final gate needs it (Before the PR).
- **Memory:** shards only (`scripts/memory-write-target.sh --shard <kind> TASK-938`). Never touch a root `.claude/memory/*.md`, and never add a `Memory-Rewrite:` trailer. The planner's shard rows cite this plan and `scripts/__tests__/zod-issue-bound.test.js`. MEASURED: those are `memory-cited-paths-exist.test.js`'s only two findings now. It goes green once this plan is committed and Task 1 has created the test. Don't chase that red before then.
- **Voice:** comments and the notes file are about a real vulnerability, so keep them plain and direct, with no jokes (CLAUDE.md voice rules).

## Review Focus

These are the inputs a broken patch would most likely mishandle. Each one is pinned in Task 1, per flavor (`zod`/`zod/v4` × ESM/CJS × 3 consumers). The patched code is the cause in either direction, so a reviewer should check these first.

1. **A large valid payload must still parse, whole.** `accepts a large good array whole, and still reports a failure that comes last`: 20,000 good strings parse with `success: true`.
2. **A late failure must still be reported at its path** after thousands of good elements. Same test: one issue at path `[20000]`.
3. **`.catch()` must recover every element, however many fail.** A catch scope gets its own issue list, so the cap can never reach into it. Pinned by `lets every .catch() element recover, however many fail`.
4. **A union option that fills its own list must fail as one `invalid_union`.** Never the zod 3 throw `Validation failed but no issues detected`, never a success. Pinned by `fails a union whose option filled its own issue list with one invalid_union, not a throw`. This is why the cap is per list and not one budget for the whole parse.
5. **The error message must stay small**, because every ipc-core handler echoes `${parsed.error.message}` into its 400 body (`packages/ipc-core/src/errors.ts`). Pinned by `keeps the error message small`: under 32 KiB. MEASURED: 16.9 KB patched, 3.4 MB unpatched, for 20,000 bad elements.

## Where this plan departs from the card

Each departure is a decisions row. Say so in the PR description.

- **"Only zod 4.6.6 fixes it" and "longer term, zod 4 is the real fix" are refuted.** Upstream's fix (commit `a0ebf970f2d752e5f58527cd2942ff48be4f46bd`, PR #6652) checks size bounds before parsing elements. It covers only arrays, maps and sets that declare `.max()`, `.length()` or `.size()`. MEASURED on the installed 4.6.7: `z.array(z.string())` with 200,000 bad elements still returns 200,000 issues and retains 66 MB; with `.max(10)` it returns 1 issue. Most of our untrusted arrays have no `.max()`, so this patch caps issue lists, which goes further than upstream. Mirroring upstream alone would leave them exposed.
- **Scope widens inside the same package.** zod 3.25.76 also ships the zod 4 core under `zod/v4`. `@modelcontextprotocol/sdk` 1.32.1 resolves zod 3.25.76 in `@ax/mcp-client` and `@ax/mcp-oauth` and imports `zod/v4`. So the host's MCP tools/list inventory and OAuth sign-in parse remote-server responses on that pre-4.6.6 core. MEASURED: `ListToolsResultSchema` with 200,000 bad tools reaches 189 MB of heap; `CallToolResultSchema` with 200,000 bad content blocks reaches 1,041 MB. The audit ignore covers the whole package, so both engines are patched.
- **The issues are made in `addIssueToContext`, not in `ParseStatus.mergeArray`.** `mergeArray` only folds element statuses. The v3 cap therefore lives in `addIssueToContext`, plus the one place that bypasses it: `ZodUnion` copying a near-miss ("dirty") option's issues.
- **"Pin zod 3 at 3.25.76 exactly" is done by the guard**, not by changing 48 `^3.23.8` manifests or adding an override. The guard checks the registration, that every installed zod 3 is exactly 3.25.76, and that they all resolve to one directory. An override such as `zod@>=3 <4` would fight the existing zod 4 override: `pnpm-lock.yaml` shows that override rewrote peer ranges like `^3.25 || ^4.0` (MCP SDK, zod-to-json-schema) wholesale to `>=4.6.6 <5.0.0`.
- **zod 4.6.7 arrives through more than `@ai-sdk/anthropic`**: also `ai`, `@ai-sdk/*`, the agent-aisdk-runner's MCP SDK, `@anthropic-ai/sdk` in web-tools, and better-auth. This only matters for the corrected comment. That copy keeps upstream semantics and is out of scope.
- **Not every zod 3 is reachable.** `@anthropic-ai/claude-agent-sdk` bundles its own zod inside `sdk.mjs` (sandbox side), so no `node_modules` patch reaches it. It is listed as a residual.
- **Not built here (YAGNI):**
  - an early break out of element loops, and skipping `unionErrors` construction once a list is full. Both are CPU-only, no count-based test can see them, and memory is already bounded;
  - backporting 4.6.6's `capSize` into the v4 core. The MCP SDK has one bounded array (`.max(100)`), and the cap already bounds memory;
  - patching `src/*.ts`;
  - adding `.max()` to our schemas;
  - transport size caps.

  The CPU residual is MEASURED in Appendix B; the follow-ups are listed under Before the PR.

## Card premises, checked (at 15f71a4d5)

- **True:**
  - 49 workspace packages depend on zod 3 directly, and all of them resolve 3.25.76 (`pnpm-lock.yaml` importers). 48 declare `"zod": "^3.23.8"`; `packages/routines-contract` already pins `"3.25.76"`. zod 4.6.7 is also installed.
  - The advisory's vulnerable range is `< 4.6.6`, first patched 4.6.6, GitHub-reviewed 2026-10-23 (CVE-2023-54404).
  - d8cced6cd added the ignore, `scripts/__tests__/zod-audit-exception.test.js` (zod 4 floor only), and the zod entry in the node-forge guard's exact `ignoreGhsas` list.
  - In the v3 API, `ZodArray._parse` adds the `too_big` issue and then still parses every element, so `.max()` protects nothing. MEASURED: 200,001 issues for `.max(10)` over 200,000 bad elements.
  - CI runs `pnpm install --frozen-lockfile`, runs `pnpm test:scripts` unconditionally, and runs `pnpm audit --audit-level moderate` last (`.github/workflows/ci.yml`).
  - Both Dockerfiles `COPY . .`, then run `pnpm install --frozen-lockfile`, then `pnpm deploy --prod --legacy`. `patches/` is not dockerignored.
- **Refuted or corrected:** the departures above. The package has no `lib/`; the files that run are `v3/*.js` (`import`) and `v3/*.cjs` (`require`), resolved through `index.js` and `index.cjs`, and the v4 core is `v4/core/schemas.{js,cjs}`.

## Order and file ownership

| # | Task | Tier | Touches |
|---|---|---|---|
| 1 | The regression test, red first | integration | new `scripts/__tests__/zod-issue-bound.test.js` |
| 2 | The zod 3.25.76 patch | sensitive | new `patches/zod@3.25.76.patch`, `package.json` (one line), `pnpm-lock.yaml`. pnpm generates all three |
| 3 | The audit guard pins the patch; the guards say it exists | mechanical | `scripts/__tests__/zod-audit-exception.test.js`, `scripts/__tests__/node-forge-signature-validation.test.js` (comment) |
| 4 | Patch notes | mechanical | new `patches/zod@3.25.76.md` |

Run the tasks in order, one at a time, in this worktree.

---

### Task 1: The regression test, red first [tier: integration]

The test resolves zod exactly as three boundary packages do: `packages/http-server` (HTTP bodies), `packages/ipc-protocol` (sandbox→host IPC) and `packages/mcp-client` (remote MCP responses). For each, it loads all four flavors from the installed package: `zod` and `zod/v4`, each as ESM and CommonJS. Two child processes, each with a 96 MB heap, then parse 1,000,000 bad elements through `zod` (from `packages/http-server`) and through the MCP SDK's own `ListToolsResultSchema` (from `packages/mcp-client`). The planner validated this file against the unpatched tree and against a scratchpad copy of the patched package. A mutation run reverted each of the 28 patched behaviours (14 per build) one at a time, and every one reddens at least one test.

**Files:**
- Create: `scripts/__tests__/zod-issue-bound.test.js` (text below; byte-identical copy in the validated-artifacts directory).

**Interfaces:**
- Produces: nothing another task imports. `CAP = 100` must equal the patch's `MAX_ISSUES` (Task 2). `CONSUMERS` assumes all three packages keep a direct `zod` 3 dependency, and that `packages/mcp-client` keeps `@modelcontextprotocol/sdk` as a direct dependency.

- [ ] **Step 1: Write the test file.**

```js
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// GHSA-mrhx-c7xc-m3w5: a zod collection schema builds one issue object per
// failing element, so one big untrusted payload can run the process out of
// memory. zod 4.6.6 (upstream a0ebf970) only stops early for collections that
// declare .max(), .length() or .size(); an unbounded z.array() still builds an
// issue per element there. zod 3 has no fixed release at all. So
// patches/zod@3.25.76.patch (TASK-938) caps every issue list at 100 in BOTH
// engines that zod 3.25.76 ships: the v3 API our packages import as `zod`, and
// the zod 4 core under `zod/v4`, which @modelcontextprotocol/sdk uses to parse
// what remote MCP servers send. It also backports 4.6.6's size short-circuit to
// the v3 API. pnpm audit cannot see a local patch, so the advisory stays in
// pnpm.auditConfig.ignoreGhsas; these tests are what make that safe. They run
// against the installed copy, they fail on an unpatched 3.25.76, and CI runs
// this suite on every PR. zod-audit-exception.test.js proves the tree holds one
// zod 3 copy and that the patch is registered.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// MAX_ISSUES in patches/zod@3.25.76.patch.
const CAP = 100;
// 200 times the cap. The memory claim rides on the 1,000,000-element children
// at the bottom; these only have to be far past the cap, and stay fast.
const N = 20_000;
const BAD = Array(N).fill(0);
const BAD_OBJECT = Object.fromEntries(Array.from({ length: N / 4 }, (_, i) => [`k${i}`, 0]));

// Each consumer sits on a trust boundary from the TASK-938 inventory: HTTP
// request bodies, sandbox-to-host IPC, and remote MCP server responses.
const CONSUMERS = ['packages/http-server', 'packages/ipc-protocol', 'packages/mcp-client'];

async function loadZod(consumer) {
  const require = createRequire(join(ROOT, consumer, 'package.json'));
  const manifestPath = require.resolve('zod/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const esm = async (subpath) =>
    (await import(pathToFileURL(join(dirname(manifestPath), manifest.exports[subpath].import)).href)).z;
  return {
    version: manifest.version,
    flavors: [
      ['zod, ESM', await esm('.'), 'v3'],
      ['zod, CJS', require('zod').z, 'v3'],
      ['zod/v4, ESM', await esm('./v4'), 'v4'],
      ['zod/v4, CJS', require('zod/v4').z, 'v4'],
    ],
  };
}

const loaded = await Promise.all(CONSUMERS.map(async (consumer) => [consumer, await loadZod(consumer)]));

for (const [consumer, { version, flavors }] of loaded) {
  describe(`${consumer}: zod stops collecting issues at ${CAP}`, () => {
    it('resolves zod 3.25.76, the version the patch is registered for', () => {
      expect(version).toBe('3.25.76');
    });

    for (const [flavor, z, engine] of flavors) {
      describe(flavor, () => {
        it(`fails ${N} bad array elements with the first ${CAP} issues`, () => {
          const r = z.array(z.string()).safeParse(BAD);
          expect(r.success).toBe(false);
          expect(r.error).toBeInstanceOf(z.ZodError);
          expect(r.error.issues).toHaveLength(CAP);
          expect(r.error.issues[0].path).toEqual([0]);
          expect(r.error.issues[CAP - 1].path).toEqual([CAP - 1]);
        });

        it('caps a record (bad values or bad keys) and an object catchall the same way', () => {
          expect(z.record(z.string(), z.string()).safeParse(BAD_OBJECT).error.issues).toHaveLength(CAP);
          expect(z.record(z.string().regex(/^x/), z.number()).safeParse(BAD_OBJECT).error.issues).toHaveLength(CAP);
          expect(z.object({}).catchall(z.string()).safeParse(BAD_OBJECT).error.issues).toHaveLength(CAP);
        });

        it('caps a tuple rest, a map (bad values or bad keys) and a set the same way', () => {
          const tuple = engine === 'v3' ? z.tuple([z.string()]).rest(z.string()) : z.tuple([z.string()], z.string());
          expect(tuple.safeParse(BAD).error.issues).toHaveLength(CAP);
          const entries = Array.from({ length: N / 4 }, (_, i) => [`k${i}`, i]);
          expect(z.map(z.string(), z.string()).safeParse(new Map(entries)).error.issues).toHaveLength(CAP);
          const badKeys = new Map(entries.map(([key, value]) => [value, key]));
          expect(z.map(z.string(), z.string()).safeParse(badKeys).error.issues).toHaveLength(CAP);
          expect(z.set(z.string()).safeParse(new Set(BAD.map((_, i) => i))).error.issues).toHaveLength(CAP);
        });

        it('caps an array of unions, including one that keeps a near-miss option', () => {
          expect(z.array(z.union([z.string(), z.null()])).safeParse(BAD).error.issues).toHaveLength(CAP);
          const nearMiss = z.array(z.union([z.string().min(5), z.number()]));
          expect(nearMiss.safeParse(Array(N).fill('ab')).error.issues).toHaveLength(CAP);
        });

        it('caps the async parse path, including elements whose check is async', async () => {
          const r = await z.array(z.string()).safeParseAsync(BAD);
          expect(r.success).toBe(false);
          expect(r.error.issues).toHaveLength(CAP);
          const rejectLater = z.string().refine(async () => false);
          expect((await z.array(rejectLater).safeParseAsync(Array(N).fill('x'))).error.issues).toHaveLength(CAP);
          const strings = Object.fromEntries(Object.keys(BAD_OBJECT).map((key) => [key, 'x']));
          expect((await z.record(z.string(), rejectLater).safeParseAsync(strings)).error.issues).toHaveLength(CAP);
          const nearMiss = z.array(z.union([z.string().min(5), z.number()]));
          expect((await nearMiss.safeParseAsync(Array(N).fill('ab'))).error.issues).toHaveLength(CAP);
        });

        it('still reports every issue of a small input, and still accepts a good one', () => {
          const r = z.array(z.string()).safeParse([1, 'a', 2]);
          expect(r.error.issues.map((issue) => issue.path)).toEqual([[0], [2]]);
          expect(z.array(z.string()).safeParse(['a', 'b'])).toEqual({ success: true, data: ['a', 'b'] });
          expect(() => z.array(z.string()).parse([1])).toThrow(z.ZodError);
        });

        it('accepts a large good array whole, and still reports a failure that comes last', () => {
          const good = z.array(z.string()).safeParse(Array(N).fill('x'));
          expect(good.success).toBe(true);
          expect(good.data).toHaveLength(N);
          const late = z.array(z.string()).safeParse([...Array(N).fill('x'), 0]);
          expect(late.error.issues.map((issue) => issue.path)).toEqual([[N]]);
        });

        it('lets every .catch() element recover, however many fail', () => {
          const r = z.array(z.string().catch('fallback')).safeParse(BAD);
          expect(r.success).toBe(true);
          expect(r.data).toHaveLength(N);
          expect(new Set(r.data)).toEqual(new Set(['fallback']));
        });

        it('fails a union whose option filled its own issue list with one invalid_union, not a throw', () => {
          const r = z.union([z.array(z.string()), z.number()]).safeParse(BAD);
          expect(r.success).toBe(false);
          expect(r.error.issues).toHaveLength(1);
          expect(r.error.issues[0].code).toBe('invalid_union');
          const optionIssues = engine === 'v3' ? r.error.issues[0].unionErrors[0].issues : r.error.issues[0].errors[0];
          expect(optionIssues).toHaveLength(CAP);
        });

        it('keeps the error message small (ipc-core echoes it into its 400 body)', () => {
          expect(z.array(z.string()).safeParse(BAD).error.message.length).toBeLessThan(32 * 1024);
        });

        if (engine === 'v3') {
          it('reports only the size issue for an array or set over its .max() or .length()', () => {
            for (const schema of [z.array(z.string()).max(10), z.array(z.string()).length(10)]) {
              const { issues } = schema.safeParse(BAD).error;
              expect(issues).toHaveLength(1);
              expect(issues[0].code).toBe('too_big');
            }
            const set = new Set(Array.from({ length: 10_000 }, (_, i) => i));
            expect(z.set(z.string()).max(10).safeParse(set).error.issues).toHaveLength(1);
          });
        }
      });
    }
  });
}

// Bounded issues have to mean bounded memory. Each child gets a 96 MB heap: the
// patched parse peaks near 35 MB, an unpatched one needs about 250 MB (v3) or
// about 950 MB (the MCP SDK's tools/list schema) and dies with "heap out of
// memory" in well under a second.
function parseInSmallHeap(consumer, code) {
  const stdout = execFileSync(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', code], {
    cwd: join(ROOT, consumer),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 20_000,
  });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

describe('a 1,000,000-element bad payload parses inside a 96 MB heap', () => {
  it('an HTTP or IPC body validated with zod (packages/http-server)', () => {
    const out = parseInSmallHeap(
      'packages/http-server',
      `import { z } from 'zod';
       const r = z.array(z.string()).safeParse(Array(1_000_000).fill(0));
       console.log(JSON.stringify({ success: r.success, issues: r.error?.issues.length }));`,
    );
    expect(out).toEqual({ success: false, issues: CAP });
  });

  it("a remote MCP server's tools/list result (the host's connector inventory, packages/mcp-client)", () => {
    const out = parseInSmallHeap(
      'packages/mcp-client',
      `const { ListToolsResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
       const r = ListToolsResultSchema.safeParse({ tools: Array(1_000_000).fill(0) });
       console.log(JSON.stringify({ success: r.success, issues: r.error?.issues.length }));`,
    );
    expect(out).toEqual({ success: false, issues: CAP });
  });
});
```

- [ ] **Step 2: Run it on the unpatched tree, and watch it fail for the right reasons.** Run: `pnpm test:scripts zod-issue-bound`.
  - Expected: `Test Files 1 failed (1)` and `Tests 92 failed | 39 passed (131)`. MEASURED by the planner: 2.7 s.
  - The 39 passes are 3 × `resolves zod 3.25.76…`, plus 12 each of `still reports every issue of a small input…`, `accepts a large good array whole…` and `lets every .catch() element recover…`. These are semantic guards that must hold both before and after the patch.
  - Every failure must be one of three things:
    - a length assertion such as `expected [ …(20000) ] to have a length of 100`;
    - a message-length assertion;
    - for the two child tests, `Command failed … FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`.
  - A `Cannot find module`, a `TypeError`, or a timeout is a bug in the test, not the expected red. Stop and fix it.
- [ ] **Step 3: Lint.** Run: `pnpm exec eslint scripts/__tests__/zod-issue-bound.test.js`. Expected: exit 0 (the planner checked it through the repo config with `--stdin`).
- [ ] **Step 4: Commit.**
  - `git add scripts/__tests__/zod-issue-bound.test.js`
  - `git commit -m "test: zod collections stop at 100 issues (red until the zod 3.25.76 patch, TASK-938)"`

### Task 2: The zod 3.25.76 patch [tier: sensitive]

**Run `security-checklist`** (Step 7). This is a supply-chain change to a dependency that sits on every untrusted-input path in the host.

**Files** (pnpm generates all three; never hand-edit them):
- Create: `patches/zod@3.25.76.patch`.
- Modify: `package.json`. `pnpm.patchedDependencies` gains `"zod@3.25.76": "patches/zod@3.25.76.patch"` after the node-forge entry. pnpm 10.33.2 writes it here because the root manifest already has a `pnpm` field, not to `pnpm-workspace.yaml`.
- Modify: `pnpm-lock.yaml`. It gains `patchedDependencies` → `zod@3.25.76` with its hash, and every `zod@3.25.76` reference becomes `zod@3.25.76(patch_hash=…)`.

**Interfaces:**
- Consumes: Task 1's test, which this task turns green.
- Produces: `const MAX_ISSUES = 100;` (module-private) in the six patched files, and the `patchedDependencies` key Task 3 asserts. The behaviour is in Appendix A.
  - **v3 API:**
    - `addIssueToContext` returns early once `ctx.common.issues.length >= 100`.
    - `ZodUnion` copies a dirty option's issues only up to the cap, in both the sync and async paths.
    - `ZodArray` returns `INVALID` right after its size issue when `length > exactLength` or `length > maxLength`; `ZodSet` does the same when `size > maxSize`.
  - **v4 core:** `handleArrayResult`, `handleObjectResult`, `handleTupleResult`, `handleSetResult`, `handleMapResult` (key and value) and `$ZodRecord`'s three pushes (invalid key, async value, sync value) skip their push once the container holds 100.

- [ ] **Step 1: Get the diff.** Use `/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/386b12a8-02d6-45fd-a50d-1e78eb04cac6/scratchpad/TASK-938-planner/zod-3.25.76-TASK-938.diff`. `shasum -a 256` on it should print `e709ded198c67afe0120d7945491d04933f05622ab04d9d531e4bb169bb82a18`. If that file is gone, copy Appendix A's block, everything between the fences, into a file in your scratchpad. Step 3's checks are the real gate.
- [ ] **Step 2: Open the edit directory.** Run: `pnpm patch zod@3.25.76`. Expected: it prints an edit directory, `node_modules/.pnpm_patches/zod@3.25.76`.
- [ ] **Step 3: Apply the diff and check it.**
  - Run: `patch -p1 -d node_modules/.pnpm_patches/zod@3.25.76 < <the diff file>`. Expected: six `patching file …` lines, no `FAILED`, and no `Hunk #… succeeded at … (offset …)` or `fuzz`. The planner applied it this way to a fresh copy of the package and got a byte-identical result.
  - Then `find node_modules/.pnpm_patches/zod@3.25.76 -name '*.orig' -o -name '*.rej'` prints nothing.
  - Then `grep -c 'ax-next patch (GHSA-mrhx-c7xc-m3w5' node_modules/.pnpm_patches/zod@3.25.76/v3/types.js` prints `5`, and the same for `v3/types.cjs`. `v3/helpers/parseUtil.js`, `v3/helpers/parseUtil.cjs`, `v4/core/schemas.js` and `v4/core/schemas.cjs` each print `1`.
- [ ] **Step 4: Commit the patch through pnpm, then check what it wrote.**
  - Run: `pnpm patch-commit node_modules/.pnpm_patches/zod@3.25.76`. It writes the patch file, edits `package.json`, and runs an install.
  - `git status --short`: only `M package.json`, `M pnpm-lock.yaml` and `?? patches/zod@3.25.76.patch`, plus this plan and its shard if they aren't committed yet.
  - `git diff package.json`: the new `"zod@3.25.76": "patches/zod@3.25.76.patch"` line, plus a comma after the node-forge entry. pnpm rewrites the manifest itself; if it reformatted anything else, put that back and keep only the new line.
  - `grep -c 'ax-next patch (GHSA-mrhx-c7xc-m3w5' patches/zod@3.25.76.patch` prints `14`.
  - `ls node_modules/.pnpm | grep '^zod@'` lists exactly `zod@3.25.76_patch_hash=<hash>` and `zod@4.6.7`. No bare `zod@3.25.76` remains.
  - `pnpm install --frozen-lockfile` exits 0.
- [ ] **Step 5: Turn Task 1 green.** Run: `pnpm test:scripts zod-issue-bound`. Expected: `Tests 131 passed (131)`. MEASURED on the prototype: ~3 s.
- [ ] **Step 6: Prove the deployed tree carries the patch.** This is what both Dockerfiles run, and nothing has ever checked it, not even for node-forge.
  - Run `pnpm build`, then `pnpm --filter @ax/cli deploy --prod --legacy <your scratchpad>/deploy-938`.
  - `ls <your scratchpad>/deploy-938/node_modules/.pnpm | grep '^zod@3'` prints exactly one line, `zod@3.25.76_patch_hash=…`.
  - `grep -c 'ax-next patch (GHSA-mrhx-c7xc-m3w5'` on that directory's `node_modules/zod/v3/types.js` prints `5`, and on `node_modules/zod/v4/core/schemas.js` prints `1`.
  - The same mechanism carries node-forge's patch: `grep -c 'CVE-2026-85393'` on `<your scratchpad>/deploy-938/node_modules/.pnpm/node-forge@1.4.0_patch_hash=*/node_modules/node-forge/lib/rsa.js` prints `1`.
  - From `<your scratchpad>/deploy-938` (`@ax/cli` depends on zod directly), run:
    `node --max-old-space-size=96 --input-type=module -e "import { z } from 'zod'; console.log(z.array(z.string()).safeParse(Array(1e6).fill(0)).error.issues.length)"`
    It prints `100`.
  - Delete `deploy-938`.
  - INFERRED, not measured: pnpm 10.33.2's legacy deploy runs `install.handler` with the workspace options, and those carry `patchedDependencies`. **If the deployed tree has no patched zod, stop and escalate:** the image would ship unpatched zod and unpatched node-forge.
- [ ] **Step 7: `security-checklist`.** Walk the three threat models and keep the note for the PR (Before the PR lists what it must cover).
- [ ] **Step 8: Commit.**
  - `git add patches/zod@3.25.76.patch package.json pnpm-lock.yaml`
  - `git commit -m "deps: patch zod 3.25.76 so a failing collection stops at 100 issues (GHSA-mrhx-c7xc-m3w5, TASK-938)"`

### Task 3: The audit guard pins the patch; the guards say it exists [tier: mechanical]

This fixes the stale line that made the card look true. `scripts/__tests__/zod-audit-exception.test.js:5-7` says the advisory "is fixed only in zod 4.6.6". That holds only for size-bounded collections.

**Files:**
- Modify: `scripts/__tests__/zod-audit-exception.test.js`. Replace the whole file with the text below (byte-identical copy in the validated-artifacts directory). The zod 4 floor check keeps its name and its logic; only the `pnpm list` walk moves into a shared, memoised helper so the file lists once. The new test is `keeps every installed zod 3 at the one patched 3.25.76`.
- Modify: `scripts/__tests__/node-forge-signature-validation.test.js:57-59`, the comment above the `auditConfig` assertion. The assertion itself is unchanged, because the ignore list is unchanged.

**Interfaces:**
- Consumes: the `patchedDependencies` key from Task 2, and `pnpm list -r --depth Infinity --json`, whose dependency nodes carry `version` and `path`. MEASURED on this tree: 93 zod references, every one with a `path`; the 89 for zod 3 resolve to one directory.

- [ ] **Step 1: Replace the audit guard.**

```js
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6): a collection schema builds one issue per
// failing element, so one big untrusted payload can exhaust memory. The 4.6.6
// fix (upstream a0ebf970) only makes .max(), .length() and .size() reject an
// oversized collection before its elements are parsed. An unbounded z.array()
// still builds one issue per bad element in 4.6.6 and later.
//
// Our own packages are on zod 3.25.76, which has no fixed release, so
// patches/zod@3.25.76.patch (TASK-938) bounds it locally. Every issue list
// stops at 100, in both engines the package ships (`zod`, and the zod 4 core
// under `zod/v4` that @modelcontextprotocol/sdk uses), and the v3 API gets
// 4.6.6's size short-circuit. zod-issue-bound.test.js proves the installed copy
// is bounded. pnpm audit checks version numbers and cannot see a local patch,
// so the advisory stays in pnpm.auditConfig.ignoreGhsas (Vinay's call,
// 2026-10-23).
//
// That ignore covers every zod version. This file makes sure it hides nothing
// else: the patch is registered, every zod 3 in the tree is that one patched
// 3.25.76, and every zod 4 is at 4.6.6 or later (the package.json override).
const root = fileURLToPath(new URL('../../', import.meta.url));

let installed;
function installedZods() {
  if (installed) return installed;
  const out = execFileSync('pnpm', ['list', '-r', '--depth', 'Infinity', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const projects = JSON.parse(out);
  const seen = new Set();
  const zods = [];
  const walk = (deps) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      const key = `${name}@${info?.version}`;
      if (name === 'zod') zods.push({ version: info.version, path: info.path });
      if (seen.has(key)) continue;
      seen.add(key);
      walk(info?.dependencies);
    }
  };
  for (const p of projects) {
    walk(p.dependencies);
    walk(p.devDependencies);
  }
  installed = zods;
  return zods;
}

it('keeps every installed zod 4 at 4.6.6 or later while the zod advisory is ignored', () => {
  const zods = installedZods();
  // A listing that found no zod at all would make the check vacuous.
  expect(zods.length).toBeGreaterThan(0);
  const below = [...new Set(zods.map(({ version }) => version))].filter((v) => {
    const [major, minor, patch] = v.split('.').map(Number);
    return major === 4 && (minor < 6 || (minor === 6 && patch < 6));
  });
  expect(below).toEqual([]);
});

it('keeps every installed zod 3 at the one patched 3.25.76', () => {
  const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  expect(manifest.pnpm.patchedDependencies['zod@3.25.76']).toBe('patches/zod@3.25.76.patch');
  const zod3 = installedZods().filter(({ version }) => version.split('.')[0] === '3');
  expect(zod3.length).toBeGreaterThan(0);
  // pnpm applies the patch to exactly this version; any other zod 3 would be unpatched.
  expect([...new Set(zod3.map(({ version }) => version))]).toEqual(['3.25.76']);
  // One directory on disk, so the consumers zod-issue-bound.test.js loads from
  // stand for every package that uses zod 3.
  expect(zod3.every(({ path }) => typeof path === 'string')).toBe(true);
  expect(new Set(zod3.map(({ path }) => realpathSync(path))).size).toBe(1);
});
```

- [ ] **Step 2: Replace the node-forge comment** (lines 57–59: "The braces exception … Any further entry needs one too.") with:

```js
  // The braces exception (GHSA-vfj7-8cjw-p6xm, TASK-750) has its own guard in
  // braces-dev-only-audit-exception.test.js. The zod one (GHSA-mrhx-c7xc-m3w5) is
  // covered by a local patch, patches/zod@3.25.76.patch (TASK-938), guarded by
  // zod-issue-bound.test.js and zod-audit-exception.test.js. Any further entry
  // needs a guard too.
```

- [ ] **Step 3: Run both.** Run: `pnpm test:scripts zod-audit-exception node-forge-signature-validation`. Expected: `Test Files 2 passed (2)`, with zod-audit-exception reporting 2 tests. MEASURED before the patch: the zod 3 test fails only on `expected undefined to be 'patches/zod@3.25.76.patch'`, and with that one line removed its other assertions pass.
- [ ] **Step 4: Watch the new check fail, then restore.**
  - Delete the `"zod@3.25.76"` line from `package.json` (fix the trailing comma). Don't run install.
  - Run `pnpm test:scripts zod-audit-exception`. Expected: `keeps every installed zod 3 at the one patched 3.25.76` fails with `expected undefined to be 'patches/zod@3.25.76.patch'`.
  - Restore with `git checkout -- package.json`. Task 2 is committed, so this restores its version. `git diff --quiet package.json` exits 0.
- [ ] **Step 5: Lint.** Run: `pnpm exec eslint scripts/__tests__/zod-audit-exception.test.js scripts/__tests__/node-forge-signature-validation.test.js`. Expected: exit 0.
- [ ] **Step 6: Commit.**
  - `git add scripts/__tests__/zod-audit-exception.test.js scripts/__tests__/node-forge-signature-validation.test.js`
  - `git commit -m "test: the zod audit guard pins the patched 3.25.76; guards say the patch exists (TASK-938)"`

### Task 4: Patch notes [tier: mechanical]

This follows the shape of `patches/node-forge@1.4.0.md`: what the patch does, why audit is still told to ignore the advisory, what guards it, and when to remove it.

**Files:**
- Create: `patches/zod@3.25.76.md`.

- [ ] **Step 1: Write the notes.**

```markdown
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
  taking their elements' issues once they hold 100.

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
```

- [ ] **Step 2: Commit.**
  - `git add patches/zod@3.25.76.md`
  - `git commit -m "docs: zod 3.25.76 patch notes (TASK-938)"`

---

## Card acceptance → tests

| Card acceptance | Evidence |
|---|---|
| The regression test fails before the patch and passes after | T1 Step 2 (`92 failed \| 39 passed`); T2 Step 5 (`131 passed`) |
| A huge failing array fails within a bounded number of issues and bounded memory | T1: every collection test, and the two 96 MB-heap children (1,000,000 elements) |
| The error stays a normal ZodError; callers see an invalid result, not a crash | T1: `toBeInstanceOf(z.ZodError)`, `.parse` throws `ZodError`, and the union whose option filled its list |
| Mirror 4.6.6 where possible | T1: `reports only the size issue…` (v3 API) |
| Set and record parsing, if they share the shape | T1: record (bad values, bad keys, async), catchall, tuple rest, map (bad keys and values), set |
| Every zod 3 copy in the tree is the patched 3.25.76 | T3 `keeps every installed zod 3 at the one patched 3.25.76`; T2 Step 4 (`ls node_modules/.pnpm`); T2 Step 6 (deployed tree) |
| Comments say the patch exists; pin like the node-forge guard | T3 (audit guard header and pin, node-forge comment); T4 (notes) |
| Untrusted-input places listed, with body limits | Appendix C, copied into the PR body; decisions shard |
| Decisions shard records the bound | `.claude/memory/decisions/2026-10-23-TASK-938.md`, "TASK-938 plan" rows (planner) |
| Full gate, then lint | Before the PR |
| `security-checklist` | T2 Step 7 |

## Before the PR

- **Gates (CLAUDE.md):** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Docker-backed packages need `DOCKER_HOST`; the local value used by recent plans is `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`.
  - The full recursive run matters more than usual here, because this patch changes zod's runtime behaviour for every package. Expected: no package test changes outcome. The inventory found no test that relies on more than about 2 issues. `packages/sandbox-k8s/src/__tests__/open-session-schema.test.ts`'s case over `.max(8)` uses valid elements, so its single `too_big` issue is unchanged.
  - If a test fails because it expected element issues from an array over its `.max()`/`.length()`, it was pinning the vulnerable behaviour. Update it to expect only the size issue, and name it in the PR.
  - Docker start-slot timeouts are not this change: re-run those packages one at a time, and report both runs.
- **Audit:** `pnpm audit --audit-level moderate` passes. The ignore list is unchanged. A brand-new advisory can still land at any time (CI runs audit last), so read any red one before blaming this change.
- **Boundary review:** none. No hook, IPC action or plugin manifest changes.
- **Security note** (from T2 Step 7):
  - **Supply chain:**
    - The change is a local patch to six built files of an existing pinned dependency, reviewable as a diff (`patches/zod@3.25.76.patch`).
    - It adds no dependency, install script or network access.
    - It is pinned by `zod-audit-exception.test.js`, and the deployed tree was checked (T2 Step 6).
  - **Untrusted input:**
    - Every collection in both engines stops at 100 issues per list.
    - A failure is still a `ZodError`, and valid input is unchanged.
    - The measured before and after numbers are in Appendix B; the inventory is in Appendix C.
  - **Sandbox escape and prompt injection:** N/A. No capability changes; the patch makes untrusted input cheaper to reject.
  - **Residuals:**
    - zod 4.6.7 keeps upstream behaviour. It carries better-auth's request bodies, the AI-SDK runner and its MCP calls.
    - The Agent SDK bundles its own zod.
    - CPU after the cap stays linear: about 1.2 s per 200,000 failing plain-union elements on the v3 API, memory bounded.
    - Several transports have no response size cap (follow-ups below).
- **Semantic changes to state in the PR**, all intended. Items 1–3 match upstream 4.6.6; item 4 is this patch's own cap:
  1. An array over its `.max()`/`.length()`, or a set over its `.max()`, reports only the size issue.
  2. A union with such an array as an option now fails as `invalid_union`, where before it adopted that option's issues. It still fails.
  3. A `.refine()`/`.superRefine()` on an oversized array no longer runs, because the elements were never parsed (upstream: "no later check may read it").
  4. A parse with more than 100 issues reports the first 100, in parse order.
- **Follow-up cards to file (not built here):**
  1. `@ax/mcp-oauth`: cap OAuth metadata, DCR and token response bodies. `safeFetch` has no byte cap, and the SDK reads the full `response.json()`.
  2. `@ax/llm-openrouter`: cap the completion response body.
  3. `@ax/agent-aisdk-runner`: cap MCP `callTool` responses. They are parsed with zod 4.6.7, which still builds an issue per element for `CallToolResultSchema.content`.
  4. Add `.max()` to the untrusted arrays and records that have none: `skill.propose`'s `capabilityProposal` arrays, `event.chat-end`'s `outcome.messages`, the connectors `CapabilitiesSchema` arrays, the agents `credentialBindings` count, and chat `permission-decision`'s `shown.*`. This holds up whatever version of zod we run.
- **Deploy:** none in this PR; the next image build picks the patch up.
  - The deployed virtual-store directory names that include zod change (`…_patch_hash=…`).
  - Runner paths are resolved at runtime (`presets/k8s/src/index.ts:129`, `packages/cli/src/main.ts:146`), and the shared pool rehashes its pod template whenever it changes, so nothing hardcodes those names.
  - `deploy/gke/shared-pool-production-rollout-2026-10-02.json` records an old store path. It is a historical record, not config.
- **PR body:**
  - what changed and why;
  - the bound (Architecture);
  - Appendix B (measurements) and Appendix C (inventory);
  - the departures and semantic changes;
  - residuals and follow-ups;
  - test evidence: red `92 failed | 39 passed` before, `131 passed` after, the planner's 28/28 mutants, and the T2 Step 6 result.

---

## Appendix A: the patch

Apply it in the `pnpm patch` edit directory with `patch -p1` (T2 Step 3). Everything inside the fences is the file.

```diff
diff -ruN a/v3/helpers/parseUtil.cjs b/v3/helpers/parseUtil.cjs
--- a/v3/helpers/parseUtil.cjs
+++ b/v3/helpers/parseUtil.cjs
@@ -37,7 +37,14 @@
 };
 exports.makeIssue = makeIssue;
 exports.EMPTY_PATH = [];
+// ax-next patch (GHSA-mrhx-c7xc-m3w5): a parse collects at most this many issues
+// in one issues list, so a huge failing array, record or catchall cannot allocate
+// an issue per element. The first issue always lands, so a failed parse is still
+// a normal ZodError. Keep in step with MAX_ISSUES in ../types.cjs.
+const MAX_ISSUES = 100;
 function addIssueToContext(ctx, issueData) {
+    if (ctx.common.issues.length >= MAX_ISSUES)
+        return;
     const overrideMap = (0, errors_js_1.getErrorMap)();
     const issue = (0, exports.makeIssue)({
         issueData: issueData,
diff -ruN a/v3/helpers/parseUtil.js b/v3/helpers/parseUtil.js
--- a/v3/helpers/parseUtil.js
+++ b/v3/helpers/parseUtil.js
@@ -29,7 +29,14 @@
     };
 };
 export const EMPTY_PATH = [];
+// ax-next patch (GHSA-mrhx-c7xc-m3w5): a parse collects at most this many issues
+// in one issues list, so a huge failing array, record or catchall cannot allocate
+// an issue per element. The first issue always lands, so a failed parse is still
+// a normal ZodError. Keep in step with MAX_ISSUES in ../types.js.
+const MAX_ISSUES = 100;
 export function addIssueToContext(ctx, issueData) {
+    if (ctx.common.issues.length >= MAX_ISSUES)
+        return;
     const overrideMap = getErrorMap();
     const issue = makeIssue({
         issueData: issueData,
diff -ruN a/v3/types.cjs b/v3/types.cjs
--- a/v3/types.cjs
+++ b/v3/types.cjs
@@ -9,6 +9,9 @@
 const errorUtil_js_1 = require("./helpers/errorUtil.cjs");
 const parseUtil_js_1 = require("./helpers/parseUtil.cjs");
 const util_js_1 = require("./helpers/util.cjs");
+// ax-next patch (GHSA-mrhx-c7xc-m3w5): the issues-per-list cap that
+// addIssueToContext enforces in ./helpers/parseUtil.cjs. Keep the two in step.
+const MAX_ISSUES = 100;
 class ParseInputLazyPath {
     constructor(parent, value, path, key) {
         this._cachedPath = [];
@@ -1819,6 +1822,13 @@
                 status.dirty();
             }
         }
+        // ax-next patch (GHSA-mrhx-c7xc-m3w5, mirrors zod 4.6.6 commit a0ebf970):
+        // an array longer than its .max() or .length() has already failed, so
+        // report only the size issue and do not parse its elements.
+        if ((def.exactLength !== null && ctx.data.length > def.exactLength.value) ||
+            (def.maxLength !== null && ctx.data.length > def.maxLength.value)) {
+            return parseUtil_js_1.INVALID;
+        }
         if (ctx.common.async) {
             return Promise.all([...ctx.data].map((item, i) => {
                 return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
@@ -2301,7 +2311,8 @@
             for (const result of results) {
                 if (result.result.status === "dirty") {
                     // add issues from dirty option
-                    ctx.common.issues.push(...result.ctx.common.issues);
+                    // ax-next patch (GHSA-mrhx-c7xc-m3w5): copy no more than the cap allows.
+                    ctx.common.issues.push(...result.ctx.common.issues.slice(0, Math.max(0, MAX_ISSUES - ctx.common.issues.length)));
                     return result.result;
                 }
             }
@@ -2361,7 +2372,8 @@
                 }
             }
             if (dirty) {
-                ctx.common.issues.push(...dirty.ctx.common.issues);
+                // ax-next patch (GHSA-mrhx-c7xc-m3w5): copy no more than the cap allows.
+                ctx.common.issues.push(...dirty.ctx.common.issues.slice(0, Math.max(0, MAX_ISSUES - ctx.common.issues.length)));
                 return dirty.result;
             }
             const unionErrors = issues.map((issues) => new ZodError_js_1.ZodError(issues));
@@ -2845,6 +2857,12 @@
                 });
                 status.dirty();
             }
+        }
+        // ax-next patch (GHSA-mrhx-c7xc-m3w5, mirrors zod 4.6.6 commit a0ebf970):
+        // a set larger than its .max() or .size() has already failed, so report
+        // only the size issue and do not parse its elements.
+        if (def.maxSize !== null && ctx.data.size > def.maxSize.value) {
+            return parseUtil_js_1.INVALID;
         }
         const valueType = this._def.valueType;
         function finalizeSet(elements) {
diff -ruN a/v3/types.js b/v3/types.js
--- a/v3/types.js
+++ b/v3/types.js
@@ -3,6 +3,9 @@
 import { errorUtil } from "./helpers/errorUtil.js";
 import { DIRTY, INVALID, OK, ParseStatus, addIssueToContext, isAborted, isAsync, isDirty, isValid, makeIssue, } from "./helpers/parseUtil.js";
 import { util, ZodParsedType, getParsedType } from "./helpers/util.js";
+// ax-next patch (GHSA-mrhx-c7xc-m3w5): the issues-per-list cap that
+// addIssueToContext enforces in ./helpers/parseUtil.js. Keep the two in step.
+const MAX_ISSUES = 100;
 class ParseInputLazyPath {
     constructor(parent, value, path, key) {
         this._cachedPath = [];
@@ -1798,6 +1801,13 @@
                 status.dirty();
             }
         }
+        // ax-next patch (GHSA-mrhx-c7xc-m3w5, mirrors zod 4.6.6 commit a0ebf970):
+        // an array longer than its .max() or .length() has already failed, so
+        // report only the size issue and do not parse its elements.
+        if ((def.exactLength !== null && ctx.data.length > def.exactLength.value) ||
+            (def.maxLength !== null && ctx.data.length > def.maxLength.value)) {
+            return INVALID;
+        }
         if (ctx.common.async) {
             return Promise.all([...ctx.data].map((item, i) => {
                 return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
@@ -2278,7 +2288,8 @@
             for (const result of results) {
                 if (result.result.status === "dirty") {
                     // add issues from dirty option
-                    ctx.common.issues.push(...result.ctx.common.issues);
+                    // ax-next patch (GHSA-mrhx-c7xc-m3w5): copy no more than the cap allows.
+                    ctx.common.issues.push(...result.ctx.common.issues.slice(0, Math.max(0, MAX_ISSUES - ctx.common.issues.length)));
                     return result.result;
                 }
             }
@@ -2338,7 +2349,8 @@
                 }
             }
             if (dirty) {
-                ctx.common.issues.push(...dirty.ctx.common.issues);
+                // ax-next patch (GHSA-mrhx-c7xc-m3w5): copy no more than the cap allows.
+                ctx.common.issues.push(...dirty.ctx.common.issues.slice(0, Math.max(0, MAX_ISSUES - ctx.common.issues.length)));
                 return dirty.result;
             }
             const unionErrors = issues.map((issues) => new ZodError(issues));
@@ -2816,6 +2828,12 @@
                 });
                 status.dirty();
             }
+        }
+        // ax-next patch (GHSA-mrhx-c7xc-m3w5, mirrors zod 4.6.6 commit a0ebf970):
+        // a set larger than its .max() or .size() has already failed, so report
+        // only the size issue and do not parse its elements.
+        if (def.maxSize !== null && ctx.data.size > def.maxSize.value) {
+            return INVALID;
         }
         const valueType = this._def.valueType;
         function finalizeSet(elements) {
diff -ruN a/v4/core/schemas.cjs b/v4/core/schemas.cjs
--- a/v4/core/schemas.cjs
+++ b/v4/core/schemas.cjs
@@ -35,6 +35,11 @@
 const regexes = __importStar(require("./regexes.cjs"));
 const util = __importStar(require("./util.cjs"));
 const versions_js_1 = require("./versions.cjs");
+// ax-next patch (GHSA-mrhx-c7xc-m3w5): a collection (array, tuple rest, record,
+// object catchall, map, set) stops taking its elements' issues once it holds
+// this many, so a huge failing input cannot allocate an issue per element. The
+// first failing element always reports, so the parse still fails normally.
+const MAX_ISSUES = 100;
 exports.$ZodType = core.$constructor("$ZodType", (inst, def) => {
     var _a;
     inst ?? (inst = {});
@@ -645,7 +650,7 @@
     };
 });
 function handleArrayResult(result, final, index) {
-    if (result.issues.length) {
+    if (result.issues.length && final.issues.length < MAX_ISSUES) {
         final.issues.push(...util.prefixIssues(index, result.issues));
     }
     final.value[index] = result.value;
@@ -686,7 +691,7 @@
 });
 function handleObjectResult(result, final, key) {
     // if(isOptional)
-    if (result.issues.length) {
+    if (result.issues.length && final.issues.length < MAX_ISSUES) {
         final.issues.push(...util.prefixIssues(key, result.issues));
     }
     final.value[key] = result.value;
@@ -1172,7 +1177,7 @@
     };
 });
 function handleTupleResult(result, final, index) {
-    if (result.issues.length) {
+    if (result.issues.length && final.issues.length < MAX_ISSUES) {
         final.issues.push(...util.prefixIssues(index, result.issues));
     }
     final.value[index] = result.value;
@@ -1239,28 +1244,30 @@
                     throw new Error("Async schemas not supported in object keys currently");
                 }
                 if (keyResult.issues.length) {
-                    payload.issues.push({
-                        origin: "record",
-                        code: "invalid_key",
-                        issues: keyResult.issues.map((iss) => util.finalizeIssue(iss, ctx, core.config())),
-                        input: key,
-                        path: [key],
-                        inst,
-                    });
+                    if (payload.issues.length < MAX_ISSUES) {
+                        payload.issues.push({
+                            origin: "record",
+                            code: "invalid_key",
+                            issues: keyResult.issues.map((iss) => util.finalizeIssue(iss, ctx, core.config())),
+                            input: key,
+                            path: [key],
+                            inst,
+                        });
+                    }
                     payload.value[keyResult.value] = keyResult.value;
                     continue;
                 }
                 const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
                 if (result instanceof Promise) {
                     proms.push(result.then((result) => {
-                        if (result.issues.length) {
+                        if (result.issues.length && payload.issues.length < MAX_ISSUES) {
                             payload.issues.push(...util.prefixIssues(key, result.issues));
                         }
                         payload.value[keyResult.value] = result.value;
                     }));
                 }
                 else {
-                    if (result.issues.length) {
+                    if (result.issues.length && payload.issues.length < MAX_ISSUES) {
                         payload.issues.push(...util.prefixIssues(key, result.issues));
                     }
                     payload.value[keyResult.value] = result.value;
@@ -1306,7 +1313,8 @@
     };
 });
 function handleMapResult(keyResult, valueResult, final, key, input, inst, ctx) {
-    if (keyResult.issues.length) {
+    const room = final.issues.length < MAX_ISSUES;
+    if (keyResult.issues.length && room) {
         if (util.propertyKeyTypes.has(typeof key)) {
             final.issues.push(...util.prefixIssues(key, keyResult.issues));
         }
@@ -1320,7 +1328,7 @@
             });
         }
     }
-    if (valueResult.issues.length) {
+    if (valueResult.issues.length && room) {
         if (util.propertyKeyTypes.has(typeof key)) {
             final.issues.push(...util.prefixIssues(key, valueResult.issues));
         }
@@ -1366,7 +1374,7 @@
     };
 });
 function handleSetResult(result, final) {
-    if (result.issues.length) {
+    if (result.issues.length && final.issues.length < MAX_ISSUES) {
         final.issues.push(...result.issues);
     }
     final.value.add(result.value);
diff -ruN a/v4/core/schemas.js b/v4/core/schemas.js
--- a/v4/core/schemas.js
+++ b/v4/core/schemas.js
@@ -5,6 +5,11 @@
 import * as regexes from "./regexes.js";
 import * as util from "./util.js";
 import { version } from "./versions.js";
+// ax-next patch (GHSA-mrhx-c7xc-m3w5): a collection (array, tuple rest, record,
+// object catchall, map, set) stops taking its elements' issues once it holds
+// this many, so a huge failing input cannot allocate an issue per element. The
+// first failing element always reports, so the parse still fails normally.
+const MAX_ISSUES = 100;
 export const $ZodType = /*@__PURE__*/ core.$constructor("$ZodType", (inst, def) => {
     var _a;
     inst ?? (inst = {});
@@ -614,7 +619,7 @@
     };
 });
 function handleArrayResult(result, final, index) {
-    if (result.issues.length) {
+    if (result.issues.length && final.issues.length < MAX_ISSUES) {
         final.issues.push(...util.prefixIssues(index, result.issues));
     }
     final.value[index] = result.value;
@@ -655,7 +660,7 @@
 });
 function handleObjectResult(result, final, key) {
     // if(isOptional)
-    if (result.issues.length) {
+    if (result.issues.length && final.issues.length < MAX_ISSUES) {
         final.issues.push(...util.prefixIssues(key, result.issues));
     }
     final.value[key] = result.value;
@@ -1141,7 +1146,7 @@
     };
 });
 function handleTupleResult(result, final, index) {
-    if (result.issues.length) {
+    if (result.issues.length && final.issues.length < MAX_ISSUES) {
         final.issues.push(...util.prefixIssues(index, result.issues));
     }
     final.value[index] = result.value;
@@ -1208,28 +1213,30 @@
                     throw new Error("Async schemas not supported in object keys currently");
                 }
                 if (keyResult.issues.length) {
-                    payload.issues.push({
-                        origin: "record",
-                        code: "invalid_key",
-                        issues: keyResult.issues.map((iss) => util.finalizeIssue(iss, ctx, core.config())),
-                        input: key,
-                        path: [key],
-                        inst,
-                    });
+                    if (payload.issues.length < MAX_ISSUES) {
+                        payload.issues.push({
+                            origin: "record",
+                            code: "invalid_key",
+                            issues: keyResult.issues.map((iss) => util.finalizeIssue(iss, ctx, core.config())),
+                            input: key,
+                            path: [key],
+                            inst,
+                        });
+                    }
                     payload.value[keyResult.value] = keyResult.value;
                     continue;
                 }
                 const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
                 if (result instanceof Promise) {
                     proms.push(result.then((result) => {
-                        if (result.issues.length) {
+                        if (result.issues.length && payload.issues.length < MAX_ISSUES) {
                             payload.issues.push(...util.prefixIssues(key, result.issues));
                         }
                         payload.value[keyResult.value] = result.value;
                     }));
                 }
                 else {
-                    if (result.issues.length) {
+                    if (result.issues.length && payload.issues.length < MAX_ISSUES) {
                         payload.issues.push(...util.prefixIssues(key, result.issues));
                     }
                     payload.value[keyResult.value] = result.value;
@@ -1275,7 +1282,8 @@
     };
 });
 function handleMapResult(keyResult, valueResult, final, key, input, inst, ctx) {
-    if (keyResult.issues.length) {
+    const room = final.issues.length < MAX_ISSUES;
+    if (keyResult.issues.length && room) {
         if (util.propertyKeyTypes.has(typeof key)) {
             final.issues.push(...util.prefixIssues(key, keyResult.issues));
         }
@@ -1289,7 +1297,7 @@
             });
         }
     }
-    if (valueResult.issues.length) {
+    if (valueResult.issues.length && room) {
         if (util.propertyKeyTypes.has(typeof key)) {
             final.issues.push(...util.prefixIssues(key, valueResult.issues));
         }
@@ -1335,7 +1343,7 @@
     };
 });
 function handleSetResult(result, final) {
-    if (result.issues.length) {
+    if (result.issues.length && final.issues.length < MAX_ISSUES) {
         final.issues.push(...result.issues);
     }
     final.value.add(result.value);
```

## Appendix B: measurements (MEASURED at 15f71a4d5)

The input is 200,000 bad elements (`0`), about 400 KB as JSON. "Retained" is the heap after GC while the error is still held (in-process, `--expose-gc`). "Heap" is `heapUsed` right after the parse. The patched columns come from a scratchpad copy of the package with Appendix A applied.

| Schema | 3.25.76 `zod` | patched | 3.25.76 `zod/v4` | patched | 4.6.7 (upstream fix) |
|---|---|---|---|---|---|
| `z.array(z.string())` | 200,000 issues, 48 MB retained | 100, 0.1 MB | 200,000, 145 MB | 100, 0.1 MB | 200,000, 66 MB |
| `z.array(z.string()).max(10)` | 200,001, 48 MB | 1, 0 MB | 200,001, 145 MB | 101, 0.1 MB (check runs after parse) | 1, 0 MB |
| `z.array(z.union([z.string(), z.null()]))` | 200,000, 654 MB, 1.4 s | 100, 1.9 MB, 1.2 s (CPU residual) | 200,000, 389 MB | 100, 0.2 MB | 200,000, 151 MB |
| `z.record(z.string(), z.string())`, 200,000 keys | 200,000, 48 MB | 100, 0 MB | 200,000, 145 MB | 100, 0.1 MB | 200,000, 66 MB |
| MCP SDK `ListToolsResultSchema`, `tools` | — | — | 189 MB heap | 21 MB heap | — |
| MCP SDK `CallToolResultSchema`, `content` | — | — | 1,041 MB heap | 22 MB heap | — |
| `error.message`, 20,000 bad (`z.array(z.string())`) | 3.4 MB | 16.9 KB | 3.2 MB | 15.8 KB | — |
| 1,000,000 bad, child with a 96 MB heap | heap OOM in 0.3 s | exit 0, 33 MB | `ListToolsResultSchema`: heap OOM in 0.2 s | exit 0, 34 MB | — |

## Appendix C: where untrusted input meets unbounded zod collections (for the PR body)

Unpatched, 2 bytes of input (`0,`) retain about 240 bytes on the v3 API, and about 5 KB under the MCP SDK's content union. That puts a 4 MiB IPC frame or a 2 MiB tools/list page in the hundreds of MB to GB range (INFERRED from Appendix B). The rows marked **none** are the follow-up cards.

| Entry point | Boundary | Unbounded collections | Limit before zod | zod |
|---|---|---|---|---|
| IPC `event.turn-end` (`packages/ipc-core/src/handlers/event-turn-end.ts`) | sandbox → host | `contentBlocks` (discriminated union of 8). Inside it, `tool_result.content` is a union of a string or an array | 4 MiB `MAX_FRAME` (`packages/core/src/ipc/framing.ts`) | v3 |
| IPC `event.chat-end` | sandbox → host | `outcome.messages[].contentBlocks` | 4 MiB | v3 |
| IPC `skill.propose` | sandbox → host | `capabilityProposal` arrays (`allowedHosts`, `credentials`, `mcpServers[]`, `packages.*`) | 4 MiB | v3 |
| IPC `tool.execute-host` → `connector_propose` → `connectors:install-authored` | model → host | connectors `CapabilitiesSchema` arrays (`allowedHosts`, `mcpServers[]`, `credentials`, `packages.*`, OAuth `scopes`) | 4 MiB | v3 |
| IPC `event.connector-auth-failure` | sandbox → host | `servers`, which has `.max(32)`, but zod 3 parsed the elements anyway until this patch | 4 MiB | v3 |
| `POST /api/chat/messages` (`packages/channel-web/src/server/routes-chat.ts`) | browser (signed in) | `contentBlocks`, which has `.max(20)` but was parsed anyway until this patch, plus the nested `tool_result.content` | 1 MiB (`packages/http-server` `MAX_BODY_BYTES`) | v3 |
| `/api/chat/permission-decision`, `/api/chat/approve-authored-skill` | browser (signed in) | `shown.hosts/slots/npm/pypi` | 1 MiB | v3 |
| `/admin/connectors`, `/admin/agents/*` | admin | `CapabilitiesSchema` arrays; `credentialBindings` record (no count cap) | 64 KiB | v3 |
| MCP tools/list inventory (`packages/mcp-client/src/connector-inventory/list-tools.ts`) | remote MCP server | `ListToolsResultSchema.tools`, plus the `JSONRPCMessageSchema` union on every message | 2 MiB per response, at most 10 pages | `zod/v4` in 3.25.76 |
| MCP OAuth sign-in (`packages/mcp-oauth/src/oauth-flow.ts` → the SDK's `client/auth.js`) | remote auth server | OAuth metadata, DCR and token schemas (`scopes_supported`, `redirect_uris`, …) | **none** | `zod/v4` in 3.25.76 |
| OAuth discover-hosts preview (`packages/mcp-oauth/src/host-discovery.ts`) | remote | the same SDK schemas | 64 KiB per response, at most 16 | `zod/v4` in 3.25.76 |
| OpenRouter completion (`packages/llm-openrouter/src/translate.ts`) | remote LLM API | `choices` | **none** | v3 |
| AI-SDK runner MCP `callTool` (`packages/agent-aisdk-runner/src/tools/connector-tools.ts`) | remote → sandbox | `CallToolResultSchema.content` (union of 5) | **none** | zod 4.6.7, not patched (upstream semantics) |
| `/webhooks/:token/*` | external | none: `JSON.parse` only | 1 MiB | — |
| `/auth/*` (better-auth) | browser, before sign-in | better-auth's own schemas (not inspected) | 1 MiB | zod 4.6.7 |
