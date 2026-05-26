# JIT Phase 1a — Bundle Contract + Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a skill a *bundle* (a file tree) end-to-end — `SKILL.md` plus zero-or-more supporting files — so later phases (open-mode authoring, share-to-catalog) can ship multi-file skills, while every existing single-file skill keeps working byte-identically.

**Architecture:** `SKILL.md` stays as today's `manifest_yaml`/`body_md` columns (the parsed index). A new additive `skills_v1_skill_files` table holds *extra* (non-`SKILL.md`) files. Resolve reconstructs the bundle = reconstructed `SKILL.md` + extra files. The sandbox materialization contract changes from a single `skillMd: string` to `files: { path, contents }[]` across orchestrator → sandbox-protocol → sandbox-k8s → runner → sandbox-subprocess, with path-safety + veto-list + caps re-validated at each trust boundary (the `validateMcpEntry` defense-in-depth pattern). No git storage in this phase (deferred to P5/P6 per the planning decision); no data backfill (existing skills have zero extra-file rows).

**Tech Stack:** TypeScript, pnpm workspace, kysely + Postgres (testcontainers in tests), zod (sandbox-protocol), vitest.

**Scope guardrails:**
- This phase changes the **shape** of `skills:upsert`/`skills:resolve` (hook-surface change) and the `sandbox:open-session` `installedSkills` contract. Boundary-review note: the new payload field is `files: { path, contents }[]` — storage-agnostic, no backend vocabulary, no leak.
- **Security-checklist applies** (sandbox materialization + untrusted bundle content). Run the `security-checklist` skill before opening the PR; the threat is path-traversal / writing outside the skill dir / smuggling SDK-config files — addressed by the veto-list + post-join containment check at the runner boundary (Tasks 4, 7, 8).
- **Half-wired window:** the multi-file *write* path (`skills:upsert` `files`) has no production caller until P5 authoring. It is exercised by tests + the canary here. State this in the PR "half-wired window OPEN" section; it CLOSES in P5.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/skills/src/migrations.ts` | DDL for skills tables | **add** `skills_v1_skill_files` table + row type |
| `packages/skills/src/store.ts` | global skill storage | **add** extra-file write/read |
| `packages/skills/src/user-store.ts` | user-scoped skill storage | **add** extra-file write/read |
| `packages/skills/src/types.ts` | public I/O shapes | **add** `files` to upsert input + resolved/detail outputs |
| `packages/skills/src/bundle-files.ts` | **new** — bundle-file path/veto/caps validator (pure fn) | **create** |
| `packages/skills/src/plugin.ts` | hook handlers | **wire** validation + pass `files` through upsert/resolve |
| `packages/sandbox-protocol/src/schemas.ts` | open-session zod contract | **change** `InstalledSkillSchema` `skillMd`→`files` |
| `packages/chat-orchestrator/src/orchestrator.ts` | builds `InstalledSkillForSandbox` | **change** `skillMd`→`files` + construction |
| `packages/sandbox-k8s/src/pod-spec.ts` | `AX_INSTALLED_SKILLS_JSON` producer | **change** type + encoding + cap |
| `packages/agent-claude-sdk-runner/src/installed-skills.ts` | k8s runner materializer | **change** to write `files[]` + revalidate |
| `packages/sandbox-subprocess/src/open-session.ts` | subprocess materializer | **change** to write `files[]` + revalidate |
| `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` | end-to-end canary | **extend** with a multi-file bundle case |

---

## Shared rule: bundle-file validity (referenced by Tasks 3, 4, 7, 8)

A **valid extra-file path** is:
- relative, POSIX, matching `^[a-z0-9._-]+(\/[a-z0-9._-]+)*$` (no leading `/`, no `..`, no backslashes, no control chars);
- **not** a reserved/generated/SDK-config path: not `SKILL.md` (reconstructed from columns), not `.mcp.json` (generated from `mcpServers`), and not under `.claude/` or `.git/`.

**Caps:** ≤ 16 extra files per skill; path ≤ 256 chars; per-file contents ≤ 256 KiB; total extra-file bytes ≤ 512 KiB.

These rules are enforced **independently** at three trust boundaries (no shared import across the plugin boundary — invariant I2): on write (`@ax/skills`, Task 3), in the wire schema (`@ax/sandbox-protocol`, Task 4), and at the runner extract boundary (Tasks 7 & 8).

---

### Task 1: Add the `skills_v1_skill_files` table

**Files:**
- Modify: `packages/skills/src/migrations.ts`
- Test: `packages/skills/src/__tests__/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `migrations.test.ts` (mirrors the existing testcontainers + `makeKysely()` + `runSkillsMigration` pattern in that file):

