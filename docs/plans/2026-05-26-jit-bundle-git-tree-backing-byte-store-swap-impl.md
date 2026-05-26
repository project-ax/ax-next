# JIT — Bundle Git-Tree Backing (Byte-Store Swap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the Phase-1a `skills_v1_skill_files` DB byte-store for **content-addressed git trees**, so a catalog entry becomes `{ skillId, scope, version, treeSha }` + the existing parsed SKILL.md index — buying integrity (the tree SHA pins exact bytes), free dedup, versioning, and the drift-free promotion story (§6D) — **without changing the `files[]` contract** (no hook-surface change, no sandbox-protocol change, no materializer change).

**Architecture:** `@ax/skills` gains its **own** content-addressed git object store (a bare repo via `isomorphic-git`, the *same third-party library* `@ax/workspace-git-core` already uses — **not** a cross-plugin import, and **not** the workspace plugin's hooks). The store writes the extra (non-SKILL.md) files of a bundle as a git tree and returns the root tree SHA; the catalog row gains a nullable `bundle_tree_sha` column that replaces the `skills_v1_skill_files` table as the byte-store. `skills:upsert`/`resolve`/`get` keep **byte-identical I/O shapes** — only *where the extra-file bytes live* changes. Read-back walks the tree and **re-validates path/veto/caps + rejects any non-`100644` blob mode** (symlink `120000` / exec-bit `100755` / submodule) at the git-extract boundary — a forward guard for the P5/P6 author-workspace-tree flow, since `isomorphic-git`'s `readTree` exposes modes (the workspace store's `ls-tree --name-only` path does not).

**Tech Stack:** TypeScript, pnpm workspace, kysely + Postgres (testcontainers in tests), `isomorphic-git@1.37.5` (pinned to the version already in the lockfile via `@ax/workspace-git-core`), vitest, Helm (chart render tests).

**Scope guardrails:**

- **Boundary review: N/A (internal-implementation-only).** This task changes **no** hook signature: `skills:upsert`/`skills:resolve`/`skills:get` keep their exact `SkillsUpsertInput.files` / `ResolvedSkill.files` / `SkillDetail.files` shapes; `sandbox-protocol`'s `InstalledSkillSchema`, the orchestrator's `files[]` construction, and both runner materializers are **untouched**. Per CLAUDE.md, "patches that only change a plugin's internal implementation (no hook-surface change) don't need boundary review." The one new surface is a **construction-time plugin config** field (`bundleStore.repoRoot`) — plugin-local config, not a hook payload, no leak.
- **Security-checklist applies** (the card flags it: "storage + extract-boundary validation"). It is a **pre-PR gate** (Task 7). Pre-stated threat model:
  - **Supply chain:** the one new dependency, `isomorphic-git@1.37.5`, is **already present in the lockfile** (`@ax/workspace-git-core` depends on the exact same version); pinning to it adds **zero** new third-party code to the tree. Re-confirm the pin matches the lockfile entry.
  - **Sandbox escape / path-traversal at extract:** a git tree *could* (in the future P5/P6 author-workspace flow) carry a symlink (mode `120000`), an exec bit (`100755`), a submodule (`160000`/gitlink), a `..` segment, or a veto'd path (`.mcp.json`, `.claude/*`, `.git/*`). The bundle store's `readTree` rejects non-`100644` blob modes and non-`blob`/`tree` object types, then re-runs `validateBundleFiles` (charset / veto / caps / `.`/`..` segments) on the reconstructed paths (the `validateMcpEntry` defense-in-depth pattern). The **existing** three downstream boundaries (`sandbox-protocol` schema + both materializers) **still** re-validate `files[]` independently — unchanged.
  - **Prompt injection:** unchanged — no model/tool output enters the store path differently than before; the store sees only `validateBundleFiles`-checked input.
  - **Integrity:** content-addressing means a tampered blob changes the tree SHA, so a row's `bundle_tree_sha` pointing at the wrong/absent object fails `readTree` **loudly** rather than serving wrong bytes.
- **Half-wired window: stays OPEN (inherited from TASK-32, NOT newly opened).** The multi-file *write* path (`skills:upsert` with `files`) still has no production caller until **P5** (open-mode authoring / share-to-catalog); it is exercised by tests + the canary. TASK-40 **re-backs an existing half-wired store** — it does not open a *new* half-wired surface. Consequently the bundle repo's production **durability** is not load-bearing until P5 wires a writer (every deployed skill has `bundle_tree_sha = NULL` today, so every `resolve` returns `files: []` regardless of the repo). The window CLOSES in **P5**.

**Resolved implementation forks (do not relitigate — locked decision #10 stands; these resolve *mechanism* the as-built code left open):**

1. **Backing store = a skills-owned `isomorphic-git` bare repo** (confirmed with the human, 2026-05-26). The design's pointer to "the existing host-side git storage that already backs workspaces (`git-workspace.ts` infra)" is **stale**: `git-workspace.ts` is *runner-side* (it consumes a baseline bundle to build the sandbox HOME); the real host store (`@ax/workspace-git*`) exposes **no** content-addressed tree API (only per-`workspaceId` `workspace:apply`/`read`/`list`/`diff`, CAS-on-`parent`, returning an opaque `WorkspaceVersion` *commit* token — never a tree SHA), hardcodes mode `100644`, and discards modes on read. `@ax/skills` also **cannot import** `@ax/workspace-git-core` (invariant I2). So `@ax/skills` owns its own bare repo using the same `isomorphic-git` library directly — a true *internal swap*, no new hook (consistent with §11 listing none), and it can preserve+validate git modes (which the workspace store cannot).
2. **Extract host-side, not runner-fetch-by-SHA** (the one fork §11.8 explicitly leaves open). The card mandates "the `files[]` contract is unchanged," so the store reconstructs `files[]` host-side and everything downstream (orchestrator → sandbox-protocol → materializers) is untouched. The "runner fetches by SHA over the git wire" alternative is rejected because it *would* change the contract.
3. **The tree stores the *extra* (non-SKILL.md) files only** — a 1:1 replacement of what `skills_v1_skill_files` held. SKILL.md stays in `manifest_yaml`/`body_md` (the parsed index, untouched), so `resolve`/`get`/`upsert` shapes are byte-identical. Whole-bundle SHA pinning (SKILL.md *inside* the registered tree, for the §6D "shipped-bytes == reviewed-bytes" promotion proof) is a **P5/P6 promotion-task** refinement, not this swap.
4. **Multi-replica is a deferred lift (ARCH-9), accepted.** The bundle repo lives on the host PVC (single-replica posture, same as `@ax/workspace-git` local vs `-server`). The chart fails render for `replicas>1` today (ARCH-1); when multi-replica is unlocked, the catalog byte-store gets the same shared-storage treatment workspace-git-server got. Recorded so the next reader sees the trade.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/skills/src/migrations.ts` | DDL + row types for skills tables | **add** `bundle_tree_sha` column to both skill tables + both row interfaces |
| `packages/skills/src/bundle-store.ts` | **new** — content-addressed git object store (`isomorphic-git`) with extract-boundary mode/path validation | **create** |
| `packages/skills/src/store.ts` | global skill storage | **swap** extra-file byte-store from `skills_v1_skill_files` → bundle store + `bundle_tree_sha` |
| `packages/skills/src/user-store.ts` | user-scoped skill storage | **swap** same as `store.ts`, user scope |
| `packages/skills/src/plugin.ts` | hook handlers + wiring | **add** optional `SkillsPluginConfig`; construct the bundle store once and inject into both stores |
| `packages/skills/package.json` | deps | **add** `isomorphic-git: 1.37.5` |
| `presets/k8s/src/index.ts` | host plugin wiring | **read** `AX_SKILLS_BUNDLE_ROOT`, pass to `createSkillsPlugin` |
| `deploy/charts/ax-next/templates/host/deployment.yaml` | host pod env | **add** `AX_SKILLS_BUNDLE_ROOT` env (local backend) |
| `packages/skills/src/__tests__/migrations.test.ts` | migration tests | **extend** — `bundle_tree_sha` column |
| `packages/skills/src/__tests__/bundle-store.test.ts` | **new** — bundle-store unit tests | **create** |
| `packages/skills/src/__tests__/store.test.ts` | store tests | **extend** — git round-trip + `bundle_tree_sha` + cross-scope dedup |
| `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` | end-to-end canary | **regression guard** (internal swap must keep the existing multi-file case green) + 1 assertion |
| `presets/k8s/src/__tests__/preset.test.ts` | preset wiring test | **extend** — config plumbed |
| `deploy/charts/ax-next/__tests__/render.test.ts` | chart render test | **extend** — env present for local backend |

---

## Shared rule: git-extract validity (referenced by Tasks 2, 3, 4)

When a tree SHA is read back into `files[]`, every entry MUST satisfy **both** of:

1. **Git mode/type:** object `type` is `tree` (descend) or `blob`; a `blob` MUST have mode **exactly `100644`**. Reject `100755` (exec bit), `120000` (symlink), and any `commit`/gitlink (`160000`) entry. The design's "no-exec-bit / reject symlinks" rule lives here because `isomorphic-git`'s `readTree` exposes the mode (unlike the workspace store).
2. **Path/veto/caps:** the reconstructed extra-file set re-passes `validateBundleFiles` (relative POSIX lowercase charset, no `..`/`.` segments, no `SKILL.md`/`.mcp.json`/`.claude`/`.git`, ≤16 files, ≤256 KiB/file, ≤512 KiB total, no dir/file collisions).

These are enforced **independently** of the write-side `validateBundleFiles` (invariant I2 / `validateMcpEntry` defense-in-depth) — a buggy/compromised writer (or a future author-workspace tree registered by SHA) can't smuggle a bad file past extract.

**Git mode constants** (mirror `@ax/workspace-git-core`): `FILE_MODE = '100644'`, `TREE_MODE = '040000'`.

---

### Task 1: Add the `bundle_tree_sha` column to both skill tables

**Files:**
- Modify: `packages/skills/src/migrations.ts`
- Test: `packages/skills/src/__tests__/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `migrations.test.ts` (mirrors the existing testcontainers + `makeKysely()` + `runSkillsMigration` pattern; the `afterEach` already drops both skill tables):

```typescript
it('skills_v1_skills has a nullable bundle_tree_sha column', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);

  // Insert WITHOUT bundle_tree_sha → defaults to NULL.
  await db
    .insertInto('skills_v1_skills')
    .values({
      skill_id: 'demo',
      description: 'd',
      manifest_yaml: 'name: demo\ndescription: d\nversion: 1\n',
      body_md: '# demo\n',
      version: 1,
    })
    .execute();
  const row = await db
    .selectFrom('skills_v1_skills')
    .select(['skill_id', 'bundle_tree_sha'])
    .where('skill_id', '=', 'demo')
    .executeTakeFirstOrThrow();
  expect(row.bundle_tree_sha).toBeNull();

  // And it accepts a SHA string.
  await db
    .updateTable('skills_v1_skills')
    .set({ bundle_tree_sha: 'a'.repeat(40) })
    .where('skill_id', '=', 'demo')
    .execute();
  const updated = await db
    .selectFrom('skills_v1_skills')
    .select('bundle_tree_sha')
    .where('skill_id', '=', 'demo')
    .executeTakeFirstOrThrow();
  expect(updated.bundle_tree_sha).toBe('a'.repeat(40));
});

it('skills_v1_user_skills has a nullable bundle_tree_sha column', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);
  await db
    .insertInto('skills_v1_user_skills')
    .values({
      owner_user_id: 'alice',
      skill_id: 'demo',
      description: 'd',
      manifest_yaml: 'name: demo\ndescription: d\nversion: 1\n',
      body_md: '# demo\n',
      version: 1,
    })
    .execute();
  const row = await db
    .selectFrom('skills_v1_user_skills')
    .select('bundle_tree_sha')
    .where('owner_user_id', '=', 'alice')
    .where('skill_id', '=', 'demo')
    .executeTakeFirstOrThrow();
  expect(row.bundle_tree_sha).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/migrations.test.ts`
Expected: FAIL — column `bundle_tree_sha` does not exist.

- [ ] **Step 3: Add the columns + extend the row types**

In `packages/skills/src/migrations.ts`, after the existing `ALTER TABLE skills_v1_skills … source_url` statement (and add a matching one for the user table), append the additive, idempotent columns:

```typescript
await sql`
  ALTER TABLE skills_v1_skills
    ADD COLUMN IF NOT EXISTS bundle_tree_sha TEXT NULL
`.execute(db);

await sql`
  ALTER TABLE skills_v1_user_skills
    ADD COLUMN IF NOT EXISTS bundle_tree_sha TEXT NULL
`.execute(db);
```

Add `bundle_tree_sha` to both row interfaces:

```typescript
export interface SkillsRow {
  skill_id: string;
  description: string;
  manifest_yaml: string;
  body_md: string;
  version: number;
  default_attached: boolean;
  source_url: string | null;
  /** Root git tree SHA of the bundle's EXTRA (non-SKILL.md) files. NULL = single-file skill. */
  bundle_tree_sha: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserSkillsRow {
  owner_user_id: string;
  skill_id: string;
  description: string;
  manifest_yaml: string;
  body_md: string;
  version: number;
  default_attached: boolean;
  source_url: string | null;
  /** Root git tree SHA of the bundle's EXTRA (non-SKILL.md) files. NULL = single-file skill. */
  bundle_tree_sha: string | null;
  created_at: Date;
  updated_at: Date;
}
```

Also update the `skills_v1_skill_files` block comment to note it is **superseded** by the bundle store (TASK-40) — left in place per the additive-only migration policy, no longer read or written:

```typescript
// skills_v1_skill_files — SUPERSEDED by the content-addressed git bundle store
// (TASK-40, JIT git-tree backing). Extra bundle files now live as a git tree
// keyed by skills_v1_skills.bundle_tree_sha / skills_v1_user_skills.bundle_tree_sha.
// This table is no longer read or written; it is retained (not dropped) because the
// migration policy is additive-only (destructive changes require a skills_v2 side-
// table). No backfill: the multi-file write path was half-wired (no production
// caller) from TASK-32 until TASK-40, so this table is empty in every deployment.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/migrations.test.ts`
Expected: PASS (all migration tests, including the pre-existing `skills_v1_skill_files` test which still passes — the table stays).

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/migrations.ts packages/skills/src/__tests__/migrations.test.ts
git commit -m "feat(skills): add bundle_tree_sha column for content-addressed bundle backing"
```

---

### Task 2: Create the content-addressed bundle store (`isomorphic-git`)

**Files:**
- Modify: `packages/skills/package.json` (add `isomorphic-git`)
- Create: `packages/skills/src/bundle-store.ts`
- Test: `packages/skills/src/__tests__/bundle-store.test.ts`

- [ ] **Step 1: Add the dependency**

In `packages/skills/package.json`, add to `dependencies` (pin to the lockfile's existing version — `@ax/workspace-git-core` already resolves `isomorphic-git@1.37.5`, so no new third-party code enters the tree):

```json
"isomorphic-git": "1.37.5"
```

Run `pnpm install` to materialize the workspace symlink (no lockfile churn expected — same version).

- [ ] **Step 2: Write the failing test**

Create `packages/skills/src/__tests__/bundle-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { createBundleStore } from '../bundle-store.js';

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ax-skills-bundle-test-'));
}

describe('bundle-store', () => {
  it('round-trips a multi-file bundle through a content-addressed tree', async () => {
    const store = createBundleStore(freshRoot());
    const files = [
      { path: 'scripts/run.py', contents: 'print("hi")' },
      { path: 'data/x.json', contents: '{}' },
    ];
    const sha = await store.writeTree(files);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const read = await store.readTree(sha!);
    // readTree returns paths sorted; assert set equality.
    expect(read).toEqual([
      { path: 'data/x.json', contents: '{}' },
      { path: 'scripts/run.py', contents: 'print("hi")' },
    ]);
  });

  it('returns null for an empty file set (no tree written)', async () => {
    const store = createBundleStore(freshRoot());
    expect(await store.writeTree([])).toBeNull();
  });

  it('is content-addressed: identical bytes → identical tree SHA (dedup)', async () => {
    const store = createBundleStore(freshRoot());
    const a = await store.writeTree([{ path: 'a.txt', contents: 'same' }]);
    const b = await store.writeTree([{ path: 'a.txt', contents: 'same' }]);
    expect(a).toBe(b);
  });

  it('rejects a tree carrying an exec-bit blob at extract', async () => {
    const root = freshRoot();
    const store = createBundleStore(root);
    // Force-init the same repo and craft a malicious tree directly.
    const gitdir = join(root, 'bundles.git');
    await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
    const blobOid = await git.writeBlob({ fs, gitdir, blob: Buffer.from('payload') });
    const evilTree = await git.writeTree({
      fs,
      gitdir,
      tree: [{ mode: '100755', path: 'run.sh', oid: blobOid, type: 'blob' }],
    });
    await expect(store.readTree(evilTree)).rejects.toThrow(/mode|exec|forbidden/i);
  });

  it('rejects a tree carrying a symlink blob at extract', async () => {
    const root = freshRoot();
    const store = createBundleStore(root);
    const gitdir = join(root, 'bundles.git');
    await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
    const blobOid = await git.writeBlob({ fs, gitdir, blob: Buffer.from('/etc/passwd') });
    const evilTree = await git.writeTree({
      fs,
      gitdir,
      tree: [{ mode: '120000', path: 'link', oid: blobOid, type: 'blob' }],
    });
    await expect(store.readTree(evilTree)).rejects.toThrow(/mode|symlink|forbidden/i);
  });

  it('rejects a tree whose paths fail the bundle veto rules at extract', async () => {
    const root = freshRoot();
    const store = createBundleStore(root);
    const gitdir = join(root, 'bundles.git');
    await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
    const blobOid = await git.writeBlob({ fs, gitdir, blob: Buffer.from('{}') });
    // A regular 100644 blob, but at a vetoed path (.mcp.json).
    const tree = await git.writeTree({
      fs,
      gitdir,
      tree: [{ mode: '100644', path: '.mcp.json', oid: blobOid, type: 'blob' }],
    });
    await expect(store.readTree(tree)).rejects.toThrow(/reserved|invalid/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/bundle-store.test.ts`
Expected: FAIL — cannot find module `../bundle-store.js`.

- [ ] **Step 4: Implement the bundle store**

Create `packages/skills/src/bundle-store.ts`:

```typescript
/**
 * @ax/skills content-addressed bundle byte-store (JIT git-tree backing,
 * design §9.2 / decision #10).
 *
 * Stores a skill bundle's EXTRA (non-SKILL.md) files as a git tree in a bare
 * repo @ax/skills OWNS — using `isomorphic-git` directly (the same third-party
 * library @ax/workspace-git-core uses; NOT a cross-plugin import, NOT the
 * workspace plugin's hooks). The catalog row's `bundle_tree_sha` points at the
 * root tree. Reusing git's object format buys: integrity (the SHA pins exact
 * bytes — tampering changes the SHA), dedup (identical blobs share an OID),
 * and versioning (a new file set = a new tree).
 *
 * READ-SIDE VALIDATION (the git-extract boundary, design §9.2): git can
 * natively represent symlinks (120000) and the exec bit (100755), so readTree
 * rejects any blob whose mode isn't 100644, any non-blob/tree object, and
 * re-runs validateBundleFiles on the reconstructed paths. This is the
 * validateMcpEntry defense-in-depth pattern — independent of the write-side
 * validateBundleFiles (invariant I2) — and is the forward guard for the P5/P6
 * flow where a tree comes from an author's workspace repo, not from already-
 * validated files[].
 *
 * Single-replica posture: the repo lives on the host PVC. Multi-replica
 * (ARCH-9) is a deferred lift, same split as @ax/workspace-git local vs -server.
 */
import { existsSync, mkdirSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { validateBundleFiles, type BundleFile } from './bundle-files.js';

const FILE_MODE = '100644'; // regular, non-executable
const TREE_MODE = '040000'; // subdirectory

export interface BundleStore {
  /**
   * Write the extra files as a content-addressed git tree; return the root
   * tree SHA. An empty file set returns `null` (no tree, no row pointer).
   * Caller is responsible for write-side validateBundleFiles (plugin.ts).
   */
  writeTree(files: BundleFile[]): Promise<string | null>;
  /**
   * Read a tree SHA back into extra files. Rejects forbidden git modes/types
   * and re-validates paths/veto/caps at this trust boundary. Returns files
   * sorted by path for determinism.
   */
  readTree(treeSha: string): Promise<BundleFile[]>;
}

export function createBundleStore(repoRoot: string): BundleStore {
  const gitdir = join(repoRoot, 'bundles.git');
  let ready: Promise<void> | undefined;

  // Lazy, idempotent init — mirrors @ax/workspace-git-core's ensureRepo.
  function ensureRepo(): Promise<void> {
    if (ready === undefined) {
      ready = (async () => {
        mkdirSync(repoRoot, { recursive: true });
        if (!existsSync(join(gitdir, 'HEAD'))) {
          await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
        }
      })();
    }
    return ready;
  }

  return {
    async writeTree(files) {
      if (files.length === 0) return null;
      await ensureRepo();

      // First pass: write every blob, remember its OID.
      const blobOids = new Map<string, string>();
      for (const f of files) {
        const oid = await git.writeBlob({ fs, gitdir, blob: Buffer.from(f.contents, 'utf-8') });
        blobOids.set(f.path, oid);
      }

      // Build the directory map (dirPath '' = root) → entries, mirroring
      // @ax/workspace-git-core's writeSnapshotTree so nested paths
      // (scripts/run.py) write correctly nested trees.
      type Entry =
        | { kind: 'blob'; oid: string }
        | { kind: 'tree'; childDir: string };
      const dirs = new Map<string, Map<string, Entry>>();
      const ensureDir = (d: string): Map<string, Entry> => {
        let m = dirs.get(d);
        if (m === undefined) {
          m = new Map();
          dirs.set(d, m);
        }
        return m;
      };
      ensureDir('');
      for (const [path, oid] of blobOids) {
        const parts = path.split('/');
        const fileName = parts[parts.length - 1]!;
        let parentDir = '';
        for (let i = 0; i < parts.length - 1; i++) {
          const segment = parts[i]!;
          const childDir = parentDir === '' ? segment : `${parentDir}/${segment}`;
          const parentMap = ensureDir(parentDir);
          if (parentMap.get(segment) === undefined) {
            parentMap.set(segment, { kind: 'tree', childDir });
          }
          ensureDir(childDir);
          parentDir = childDir;
        }
        ensureDir(parentDir).set(fileName, { kind: 'blob', oid });
      }

      // Write trees leaves-up, memoized by dir path.
      const treeOids = new Map<string, string>();
      const writeDir = async (dirPath: string): Promise<string> => {
        const cached = treeOids.get(dirPath);
        if (cached !== undefined) return cached;
        const entries = dirs.get(dirPath) ?? new Map<string, Entry>();
        const tree: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
        for (const [name, entry] of entries) {
          if (entry.kind === 'blob') {
            tree.push({ mode: FILE_MODE, path: name, oid: entry.oid, type: 'blob' });
          } else {
            const childOid = await writeDir(entry.childDir);
            tree.push({ mode: TREE_MODE, path: name, oid: childOid, type: 'tree' });
          }
        }
        tree.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const oid = await git.writeTree({ fs, gitdir, tree });
        treeOids.set(dirPath, oid);
        return oid;
      };
      return writeDir('');
    },

    async readTree(treeSha) {
      await ensureRepo();
      const out: BundleFile[] = [];

      const walk = async (oid: string, prefix: string): Promise<void> => {
        const { tree } = await git.readTree({ fs, gitdir, oid });
        for (const entry of tree) {
          const rel = prefix === '' ? entry.path : `${prefix}/${entry.path}`;
          if (entry.type === 'tree') {
            await walk(entry.oid, rel);
          } else if (entry.type === 'blob') {
            // Git-extract mode guard: only a plain regular file is allowed.
            // 100755 = exec bit, 120000 = symlink — both rejected here.
            if (entry.mode !== FILE_MODE) {
              throw new Error(
                `bundle file '${rel}' has forbidden git mode ${entry.mode} ` +
                  `(only 100644 allowed; exec-bit/symlink rejected at extract)`,
              );
            }
            const { blob } = await git.readBlob({ fs, gitdir, oid: entry.oid });
            out.push({ path: rel, contents: Buffer.from(blob).toString('utf-8') });
          } else {
            // 'commit' = gitlink/submodule.
            throw new Error(`bundle tree entry '${rel}' is a ${entry.type} (submodule rejected at extract)`);
          }
        }
      };
      await walk(treeSha, '');

      // Defense-in-depth: the reconstructed extra-file set must still satisfy
      // the canonical path/veto/caps rules (independent of the write-side
      // check — invariant I2 / validateMcpEntry pattern).
      validateBundleFiles(out);

      out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return out;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/bundle-store.test.ts`
Expected: PASS (all six cases).

- [ ] **Step 6: Commit**

```bash
git add packages/skills/package.json packages/skills/src/bundle-store.ts packages/skills/src/__tests__/bundle-store.test.ts
git commit -m "feat(skills): content-addressed git bundle store with extract-boundary mode/path validation"
```

---

### Task 3: Swap the global store to the bundle store

**Files:**
- Modify: `packages/skills/src/store.ts`
- Test: `packages/skills/src/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `store.test.ts`. The existing files round-trip test (`upsert stores extra files; get/resolve return them; re-upsert replaces`) already asserts the behavior contract and will now flow through the git store — keep it. Add a backing-specific assertion:

```typescript
it('upsert writes a bundle_tree_sha; single-file skill leaves it NULL', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);
  const store = createSkillsStore(db); // default ephemeral bundle store

  await store.upsert({
    id: 'multi', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1,
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
  });
  await store.upsert({
    id: 'single', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1,
  });

  const multiRow = await db.selectFrom('skills_v1_skills').select('bundle_tree_sha').where('skill_id', '=', 'multi').executeTakeFirstOrThrow();
  const singleRow = await db.selectFrom('skills_v1_skills').select('bundle_tree_sha').where('skill_id', '=', 'single').executeTakeFirstOrThrow();
  expect(multiRow.bundle_tree_sha).toMatch(/^[0-9a-f]{40}$/);
  expect(singleRow.bundle_tree_sha).toBeNull();

  // Round-trip still works (behavior contract unchanged).
  expect((await store.get('multi'))?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  expect((await store.get('single'))?.files).toEqual([]);

  // Re-upsert with a NEW file set replaces the tree (new SHA), and an explicit
  // [] clears it back to NULL.
  await store.upsert({ id: 'multi', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 2, files: [{ path: 'data/x.json', contents: '{}' }] });
  expect((await store.get('multi'))?.files).toEqual([{ path: 'data/x.json', contents: '{}' }]);
  await store.upsert({ id: 'multi', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 3, files: [] });
  const cleared = await db.selectFrom('skills_v1_skills').select('bundle_tree_sha').where('skill_id', '=', 'multi').executeTakeFirstOrThrow();
  expect(cleared.bundle_tree_sha).toBeNull();
  expect((await store.get('multi'))?.files).toEqual([]);
});

it('upsert with files:undefined leaves an existing bundle untouched (no §6D data loss)', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);
  const store = createSkillsStore(db);
  await store.upsert({ id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1, files: [{ path: 'a.txt', contents: '1' }] });
  // Metadata-only edit (no `files` key) must NOT wipe the bundle.
  await store.upsert({ id: 'demo', description: 'changed', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 2 });
  expect((await store.get('demo'))?.files).toEqual([{ path: 'a.txt', contents: '1' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/store.test.ts`
Expected: FAIL — `createSkillsStore` doesn't write `bundle_tree_sha`; `bundle_tree_sha` column unread.

- [ ] **Step 3: Rewrite the store's byte-store helpers + upsert/read paths**

In `packages/skills/src/store.ts`:

Add the import and accept an optional bundle store:

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundleStore, type BundleStore } from './bundle-store.js';
```

```typescript
export function createSkillsStore(
  db: Kysely<SkillsDatabase>,
  // The content-addressed bundle byte-store. Optional so the ~15 existing
  // `createSkillsStore(db)` unit-test call sites keep working — they get a
  // fresh ephemeral repo (each test upserts+reads on one store instance).
  // Production wires a durable repo via the plugin (Task 5).
  bundleStore: BundleStore = createBundleStore(mkdtempSync(join(tmpdir(), 'ax-skills-bundles-'))),
): SkillsStore {
```

**Delete** `loadFiles`, `loadFilesFor`, and `replaceFiles` (they hit `skills_v1_skill_files`). Replace with bundle-store-backed helpers:

```typescript
  // Load a single skill's extra files from its tree SHA (NULL → []).
  async function loadFiles(treeSha: string | null): Promise<BundleFile[]> {
    return treeSha === null ? [] : bundleStore.readTree(treeSha);
  }
```

Update `upsert` — compute the tree SHA before the row write, persist it as a column:

```typescript
    async upsert(input) {
      // Write the extra-file tree FIRST (only when `files` is explicitly
      // provided). `undefined` = leave the current bundle unchanged (the
      // metadata-only admin/settings/refresh routes send no `files`; treating
      // that as [] would wipe a multi-file bundle on a body edit — the §6D
      // data-loss bug). An explicit `[]` → null SHA → cleared bundle.
      const filesProvided = input.files !== undefined;
      const treeSha = filesProvided ? await bundleStore.writeTree(input.files!) : null;

      const existing = await db
        .selectFrom('skills_v1_skills')
        .select('skill_id')
        .where('skill_id', '=', input.id)
        .executeTakeFirst();

      const created = existing === undefined;
      if (created) {
        const now = new Date();
        await db
          .insertInto('skills_v1_skills')
          .values({
            skill_id: input.id,
            description: input.description,
            manifest_yaml: input.manifestYaml,
            body_md: input.bodyMd,
            version: input.version,
            default_attached: input.defaultAttached ?? false,
            source_url: input.sourceUrl ?? null,
            // null when no files provided on create (single-file skill).
            bundle_tree_sha: treeSha,
            created_at: now,
            updated_at: now,
          })
          .execute();
      } else {
        await db
          .updateTable('skills_v1_skills')
          .set({
            description: input.description,
            manifest_yaml: input.manifestYaml,
            body_md: input.bodyMd,
            version: input.version,
            default_attached: input.defaultAttached ?? false,
            source_url: input.sourceUrl ?? null,
            // Only touch bundle_tree_sha when `files` was explicitly provided.
            ...(filesProvided ? { bundle_tree_sha: treeSha } : {}),
            updated_at: new Date(),
          })
          .where('skill_id', '=', input.id)
          .execute();
      }
      return { created };
    },
```

Update `get` to read from the row's SHA:

```typescript
    async get(skillId) {
      const row = await db
        .selectFrom('skills_v1_skills')
        .selectAll()
        .where('skill_id', '=', skillId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return rowToGlobalDetail(row, await loadFiles(row.bundle_tree_sha));
    },
```

Update `delete` — just delete the row (orphaned git objects are content-addressed and harmless; no gc at catalog scale):

```typescript
    async delete(skillId) {
      // Orphaned bundle tree/blobs are content-addressed (dedup-shared, GC-
      // reclaimable) — no explicit cleanup needed at the admin (~10 skills) scale.
      await db
        .deleteFrom('skills_v1_skills')
        .where('skill_id', '=', skillId)
        .execute();
    },
```

Update `getDefaults` and `resolve` to read each row's SHA (a per-row `readTree` over ≤ ~10 ids; in-process git object reads, no DB N+1):

```typescript
    async getDefaults() {
      const rows = await db
        .selectFrom('skills_v1_skills')
        .selectAll()
        .where('default_attached', '=', true)
        .orderBy('skill_id', 'asc')
        .execute();
      const out: ResolvedSkill[] = [];
      for (const r of rows) {
        out.push(rowToGlobalResolved(r, await loadFiles(r.bundle_tree_sha)));
      }
      return out;
    },

    async resolve(skillIds) {
      if (skillIds.length === 0) return [];
      const rows = await db
        .selectFrom('skills_v1_skills')
        .selectAll()
        .where('skill_id', 'in', skillIds)
        .execute();
      const byId = new Map(rows.map((r) => [r.skill_id, r]));
      const result: ResolvedSkill[] = [];
      for (const id of skillIds) {
        const row = byId.get(id);
        if (row === undefined) continue;
        result.push(rowToGlobalResolved(row, await loadFiles(row.bundle_tree_sha)));
      }
      return result;
    },
```

Remove the now-unused `BundleFile` import only if nothing else references it; `loadFiles` returns `BundleFile[]`, so keep it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/store.test.ts`
Expected: PASS (new assertions + all pre-existing store tests, including the TASK-32 files round-trip, now flowing through the git store).

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/store.ts packages/skills/src/__tests__/store.test.ts
git commit -m "feat(skills): back global store extra files with the git bundle store"
```

---

### Task 4: Swap the user store to the bundle store

**Files:**
- Modify: `packages/skills/src/user-store.ts`
- Test: `packages/skills/src/__tests__/store.test.ts` (add a user-scope + cross-scope-dedup case; there is no separate `user-store.test.ts`)

- [ ] **Step 1: Write the failing test**

Add to `store.test.ts` (import `createUserSkillsStore`):

```typescript
import { createUserSkillsStore } from '../user-store.js';
import { createBundleStore } from '../bundle-store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

it('user store round-trips a bundle via bundle_tree_sha', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);
  const userStore = createUserSkillsStore(db);
  await userStore.upsert({
    ownerUserId: 'alice', id: 'demo', description: 'd',
    manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1,
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
  });
  expect((await userStore.get('alice', 'demo'))?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  const [resolved] = await userStore.resolve('alice', ['demo']);
  expect(resolved?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
});

it('global + user stores sharing one bundle repo dedup identical bytes', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);
  const bundleStore = createBundleStore(mkdtempSync(joinPath(tmpdir(), 'ax-shared-bundles-')));
  const store = createSkillsStore(db, bundleStore);
  const userStore = createUserSkillsStore(db, bundleStore);
  await store.upsert({ id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1, files: [{ path: 'a.txt', contents: 'same' }] });
  await userStore.upsert({ ownerUserId: 'alice', id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1, files: [{ path: 'a.txt', contents: 'same' }] });
  const g = await db.selectFrom('skills_v1_skills').select('bundle_tree_sha').where('skill_id', '=', 'demo').executeTakeFirstOrThrow();
  const u = await db.selectFrom('skills_v1_user_skills').select('bundle_tree_sha').where('owner_user_id', '=', 'alice').where('skill_id', '=', 'demo').executeTakeFirstOrThrow();
  expect(g.bundle_tree_sha).toBe(u.bundle_tree_sha); // content-addressed: same bytes, same SHA
});
```

Also extend the `afterEach` teardown to drop `skills_v1_user_skills` if this file doesn't already (it drops `skills_v1_skills` + `skills_v1_skill_files`; add the user table):

```typescript
try { await k.schema.dropTable('skills_v1_user_skills').ifExists().execute(); } catch { /* drained pool */ }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/store.test.ts`
Expected: FAIL — `createUserSkillsStore` doesn't accept a bundle store / doesn't write `bundle_tree_sha`.

- [ ] **Step 3: Apply the same swap to `user-store.ts`**

In `packages/skills/src/user-store.ts`, mirror Task 3 with user scope. Add the import + optional bundle store param:

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundleStore, type BundleStore } from './bundle-store.js';

export function createUserSkillsStore(
  db: Kysely<SkillsDatabase>,
  bundleStore: BundleStore = createBundleStore(mkdtempSync(join(tmpdir(), 'ax-skills-bundles-'))),
): UserSkillsStore {
```

**Delete** `loadFiles`, `loadFilesFor`, `replaceFiles`. Add:

```typescript
  async function loadFiles(treeSha: string | null): Promise<BundleFile[]> {
    return treeSha === null ? [] : bundleStore.readTree(treeSha);
  }
```

`upsert` — compute the tree SHA first, persist on the row (identical structure to Task 3, with `owner_user_id` in the keys + `.values`/`.where`):

```typescript
    async upsert(input) {
      const filesProvided = input.files !== undefined;
      const treeSha = filesProvided ? await bundleStore.writeTree(input.files!) : null;

      const existing = await db
        .selectFrom('skills_v1_user_skills')
        .select('skill_id')
        .where('owner_user_id', '=', input.ownerUserId)
        .where('skill_id', '=', input.id)
        .executeTakeFirst();

      const created = existing === undefined;
      if (created) {
        const now = new Date();
        await db.insertInto('skills_v1_user_skills').values({
          owner_user_id: input.ownerUserId,
          skill_id: input.id,
          description: input.description,
          manifest_yaml: input.manifestYaml,
          body_md: input.bodyMd,
          version: input.version,
          default_attached: input.defaultAttached ?? false,
          source_url: input.sourceUrl ?? null,
          bundle_tree_sha: treeSha,
          created_at: now,
          updated_at: now,
        }).execute();
      } else {
        await db.updateTable('skills_v1_user_skills').set({
          description: input.description,
          manifest_yaml: input.manifestYaml,
          body_md: input.bodyMd,
          version: input.version,
          default_attached: input.defaultAttached ?? false,
          source_url: input.sourceUrl ?? null,
          ...(filesProvided ? { bundle_tree_sha: treeSha } : {}),
          updated_at: new Date(),
        })
          .where('owner_user_id', '=', input.ownerUserId)
          .where('skill_id', '=', input.id)
          .execute();
      }
      return { created };
    },
```

`get`:

```typescript
    async get(ownerUserId, skillId) {
      const row = await db
        .selectFrom('skills_v1_user_skills')
        .selectAll()
        .where('owner_user_id', '=', ownerUserId)
        .where('skill_id', '=', skillId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return rowToUserDetail(row, ownerUserId, await loadFiles(row.bundle_tree_sha));
    },
```

`delete` (drop the cleanup of the old files table):

```typescript
    async delete(ownerUserId, skillId) {
      await db
        .deleteFrom('skills_v1_user_skills')
        .where('owner_user_id', '=', ownerUserId)
        .where('skill_id', '=', skillId)
        .execute();
    },
```

`getDefaults` + `resolve` — per-row `readTree`:

```typescript
    async getDefaults(ownerUserId) {
      const rows = await db.selectFrom('skills_v1_user_skills').selectAll()
        .where('owner_user_id', '=', ownerUserId)
        .where('default_attached', '=', true)
        .orderBy('skill_id', 'asc').execute();
      const out: ResolvedSkill[] = [];
      for (const r of rows) out.push(rowToUserResolved(r, await loadFiles(r.bundle_tree_sha)));
      return out;
    },

    async resolve(ownerUserId, skillIds) {
      if (skillIds.length === 0) return [];
      const rows = await db.selectFrom('skills_v1_user_skills').selectAll()
        .where('owner_user_id', '=', ownerUserId)
        .where('skill_id', 'in', skillIds).execute();
      const byId = new Map(rows.map((r) => [r.skill_id, r]));
      const result: ResolvedSkill[] = [];
      for (const id of skillIds) {
        const row = byId.get(id);
        if (row === undefined) continue;
        result.push(rowToUserResolved(row, await loadFiles(row.bundle_tree_sha)));
      }
      return result;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/user-store.ts packages/skills/src/__tests__/store.test.ts
git commit -m "feat(skills): back user store extra files with the shared git bundle store"
```

---

### Task 5: Wire the bundle store into the plugin (config + injection)

**Files:**
- Modify: `packages/skills/src/plugin.ts`, `packages/skills/src/index.ts` (export the config type)
- Test: `packages/skills/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `plugin.test.ts` (mirror its existing harness; it builds the plugin via `createSkillsPlugin()` over testcontainers Postgres). Assert a multi-file bundle round-trips through the **plugin** path with a durable repoRoot, AND that a fresh plugin pointed at the **same** repoRoot can read a previously-written tree (durability):

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('skills:upsert + skills:resolve round-trip a bundle via a durable repoRoot', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-skills-plugin-bundle-'));
  // Build the harness with createSkillsPlugin({ bundleStore: { repoRoot } }).
  const h = await makeHarness({ skillsConfig: { bundleStore: { repoRoot } } });
  await h.bus.call('skills:upsert', h.ctx(), {
    manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY,
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
  });
  const out = await h.bus.call<SkillsResolveInput, SkillsResolveOutput>('skills:resolve', h.ctx(), { skillIds: ['github'] });
  expect(out.skills[0]?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
});
```

(Adapt to the file's actual harness factory; the key is passing `createSkillsPlugin({ bundleStore: { repoRoot } })`. `'github'` is the id in `SAMPLE_MANIFEST`, per the existing plugin tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/plugin.test.ts`
Expected: FAIL — `createSkillsPlugin` takes no argument.

- [ ] **Step 3: Add the config + construct/inject the bundle store**

In `packages/skills/src/plugin.ts`:

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundleStore } from './bundle-store.js';

export interface SkillsPluginConfig {
  /**
   * Content-addressed bundle byte-store location. `repoRoot` hosts a bare git
   * repo at `<repoRoot>/bundles.git`. Capabilities scoped to this dir only.
   * OPTIONAL: when omitted the plugin uses an EPHEMERAL temp dir (and warns) —
   * fine for tests, but production MUST wire a durable path (Task 6) or the
   * catalog's extra-file bytes are lost on restart. Today every deployed skill
   * has no extra files (the write path is half-wired until P5), so the
   * ephemeral fallback is non-fatal until then.
   */
  bundleStore?: { repoRoot: string };
}

export function createSkillsPlugin(config: SkillsPluginConfig = {}): Plugin {
```

Inside `init`, after `db` is resolved and before creating the stores:

```typescript
      let repoRoot = config.bundleStore?.repoRoot;
      if (repoRoot === undefined) {
        repoRoot = mkdtempSync(join(tmpdir(), 'ax-skills-bundles-'));
        initCtx.logger.warn('skills_bundle_store_ephemeral', {
          repoRoot,
          note: 'no AX_SKILLS_BUNDLE_ROOT configured — bundle bytes are not durable across restarts',
        });
      }
      const bundleStore = createBundleStore(repoRoot);
      const store = createSkillsStore(db, bundleStore);
      const userStore = createUserSkillsStore(db, bundleStore);
```

(Replace the existing `const store = createSkillsStore(db); const userStore = createUserSkillsStore(db);` lines.)

Export the config type from `packages/skills/src/index.ts`:

```typescript
export { createSkillsPlugin, type SkillsPluginConfig } from './plugin.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test`
Expected: PASS (whole package green — all existing no-arg `createSkillsPlugin()` test call sites still compile and pass via the ephemeral fallback).

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/plugin.ts packages/skills/src/index.ts packages/skills/src/__tests__/plugin.test.ts
git commit -m "feat(skills): inject a durable bundle store via optional plugin config"
```

---

### Task 6: Wire the production durable path (preset + chart)

This closes the production-wiring gap so the bundle store is **not half-wired infra** — it is constructed with a durable repoRoot in the deployed host.

**Files:**
- Modify: `presets/k8s/src/index.ts`
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml`
- Test: `presets/k8s/src/__tests__/preset.test.ts`, `deploy/charts/ax-next/__tests__/render.test.ts`

- [ ] **Step 1: Write the failing preset test**

In `presets/k8s/src/__tests__/preset.test.ts`, assert that when `AX_SKILLS_BUNDLE_ROOT` is set the skills plugin is constructed with that repoRoot. Mirror the file's existing env-driven construction assertions (the preset reads `env` and builds the plugin list). If the existing tests assert on a returned config object, assert `config.skills?.bundleStore?.repoRoot === '/var/lib/ax-next/workspaces/skill-bundles'` for a representative env; otherwise assert the plugin list includes a skills plugin built from that env (follow the file's established assertion style).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/preset-k8s test -- src/__tests__/preset.test.ts`
Expected: FAIL — `AX_SKILLS_BUNDLE_ROOT` not read; plugin still built with no config.

(If the preset package name differs, use the name from `presets/k8s/package.json`.)

- [ ] **Step 3: Read the env + pass it through**

In `presets/k8s/src/index.ts`, in the env→config resolution, read the optional bundle root:

```typescript
const skillsBundleRoot = env.AX_SKILLS_BUNDLE_ROOT;
```

At the skills construction site (currently `plugins.push(createSkillsPlugin());`):

```typescript
plugins.push(
  createSkillsPlugin(
    skillsBundleRoot !== undefined && skillsBundleRoot !== ''
      ? { bundleStore: { repoRoot: skillsBundleRoot } }
      : {},
  ),
);
```

(Follow the file's existing "treat empty string as unset" convention, used for `AX_WORKSPACE_ROOT`.)

- [ ] **Step 4: Add the chart env (local backend)**

In `deploy/charts/ax-next/templates/host/deployment.yaml`, inside the existing `{{- if eq .Values.workspace.backend "local" }}` block (next to `AX_WORKSPACE_ROOT`), add — a sibling dir on the same host PVC, distinct from workspace-git's `<repoRoot>/repo.git`:

```yaml
            # Skill bundle byte-store (JIT git-tree backing). A bare git repo
            # under the host PVC, sibling to workspace-git's repo.git. Single-
            # replica posture; multi-replica catalog durability is deferred
            # (ARCH-9), same split as workspace-git local vs -server.
            - name: AX_SKILLS_BUNDLE_ROOT
              value: {{ printf "%s/skill-bundles" .Values.workspace.mountPath | quote }}
```

(Left unset for `git-protocol`/multi-replica — the plugin falls back to ephemeral with a warn; non-fatal until P5 wires a writer, per the half-wired note.)

- [ ] **Step 5: Add the chart render test**

In `deploy/charts/ax-next/__tests__/render.test.ts`, mirror the existing `AX_WORKSPACE_ROOT` render assertions:

```typescript
it('backend=local: host has AX_SKILLS_BUNDLE_ROOT under the workspace PVC', () => {
  const names = /* render host env names for default (local) backend */;
  expect(names).toContain('AX_SKILLS_BUNDLE_ROOT');
  // value asserts to `${workspace.mountPath}/skill-bundles`
});

it('backend=git-protocol: host has no AX_SKILLS_BUNDLE_ROOT', () => {
  const names = /* render host env names for git-protocol backend */;
  expect(names).not.toContain('AX_SKILLS_BUNDLE_ROOT');
});
```

(Use the file's existing `helmTemplate` helper + env-extraction pattern, mirroring its `AX_WORKSPACE_ROOT` cases at `render.test.ts:341/368`.)

- [ ] **Step 6: Run both test suites to verify they pass**

Run:
```bash
pnpm -F @ax/preset-k8s test -- src/__tests__/preset.test.ts
pnpm -F <chart-test-package> test -- __tests__/render.test.ts
```
Expected: PASS. (Chart test package name per `deploy/charts/ax-next/package.json`.)

- [ ] **Step 7: Commit**

```bash
git add presets/k8s/src/index.ts deploy/charts/ax-next/templates/host/deployment.yaml presets/k8s/src/__tests__/preset.test.ts deploy/charts/ax-next/__tests__/render.test.ts
git commit -m "feat(preset,chart): wire AX_SKILLS_BUNDLE_ROOT durable path for the bundle store"
```

---

### Task 7: End-to-end canary + full verification + security-checklist (pre-PR gate)

**Files:**
- Modify: `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts`

- [ ] **Step 1: Confirm the canary is a green regression guard, add one backing assertion**

The canary's existing `a multi-file bundle threads SKILL.md + extra files through to sandbox:open-session` case is the end-to-end proof the **internal swap preserves behavior** — it must stay green with no change to its assertions. Add a small assertion that the swap actually went through the git store (the catalog row carries a `bundle_tree_sha`), querying the canary's DB handle after the multi-file upsert:

```typescript
const treeRow = await cleanup.query(
  "SELECT bundle_tree_sha FROM skills_v1_skills WHERE skill_id = 'github'",
);
expect(treeRow.rows[0].bundle_tree_sha).toMatch(/^[0-9a-f]{40}$/);
```

(`cleanup` is the canary's existing pg client; `'github'` is the multi-file skill's id in that test. Keep the existing `DROP TABLE IF EXISTS skills_v1_skill_files` teardown — the table still exists.)

- [ ] **Step 2: Run the canary**

Run: `pnpm -F @ax/skills test -- src/__tests__/e2e/skill-install.canary.test.ts`
Expected: PASS — both the single-file (`files: ['SKILL.md']`) byte-identical case and the multi-file case green, plus the new `bundle_tree_sha` assertion.

- [ ] **Step 3: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. (`pnpm build` (tsc) catches undeclared workspace deps vitest tolerates — confirms `isomorphic-git` is declared in `@ax/skills` and nothing imports `@ax/workspace-git*`. `pnpm lint` confirms `no-restricted-imports` sees no cross-plugin `@ax/*` import — only the third-party `isomorphic-git`.)

- [ ] **Step 4: Run the security-checklist skill (required — the card flags it)**

Invoke the `security-checklist` skill and answer all three threat models against this diff. Key items, pre-stated in "Scope guardrails" above:
- **Supply chain:** `isomorphic-git@1.37.5` is already in the lockfile (via `@ax/workspace-git-core`); confirm the pin matches and no transitive additions appear in the lockfile diff.
- **Sandbox escape / prompt injection:** the git-extract boundary (`bundle-store.ts` `readTree`) rejects non-`100644` blob modes (symlink/exec-bit), non-blob/tree objects (submodule), and re-runs `validateBundleFiles` (path/veto/caps) — independent of the write-side check (I2). Confirm the three downstream boundaries (sandbox-protocol schema + both materializers) are unchanged and still re-validate.
Paste the structured note into the PR.

- [ ] **Step 5: Commit + open PR**

```bash
git add packages/skills/src/__tests__/e2e/skill-install.canary.test.ts
git commit -m "test(skills): canary asserts the git-tree backing (bundle_tree_sha) end to end"
```

PR description MUST include:
- **Boundary review: N/A** — internal-implementation-only; no hook/contract change (the `files[]` contract, sandbox-protocol schema, orchestrator, and both materializers are untouched). The only new surface is a construction-time plugin config (`bundleStore.repoRoot`).
- **Half-wired window: OPEN (inherited from TASK-32, not newly opened)** — the multi-file *write* path has no production caller until P5; TASK-40 re-backs an existing half-wired store. The bundle repo's production durability becomes load-bearing only when P5 wires a writer. Window CLOSES in P5.
- **Stale design assumptions flagged + resolved** — the design's "reuse `git-workspace.ts` infra" pointer was stale (runner-side file; host store has no tree API + strips modes); resolved to a skills-owned `isomorphic-git` repo (human-confirmed). Multi-replica catalog durability deferred to ARCH-9.
- The security-checklist note.

---

## Self-Review

**Spec coverage** (against design §9.2 + §11.8 + decision #10, and the card):
- "Swap the DB files-table byte-store for content-addressed git trees" → Tasks 2 (store) + 3/4 (global/user swap). ✓
- "A catalog entry becomes `{ skillId, scope, version, treeSha }` + parsed SKILL.md index" → `bundle_tree_sha` column (Task 1); `skill_id`/`scope`(table)/`version` already on the row; SKILL.md index = unchanged `manifest_yaml`/`body_md`. ✓
- "Internal swap — the `files[]` contract is unchanged" → no hook/sandbox-protocol/orchestrator/materializer change; `skills:upsert`/`resolve`/`get` I/O byte-identical (Tasks 3–5); canary regression guard (Task 7). ✓
- "Validation at the git-extract boundary: relative-path / reject `..`+absolute+symlinks, no-exec-bit, veto-list, caps" → `readTree` mode/type guard + re-run `validateBundleFiles` (Task 2, Shared rule); caps re-checked runner-side are the **unchanged** existing materializer boundaries. ✓
- "Integrity / dedup / versioning" → content-addressed tree SHA (Task 2: round-trip, dedup, content-addressing tests). ✓
- "Security-checklist (storage + extract-boundary validation)" → pre-PR gate (Task 7 Step 4) + pre-stated threat model. ✓
- "Verify the internal-swap assumption holds once TASK-32 ships" → verified against merged TASK-32 (PR #183): `skills_v1_skill_files` is touched only by `@ax/skills`; mappers take `files` as a param; swap is internal. Stale design pointer flagged + resolved. ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. Two intentional "follow the file's pattern" notes (preset test assertion style, chart render env-extraction helper) reference existing anchors (`render.test.ts:341/368`) rather than inventing helper signatures — the bite-sized code to add is fully specified; only the surrounding harness idiom is deferred to the file. No TBD/TODO.

**Type consistency:** the byte-store helper is `BundleStore { writeTree(files: BundleFile[]): Promise<string|null>; readTree(treeSha: string): Promise<BundleFile[]> }` everywhere; the column is `bundle_tree_sha: string | null` in both `SkillsRow`/`UserSkillsRow`; `loadFiles(treeSha: string|null)` in both stores; `createSkillsStore(db, bundleStore?)` / `createUserSkillsStore(db, bundleStore?)` / `createSkillsPlugin(config?: SkillsPluginConfig)` signatures are consistent across Tasks 3/4/5. `BundleFile` is imported from `./bundle-files.js` (the existing canonical type) in `bundle-store.ts` and re-used by `types.ts`'s `BundleFile` (same shape) — no duplicate type. Mode constants `FILE_MODE='100644'`/`TREE_MODE='040000'` match `@ax/workspace-git-core`.

**Known residual / deferred (stated, not gaps):**
- **No backfill** — `skills_v1_skill_files` is empty in every deployment (write path half-wired since TASK-32); the table is retained unused (additive-only migration policy) and superseded by the git store. If rows ever exist, a backfill is a separate migration.
- **Whole-bundle SHA pinning** (SKILL.md inside the registered tree, for §6D "shipped == reviewed") is a **P5/P6 promotion-task** refinement; TASK-40's `treeSha` pins the extra-file bytes only, keeping `resolve`/`get`/`upsert` byte-identical.
- **Multi-replica catalog durability** is deferred (ARCH-9); the repo is host-PVC-local (single-replica posture), and the chart fails render for `replicas>1` today.
- **`skills:check-for-updates` / `refresh-from-source`** operate on the manifest only (extra files aren't sourced from `sourceUrl`); unaffected — same residual the Phase 1a plan noted.
