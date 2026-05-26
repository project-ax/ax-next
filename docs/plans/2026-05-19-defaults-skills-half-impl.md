# Defaults — skills-half implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `default_attached` flag to admin-managed skills so every agent receives those skills at session-open without per-agent setup.

**Architecture:** One additive DB column (`skills_v1_skills.default_attached`), one new service hook (`skills:list-defaults` returning `ResolvedSkill[]`), one orchestrator union step (merge defaults into the existing skill-resolve flow, dedup by id, explicit attachments win), one admin-UI checkbox (locked out when the skill declares credential slots). Stripped presets stay live via `bus.hasService` soft-coupling.

**Tech Stack:** TypeScript, postgres (via Kysely), Vitest + `@testcontainers/postgresql` for DB tests, `@ax/test-harness` for plugin tests, React + `@testing-library/react` for UI tests.

**Scope:** This plan covers ONLY the skills-half slice of `docs/plans/2026-05-19-defaults-design.md`. The routines-half slice ships in a separate plan + PR. The two slices are independent (Part A and Part B of the design have no cross-dependencies).

---

## Invariants

The PR must satisfy these at merge time. The reviewer will check each:

- **I-S1** — `default_attached` is a DB column flipped by the admin, NOT a manifest YAML field. SKILL.md frontmatter content is unchanged.
- **I-S2** — A skill with `capabilities.credentials.length > 0` cannot be `default_attached = true`. Enforced at upsert time by the plugin (loud `PluginError` rejection) AND in the admin UI (checkbox disabled with tooltip). v1 defaults are instruction-only.
- **I-S3** — `skills:list-defaults` returns the same `ResolvedSkill[]` shape as `skills:resolve`. No new fields disclose "this came from a default" — orchestrator/sandbox callers stay indifferent.
- **I-S4** — Orchestrator union: explicit `agent.skillAttachments` win on id collision. Defaults only fill ids the agent hasn't explicitly attached.
- **I-S5** — `skills:list-defaults` failure is non-fatal: log loud + treat as empty list. Distinct from `skills:resolve` failure which still terminates the session with `skill-resolve-failed`.
- **I-S6** — Stripped-preset compatibility: orchestrator gates the call with `bus.hasService('skills:list-defaults')`. When `@ax/skills` is absent, the orchestrator no-ops. (Mirrors the existing `skills:resolve` guard.)
- **I-S7** — Half-wired window closed in this PR: column + hook + orchestrator union + admin checkbox + canary acceptance test all ship together. No "wire this up later" follow-ups.

---

## File structure

**Modify (existing files):**

- `packages/skills/src/migrations.ts` — ALTER table; extend `SkillsRow`.
- `packages/skills/src/types.ts` — extend `SkillSummary` + `SkillDetail` with `defaultAttached`; extend `SkillsUpsertInput` with `defaultAttached?: boolean`; add `SkillsListDefaultsInput` + `SkillsListDefaultsOutput`.
- `packages/skills/src/index.ts` — re-export new types.
- `packages/skills/src/store.ts` — extend `UpsertInput`; pass `default_attached` through INSERT/UPDATE; populate the new field on `list()`/`get()`; add `getDefaults()`.
- `packages/skills/src/plugin.ts` — register `skills:list-defaults`; reject upsert when `defaultAttached: true` + non-empty `capabilities.credentials`; update `registers` manifest.
- `packages/skills/src/admin-routes.ts` — `upsertBodySchema` accepts `defaultAttached?: boolean`; pass through to `skills:upsert`.
- `packages/skills/src/__tests__/migrations.test.ts` — column shape.
- `packages/skills/src/__tests__/store.test.ts` — defaults round-trip + `getDefaults()`.
- `packages/skills/src/__tests__/plugin.test.ts` — manifest assertion includes new hook; `skills:list-defaults` round-trip; upsert rejection on default+caps.
- `packages/skills/src/__tests__/admin-routes.test.ts` — body schema accepts the flag; pass-through.
- `packages/chat-orchestrator/src/orchestrator.ts` — call `skills:list-defaults` after `skills:resolve`; union into `installedSkillsForSandbox`; dedup by id.
- `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` — 4 new orchestrator union cases.
- `packages/channel-web/src/lib/skills.ts` — wire client accepts `defaultAttached` on POST/PUT.
- `packages/channel-web/src/components/admin/SkillEditor.tsx` — checkbox; lock-out tooltip; pass through on save.
- `packages/channel-web/src/components/admin/SkillsTab.tsx` — `default` badge in the row.
- `packages/channel-web/src/components/admin/__tests__/SkillEditor.test.tsx` — checkbox + lock-out + pass-through.
- `packages/channel-web/src/components/admin/__tests__/SkillsTab.test.tsx` — badge renders when `defaultAttached: true`.
- `presets/k8s/src/__tests__/preset.test.ts` — confirm static wiring intact (no expected change to plugin name list, just sanity).

**Create:** None.

**Delete:** None.

---

## Task 1: Branch + baseline

**Files:** None modified.

