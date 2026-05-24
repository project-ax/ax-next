# ARCH-12: returns schemas for workspace:apply + workspace:diff (lazy-fn delta) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime `returns` schemas to the IPC-reachable, security-critical write-path workspace hooks `workspace:apply` and `workspace:diff`, without stripping the lazy `contentBefore`/`contentAfter` functions on delta changes — deferred from ARCH-6 (#150).

**Architecture:** The output shapes (`WorkspaceApplyOutput`, `WorkspaceDiffOutput`, `WorkspaceDelta`, `WorkspaceChange`) already live in storage-neutral `@ax/core/workspace.ts`. We add three exported zod schemas there next to the ARCH-6 read/list schemas. The `changes[]` element schema uses `.passthrough()` so the lazy function fields survive `.parse()` by reference identity (empirically verified in zod 3.25.76). The `workspace:apply` schema attaches at the single `@ax/core` facade (`registerWorkspaceApplyFacade`); the `workspace:diff` schema attaches at each of the three backend registration sites (git-core, git-server client, mock). The cross-backend `workspace-contract.ts` suite — already parameterized over the mock AND the git backend — is the integration drift guard the card requires.

**Tech Stack:** TypeScript, zod 3.25.76, vitest, pnpm workspace.

---

### Task 1: Schemas in `@ax/core` + core unit drift guards (TDD)