```typescript
it('creates skills_v1_skill_files with the compound PK', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);

  // Insert two files for one skill; the compound PK (scope, owner_user_id,
  // skill_id, path) must allow distinct paths and reject a duplicate path.
  await db
    .insertInto('skills_v1_skill_files')
    .values([
      { scope: 'global', owner_user_id: '', skill_id: 'demo', path: 'scripts/a.py', contents: 'print(1)' },
      { scope: 'global', owner_user_id: '', skill_id: 'demo', path: 'data/b.json', contents: '{}' },
    ])
    .execute();

  const rows = await db
    .selectFrom('skills_v1_skill_files')
    .selectAll()
    .where('skill_id', '=', 'demo')
    .orderBy('path')
    .execute();
  expect(rows.map((r) => r.path)).toEqual(['data/b.json', 'scripts/a.py']);

  await expect(
    db
      .insertInto('skills_v1_skill_files')
      .values({ scope: 'global', owner_user_id: '', skill_id: 'demo', path: 'scripts/a.py', contents: 'dup' })
      .execute(),
  ).rejects.toThrow();
});
```

Also extend the `afterEach` teardown in this file to drop the new table **before** the existing two (it has no FK, but keep drop order tidy):

```typescript
await k.schema.dropTable('skills_v1_skill_files').ifExists().execute();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/migrations.test.ts`
Expected: FAIL — relation `skills_v1_skill_files` does not exist.

- [ ] **Step 3: Add the table to the migration + the row type**

In `packages/skills/src/migrations.ts`, inside `runSkillsMigration`, after the existing `ALTER TABLE` statements, add:

```typescript
await db.schema
  .createTable('skills_v1_skill_files')
  .ifNotExists()
  .addColumn('scope', 'text', (c) => c.notNull())
  .addColumn('owner_user_id', 'text', (c) => c.notNull().defaultTo(''))
  .addColumn('skill_id', 'text', (c) => c.notNull())
  .addColumn('path', 'text', (c) => c.notNull())
  .addColumn('contents', 'text', (c) => c.notNull())
  .addPrimaryKeyConstraint('skills_v1_skill_files_pk', [
    'scope',
    'owner_user_id',
    'skill_id',
    'path',
  ])
  .execute();
```

Add the row interface and extend `SkillsDatabase`:

```typescript
export interface SkillFileRow {
  scope: 'global' | 'user';
  owner_user_id: string; // '' for global
  skill_id: string;
  path: string;
  contents: string;
}

export interface SkillsDatabase {
  skills_v1_skills: SkillsRow;
  skills_v1_user_skills: UserSkillsRow;
  skills_v1_skill_files: SkillFileRow; // <-- add
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/migrations.ts packages/skills/src/__tests__/migrations.test.ts
git commit -m "feat(skills): add skills_v1_skill_files table for bundle extra files"
```

---

### Task 2: Create the bundle-file validator (pure function)