- [ ] **Step 1: Create branch**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/defaults-skills-half
git status
```

Expected: `On branch feat/defaults-skills-half` and `nothing to commit, working tree clean`.

- [ ] **Step 2: Baseline build / test / lint**

```bash
pnpm install
pnpm build
pnpm test --filter @ax/skills --filter @ax/chat-orchestrator --filter @ax/channel-web --filter @ax/preset-k8s
pnpm lint
```

Expected: all green. If any of these fails on baseline, STOP and ask — we don't want to layer changes on top of a red tree.

- [ ] **Step 3: Confirm design doc is current**

Skim `docs/plans/2026-05-19-defaults-design.md`. If the design has changed since this plan was written, raise the deltas before continuing.

---

## Task 2: Migration — add `default_attached` column

**Files:**
- Modify: `packages/skills/src/migrations.ts`
- Test: `packages/skills/src/__tests__/migrations.test.ts`

- [ ] **Step 1: Add failing test for the column**

Append to `packages/skills/src/__tests__/migrations.test.ts` inside the `describe('runSkillsMigration', ...)` block:

```ts
  it('default_attached column exists with the expected default', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);

    const cols = await sql<{ column_name: string; data_type: string; column_default: string | null; is_nullable: string }>`
      SELECT column_name, data_type, column_default, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skills_v1_skills'
         AND column_name = 'default_attached'
    `.execute(db);

    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]?.data_type).toBe('boolean');
    expect(cols.rows[0]?.is_nullable).toBe('NO');
    // postgres normalises `DEFAULT false` to the textual literal "false".
    expect(cols.rows[0]?.column_default).toBe('false');
  });

  it('migration is idempotent when the column already exists', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    // Run again — should not throw.
    await runSkillsMigration(db);

    // Smoke: column still readable, default holds.
    await db
      .insertInto('skills_v1_skills')
      .values({
        skill_id: 'rerun',
        description: 'd',
        manifest_yaml: 'name: rerun\ndescription: d\n',
        body_md: '',
        version: 0,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const rows = await db
      .selectFrom('skills_v1_skills')
      .select(['skill_id', 'default_attached'])
      .execute();
    expect(rows).toEqual([{ skill_id: 'rerun', default_attached: false }]);
  });
```

- [ ] **Step 2: Run the failing tests**

```bash
pnpm test --filter @ax/skills -- migrations.test.ts
```

Expected: FAIL — `default_attached` column does not exist.

- [ ] **Step 3: Add the ALTER**

Edit `packages/skills/src/migrations.ts`:

1. Inside `runSkillsMigration`, after the existing `CREATE TABLE IF NOT EXISTS` block, append:

```ts
  await sql`
    ALTER TABLE skills_v1_skills
      ADD COLUMN IF NOT EXISTS default_attached BOOLEAN NOT NULL DEFAULT false
  `.execute(db);
```

2. Extend `SkillsRow` to include the new column:

```ts
export interface SkillsRow {
  skill_id: string;
  description: string;
  manifest_yaml: string;
  body_md: string;
  version: number;
  default_attached: boolean;
  created_at: Date;
  updated_at: Date;
}
```

- [ ] **Step 4: Re-run the tests**

```bash
pnpm test --filter @ax/skills -- migrations.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/migrations.ts packages/skills/src/__tests__/migrations.test.ts
git commit -m "$(cat <<'EOF'
feat(skills): add default_attached column (additive ALTER, idempotent)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Types — extend payload shapes

**Files:**
- Modify: `packages/skills/src/types.ts`
- Modify: `packages/skills/src/index.ts`

- [ ] **Step 1: Edit `packages/skills/src/types.ts`**

Add `defaultAttached: boolean` to `SkillSummary` (and `SkillDetail` inherits it via `extends`):

```ts
export interface SkillSummary {
  id: string;
  description: string;
  version: number;
  capabilities: SkillCapabilities;
  defaultAttached: boolean;
  updatedAt: string;
}
```

Extend `SkillsUpsertInput` (additive — the field is optional, default `false`):

```ts
export interface SkillsUpsertInput {
  manifestYaml: string;
  bodyMd: string;
  defaultAttached?: boolean;
}
```

Add the new hook payload types at the bottom of the file:

```ts
export type SkillsListDefaultsInput = Record<string, never>;
export interface SkillsListDefaultsOutput {
  skills: ResolvedSkill[];
}
```

- [ ] **Step 2: Re-export from `index.ts`**

Append to the `export type { ... } from './types.js'` block:

```ts
  SkillsListDefaultsInput,
  SkillsListDefaultsOutput,
```

- [ ] **Step 3: Type-check**

```bash
pnpm build --filter @ax/skills
```

Expected: build still passes. Existing call sites (`SkillSummary` consumers) may surface as missing-property errors — that's expected and fixed in Tasks 4 and 7. If `pnpm build` errors elsewhere, stop and read the errors before continuing.

> If the build errors with `Property 'defaultAttached' is missing in type ...` in `packages/skills/src/store.ts`, that's the next task — proceed.

- [ ] **Step 4: Commit**

```bash
git add packages/skills/src/types.ts packages/skills/src/index.ts
git commit -m "$(cat <<'EOF'
feat(skills): extend payload types with defaultAttached + list-defaults hook

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Store — read/write `default_attached`; add `getDefaults()`

**Files:**
- Modify: `packages/skills/src/store.ts`
- Test: `packages/skills/src/__tests__/store.test.ts`

- [ ] **Step 1: Add failing tests**

Append two tests inside `describe('SkillsStore', ...)` in `store.test.ts`:

```ts
  it('upsert with defaultAttached: true persists the flag and reads back via get()', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    // Instruction-only manifest (no credential slots) — required for defaults.
    const INSTRUCTION_ONLY_MANIFEST = `name: heartbeat
description: Daily check-in skill.
version: 1
`;
    await store.upsert({
      id: 'heartbeat',
      description: 'Daily check-in skill.',
      manifestYaml: INSTRUCTION_ONLY_MANIFEST,
      bodyMd: '# Heartbeat\n',
      version: 1,
      defaultAttached: true,
    });

    const detail = await store.get('heartbeat');
    expect(detail).not.toBeNull();
    expect(detail!.defaultAttached).toBe(true);

    // list() also reports it.
    const list = await store.list();
    expect(list.find((s) => s.id === 'heartbeat')?.defaultAttached).toBe(true);
  });

  it('getDefaults() returns ResolvedSkill[] for default-attached rows ordered by id', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    // Two defaults + one explicit-only skill.
    await store.upsert({
      id: 'heartbeat',
      description: 'd',
      manifestYaml: 'name: heartbeat\ndescription: d\n',
      bodyMd: '# heartbeat\n',
      version: 0,
      defaultAttached: true,
    });
    await store.upsert({
      id: 'acceptance-canary',
      description: 'd',
      manifestYaml: 'name: acceptance-canary\ndescription: d\n',
      bodyMd: '# canary\n',
      version: 0,
      defaultAttached: true,
    });
    await store.upsert({
      id: 'github',
      description: 'd',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      version: 1,
      defaultAttached: false,
    });

    const defaults = await store.getDefaults();
    expect(defaults.map((s) => s.id)).toEqual(['acceptance-canary', 'heartbeat']);
    // Returns the ResolvedSkill shape — same as resolve().
    expect(defaults[0]).toMatchObject({
      id: 'acceptance-canary',
      bodyMd: '# canary\n',
      capabilities: { allowedHosts: [], credentials: [] },
    });
    expect(defaults[0]).toHaveProperty('manifestYaml');
  });