**Files:**
- Modify: `packages/core/src/workspace.ts` (add `WorkspaceDeltaSchema`, `WorkspaceApplyOutputSchema`, `WorkspaceDiffOutputSchema`)
- Modify (verify export): `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/workspace-return-schemas.test.ts` (extend existing ARCH-6 file)

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/__tests__/workspace-return-schemas.test.ts` (and add the new imports `WorkspaceApplyOutputSchema`, `WorkspaceDiffOutputSchema`, plus types `WorkspaceApplyOutput`, `WorkspaceDiffOutput`, `WorkspaceDelta`):

```ts
  describe('WorkspaceApplyOutputSchema', () => {
    const mkDelta = (): WorkspaceDelta => ({
      before: asWorkspaceVersion('v0'),
      after: asWorkspaceVersion('v1'),
      reason: 'why',
      author: { agentId: 'a', userId: 'u', sessionId: 's' },
      changes: [
        { path: 'added.ts', kind: 'added', contentAfter: () => Promise.resolve(new Uint8Array([1])) },
        {
          path: 'mod.ts',
          kind: 'modified',
          contentBefore: () => Promise.resolve(new Uint8Array([2])),
          contentAfter: () => Promise.resolve(new Uint8Array([3])),
        },
        { path: 'gone.ts', kind: 'deleted', contentBefore: () => Promise.resolve(new Uint8Array([4])) },
      ],
    });

    it('accepts a fully-populated apply output', () => {
      const r = WorkspaceApplyOutputSchema.safeParse({
        version: asWorkspaceVersion('v1'),
        delta: mkDelta(),
      });
      expect(r.success).toBe(true);
    });

    it('accepts before: null (initial apply)', () => {
      const r = WorkspaceApplyOutputSchema.safeParse({
        version: asWorkspaceVersion('v1'),
        delta: { before: null, after: asWorkspaceVersion('v1'), changes: [] },
      });
      expect(r.success).toBe(true);
    });

    it('rejects a missing version', () => {
      expect(
        WorkspaceApplyOutputSchema.safeParse({ delta: { before: null, after: asWorkspaceVersion('v1'), changes: [] } })
          .success,
      ).toBe(false);
    });

    it('rejects a change with a bad kind', () => {
      expect(
        WorkspaceApplyOutputSchema.safeParse({
          version: asWorkspaceVersion('v1'),
          delta: { before: null, after: asWorkspaceVersion('v1'), changes: [{ path: 'x', kind: 'bogus' }] },
        }).success,
      ).toBe(false);
    });

    // THE critical drift guard: the lazy content fns must survive .parse() by
    // reference identity, not be stripped (the ARCH-6-deferred trap).
    it('round-trips lazy contentBefore/contentAfter fn refs without stripping them', () => {
      const before = () => Promise.resolve(new Uint8Array([2]));
      const after = () => Promise.resolve(new Uint8Array([3]));
      const full: WorkspaceApplyOutput = {
        version: asWorkspaceVersion('v1'),
        delta: {
          before: asWorkspaceVersion('v0'),
          after: asWorkspaceVersion('v1'),
          changes: [{ path: 'mod.ts', kind: 'modified', contentBefore: before, contentAfter: after }],
        },
      };
      const parsed = WorkspaceApplyOutputSchema.parse(full) as WorkspaceApplyOutput;
      expect(parsed.delta.changes[0]!.contentBefore).toBe(before);
      expect(parsed.delta.changes[0]!.contentAfter).toBe(after);
      expect(typeof parsed.delta.changes[0]!.contentAfter).toBe('function');
      expect(parsed).toEqual(full);
    });
  });

  describe('WorkspaceDiffOutputSchema', () => {
    it('accepts a populated diff output', () => {
      const r = WorkspaceDiffOutputSchema.safeParse({
        delta: {
          before: asWorkspaceVersion('v0'),
          after: asWorkspaceVersion('v1'),
          changes: [{ path: 'a', kind: 'added', contentAfter: () => Promise.resolve(new Uint8Array([1])) }],
        },
      });
      expect(r.success).toBe(true);
    });

    it('rejects a missing delta', () => {
      expect(WorkspaceDiffOutputSchema.safeParse({}).success).toBe(false);
    });

    it('round-trips lazy contentAfter fn ref without stripping it', () => {
      const after = () => Promise.resolve(new Uint8Array([9]));
      const full: WorkspaceDiffOutput = {
        delta: {
          before: null,
          after: asWorkspaceVersion('v1'),
          changes: [{ path: 'a', kind: 'added', contentAfter: after }],
        },
      };
      const parsed = WorkspaceDiffOutputSchema.parse(full) as WorkspaceDiffOutput;
      expect(parsed.delta.changes[0]!.contentAfter).toBe(after);
      expect(parsed).toEqual(full);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ax/core test -- workspace-return-schemas`
Expected: FAIL — `WorkspaceApplyOutputSchema`/`WorkspaceDiffOutputSchema` not exported.

- [ ] **Step 3: Add the schemas to `packages/core/src/workspace.ts`**

Insert after the `WorkspaceListOutputSchema` block and adjust the `WorkspaceDiffOutput` block at the bottom. The change-element schema `.passthrough()` keeps the lazy `contentBefore`/`contentAfter` fns intact:

```ts
// ARCH-12: runtime `returns` contracts for the write-path workspace hooks
// `workspace:apply` (via the @ax/core facade) and `workspace:diff`.
//
// `WorkspaceChange` carries LAZY `contentBefore?/contentAfter?: () => Promise<Bytes>`
// fns. A strict zod object schema strips undeclared keys (hook-bus.ts), which
// would silently delete the fns and (a) break the cross-backend
// `workspace-contract.ts` `typeof ch.contentAfter === 'function'` assertion and
// (b) sever subscribers' content access (e.g. @ax/routines sync). So the change
// element schema validates only the serializable data fields (`path`, `kind`)
// and `.passthrough()`es the rest — zod 3 passthrough keeps function-valued keys
// by REFERENCE IDENTITY (verified), so the lazy fns ride through untouched.
// `WorkspaceVersion` is a compile-time brand over string → `z.string()`.
const WorkspaceChangeSchema = z
  .object({
    path: z.string(),
    kind: z.enum(['added', 'modified', 'deleted']),
  })
  .passthrough();

export const WorkspaceDeltaSchema = z.object({
  before: z.string().nullable(),
  after: z.string(),
  reason: z.string().optional(),
  author: z
    .object({
      agentId: z.string().optional(),
      userId: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .optional(),
  changes: z.array(WorkspaceChangeSchema),
}) as unknown as ZodType<WorkspaceDelta>;

export const WorkspaceApplyOutputSchema = z.object({
  version: z.string(),
  delta: WorkspaceDeltaSchema,
}) as unknown as ZodType<WorkspaceApplyOutput>;
```

And change the existing trailing block from:

```ts
export interface WorkspaceDiffOutput {
  delta: WorkspaceDelta;
}
```

to keep the interface and add its schema right after it:

```ts
export interface WorkspaceDiffOutput {
  delta: WorkspaceDelta;
}
export const WorkspaceDiffOutputSchema = z.object({
  delta: WorkspaceDeltaSchema,
}) as unknown as ZodType<WorkspaceDiffOutput>;
```

> NOTE: `WorkspaceApplyOutputSchema` references `WorkspaceDeltaSchema` which references the `WorkspaceApplyOutput`/`WorkspaceDelta` TS types. `WorkspaceApplyOutput` is declared earlier in the file (line ~53); `WorkspaceDelta` earlier still (~39). `WorkspaceDiffOutput` is declared at the bottom, so place `WorkspaceDiffOutputSchema` immediately after it. `WorkspaceDeltaSchema`/`WorkspaceApplyOutputSchema` can be defined in the read/list schema region (after `WorkspaceListOutputSchema`) since their referenced types are all above that point.

- [ ] **Step 4: Verify the schemas are re-exported from the package barrel**

Check `packages/core/src/index.ts` re-exports everything from `./workspace.js` (the ARCH-6 read/list schemas are already exported, so a wildcard or explicit re-export should already cover the new ones). If exports are explicit, add `WorkspaceDeltaSchema`, `WorkspaceApplyOutputSchema`, `WorkspaceDiffOutputSchema`.

Run: `grep -n "WorkspaceReadOutputSchema\|export .* from './workspace" packages/core/src/index.ts`
Expected: confirms how workspace symbols are exported; mirror it for the new schemas.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ax/core test -- workspace-return-schemas`
Expected: PASS — all apply/diff schema tests green, including the fn-ref round-trip guards.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/workspace.ts packages/core/src/index.ts packages/core/src/__tests__/workspace-return-schemas.test.ts
git commit -m "[ARCH-12] add WorkspaceApply/Diff/Delta returns schemas in @ax/core (passthrough lazy-fn changes)"
```

---

### Task 2: Attach `WorkspaceApplyOutputSchema` at the facade + `WorkspaceDiffOutputSchema` at all three backends

**Files:**
- Modify: `packages/core/src/workspace-apply-facade.ts` (attach apply schema)
- Modify: `packages/workspace-git-core/src/impl.ts:919-973` (attach diff schema; import)
- Modify: `packages/workspace-git-server/src/client/plugin.ts:317-328` (attach diff schema; import)
- Modify: `packages/test-harness/src/mock-workspace.ts:237-275` (attach diff schema; import)
- Test: the existing cross-backend contract suite is the guard (Task 3 runs it)

- [ ] **Step 1: Attach the apply schema at the facade**

In `packages/core/src/workspace-apply-facade.ts`, import `WorkspaceApplyOutputSchema` from `./workspace.js` and pass it as the `opts` arg on the facade's `registerService`:

```ts
import {
  type FileChange,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceDelta,
  type WorkspaceVersion,
  WorkspaceApplyOutputSchema,
} from './workspace.js';
```

```ts
  bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
    'workspace:apply',
    plugin,
    async (ctx, input) => {
      // ... unchanged body ...
      return applied;
    },
    { returns: WorkspaceApplyOutputSchema },
  );
```

- [ ] **Step 2: Attach the diff schema in git-core**

In `packages/workspace-git-core/src/impl.ts`, add `WorkspaceDiffOutputSchema` to the existing `@ax/core` import block (alongside `WorkspaceListOutputSchema`, `WorkspaceReadOutputSchema`), then add the `opts` arg to the `workspace:diff` `registerService` (currently ends at line ~973 with no opts):

```ts
  bus.registerService<WorkspaceDiffInput, WorkspaceDiffOutput>(
    'workspace:diff',
    PLUGIN_NAME,
    async (_ctx, input) => {
      // ... unchanged body ...
      return { delta };
    },
    { returns: WorkspaceDiffOutputSchema },
  );
```

- [ ] **Step 3: Attach the diff schema in the git-server client**

In `packages/workspace-git-server/src/client/plugin.ts`, add `WorkspaceDiffOutputSchema` to the `@ax/core` import (alongside `WorkspaceListOutputSchema`, `WorkspaceReadOutputSchema`), then add the `opts` arg to the `workspace:diff` registration (line ~317):

```ts
      bus.registerService<WorkspaceDiffInput, WorkspaceDiffOutput>(
        'workspace:diff',
        PLUGIN_NAME,
        async (ctx, input) => {
          // ... unchanged body ...
        },
        { returns: WorkspaceDiffOutputSchema },
      );
```

- [ ] **Step 4: Attach the diff schema in the mock**

In `packages/test-harness/src/mock-workspace.ts`, add `WorkspaceDiffOutputSchema` to the `@ax/core` import (alongside `WorkspaceListOutputSchema`, `WorkspaceReadOutputSchema`), then add the `opts` arg to the `workspace:diff` registration (line ~237, currently ends `return { delta }; }` with no opts):

```ts
      bus.registerService<WorkspaceDiffInput, WorkspaceDiffOutput>(
        'workspace:diff',
        PLUGIN_NAME,
        async (_ctx, input) => {
          // ... unchanged body ...
          return { delta };
        },
        { returns: WorkspaceDiffOutputSchema },
      );
```

- [ ] **Step 5: Typecheck + build the four touched packages**

Run: `pnpm --filter @ax/core --filter @ax/workspace-git-core --filter @ax/workspace-git-server --filter @ax/test-harness build`
Expected: tsc clean (the `ZodType<O>` cast in Task 1 makes the schemas assignable to `returns?: ZodType<O>`).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/workspace-apply-facade.ts packages/workspace-git-core/src/impl.ts packages/workspace-git-server/src/client/plugin.ts packages/test-harness/src/mock-workspace.ts
git commit -m "[ARCH-12] wire WorkspaceApply/Diff returns schemas at facade + 3 workspace:diff backends"
```

---

### Task 3: Re-confirm the cross-backend contract (both backends) end-to-end

**Files:**
- Verify (no edit expected): `packages/test-harness/src/workspace-contract.ts` — its `contentAfter is lazy` test (line ~145) and `diff between two versions` test (line ~157) now exercise the schema'd `workspace:apply`/`diff` through the bus.
- The contract suite runs against BOTH the mock (`mock-workspace.test.ts`) and the git backend (`packages/workspace-git-core` / `workspace-git-server` contract test files).

- [ ] **Step 1: Identify every contract-suite runner**

Run: `grep -rln "runWorkspaceContract" packages --include=*.ts | grep -v node_modules`
Expected: lists the mock harness test + the git backend(s) contract test files.

- [ ] **Step 2: Run the contract suite on the mock backend**

Run: `pnpm --filter @ax/test-harness test -- mock-workspace`
Expected: PASS — in particular `contentAfter is lazy — not invoked unless called` (`typeof ch.contentAfter === 'function'` + `await ch.contentAfter!()` returns the bytes) and `diff between two versions returns the same delta shape`. This proves the attached `apply`/`diff` schemas did NOT strip the lazy fns when routed through a real bus call.

- [ ] **Step 3: Run the contract suite on the git backend(s)**

Run: `pnpm --filter @ax/workspace-git-server test` and (if it has its own contract runner) `pnpm --filter @ax/workspace-git-core test`
Expected: PASS — same `contentAfter`/`diff` assertions green against the git impl, proving the schema is non-stripping on the production write path too.

- [ ] **Step 4: Commit (only if any test file needed a tweak; otherwise skip)**

```bash
git add -A && git commit -m "[ARCH-12] re-confirm cross-backend workspace contract under returns schemas"
```

---

### Task 4: Whole-repo gate

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: all packages tsc-clean.

- [ ] **Step 2: Full test**

Run: `pnpm test`
Expected: all suites green (core return-schema unit tests + both-backend contract suites + downstream consumers like `@ax/routines` that read `change.contentAfter`).

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: clean (no `no-restricted-imports` violation — schemas are imported from `@ax/core`, which every workspace backend already imports).

- [ ] **Step 4: Commit any gate fixes**

```bash
git add -A && git commit -m "[ARCH-12] gate fixes"
```

---

## Boundary review (security-critical write path)

This patch adds a `returns` validator to existing hook registrations; it does NOT change any hook name, payload field, or signature. Per CLAUDE.md "Patches that only change a plugin's internal implementation (no hook-surface change) don't need boundary review." Recorded anyway because `workspace:apply` is a write path:

- **Alternate impl this hook could have:** GCS-backed workspace (the whole reason the surface is storage-neutral). The schema lives in `@ax/core` so a GCS backend reuses it unchanged.
- **Payload field names that might leak:** none. `version`/`before`/`after` are `z.string()` (opaque `WorkspaceVersion`), `path`/`kind`/`reason`/`author` are backend-neutral. No `sha`/`oid`/`commit`/`bundle` in the schema.
- **Subscriber risk:** none new — the schema is a non-stripping superset (`.passthrough()`), so subscribers see exactly the same object they saw before (incl. the lazy fns).
- **Wire surface:** the IPC wire shape for these hooks already lives in `@ax/ipc-protocol`; this `returns` schema is the in-process defense-in-depth assertion, not the wire contract.

## Self-Review

- **Spec coverage:** apply schema (Task 1+2), diff schema (Task 1+2), `.passthrough()` on changes (Task 1 Step 3), both-backend `workspace-contract.ts` re-verification (Task 3), git + mock both covered (Task 3 Steps 2-3). ✓
- **Placeholder scan:** none — all code shown. ✓
- **Type consistency:** `WorkspaceDeltaSchema`/`WorkspaceApplyOutputSchema`/`WorkspaceDiffOutputSchema` named consistently across all tasks; `{ returns: ... }` opts arg matches `registerService`'s 4th param. ✓
- **YAGNI:** no new package, no schema on backend-private `apply-internal` (facade covers it), no brand-new both-backend test file (existing contract suite already covers both). ✓