**Files:**
- Create: `packages/skills/src/bundle-files.ts`
- Test: `packages/skills/src/__tests__/bundle-files.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { validateBundleFiles } from '../bundle-files.js';

describe('validateBundleFiles', () => {
  it('accepts well-formed extra files', () => {
    expect(() =>
      validateBundleFiles([
        { path: 'scripts/run.py', contents: 'print(1)' },
        { path: 'data/x.json', contents: '{}' },
      ]),
    ).not.toThrow();
  });

  it.each([
    ['SKILL.md', 'reserved'],
    ['.mcp.json', 'reserved'],
    ['.claude/settings.json', 'reserved'],
    ['../escape.txt', 'invalid path'],
    ['/abs.txt', 'invalid path'],
    ['UP.txt', 'invalid path'], // uppercase not allowed by charset
  ])('rejects %s', (path) => {
    expect(() => validateBundleFiles([{ path, contents: 'x' }])).toThrow();
  });

  it('rejects duplicate paths', () => {
    expect(() =>
      validateBundleFiles([
        { path: 'a.txt', contents: '1' },
        { path: 'a.txt', contents: '2' },
      ]),
    ).toThrow(/duplicate/i);
  });

  it('enforces caps', () => {
    const tooMany = Array.from({ length: 17 }, (_, i) => ({ path: `f${i}.txt`, contents: 'x' }));
    expect(() => validateBundleFiles(tooMany)).toThrow(/at most 16/);
    expect(() => validateBundleFiles([{ path: 'big.txt', contents: 'x'.repeat(256 * 1024 + 1) }])).toThrow(/256 KiB/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/bundle-files.test.ts`
Expected: FAIL — cannot find module `../bundle-files.js`.

- [ ] **Step 3: Implement the validator**

Create `packages/skills/src/bundle-files.ts`:

```typescript
/**
 * Bundle extra-file validation — the canonical rules for the non-SKILL.md
 * files a skill bundle may carry. Pure function; re-implemented (not imported)
 * at the sandbox-protocol and runner trust boundaries per invariant I2.
 */
export interface BundleFile {
  path: string;
  contents: string;
}

const PATH_RE = /^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/;
const RESERVED = new Set(['SKILL.md', '.mcp.json']);
const MAX_FILES = 16;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_PATH_LEN = 256;

export function validateBundleFiles(files: BundleFile[]): void {
  if (files.length > MAX_FILES) {
    throw new Error(`bundle may declare at most 16 extra files, got ${files.length}`);
  }
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (typeof f.path !== 'string' || f.path.length === 0 || f.path.length > MAX_PATH_LEN) {
      throw new Error(`invalid bundle file path: ${JSON.stringify(f.path)}`);
    }
    if (f.path.includes('..') || f.path.startsWith('/') || !PATH_RE.test(f.path)) {
      throw new Error(`invalid path (must be relative, lowercase, no ../): ${f.path}`);
    }
    if (RESERVED.has(f.path) || f.path.startsWith('.claude/') || f.path.startsWith('.git/')) {
      throw new Error(`reserved bundle path may not be supplied: ${f.path}`);
    }
    if (seen.has(f.path)) throw new Error(`duplicate bundle path: ${f.path}`);
    seen.add(f.path);
    const bytes = Buffer.byteLength(f.contents, 'utf-8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`bundle file '${f.path}' exceeds 256 KiB`);
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error(`bundle extra files exceed 512 KiB total`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/bundle-files.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/bundle-files.ts packages/skills/src/__tests__/bundle-files.test.ts
git commit -m "feat(skills): bundle extra-file validator (path/veto/caps)"
```

---

### Task 3: Store extra files on upsert; return them on resolve/get

**Files:**
- Modify: `packages/skills/src/store.ts`, `packages/skills/src/user-store.ts`, `packages/skills/src/_row-mappers.ts`, `packages/skills/src/types.ts`
- Test: `packages/skills/src/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `store.test.ts` (uses the existing `makeKysely()` + `createSkillsStore` pattern):

```typescript
it('upsert stores extra files; get/resolve return them; re-upsert replaces', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);
  const store = createSkillsStore(db);

  await store.upsert({
    id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1,
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
  });

  const got = await store.get('demo');
  expect(got?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);

  const [resolved] = await store.resolve(['demo']);
  expect(resolved?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);

  // Re-upsert with a different file set fully replaces the old set.
  await store.upsert({
    id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 2,
    files: [{ path: 'data/x.json', contents: '{}' }],
  });
  const got2 = await store.get('demo');
  expect(got2?.files).toEqual([{ path: 'data/x.json', contents: '{}' }]);
});