```

- [ ] **Step 2: Run failing tests**

```bash
pnpm test --filter @ax/skills -- store.test.ts
```

Expected: FAIL — `defaultAttached` not in input type / `getDefaults` not a method.

- [ ] **Step 3: Extend `UpsertInput` and the store impl**

Edit `packages/skills/src/store.ts`:

1. Extend `UpsertInput`:

```ts
export interface UpsertInput {
  id: string;
  description: string;
  manifestYaml: string;
  bodyMd: string;
  version: number;
  defaultAttached?: boolean;
}
```

2. Extend the `SkillsStore` interface:

```ts
export interface SkillsStore {
  list(): Promise<SkillSummary[]>;
  get(skillId: string): Promise<SkillDetail | null>;
  upsert(input: UpsertInput): Promise<{ created: boolean }>;
  delete(skillId: string): Promise<void>;
  resolve(skillIds: string[]): Promise<ResolvedSkill[]>;
  getDefaults(): Promise<ResolvedSkill[]>;
}
```

3. In `list()`, return the new field:

```ts
      return rows.map((row): SkillSummary => ({
        id: row.skill_id,
        description: row.description,
        version: row.version,
        capabilities: parseCapabilities(row.manifest_yaml, row.skill_id),
        defaultAttached: row.default_attached,
        updatedAt: row.updated_at.toISOString(),
      }));
```

4. In `get()`, similarly:

```ts
      const detail: SkillDetail = {
        id: row.skill_id,
        description: row.description,
        version: row.version,
        capabilities: parseCapabilities(row.manifest_yaml, row.skill_id),
        defaultAttached: row.default_attached,
        updatedAt: row.updated_at.toISOString(),
        bodyMd: row.body_md,
        manifestYaml: row.manifest_yaml,
      };
```

5. In `upsert()`, persist the flag on both the INSERT and UPDATE branches:

```ts
      if (existing === undefined) {
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
            created_at: now,
            updated_at: now,
          })
          .execute();
        return { created: true };
      }

      await db
        .updateTable('skills_v1_skills')
        .set({
          description: input.description,
          manifest_yaml: input.manifestYaml,
          body_md: input.bodyMd,
          version: input.version,
          default_attached: input.defaultAttached ?? false,
          updated_at: new Date(),
        })
        .where('skill_id', '=', input.id)
        .execute();
      return { created: false };
```

> Note: the update branch sets `default_attached` unconditionally. Admin callers must always pass the desired state; an admin "edit body only, don't touch the flag" UX would need a partial-update API — out of scope for v1.

6. Add `getDefaults()`:

```ts
    async getDefaults() {
      const rows = await db
        .selectFrom('skills_v1_skills')
        .selectAll()
        .where('default_attached', '=', true)
        .orderBy('skill_id', 'asc')
        .execute();

      return rows.map((row): ResolvedSkill => ({
        id: row.skill_id,
        capabilities: parseCapabilities(row.manifest_yaml, row.skill_id),
        bodyMd: row.body_md,
        manifestYaml: row.manifest_yaml,
      }));
    },
```

- [ ] **Step 4: Re-run tests**

```bash
pnpm test --filter @ax/skills -- store.test.ts
```

Expected: PASS for the new tests AND all existing store.test.ts cases still pass. If existing cases fail because of a missing `defaultAttached` field on `SkillSummary`/`SkillDetail`, your `list()` / `get()` patches are not returning the field — fix and re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/store.ts packages/skills/src/__tests__/store.test.ts
git commit -m "$(cat <<'EOF'
feat(skills): store getDefaults() + defaultAttached round-trip

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Plugin — `skills:list-defaults` hook + upsert validation

**Files:**
- Modify: `packages/skills/src/plugin.ts`
- Test: `packages/skills/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Add failing tests**

Append inside `describe('@ax/skills service hooks (round-trip)', ...)` in `plugin.test.ts`:

```ts
  it('skills:list-defaults returns default-attached skills only', async () => {
    const h = await makeHarness();
    // Two skills, only one default-attached.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      {
        manifestYaml: 'name: heartbeat\ndescription: Daily check-in.\nversion: 1\n',
        bodyMd: '# heartbeat\n',
        defaultAttached: true,
      },
    );
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY },
    );

    const out = await h.bus.call<
      Record<string, never>,
      { skills: Array<{ id: string; bodyMd: string }> }
    >('skills:list-defaults', h.ctx(), {});

    expect(out.skills.map((s) => s.id)).toEqual(['heartbeat']);
    expect(out.skills[0]?.bodyMd).toBe('# heartbeat\n');
  });

  it('skills:upsert rejects defaultAttached=true when the manifest declares credential slots', async () => {
    const h = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
        'skills:upsert',
        h.ctx(),
        {
          // SAMPLE_MANIFEST has a GITHUB_TOKEN slot — not allowed as default.
          manifestYaml: SAMPLE_MANIFEST,
          bodyMd: SAMPLE_BODY,
          defaultAttached: true,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('default-attached-requires-no-credentials');
  });
```

Update the manifest assertion test (`describe('@ax/skills plugin manifest + lifecycle', ...)`) to include the new hook:

```ts
      registers: [
        'skills:list',
        'skills:get',
        'skills:upsert',
        'skills:delete',
        'skills:resolve',
        'skills:list-defaults',
      ],
```

- [ ] **Step 2: Run failing tests**

```bash
pnpm test --filter @ax/skills -- plugin.test.ts
```

Expected: FAIL — `skills:list-defaults` not registered; manifest mismatch; upsert doesn't validate the flag.

- [ ] **Step 3: Edit `packages/skills/src/plugin.ts`**

1. Add `'skills:list-defaults'` to the `registers` array in the plugin manifest.

2. Add the import for the new types alongside the other type imports:

```ts
import type {
  SkillsDeleteInput,
  SkillsDeleteOutput,
  SkillsGetInput,
  SkillsGetOutput,
  SkillsListDefaultsInput,
  SkillsListDefaultsOutput,
  SkillsListInput,
  SkillsListOutput,
  SkillsResolveInput,
  SkillsResolveOutput,
  SkillsUpsertInput,
  SkillsUpsertOutput,
} from './types.js';
```

3. In the `skills:upsert` handler, after `const parsed = parseSkillManifest(input.manifestYaml)` is checked for ok, add the default-validation guard:

```ts
          // I-S2: default-attached skills are instruction-only in v1. Credential
          // slots imply per-agent bindings, which "everyone gets this" cannot
          // supply. Loud rejection at the host so the admin sees the cause.
          if (
            input.defaultAttached === true &&
            parsed.value.capabilities.credentials.length > 0
          ) {
            throw new PluginError({
              code: 'default-attached-requires-no-credentials',
              plugin: PLUGIN_NAME,
              message: `skill '${parsed.value.id}' declares credential slots; default-attached skills must be instruction-only`,
            });
          }
```

4. In the same handler, thread `defaultAttached` into the `store.upsert` call:

```ts
          const r = await store.upsert({
            id: parsed.value.id,
            description: parsed.value.description,
            manifestYaml: input.manifestYaml,
            bodyMd: input.bodyMd,
            version: parsed.value.version,
            defaultAttached: input.defaultAttached ?? false,
          });
```

5. Register the new hook below `skills:resolve`:

```ts
      bus.registerService<SkillsListDefaultsInput, SkillsListDefaultsOutput>(
        'skills:list-defaults',
        PLUGIN_NAME,
        async () => ({ skills: await store.getDefaults() }),
      );
```

- [ ] **Step 4: Map the new error code in admin-routes.ts**

Edit `packages/skills/src/admin-routes.ts:121-134` to include the new code in `badRequestCodes`:

```ts
    const badRequestCodes = new Set([
      'invalid-name',
      'invalid-description',
      'invalid-host',
      'invalid-slot',
      'duplicate-slot',
      'invalid-kind',
      'invalid-yaml',
      'invalid-manifest',
      'invalid-version',
      'inline-secret-forbidden',
      'capability-deferred',
      'invalid-payload',
      'default-attached-requires-no-credentials',
    ]);
```

- [ ] **Step 5: Re-run tests**

```bash
pnpm test --filter @ax/skills -- plugin.test.ts
```

Expected: PASS (including the manifest assertion).

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/plugin.ts packages/skills/src/admin-routes.ts packages/skills/src/__tests__/plugin.test.ts
git commit -m "$(cat <<'EOF'
feat(skills): register skills:list-defaults + reject default+credentials

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Admin routes — body schema accepts `defaultAttached`

**Files:**
- Modify: `packages/skills/src/admin-routes.ts`
- Test: `packages/skills/src/__tests__/admin-routes.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `admin-routes.test.ts` inside the existing `describe(...)` block:

```ts
  it('POST /admin/skills with defaultAttached: true persists the flag', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const INSTRUCTION_ONLY = `---
name: greeter
description: Greets every agent at session start.
version: 1
---
# Greeter

When asked, say hi.
`;
    const { req, res, statusOf, bodyOf } = mkReq({
      method: 'POST',
      body: { skillMd: INSTRUCTION_ONLY, defaultAttached: true },
    });
    await handlers.create(req, res);
    expect(statusOf()).toBe(201);
    expect(bodyOf()).toMatchObject({ skillId: 'greeter', created: true });

    // Confirm via the list hook that the flag is persisted.
    const { skills } = await h.bus.call<Record<string, never>, { skills: Array<{ id: string }> }>(
      'skills:list-defaults', h.ctx(), {},
    );
    expect(skills.map((s) => s.id)).toEqual(['greeter']);
  });

  it('POST /admin/skills with defaultAttached: true on a credentialed manifest returns 400', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { req, res, statusOf, bodyOf } = mkReq({
      method: 'POST',
      // SAMPLE_SKILL_MD carries GITHUB_TOKEN — should reject.
      body: { skillMd: SAMPLE_SKILL_MD, defaultAttached: true },
    });
    await handlers.create(req, res);
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { code?: string }).code).toBe('default-attached-requires-no-credentials');
  });
```

> Look at the existing admin-routes.test.ts for the `mkReq` helper shape and the `SAMPLE_SKILL_MD` constant. If your local copy uses different helper names, adapt accordingly — the *meaning* is "POST with this body, assert status + decoded body."

- [ ] **Step 2: Run failing tests**

```bash
pnpm test --filter @ax/skills -- admin-routes.test.ts
```

Expected: FAIL — `defaultAttached` rejected by the zod schema as unknown key (the schema is `.strict()`).

- [ ] **Step 3: Extend the zod schema**

Edit `packages/skills/src/admin-routes.ts:149-153`:

```ts
const upsertBodySchema = z
  .object({
    skillMd: z.string().min(1).max(SKILL_MD_MAX),
    defaultAttached: z.boolean().optional(),
  })
  .strict();
```

In both `create` and `update` handlers, thread the field through to `skills:upsert`. Locate the two `'skills:upsert'` call sites and change the bus payload from:

```ts
        const out = await deps.bus.call<
          { manifestYaml: string; bodyMd: string },
          SkillsUpsertOutput
        >('skills:upsert', ctx, split);
```

to (in `create`):

```ts
        const out = await deps.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
          'skills:upsert',
          ctx,
          { ...split, defaultAttached: zodResult.data.defaultAttached ?? false },
        );
```

and similarly in `update`.

Update the type import at the top of the file:

```ts
import type {
  SkillsListOutput,
  SkillsGetOutput,
  SkillsUpsertInput,
  SkillsUpsertOutput,
} from './types.js';
```

- [ ] **Step 4: Re-run tests**

```bash
pnpm test --filter @ax/skills -- admin-routes.test.ts
pnpm test --filter @ax/skills
```

Expected: full skills test suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/admin-routes.ts packages/skills/src/__tests__/admin-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(skills): admin routes accept defaultAttached on POST/PUT

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wire client — `lib/skills.ts`

**Files:**
- Modify: `packages/channel-web/src/lib/skills.ts`

- [ ] **Step 1: Edit `upsertSkill` / `updateSkill` signatures**

Update both functions to accept an optional `defaultAttached`:

```ts
export async function upsertSkill(
  skillMd: string,
  opts?: { defaultAttached?: boolean },
): Promise<{ skillId: string; created: boolean }> {
  const res = await fetch('/admin/skills', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({
      skillMd,
      ...(opts?.defaultAttached !== undefined
        ? { defaultAttached: opts.defaultAttached }
        : {}),
    }),
  });
  return (await handleResponse(res)) as { skillId: string; created: boolean };
}

export async function updateSkill(
  skillId: string,
  skillMd: string,
  opts?: { defaultAttached?: boolean },
): Promise<{ skillId: string; created: boolean }> {
  const res = await fetch(`/admin/skills/${encodeURIComponent(skillId)}`, {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({
      skillMd,
      ...(opts?.defaultAttached !== undefined
        ? { defaultAttached: opts.defaultAttached }
        : {}),
    }),
  });
  return (await handleResponse(res)) as { skillId: string; created: boolean };
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm build --filter @ax/channel-web
```

Expected: PASS. (`SkillSummary`/`SkillDetail` now carry `defaultAttached: boolean`, consumed in Task 8.)

- [ ] **Step 3: Commit**

```bash
git add packages/channel-web/src/lib/skills.ts
git commit -m "$(cat <<'EOF'
feat(channel-web): skills wire client accepts defaultAttached on save

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: SkillEditor — checkbox + lock-out

**Files:**
- Modify: `packages/channel-web/src/components/admin/SkillEditor.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/SkillEditor.test.tsx`

- [ ] **Step 1: Add failing tests**

Append three tests inside the `describe('SkillEditor', ...)` block:

```ts
  it('default-attached checkbox saves the flag through upsertSkill', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    const textarea = await screen.findByRole('textbox');
    const VALID_INSTRUCTION_ONLY = [
      '---',
      'name: greeter',
      'description: A skill.',
      '---',
      '# Body',
    ].join('\n');
    fireEvent.change(textarea, { target: { value: VALID_INSTRUCTION_ONLY } });

    const checkbox = screen.getByRole('checkbox', { name: /default/i });
    expect(checkbox).not.toBeDisabled();
    fireEvent.click(checkbox);

    const save = screen.getByRole('button', { name: /install/i });
    fireEvent.click(save);

    await waitFor(() => {
      expect(mockUpsertSkill).toHaveBeenCalledWith(
        VALID_INSTRUCTION_ONLY,
        { defaultAttached: true },
      );
    });
  });

  it('default-attached checkbox is disabled when the parsed manifest declares credentials', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: VALID_MD } });
    // VALID_MD has capabilities.credentials.MY_TOKEN — checkbox should lock.

    const checkbox = await screen.findByRole('checkbox', { name: /default/i });
    expect(checkbox).toBeDisabled();
  });

  it('loads existing defaultAttached state on edit', async () => {
    mockGetSkill.mockResolvedValueOnce({
      ...DETAIL,
      // Override to instruction-only + default-attached.
      capabilities: { allowedHosts: [], credentials: [] },
      manifestYaml: 'name: github-api\ndescription: Interacts with the GitHub REST API.\nversion: 1\n',
      defaultAttached: true,
    });
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);

    const checkbox = await screen.findByRole('checkbox', { name: /default/i });
    await waitFor(() => expect(checkbox).toBeChecked());
  });
```

- [ ] **Step 2: Run failing tests**

```bash
pnpm test --filter @ax/channel-web -- SkillEditor
```

Expected: FAIL — no checkbox exists.

- [ ] **Step 3: Add the checkbox to SkillEditor**

Edit `packages/channel-web/src/components/admin/SkillEditor.tsx`:

1. Add state:

```tsx
  const [defaultAttached, setDefaultAttached] = useState<boolean>(false);
```

2. In the edit-mode loader effect (the `void (async () => { ... })()` block), set the flag from the fetched detail:

```tsx
        if (cancelled) return;
        const md =
          '---\n' +
          detail.manifestYaml +
          (detail.manifestYaml.endsWith('\n') ? '' : '\n') +
          '---\n' +
          detail.bodyMd;
        setText(md);
        setDefaultAttached(detail.defaultAttached);
```

> Also reset `defaultAttached` to `false` in the new-skill branch (where the effect runs `setText(EMPTY_TEMPLATE)`).

3. Compute lock-out: a parsed manifest with non-empty `credentials` should disable the checkbox. Add after the `parsedResult` useMemo:

```tsx
  const canBeDefault =
    parsedResult.ok && parsedResult.value.capabilities.credentials.length === 0;
  // Auto-clear the flag if the user adds credential slots while the box was checked.
  useEffect(() => {
    if (!canBeDefault && defaultAttached) setDefaultAttached(false);
  }, [canBeDefault, defaultAttached]);
```

4. Pass the flag through in `handleSave`:

```tsx
      if (skillId === undefined) {
        await upsertSkill(text, { defaultAttached });
      } else {
        await updateSkill(skillId, text, { defaultAttached });
      }
```

5. Render the checkbox between the two-column preview pane and the Cancel/Save row. Use shadcn primitives (per CLAUDE.md invariant #6) — `Checkbox` from `@/components/ui/checkbox`. If that primitive isn't installed yet, run:

```bash
pnpm dlx shadcn@latest add checkbox -c packages/channel-web
```

Then in the JSX:

```tsx
      <div className="flex items-start gap-2">
        <Checkbox
          id="default-attached"
          checked={defaultAttached}
          disabled={!canBeDefault}
          onCheckedChange={(v) => setDefaultAttached(v === true)}
        />
        <div className="space-y-1 leading-none">
          <label
            htmlFor="default-attached"
            className="text-sm font-medium"
          >
            Default-attached to all agents
          </label>
          <p className="text-xs text-muted-foreground">
            {canBeDefault
              ? "Adds this skill to every agent at session start, without per-agent setup."
              : "Capability-bearing skills must be attached per agent."}
          </p>
        </div>
      </div>
```

Add the import for `Checkbox` at the top of the file.

- [ ] **Step 4: Re-run tests**

```bash
pnpm test --filter @ax/channel-web -- SkillEditor
```

Expected: PASS. (If the lock-out tests use `VALID_MD` and it has credentials, they should now pass; if a test fails because the checkbox is hidden behind a label click, use `getByLabelText('Default-attached to all agents')` instead of `getByRole('checkbox', { name: /default/i })`.)

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/admin/SkillEditor.tsx packages/channel-web/src/components/admin/__tests__/SkillEditor.test.tsx
# If `pnpm dlx shadcn add checkbox` created new files, stage them too:
git add packages/channel-web/components.json packages/channel-web/src/components/ui/checkbox.tsx
git commit -m "$(cat <<'EOF'
feat(channel-web): SkillEditor default-attached checkbox + lock-out

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: SkillsTab — "default" badge on default-attached rows

**Files:**
- Modify: `packages/channel-web/src/components/admin/SkillsTab.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/SkillsTab.test.tsx`

- [ ] **Step 1: Add failing test**

Append to `SkillsTab.test.tsx`:

```ts
  it('renders a "default" badge for default-attached skills', async () => {
    mockListSkills.mockResolvedValueOnce([
      {
        id: 'heartbeat',
        description: 'Daily check-in.',
        version: 1,
        capabilities: { allowedHosts: [], credentials: [] },
        defaultAttached: true,
        updatedAt: '2026-05-19T00:00:00.000Z',
      },
      {
        id: 'github',
        description: 'GitHub API.',
        version: 1,
        capabilities: { allowedHosts: ['api.github.com'], credentials: [{ slot: 'X', kind: 'api-key' }] },
        defaultAttached: false,
        updatedAt: '2026-05-19T00:00:00.000Z',
      },
    ]);

    render(<SkillsTab />);

    // The default-attached row should expose the badge text.
    const heartbeatRow = (await screen.findByText('heartbeat')).closest('tr')!;
    expect(heartbeatRow).toHaveTextContent(/default/i);

    // The non-default row should not.
    const githubRow = screen.getByText('github').closest('tr')!;
    expect(githubRow).not.toHaveTextContent(/default/i);
  });
```

> Adapt `mockListSkills` to the existing mock-setup pattern in `SkillsTab.test.tsx`.

- [ ] **Step 2: Run failing test**

```bash
pnpm test --filter @ax/channel-web -- SkillsTab
```

Expected: FAIL.

- [ ] **Step 3: Add the badge**

Edit `packages/channel-web/src/components/admin/SkillsTab.tsx`. In the row rendering JSX (the `<TableCell className="font-mono text-xs">{s.id}</TableCell>` cell), append a badge:

```tsx
                  <TableCell className="font-mono text-xs">
                    {s.id}
                    {s.defaultAttached && (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        default
                      </Badge>
                    )}
                  </TableCell>
```

> `Badge` is already imported in this file.

- [ ] **Step 4: Re-run tests**

```bash
pnpm test --filter @ax/channel-web
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/admin/SkillsTab.tsx packages/channel-web/src/components/admin/__tests__/SkillsTab.test.tsx
git commit -m "$(cat <<'EOF'
feat(channel-web): SkillsTab default badge on default-attached rows

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Orchestrator — union defaults into installedSkills

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

This is the load-bearing wire-up step — without it the column + hook + UI ship as dead code (I-S7 violated). Pay particular attention here.

- [ ] **Step 1: Add failing tests**

Append four new tests inside the same `describe(...)` block as the existing Phase 1 skill-attachment tests in `orchestrator.test.ts` (look for `// Phase 1 (skill-install) — skill attachment union step`):

```ts
  // -----------------------------------------------------------------
  // 2026-05-19 defaults — union of explicit attachments + defaults.
  // -----------------------------------------------------------------

  function buildDefaultsHook(opts: {
    listDefaultsThrows?: unknown;
    skills?: ResolvedSkill[];
  }): { listDefaultsCalls: { count: number }; services: Record<string, ServiceHandler> } {
    const counter = { count: 0 };
    const services: Record<string, ServiceHandler> = {
      'skills:list-defaults': async () => {
        counter.count += 1;
        if (opts.listDefaultsThrows !== undefined) throw opts.listDefaultsThrows;
        return { skills: opts.skills ?? [] };
      },
    };
    return { listDefaultsCalls: counter, services };
  }

  it('unions skills:list-defaults output into installedSkills (no explicit attachments)', async () => {
    const proxy = buildProxyHooks();
    const defaultSkill: ResolvedSkill = {
      id: 'heartbeat',
      capabilities: { allowedHosts: [], credentials: [] },
      bodyMd: '# heartbeat\n',
      manifestYaml: 'name: heartbeat\ndescription: hb\n',
    };
    const defaults = buildDefaultsHook({ skills: [defaultSkill] });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } },
          // No explicit skillAttachments.
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, defaults.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('defaults-only-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(defaults.listDefaultsCalls.count).toBe(1);

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{ id: string; skillMd: string }>;
    };
    expect(sandboxIn.installedSkills).toHaveLength(1);
    expect(sandboxIn.installedSkills![0]!.id).toBe('heartbeat');
  });

  it('explicit attachments win on id collision (defaults filtered out for same id)', async () => {
    const proxy = buildProxyHooks();
    const explicitSkill: ResolvedSkill = {
      id: 'shared',
      capabilities: { allowedHosts: ['api.example.com'], credentials: [{ slot: 'TOK', kind: 'api-key' }] },
      bodyMd: '# explicit body\n',
      manifestYaml: 'name: shared\ndescription: explicit\n',
    };
    const defaultSameId: ResolvedSkill = {
      id: 'shared',
      capabilities: { allowedHosts: [], credentials: [] },
      bodyMd: '# default body\n',
      manifestYaml: 'name: shared\ndescription: default\n',
    };
    const skillsHooks = buildSkillsHooks({ skills: { shared: explicitSkill } });
    const defaults = buildDefaultsHook({ skills: [defaultSameId] });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } },
          skillAttachments: [
            { skillId: 'shared', credentialBindings: { TOK: 'my-tok' } },
          ],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, skillsHooks.services, defaults.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('explicit-wins-session'),
      { message: { role: 'user', content: 'hi' } },
    );

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills: Array<{ id: string; skillMd: string }>;
    };
    expect(sandboxIn.installedSkills).toHaveLength(1);
    // Explicit body wins.
    expect(sandboxIn.installedSkills[0]!.skillMd).toContain('# explicit body');
  });

  it('skips defaults entirely when skills:list-defaults service is not registered', async () => {
    // Stripped-preset compatibility (I-S6).
    const proxy = buildProxyHooks();
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } },
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services);
    // NO defaults.services — service absent.
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('no-defaults-service-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{ id: string; skillMd: string }>;
    };
    expect(sandboxIn.installedSkills ?? []).toHaveLength(0);
  });

  it('skills:list-defaults throwing does NOT terminate the session (non-fatal, I-S5)', async () => {
    const proxy = buildProxyHooks();
    const defaults = buildDefaultsHook({ listDefaultsThrows: new Error('boom') });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } },
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, defaults.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('defaults-throw-session'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete'); // NOT terminated.

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills?: Array<{ id: string; skillMd: string }>;
    };
    expect(sandboxIn.installedSkills ?? []).toHaveLength(0);
  });
```

- [ ] **Step 2: Run failing tests**

```bash
pnpm test --filter @ax/chat-orchestrator -- orchestrator.test.ts
```

Expected: FAIL — the orchestrator doesn't call `skills:list-defaults` yet.

- [ ] **Step 3: Edit `packages/chat-orchestrator/src/orchestrator.ts`**

At lines 871-878 (just before the `installedSkillsForSandbox` construction), add the defaults pull and the union step. The end-state of that span should be:

```ts
    const unionedAllowlist = [...baseAllowSet];
    const unionedCreds = baseCreds;

    // 2026-05-19 defaults — union admin-curated default skills into the
    // installedSkills set. Soft-coupled via hasService: stripped presets
    // without @ax/skills no-op (I-S6). Throws are non-fatal (I-S5) — log
    // + treat as empty; the session still opens. Explicit attachments win
    // on id collision (I-S4) — we filter defaults by ids already present
    // in resolvedSkills.
    let defaultSkillsForUnion: ResolvedSkillForOrch[] = [];
    if (bus.hasService('skills:list-defaults')) {
      try {
        const r = await bus.call<
          Record<string, never>,
          { skills: ResolvedSkillForOrch[] }
        >('skills:list-defaults', ctx, {});
        defaultSkillsForUnion = r.skills;
      } catch (err) {
        // Matches the existing `ctx.logger.warn(event, fields)` convention in
        // this file (see proxy_close_session_failed at orchestrator.ts:930).
        ctx.logger.warn('skills_list_defaults_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        defaultSkillsForUnion = [];
      }
    }
    const explicitIds = new Set(resolvedSkills.map((s) => s.id));
    const unionedSkills = [
      ...resolvedSkills,
      ...defaultSkillsForUnion.filter((s) => !explicitIds.has(s.id)),
    ];

    const installedSkillsForSandbox: InstalledSkillForSandbox[] = unionedSkills.map((s) => ({
      id: s.id,
      skillMd: '---\n' + s.manifestYaml + (s.manifestYaml.endsWith('\n') ? '' : '\n') + '---\n' + s.bodyMd,
    }));
```

- [ ] **Step 4: Re-run tests**

```bash
pnpm test --filter @ax/chat-orchestrator -- orchestrator.test.ts
```

Expected: all four new cases pass. Existing Phase 1 tests still pass (the explicit-attachment path is unchanged when defaults are empty).

- [ ] **Step 5: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/__tests__/orchestrator.test.ts
git commit -m "$(cat <<'EOF'
feat(chat-orchestrator): union skills:list-defaults into installedSkills

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Preset wiring assertions + half-wired window closure

**Files:**
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (only if the static-hook-set assertion exists for @ax/skills)

- [ ] **Step 1: Check whether preset.test.ts asserts the @ax/skills `registers` set**

```bash
grep -n "skills:" presets/k8s/src/__tests__/preset.test.ts
```

If the file only asserts the plugin *name* list (not its individual hook list), no edit is needed — the plugin's own `plugin.test.ts` (updated in Task 5) already pins the `registers` set, and the k8s preset just instantiates `createSkillsPlugin()` which inherits the new hook.

If there IS a wiring assertion like `expect(allRegistered).toContain('skills:resolve')`, append:

```ts
        'skills:list-defaults',
```

to the same list.

- [ ] **Step 2: Run preset + acceptance tests**

```bash
pnpm test --filter @ax/preset-k8s
```

Expected: PASS. The acceptance.test.ts sub-tests drop `@ax/skills` from the loaded set (per `feedback_preset_drop_vs_load_lists.md`), so those canaries don't need to grow.

- [ ] **Step 3: Commit (only if Step 1 required an edit)**

```bash
git add presets/k8s/src/__tests__/preset.test.ts
git commit -m "$(cat <<'EOF'
test(preset-k8s): pin skills:list-defaults in static wiring assertion

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Otherwise skip this commit.

---

## Task 12: Canary acceptance — default skill threads into sandbox:open-session

This proves end-to-end that the new column → hook → orchestrator union → sandbox payload chain works. We do it at the orchestrator level (not the deep sandbox-subprocess level) — the existing `skill-discovery.acceptance.test.ts` already pins the runner-visible side; what's NEW is the orchestrator union step, and that's what this canary covers.

**Files:**
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

- [ ] **Step 1: Add the canary test**

Append in the same `describe(...)` block as Task 10:

```ts
  // 2026-05-19 defaults — end-to-end canary closing I-S7's half-wired window.
  // Default-attached instruction-only skill flows: db row → skills:list-defaults
  // → orchestrator union → sandbox:open-session installedSkills payload.
  it('CANARY: default-attached instruction skill is delivered to sandbox:open-session with intact SKILL.md', async () => {
    const proxy = buildProxyHooks();
    const defaultSkill: ResolvedSkill = {
      id: 'greeter',
      capabilities: { allowedHosts: [], credentials: [] },
      bodyMd: '# Greeter\n\nSay hi.\n',
      manifestYaml: 'name: greeter\ndescription: Greets every agent.\nversion: 1\n',
    };
    const defaults = buildDefaultsHook({ skills: [defaultSkill] });
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks({
      agentsResolve: async () => ({
        agent: {
          ...TEST_AGENT,
          allowedHosts: ['api.anthropic.com'],
          requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } },
          // Critical: agent has ZERO explicit skillAttachments. The skill
          // gets there only because it is default-attached.
          skillAttachments: [],
        },
      }),
      openSession: makeChatEndOpenSession(busRef),
    });
    Object.assign(mocks.services, proxy.services, defaults.services);
    const h = await createTestHarness({
      services: mocks.services,
      plugins: [
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
      ],
    });
    busRef.current = h.bus;

    await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      silentCtx('defaults-canary-session'),
      { message: { role: 'user', content: 'hi' } },
    );

    const sandboxIn = mocks.calls.lastSandboxInput as {
      installedSkills: Array<{ id: string; skillMd: string }>;
    };
    expect(sandboxIn.installedSkills).toHaveLength(1);
    const entry = sandboxIn.installedSkills[0]!;
    expect(entry.id).toBe('greeter');
    // SKILL.md framing: --- yaml --- body
    expect(entry.skillMd).toContain('---\nname: greeter\n');
    expect(entry.skillMd).toContain('---\n# Greeter');
  });