it('a skill with no extra files reports files: []', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);
  const store = createSkillsStore(db);
  await store.upsert({ id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1 });
  const got = await store.get('demo');
  expect(got?.files).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/store.test.ts`
Expected: FAIL — `upsert` does not accept `files`; `files` is undefined on the result.

- [ ] **Step 3: Add `files` to the types**

In `packages/skills/src/types.ts`:

```typescript
// add to the resolved + detail shapes
export interface ResolvedSkill extends /* existing */ {
  // ...existing fields...
  files: { path: string; contents: string }[]; // extra (non-SKILL.md) bundle files
}
export interface SkillDetail extends SkillSummary {
  bodyMd: string;
  manifestYaml: string;
  files: { path: string; contents: string }[]; // <-- add
}
// upsert input gains optional extra files
export interface SkillsUpsertInput {
  manifestYaml: string;
  bodyMd: string;
  files?: { path: string; contents: string }[]; // <-- add (defaults to none)
  defaultAttached?: boolean;
  scope?: 'global' | 'user';
  ownerUserId?: string;
}
```

- [ ] **Step 4: Implement store write/read (global + user)**

In `packages/skills/src/store.ts`, extend the store's internal `UpsertInput` with `files?: { path: string; contents: string }[]` and, inside `upsert`, after writing the main row, replace the file set in the same logical operation:

```typescript
// after the INSERT/UPDATE of the skills_v1_skills row:
await db.deleteFrom('skills_v1_skill_files')
  .where('scope', '=', 'global').where('owner_user_id', '=', '').where('skill_id', '=', input.id)
  .execute();
const files = input.files ?? [];
if (files.length > 0) {
  await db.insertInto('skills_v1_skill_files')
    .values(files.map((f) => ({ scope: 'global' as const, owner_user_id: '', skill_id: input.id, path: f.path, contents: f.contents })))
    .execute();
}
```

Add a private helper used by `get` and `resolve` to fetch a skill's extra files (ordered by path for determinism):

```typescript
async function loadFiles(skillId: string): Promise<{ path: string; contents: string }[]> {
  const rows = await db.selectFrom('skills_v1_skill_files')
    .select(['path', 'contents'])
    .where('scope', '=', 'global').where('owner_user_id', '=', '').where('skill_id', '=', skillId)
    .orderBy('path').execute();
  return rows.map((r) => ({ path: r.path, contents: r.contents }));
}
```

In `get` and each `resolve` result, attach `files: await loadFiles(id)`. (For `resolve` over many ids, batch with a single `where('skill_id', 'in', ids)` query and group by `skill_id` to avoid N+1.)

Mirror all of the above in `packages/skills/src/user-store.ts`, but with `scope: 'user'` and `owner_user_id: ownerUserId` in every `where`/`values`.

In `packages/skills/src/_row-mappers.ts`, the mappers that build `SkillDetail`/`ResolvedSkill` must accept and pass through `files` (default `[]`), so callers that don't load files still produce a valid shape.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/store.ts packages/skills/src/user-store.ts packages/skills/src/_row-mappers.ts packages/skills/src/types.ts packages/skills/src/__tests__/store.test.ts
git commit -m "feat(skills): persist + resolve bundle extra files"
```

---

### Task 4: Wire validation into `skills:upsert`; thread `files` through hooks

**Files:**
- Modify: `packages/skills/src/plugin.ts`
- Test: `packages/skills/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('skills:upsert rejects a bundle file that escapes the dir', async () => {
  const h = await makeHarness();
  await expect(
    h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY,
      files: [{ path: '../evil.txt', contents: 'x' }],
    }),
  ).rejects.toThrow(/invalid path/i);
});

it('skills:resolve returns bundle files for a multi-file skill', async () => {
  const h = await makeHarness();
  await h.bus.call('skills:upsert', h.ctx(), {
    manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY,
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
  });
  const out = await h.bus.call<SkillsResolveInput, SkillsResolveOutput>('skills:resolve', h.ctx(), { skillIds: ['github'] });
  expect(out.skills[0]?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
});
```