```

- [ ] **Step 2: Run the canary**

```bash
pnpm test --filter @ax/chat-orchestrator -- orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/chat-orchestrator/src/__tests__/orchestrator.test.ts
git commit -m "$(cat <<'EOF'
test(chat-orchestrator): canary — default skill reaches sandbox:open-session

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Full build / test / lint + security-checklist + PR

**Files:** None edited directly here.

- [ ] **Step 1: Full build, test, lint**

```bash
pnpm build
pnpm test
pnpm lint
```

All three must be fully green before opening the PR. Per project convention (`feedback_run_lint_before_pr.md` + `feedback_run_tsc_alongside_vitest.md`), `pnpm build` is the source of truth for type errors — don't rely on `pnpm test` alone.

- [ ] **Step 2: Security-checklist pass**

Invoke the `security-checklist` skill. This PR touches:
  - **Skill body content** lands in the agent's context at session-open — same trust profile as today's installed-skill body (operator-trusted, lands in model context). Default-attached is admin-write-only via `auth:require-admin`. No new prompt-injection surface beyond what already exists.
  - **Capability gating** — `default-attached + credentials.length > 0` is rejected at the host. UI lockout is convenience; the gate is on the server (I-S2).
  - **No new dependencies, no new IPC actions, no new sandbox boundaries.**