(`'github'` is the id in `SAMPLE_MANIFEST`, per the existing plugin tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/plugin.test.ts`
Expected: FAIL — upsert does not validate/forward `files`.

- [ ] **Step 3: Wire it in `plugin.ts`**

In the `skills:upsert` handler, after parsing the manifest and before calling the store, validate and forward the optional files:

```typescript
import { validateBundleFiles } from './bundle-files.js';
// ...
const files = (input as SkillsUpsertInput).files ?? [];
validateBundleFiles(files); // throws on bad path / veto / caps
// pass `files` into store.upsert({ ..., files }) / userStore.upsert({ ..., files })
```

No change needed to the `skills:resolve` handler body beyond ensuring it returns the store's `files` (Task 3 already populates `ResolvedSkill.files`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test`
Expected: PASS (whole package green).

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/plugin.ts packages/skills/src/__tests__/plugin.test.ts
git commit -m "feat(skills): validate + forward bundle files through upsert/resolve"
```

---

### Task 5: Change the `sandbox-protocol` contract (`skillMd` → `files`)

**Files:**
- Modify: `packages/sandbox-protocol/src/schemas.ts`
- Test: `packages/sandbox-protocol/src/__tests__/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('InstalledSkillSchema requires a SKILL.md file and rejects traversal', () => {
  const ok = InstalledSkillSchema.safeParse({
    id: 'demo',
    files: [{ path: 'SKILL.md', contents: '# x' }, { path: 'scripts/a.py', contents: 'print(1)' }],
  });
  expect(ok.success).toBe(true);

  const noSkillMd = InstalledSkillSchema.safeParse({ id: 'demo', files: [{ path: 'a.txt', contents: 'x' }] });
  expect(noSkillMd.success).toBe(false);

  const traversal = InstalledSkillSchema.safeParse({
    id: 'demo', files: [{ path: 'SKILL.md', contents: '# x' }, { path: '../e.txt', contents: 'x' }],
  });
  expect(traversal.success).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/sandbox-protocol test`
Expected: FAIL — schema still has `skillMd`.

- [ ] **Step 3: Update the schema**

In `packages/sandbox-protocol/src/schemas.ts`, replace the `skillMd` field of `InstalledSkillSchema` with a `files` array. `SKILL.md` is allowed here (it is the root file at this hop); the traversal/charset rules still apply to every path:

```typescript
const SKILL_FILE_PATH_RE = /^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/;

export const InstalledSkillSchema = z.object({
  id: z.string().regex(ID_RE, 'invalid skill id shape'),
  files: z
    .array(
      z.object({
        path: z
          .string().min(1).max(256)
          .regex(SKILL_FILE_PATH_RE, 'invalid file path')
          .refine((p) => !p.includes('..'), 'no parent traversal'),
        contents: z.string().min(0).max(256 * 1024),
      }),
    )
    .min(1).max(24)
    .refine((fs) => fs.some((f) => f.path === 'SKILL.md'), 'files must include SKILL.md'),
  mcpServers: z.array(McpServerSchema).max(8).default([]),
  allowedHosts: z.array(z.string().max(256)).max(64).default([]),
  credentials: z.array(z.object({ slot: z.string().max(64), kind: z.literal('api-key') })).max(32).default([]),
});
```

(`max(24)` = 16 extra files + SKILL.md + headroom; the 16-extra cap is enforced upstream in `@ax/skills`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/sandbox-protocol test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-protocol/src/schemas.ts packages/sandbox-protocol/src/__tests__/schemas.test.ts
git commit -m "feat(sandbox-protocol): installedSkills carries a file tree, not skillMd"
```

---

### Task 6: Orchestrator builds `files[]`

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

Add an assertion (or extend an existing open-session test) that the `installedSkills` passed to `sandbox:open-session` carry a `SKILL.md` file plus any resolved extra files. Use the existing harness/mock for `skills:resolve` to return a skill with `files: [{ path: 'scripts/a.py', contents: 'print(1)' }]`, then assert the captured `sandbox:open-session` input:

```typescript
const skill = captured.installedSkills[0];
expect(skill.files.find((f) => f.path === 'SKILL.md')).toBeTruthy();
expect(skill.files.find((f) => f.path === 'scripts/a.py')?.contents).toBe('print(1)');
expect('skillMd' in skill).toBe(false);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/chat-orchestrator test`
Expected: FAIL — `skill.files` undefined; `skillMd` still present.

- [ ] **Step 3: Update the type + construction**

In `orchestrator.ts`, change `InstalledSkillForSandbox`:

```typescript
interface InstalledSkillForSandbox {
  id: string;
  files: { path: string; contents: string }[]; // SKILL.md (reconstructed) + extra files
  mcpServers: McpServerSpecForOrch[];
  allowedHosts: string[];
  credentials: Array<{ slot: string; kind: 'api-key' }>;
}
```

And the construction site (the `unionedSkills.map(...)`):

```typescript
const installedSkillsForSandbox: InstalledSkillForSandbox[] = unionedSkills.map((s) => ({
  id: s.id,
  files: [
    {
      path: 'SKILL.md',
      contents: '---\n' + s.manifestYaml + (s.manifestYaml.endsWith('\n') ? '' : '\n') + '---\n' + s.bodyMd,
    },
    ...(s.files ?? []).map((f) => ({ path: f.path, contents: f.contents })),
  ],
  mcpServers: s.capabilities.mcpServers ?? [],
  allowedHosts: s.capabilities.allowedHosts ?? [],
  credentials: (s.capabilities.credentials ?? []).map((c) => ({ slot: c.slot, kind: 'api-key' as const })),
}));
```

(`s.files` comes from `ResolvedSkill.files` defined in Task 3. The orchestrator's local `ResolvedSkillForOrch` type must also gain `files?: { path: string; contents: string }[]`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/chat-orchestrator test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/__tests__/orchestrator.test.ts
git commit -m "feat(orchestrator): build installedSkills file tree (SKILL.md + extras)"
```

---

### Task 7: k8s producer ships `files` in `AX_INSTALLED_SKILLS_JSON`

**Files:**
- Modify: `packages/sandbox-k8s/src/pod-spec.ts`
- Test: `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('encodes installedSkills files into AX_INSTALLED_SKILLS_JSON', () => {
  const spec = buildPodSpec({
    /* ...existing required fields... */
    installedSkills: [{ id: 'demo', files: [{ path: 'SKILL.md', contents: '# x' }] }],
  });
  const env = findEnv(spec, 'AX_INSTALLED_SKILLS_JSON');
  const parsed = JSON.parse(env!.value!);
  expect(parsed[0].files[0]).toEqual({ path: 'SKILL.md', contents: '# x' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/sandbox-k8s test`
Expected: FAIL — type/encoding still keyed on `skillMd`.

- [ ] **Step 3: Update the input type + cap**

In `pod-spec.ts`, change the `installedSkills` input type's `skillMd: string` to `files: { path: string; contents: string }[]`, and bump the size guard (a file tree is larger than a single string):

```typescript
installedSkills?: Array<{
  id: string;
  files: { path: string; contents: string }[];
  mcpServers?: McpServerSpecLike[];
  allowedHosts?: string[];
  credentials?: Array<{ slot: string; kind: 'api-key' }>;
}>;
// ...
const encoded = JSON.stringify(input.installedSkills);
if (Buffer.byteLength(encoded, 'utf-8') > 768 * 1024) {
  throw new Error('AX_INSTALLED_SKILLS_JSON payload over 768 KiB — too large for env var transport');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/sandbox-k8s test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-k8s/src/pod-spec.ts packages/sandbox-k8s/src/__tests__/pod-spec.test.ts
git commit -m "feat(sandbox-k8s): ship skill file tree in AX_INSTALLED_SKILLS_JSON"
```

---

### Task 8: Runner materializes `files[]` (k8s path)

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/installed-skills.ts`
- Test: `packages/agent-claude-sdk-runner/src/__tests__/installed-skills.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('materializes a multi-file bundle read-only and rejects traversal', async () => {
  const ccd = await mkdtempConfigDir(); // existing helper pattern in this test file
  process.env.CLAUDE_CONFIG_DIR = ccd;
  process.env.AX_INSTALLED_SKILLS_JSON = JSON.stringify([
    { id: 'demo', files: [{ path: 'SKILL.md', contents: '# x' }, { path: 'scripts/a.py', contents: 'print(1)' }] },
  ]);
  await materializeInstalledSkillsFromEnv();
  const body = await fs.readFile(path.join(ccd, 'skills', 'demo', 'scripts', 'a.py'), 'utf-8');
  expect(body).toBe('print(1)');
  const st = await fs.stat(path.join(ccd, 'skills', 'demo', 'scripts', 'a.py'));
  expect(st.mode & 0o222).toBe(0); // not writable

  process.env.AX_INSTALLED_SKILLS_JSON = JSON.stringify([
    { id: 'demo2', files: [{ path: 'SKILL.md', contents: '# x' }, { path: '../escape.txt', contents: 'x' }] },
  ]);
  await expect(materializeInstalledSkillsFromEnv()).rejects.toThrow(/invalid|escape/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/agent-claude-sdk-runner test -- src/__tests__/installed-skills.test.ts`
Expected: FAIL — materializer still reads `skillMd`.

- [ ] **Step 3: Rewrite the per-entry loop to write files with re-validation**

In `installed-skills.ts`, replace the `skillMd` read + single `SKILL.md` write with a files loop. Re-validate every path at this trust boundary (defense-in-depth — a buggy/compromised host could otherwise write outside the skill dir):

```typescript
const SKILL_FILE_PATH_RE = /^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/;

function assertSafeRelPath(p: string): void {
  if (typeof p !== 'string' || p.length === 0 || p.length > 256) throw new Error(`invalid skill file path: ${String(p)}`);
  if (p.includes('..') || p.startsWith('/') || !SKILL_FILE_PATH_RE.test(p)) throw new Error(`invalid skill file path (traversal/charset): ${p}`);
  if (p === '.mcp.json' || p.startsWith('.claude/') || p.startsWith('.git/')) throw new Error(`reserved skill file path: ${p}`);
}

// inside the per-entry loop, after validating e.id:
const files = obj['files'];
if (!Array.isArray(files) || files.length === 0) {
  throw new Error(`installed skill '${e.id}' must carry a non-empty files array`);
}
let sawSkillMd = false;
for (const file of files as Array<{ path: string; contents: string }>) {
  assertSafeRelPath(file.path);
  if (file.path === 'SKILL.md') sawSkillMd = true;
  const full = path.join(skillDir, file.path);
  // post-join containment guard (belt-and-suspenders over the regex)
  if (full !== skillDir && !full.startsWith(skillDir + path.sep)) {
    throw new Error(`skill file '${file.path}' escapes skill dir`);
  }
  await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o755 });
  await fs.writeFile(full, file.contents, { mode: 0o444, encoding: 'utf-8' });
}
if (!sawSkillMd) throw new Error(`installed skill '${e.id}' is missing SKILL.md`);
```

Leave the existing `.mcp.json` generation from `mcpServers` and the final `chmod(skillsDir, 0o555)` exactly as-is — they run after the files loop.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/agent-claude-sdk-runner test -- src/__tests__/installed-skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/installed-skills.ts packages/agent-claude-sdk-runner/src/__tests__/installed-skills.test.ts
git commit -m "feat(runner): materialize skill bundle file tree with extract-boundary validation"
```

---

### Task 9: Subprocess sandbox materializes `files[]`

**Files:**
- Modify: `packages/sandbox-subprocess/src/open-session.ts`
- Test: `packages/sandbox-subprocess/src/__tests__/open-session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('writes a multi-file bundle read-only', async () => {
  const { configDir } = await openSessionForTest({
    installedSkills: [{ id: 'demo', files: [{ path: 'SKILL.md', contents: '# x' }, { path: 'scripts/a.py', contents: 'print(1)' }], mcpServers: [] }],
  });
  const body = await fs.readFile(path.join(configDir, 'skills', 'demo', 'scripts', 'a.py'), 'utf-8');
  expect(body).toBe('print(1)');
});
```

(Use the file's existing open-session test helper; mirror its setup.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/sandbox-subprocess test`
Expected: FAIL — materializer still reads `skill.skillMd`.

- [ ] **Step 3: Apply the same files loop**

In `open-session.ts`, inside the `for (const skill of input.installedSkills)` block, replace the single `SKILL.md` write with the same validated files loop as Task 8 Step 3 (copy it verbatim — `assertSafeRelPath` + the per-file write + the SKILL.md presence check), keeping the `.mcp.json` generation and the trailing `chmod(installedSkillsDir, 0o555)` unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/sandbox-subprocess test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-subprocess/src/open-session.ts packages/sandbox-subprocess/src/__tests__/open-session.test.ts
git commit -m "feat(sandbox-subprocess): materialize skill bundle file tree"
```

---

### Task 10: End-to-end canary + full verification

**Files:**
- Modify: `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts`

- [ ] **Step 1: Extend the canary**

Add a case that upserts a skill **with an extra file**, resolves it through the orchestrator path the canary already exercises, and asserts the materialized sandbox dir contains both `SKILL.md` and the extra file (read-only). Add a second assertion that a **single-file** skill (no `files`) still materializes exactly `SKILL.md` and nothing else — the byte-identical-behavior guarantee.

- [ ] **Step 2: Run the canary**

Run: `pnpm -F @ax/skills test -- src/__tests__/e2e/skill-install.canary.test.ts`
Expected: PASS.

- [ ] **Step 3: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. (Per repo convention — build catches undeclared workspace deps that vitest tolerates; lint scoped to changed files to avoid stale-worktree noise.)

- [ ] **Step 4: Run the security-checklist skill**

Invoke the `security-checklist` skill and answer all three threat models. Key item: path-traversal / writing outside the skill dir / smuggling `.mcp.json`/`.claude/*` — confirm the veto-list + regex + post-join containment guard at Tasks 4, 5, 8, 9 cover it. Paste the structured note into the PR.

- [ ] **Step 5: Commit + open PR**

```bash
git add packages/skills/src/__tests__/e2e/skill-install.canary.test.ts
git commit -m "test(skills): canary covers multi-file bundle + single-file byte-identical"
```

PR description must include:
- **Boundary review:** new payload field `files: { path, contents }[]` — storage-agnostic, no leak; alternate impl = git-tree storage (deferred to P5/P6).
- **Half-wired window OPEN:** the multi-file *write* path (`skills:upsert` `files`) has no production caller until P5 authoring; exercised by tests + canary here. Window CLOSES in P5.
- The security-checklist note.

---

## Self-Review

**Spec coverage** (against design §9.2 + the "Contract+model now" decision):
- "Skill is a file tree end-to-end" → Tasks 1–9 (storage → contract → both materializers). ✓
- "Existing skills byte-identical, no backfill" → SKILL.md stays in `manifest_yaml`/`body_md`; extra-files table empty for existing skills; canary asserts single-file unchanged (Task 10). ✓
- "Extract-boundary validation (path/veto/exec-bit)" → Task 2 (write), Task 5 (wire), Tasks 8/9 (runner, read-only `0o444`/`0o555`). ✓
- "No git storage this phase" → storage is the DB files table; git deferred. ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. No TBD/TODO. ✓

**Type consistency:** the field is `files: { path: string; contents: string }[]` everywhere (`SkillsUpsertInput`, `ResolvedSkill`, `SkillDetail`, `InstalledSkillForSandbox`, `InstalledSkillSchema`, pod-spec input, both materializers); `skillMd` is fully removed from the sandbox path. `validateBundleFiles` (skills, excludes SKILL.md) vs `assertSafeRelPath` (runner, allows SKILL.md) are intentionally different (the runner hop legitimately carries SKILL.md as a file) — documented in Task 8.

**Known residual:** `skills:check-for-updates` / `refresh-from-source` operate on the manifest only and are unaffected (extra files aren't sourced from `sourceUrl` in this phase) — acceptable; revisit when remote bundles land.