Walk the three threat models and append the security note to the PR body.

- [ ] **Step 3: YAGNI / placeholder audit**

Skim the diff:

```bash
git diff origin/main...HEAD --stat
git log origin/main..HEAD --oneline
```

Per `feedback_yagni_check_in_plans.md`: every added line of code should be load-bearing for this PR or for a documented next slice. If there are stubs, TODOs, or unused exports, remove them before opening the PR.

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin feat/defaults-skills-half
```

Open the PR with a body that includes:

- **Summary:** 1-3 bullets — column + hook + orchestrator union + admin checkbox.
- **Invariants:** Reproduce I-S1..I-S7 from this plan, each with a sentence on how the PR satisfies it.
- **Boundary review** (per CLAUDE.md):
  - *Alternate impl this hook could have:* a `@ax/skills-fs` (file-backed) plugin reading default skills from a config dir.
  - *Payload field names that might leak:* none. `SkillsListDefaultsOutput` reuses `ResolvedSkill`, which uses no storage vocabulary.
  - *Subscriber risk:* none (service hook, no subscribers).
  - *Wire surface:* no new IPC action.
- **Half-wired window:** CLOSED in this PR (DB column + hook + orchestrator union + admin UI + canary test all ship together).
- **Security note:** from Step 2.
- **Follow-up:** routines-half plan ships separately (`docs/plans/2026-05-19-defaults-routines-half-impl.md` to be written next).

- [ ] **Step 5: Update memory**

After PR merges, add a `project_defaults_skills_half_shipped.md` memory entry summarising:
- PR number, ship date
- What's in (column, hook, union, UI checkbox, canary)
- What's deferred (routines-half slice, capability-bearing defaults, per-agent opt-out)

---

## Self-review checklist (do this before declaring the plan ready)

**Spec coverage** — each design section maps to at least one task:

- Design §"Part A — Skill defaults" / Storage → Task 2 ✓
- Hook surface → Tasks 3 + 5 ✓
- Orchestrator change → Task 10 ✓
- Failure modes (list-defaults throw, service absent) → Task 10 ✓
- Admin UI (checkbox + lock-out + list annotation) → Tasks 7 + 8 + 9 ✓
- Update propagation (admin edit → next session sees new bytes) → covered by store round-trip in Task 4 (no per-agent state to invalidate) ✓
- "Non-goal: capability-bearing defaults" → enforced by Task 5 + Task 8 ✓

**Type consistency** — `defaultAttached` (camelCase across types) vs `default_attached` (snake_case at DB column) is the only spelling distinction; review confirms both are used consistently in their respective layers.

**Placeholder scan** — no "TBD", "implement later", or unspecified-code steps.

**Bite-sized check** — each task has a failing-test step, a run-and-see-fail step, a code step, a re-run-and-see-pass step, and a commit step. Tasks 1, 11, and 13 are integration/audit tasks rather than TDD cycles — intentional.

**LOC estimate** — design predicted ~300-400 LOC for skills-half. Plan covers approximately that.

---

## Out of scope (intentionally)

- Routines-half (separate plan; design's Part B).
- Capability-bearing default skills (design "Non-goals" — adds `default_bindings` column later).
- Per-agent opt-out from a default (design "Non-goals").
- Per-team / per-tenant scoping (design "Non-goals").
- Admin "Defaults" cross-cutting tab (design "Non-goals" — defaults live in `/admin/skills`).
