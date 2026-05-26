# JIT — Per-User Skill Attachment + Orchestrator Union Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **per-`(user, agent)`** skill-attachment layer so a user can self-serve activate a catalog skill on *their* agent without touching the admin-managed agent-global config — and teach the orchestrator to union **three** skill sources (per-user, agent-global, default-attached) with precedence **per-user > agent-global > default-attached** on id collision.

**Architecture:** A new additive `skills_v1_user_attachments` table in `@ax/skills` holds one row per `(owner_user_id, agent_id, skill_id)` with a JSONB `credential_bindings` map. Two new service hooks — `skills:attach-for-user` (write) and `skills:list-user-attachments` (read) — back it. The orchestrator fetches the per-user list for `(ctx.userId, agent.id)`, then redefines its existing `attachments` variable as `[...perUser, ...agentGlobal filtered to drop per-user-covered ids]`. Because the **whole** downstream chain (`skills:resolve(ownerUserId)`, the credential/host merge loop, the defaults filter, the `installedSkills` build) already keys off that one `attachments` list, the three-source union and the per-user-binding-wins precedence fall out with no other orchestrator change. The skill **content** override (a user-scoped skill of the same id wins) is *already* handled by `skills:resolve(ownerUserId)` via `mergeUserWins` — the orchestrator already passes `ownerUserId: ctx.userId`, so it is preserved for free.

**Tech Stack:** TypeScript, pnpm workspace, kysely + Postgres (testcontainers in tests), zod (return-shape validation), vitest.

**Scope guardrails:**

- **Hook-surface change (boundary review).** Two new `skills:*` service hooks. Payload fields are `{ userId, agentId, skillId, credentialBindings }` (write) and `{ userId, agentId }` → `{ attachments: { skillId, credentialBindings }[] }` (read) — all opaque identifiers + an opaque-ref map, no `sha`/`pod`/`socket`/`bucket`/`generation` vocabulary. The full boundary-review note is in **Task 5 Step 6** and the PR section; §11 pre-specified these and this plan confirms them against reality.
- **Ownership decision (invariant #4).** Per-user attachments live in `@ax/skills`, **not** `@ax/agents`, for three reasons: (a) the design names the hooks `skills:*` (§11.2); (b) `@ax/skills` already owns *the user's private skill world* (`skills_v1_user_skills`) — keeping "a user's personal skill state" in one plugin; (c) agent-global attachments remain `@ax/agents`' admin-managed config, a **genuinely separate concept** (admin-global vs self-serve), so there is one source of truth per concept. `agent_id` is stored as an **opaque scoping key** — no FK to `agents_v1_agents`, no `agents:resolve` validation (capabilities minimized; a dangling attachment to a deleted agent simply never resolves at session open).
- **Security-checklist applies (pre-PR gate).** The card itself does not flag it, but this hook **widens a session's egress allowlist and injects user-scoped credential refs into `proxy:open-session`** — a capability/credential boundary (invariant #5). The threat model is pre-stated in **Task 7 Step 4**; run the `security-checklist` skill before opening the PR and paste the structured note.
- **Half-wired window.** The **read** path (`skills:list-user-attachments`) is **fully wired this PR** — the orchestrator calls it on every chat; it returns `[]` for everyone today (no rows exist), so behavior is byte-unchanged until rows are written. The **write** path (`skills:attach-for-user`) is **registered + unit-tested + canary-reachable** this PR but has **no production caller** — its first production caller is **TASK-36** (pending-turn → re-spawn → resume: *"on approval the orchestrator installs/attaches/binds"*); the out-of-band settings "Connections" surface (Part II P7 #1) is a later second caller. State "half-wired window OPEN (write path)" in the PR; it CLOSES in **TASK-36**.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/skills/src/migrations.ts` | DDL for skills tables | **add** `skills_v1_user_attachments` table + `UserAttachmentRow` + extend `SkillsDatabase` |
| `packages/skills/src/attachment-validation.ts` | **new** — pure binding validator (orphan / missing) | **create** |
| `packages/skills/src/user-attachments-store.ts` | **new** — per-`(user, agent)` attachment storage | **create** |
| `packages/skills/src/types.ts` | public I/O shapes + `returns` schemas | **add** attach / list-user-attachments types + Zod schemas |
| `packages/skills/src/plugin.ts` | hook handlers + manifest | **register** `skills:attach-for-user` + `skills:list-user-attachments`; add both to `registers` |
| `packages/chat-orchestrator/src/orchestrator.ts` | per-session skill union | **add** per-user source; redefine `attachments` as the per-user-first union |
| `packages/skills/src/__tests__/migrations.test.ts` | migration tests | **extend** (new table + teardown) |
| `packages/skills/src/__tests__/attachment-validation.test.ts` | **new** validator unit tests | **create** |
| `packages/skills/src/__tests__/user-attachments-store.test.ts` | **new** store tests | **create** |
| `packages/skills/src/__tests__/return-schemas.test.ts` | returns-schema drift guard | **extend** (two new schemas) |
| `packages/skills/src/__tests__/plugin.test.ts` | plugin hooks + manifest | **extend** (manifest equality, attach/list tests, teardown) |
| `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` | orchestrator behavior | **extend** (per-user precedence test) |
| `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` | end-to-end canary | **extend** (per-user attachment + content-override cases) |

---

## Shared rule: attachment-binding validity (referenced by Tasks 2, 5)

A per-user attachment's `credentialBindings` (slot → opaque credential ref) is **valid** for a resolved skill iff:

- **no orphan binding** — every key in `credentialBindings` is a credential slot the skill's manifest declares;
- **no missing binding** — every credential slot the skill declares has a binding key present.

This mirrors `@ax/agents`' `validateNewAttachments` (`binding-orphan` / `binding-missing`) but is **re-implemented independently** in `@ax/skills` (no cross-plugin import — invariant #2). `slot-collision` is **not** checked here: cross-skill slot collisions across sources are resolved/rejected at session open by the orchestrator's existing `skill-slot-collision` path (with per-user-wins dropping any agent-global copy of the *same* skill id first, so a skill never collides with itself). Documented as a known residual in Task 7's Self-Review.

---

### Task 1: Add the `skills_v1_user_attachments` table

**Files:**
- Modify: `packages/skills/src/migrations.ts`
- Test: `packages/skills/src/__tests__/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `migrations.test.ts` (mirrors the existing `makeKysely()` + `runSkillsMigration` pattern in that file):

```typescript
it('creates skills_v1_user_attachments with the compound PK (user, agent, skill)', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);

  await db
    .insertInto('skills_v1_user_attachments')
    .values([
      { owner_user_id: 'u1', agent_id: 'a1', skill_id: 'github', credential_bindings: JSON.stringify({ GITHUB_TOKEN: 'ref1' }) as unknown },
      { owner_user_id: 'u1', agent_id: 'a1', skill_id: 'linear', credential_bindings: JSON.stringify({}) as unknown },
      { owner_user_id: 'u1', agent_id: 'a2', skill_id: 'github', credential_bindings: JSON.stringify({ GITHUB_TOKEN: 'ref2' }) as unknown },
    ])
    .execute();

  // Distinct (user, agent) pairs keep their own rows.
  const a1 = await db
    .selectFrom('skills_v1_user_attachments')
    .selectAll()
    .where('owner_user_id', '=', 'u1')
    .where('agent_id', '=', 'a1')
    .orderBy('skill_id')
    .execute();
  expect(a1.map((r) => r.skill_id)).toEqual(['github', 'linear']);

  // Same (user, agent, skill) again must violate the compound PK.
  await expect(
    db
      .insertInto('skills_v1_user_attachments')
      .values({ owner_user_id: 'u1', agent_id: 'a1', skill_id: 'github', credential_bindings: JSON.stringify({}) as unknown })
      .execute(),
  ).rejects.toThrow();
});
```

Also extend the `afterEach` teardown in this file to drop the new table **first** (it has no FK, but keep drop order tidy), inside the existing `while (opened.length > 0)` loop, before the `skills_v1_user_skills` drop:

```typescript
try {
  await k.schema.dropTable('skills_v1_user_attachments').ifExists().execute();
} catch {
  /* drained pool — ignore */
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/migrations.test.ts`
Expected: FAIL — relation `skills_v1_user_attachments` does not exist.

- [ ] **Step 3: Add the table to the migration + the row type**

In `packages/skills/src/migrations.ts`, inside `runSkillsMigration`, after the existing `skills_v1_user_skills` `CREATE TABLE`, add:

```typescript
  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_user_attachments (
      owner_user_id       TEXT NOT NULL,
      agent_id            TEXT NOT NULL,
      skill_id            TEXT NOT NULL,
      credential_bindings JSONB NOT NULL DEFAULT '{}',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, agent_id, skill_id)
    )
  `.execute(db);
```

Add the row interface and extend `SkillsDatabase` at the bottom of the file:

```typescript
/**
 * Per-(user, agent) skill activation. Self-serve layer that sits ABOVE the
 * admin-managed agent-global attachments owned by @ax/agents. `agent_id` is
 * an opaque scoping key — no FK to agents_v1_agents (cross-plugin FKs are
 * banned; a dangling row to a deleted agent simply never resolves at session
 * open). `credential_bindings` is a JSONB slot → opaque-ref map (never a
 * secret), mirroring the agent-global attachment shape.
 */
export interface UserAttachmentRow {
  owner_user_id: string;
  agent_id: string;
  skill_id: string;
  credential_bindings: unknown; // JSONB Record<string,string>; store casts on read
  created_at: Date;
  updated_at: Date;
}

export interface SkillsDatabase {
  skills_v1_skills: SkillsRow;
  skills_v1_user_skills: UserSkillsRow;
  skills_v1_user_attachments: UserAttachmentRow; // <-- add
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/migrations.ts packages/skills/src/__tests__/migrations.test.ts
git commit -m "feat(skills): add skills_v1_user_attachments table for per-user skill activation"
```

---

### Task 2: Attachment-binding validator (pure function)

**Files:**
- Create: `packages/skills/src/attachment-validation.ts`
- Test: `packages/skills/src/__tests__/attachment-validation.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { validateAttachmentBindings } from '../attachment-validation.js';

describe('validateAttachmentBindings', () => {
  it('accepts bindings that exactly match the declared slots', () => {
    expect(
      validateAttachmentBindings(['GITHUB_TOKEN'], { GITHUB_TOKEN: 'ref' }),
    ).toEqual({ ok: true });
  });

  it('accepts an inert skill (no slots, no bindings)', () => {
    expect(validateAttachmentBindings([], {})).toEqual({ ok: true });
  });

  it('rejects a binding for an undeclared slot (orphan)', () => {
    const r = validateAttachmentBindings(['GITHUB_TOKEN'], { GITHUB_TOKEN: 'ref', EXTRA: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('binding-orphan');
  });

  it('rejects a declared slot with no binding (missing)', () => {
    const r = validateAttachmentBindings(['GITHUB_TOKEN', 'OTHER'], { GITHUB_TOKEN: 'ref' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('binding-missing');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/attachment-validation.test.ts`
Expected: FAIL — cannot find module `../attachment-validation.js`.

- [ ] **Step 3: Implement the validator**

Create `packages/skills/src/attachment-validation.ts`:

```typescript
/**
 * Pure-function validation for a per-user skill attachment's credential
 * bindings. No bus calls, no DB — exercised independently in unit tests.
 *
 * Mirrors @ax/agents' validateNewAttachments (binding-orphan / binding-missing)
 * but is re-implemented here on purpose: invariant #2 forbids importing across
 * the plugin boundary. The shapes are simple (a slot-name array + a slot→ref
 * map), so there is no cross-plugin type to drift.
 *
 * `slot-collision` is intentionally NOT checked here — cross-skill slot
 * collisions across the per-user / agent-global / default sources are resolved
 * (per-user wins, dropping the agent-global copy of the same skill id) and
 * otherwise rejected at session open by the orchestrator's existing
 * `skill-slot-collision` path. This validator only checks one skill's own
 * bindings against its own declared slots.
 */
export type AttachmentValidationResult =
  | { ok: true }
  | { ok: false; code: 'binding-orphan' | 'binding-missing'; message: string };

export function validateAttachmentBindings(
  declaredSlots: readonly string[],
  credentialBindings: Record<string, string>,
): AttachmentValidationResult {
  const declared = new Set(declaredSlots);

  // binding-orphan: a binding key the skill does not declare.
  for (const slot of Object.keys(credentialBindings)) {
    if (!declared.has(slot)) {
      return {
        ok: false,
        code: 'binding-orphan',
        message: `attachment binds slot '${slot}' which the skill does not declare`,
      };
    }
  }

  // binding-missing: a declared slot with no binding.
  for (const slot of declared) {
    if (!(slot in credentialBindings)) {
      return {
        ok: false,
        code: 'binding-missing',
        message: `attachment is missing binding for required slot '${slot}'`,
      };
    }
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/attachment-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/attachment-validation.ts packages/skills/src/__tests__/attachment-validation.test.ts
git commit -m "feat(skills): pure validator for per-user attachment credential bindings"
```

---

### Task 3: Per-user attachments store (upsert + list)

**Files:**
- Create: `packages/skills/src/user-attachments-store.ts`
- Test: `packages/skills/src/__tests__/user-attachments-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/skills/src/__tests__/user-attachments-store.test.ts` (mirrors `store.test.ts`'s testcontainers + `makeKysely()` pattern — copy its `beforeAll`/`afterEach`/`afterAll` boilerplate, adding `skills_v1_user_attachments` to the teardown DROP set):

```typescript
import { describe, it, expect } from 'vitest';
import { runSkillsMigration } from '../migrations.js';
import { createUserAttachmentsStore } from '../user-attachments-store.js';
// + the makeKysely()/container boilerplate copied from store.test.ts

describe('createUserAttachmentsStore', () => {
  it('upsert inserts then updates; listForUserAgent is scoped + ordered', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createUserAttachmentsStore(db);

    const first = await store.upsert({ ownerUserId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } });
    expect(first).toEqual({ created: true });
    await store.upsert({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear', credentialBindings: {} });

    // Re-upsert the same (user, agent, skill) replaces the bindings; created:false.
    const again = await store.upsert({ ownerUserId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref2' } });
    expect(again).toEqual({ created: false });

    const list = await store.listForUserAgent('u1', 'a1');
    expect(list).toEqual([
      { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref2' } },
      { skillId: 'linear', credentialBindings: {} },
    ]);
  });

  it('scopes by (user, agent): user B and agent a2 never bleed into a1/u1', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createUserAttachmentsStore(db);

    await store.upsert({ ownerUserId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: {} });
    await store.upsert({ ownerUserId: 'u1', agentId: 'a2', skillId: 'linear', credentialBindings: {} });
    await store.upsert({ ownerUserId: 'u2', agentId: 'a1', skillId: 'slack', credentialBindings: {} });

    const u1a1 = await store.listForUserAgent('u1', 'a1');
    expect(u1a1.map((a) => a.skillId)).toEqual(['github']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/user-attachments-store.test.ts`
Expected: FAIL — cannot find module `../user-attachments-store.js`.

- [ ] **Step 3: Implement the store**

Create `packages/skills/src/user-attachments-store.ts` (mirrors `user-store.ts`'s SELECT→INSERT-or-UPDATE shape and JSONB handling from `@ax/agents`' store):

```typescript
/**
 * @ax/skills per-(user, agent) attachment store.
 *
 * Self-serve layer above the admin-managed agent-global attachments owned by
 * @ax/agents. Every query is scoped to (owner_user_id, agent_id): this is the
 * scope-isolation boundary — user A's queries MUST NEVER touch user B's rows,
 * and agent a1's attachments never bleed into a2.
 *
 * credential_bindings is JSONB: written via JSON.stringify (matching the
 * @ax/agents skill_attachments precedent), read back as a parsed object by
 * node-postgres.
 */
import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';

export interface UserAttachment {
  skillId: string;
  /** slot → opaque credential ref (the user's own credential). Never a secret. */
  credentialBindings: Record<string, string>;
}

export interface UpsertUserAttachmentInput {
  ownerUserId: string;
  agentId: string;
  skillId: string;
  credentialBindings: Record<string, string>;
}

export interface UserAttachmentsStore {
  /** Upsert one attachment. Returns { created: true } on insert, false on update. */
  upsert(input: UpsertUserAttachmentInput): Promise<{ created: boolean }>;
  /** List a user's attachments on one agent, ordered by skill_id (deterministic). */
  listForUserAgent(ownerUserId: string, agentId: string): Promise<UserAttachment[]>;
}

export function createUserAttachmentsStore(
  db: Kysely<SkillsDatabase>,
): UserAttachmentsStore {
  return {
    async upsert(input) {
      // SELECT → INSERT or UPDATE so `created` is accurate. Accepted race
      // mirrors user-store.ts: a concurrent insert of the same compound key
      // surfaces as a PRIMARY KEY violation, acceptable at user scale.
      const existing = await db
        .selectFrom('skills_v1_user_attachments')
        .select('skill_id')
        .where('owner_user_id', '=', input.ownerUserId)
        .where('agent_id', '=', input.agentId)
        .where('skill_id', '=', input.skillId)
        .executeTakeFirst();

      if (existing === undefined) {
        const now = new Date();
        await db
          .insertInto('skills_v1_user_attachments')
          .values({
            owner_user_id: input.ownerUserId,
            agent_id: input.agentId,
            skill_id: input.skillId,
            credential_bindings: JSON.stringify(input.credentialBindings) as unknown,
            created_at: now,
            updated_at: now,
          })
          .execute();
        return { created: true };
      }

      await db
        .updateTable('skills_v1_user_attachments')
        .set({
          credential_bindings: JSON.stringify(input.credentialBindings) as unknown,
          updated_at: new Date(),
        })
        .where('owner_user_id', '=', input.ownerUserId)
        .where('agent_id', '=', input.agentId)
        .where('skill_id', '=', input.skillId)
        .execute();
      return { created: false };
    },

    async listForUserAgent(ownerUserId, agentId) {
      const rows = await db
        .selectFrom('skills_v1_user_attachments')
        .selectAll()
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .orderBy('skill_id', 'asc')
        .execute();

      return rows.map((r) => ({
        skillId: r.skill_id,
        credentialBindings: (r.credential_bindings ?? {}) as Record<string, string>,
      }));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/user-attachments-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/user-attachments-store.ts packages/skills/src/__tests__/user-attachments-store.test.ts
git commit -m "feat(skills): per-(user,agent) attachment store (upsert + scoped list)"
```

---

### Task 4: Public hook types + `returns` schemas

**Files:**
- Modify: `packages/skills/src/types.ts`
- Test: `packages/skills/src/__tests__/return-schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `return-schemas.test.ts` (and add the two new symbols to its import block):

```typescript
it('SkillsAttachForUserOutputSchema round-trips a fully-populated value', () => {
  const v: SkillsAttachForUserOutput = { created: true };
  expect(SkillsAttachForUserOutputSchema.parse(v)).toEqual(v);
});

it('SkillsListUserAttachmentsOutputSchema round-trips a fully-populated value', () => {
  const v: SkillsListUserAttachmentsOutput = {
    attachments: [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref' } }],
  };
  expect(SkillsListUserAttachmentsOutputSchema.parse(v)).toEqual(v);
});
```

Add to the import block at the top of `return-schemas.test.ts`:

```typescript
  SkillsAttachForUserOutputSchema,
  SkillsListUserAttachmentsOutputSchema,
  type SkillsAttachForUserOutput,
  type SkillsListUserAttachmentsOutput,
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/return-schemas.test.ts`
Expected: FAIL — the two schema symbols are not exported from `../types.js`.

- [ ] **Step 3: Add the interfaces + schemas to `types.ts`**

In `packages/skills/src/types.ts`, after the `SkillsCheckForUpdates*` interfaces (before the runtime-`returns` section), add:

```typescript
// ---------------------------------------------------------------------------
// Per-user skill attachment (TASK-33). Self-serve layer above the admin-managed
// agent-global attachments owned by @ax/agents. A future @ax/skills-fs impl
// would register these same hooks with these exact shapes — no field mentions
// postgres, rows, or any storage detail. `agentId`/`skillId`/`userId` are
// opaque ids; `credentialBindings` maps a declared slot to an opaque credential
// ref (NEVER a secret — same posture as the agent-global attachment shape).
// ---------------------------------------------------------------------------
export interface UserSkillAttachment {
  skillId: string;
  credentialBindings: Record<string, string>;
}

export interface SkillsAttachForUserInput {
  userId: string;
  agentId: string;
  skillId: string;
  credentialBindings: Record<string, string>;
}
export interface SkillsAttachForUserOutput {
  created: boolean;
}

export interface SkillsListUserAttachmentsInput {
  userId: string;
  agentId: string;
}
export interface SkillsListUserAttachmentsOutput {
  attachments: UserSkillAttachment[];
}
```

Then, in the runtime-`returns` section (after `SkillsCheckForUpdatesOutputSchema`), add:

```typescript
export const SkillsAttachForUserOutputSchema = z.object({
  created: z.boolean(),
}) as unknown as ZodType<SkillsAttachForUserOutput>;

export const SkillsListUserAttachmentsOutputSchema = z.object({
  attachments: z.array(
    z.object({
      skillId: z.string(),
      credentialBindings: z.record(z.string()),
    }),
  ),
}) as unknown as ZodType<SkillsListUserAttachmentsOutput>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/return-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/types.ts packages/skills/src/__tests__/return-schemas.test.ts
git commit -m "feat(skills): hook types + returns schemas for per-user attachments"
```

---

### Task 5: Register `skills:attach-for-user` + `skills:list-user-attachments`

**Files:**
- Modify: `packages/skills/src/plugin.ts`
- Test: `packages/skills/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing tests**

First, update the existing **manifest equality** test in `plugin.test.ts` (`'manifest matches the documented surface'`) — append the two new hooks to the expected `registers` array:

```typescript
      registers: [
        'skills:list',
        'skills:get',
        'skills:upsert',
        'skills:delete',
        'skills:resolve',
        'skills:list-defaults',
        'skills:check-for-updates',
        'skills:attach-for-user',
        'skills:list-user-attachments',
      ],
```

Extend the `afterEach` teardown in `plugin.test.ts` to drop the new table (add before the `skills_v1_user_skills` drop):

```typescript
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_attachments');
```

Then add a new `describe` block with the behavior tests (import the new I/O types at the top of the file):

```typescript
describe('@ax/skills per-user attachments', () => {
  const HOSTED_SKILL = `name: github
description: GitHub.
version: 1
capabilities:
  allowedHosts:
    - api.github.com
  credentials:
    - slot: GITHUB_TOKEN
      kind: api-key
`;

  it('attach-for-user stores a binding; list-user-attachments returns it scoped', async () => {
    const h = await makeHarness();
    // The skill must exist (global) for the attach hook to resolve its slots.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: HOSTED_SKILL,
      bodyMd: '# gh\n',
    });

    const r = await h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>(
      'skills:attach-for-user',
      h.ctx(),
      { userId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } },
    );
    expect(r).toEqual({ created: true });

    const list = await h.bus.call<SkillsListUserAttachmentsInput, SkillsListUserAttachmentsOutput>(
      'skills:list-user-attachments',
      h.ctx(),
      { userId: 'u1', agentId: 'a1' },
    );
    expect(list.attachments).toEqual([
      { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } },
    ]);

    // A different user sees nothing.
    const other = await h.bus.call<SkillsListUserAttachmentsInput, SkillsListUserAttachmentsOutput>(
      'skills:list-user-attachments',
      h.ctx(),
      { userId: 'u2', agentId: 'a1' },
    );
    expect(other.attachments).toEqual([]);
  });

  it('attach-for-user rejects an unknown skill', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>('skills:attach-for-user', h.ctx(), {
        userId: 'u1', agentId: 'a1', skillId: 'nope', credentialBindings: {},
      }),
    ).rejects.toThrow(/not installed|not-found/i);
  });

  it('attach-for-user rejects a binding for an undeclared slot (orphan)', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: HOSTED_SKILL,
      bodyMd: '# gh\n',
    });
    await expect(
      h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>('skills:attach-for-user', h.ctx(), {
        userId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref', BOGUS: 'x' },
      }),
    ).rejects.toThrow(/binding-orphan|does not declare/i);
  });
});
```

Add these to the type-import block at the top of `plugin.test.ts`:

```typescript
  SkillsAttachForUserInput,
  SkillsAttachForUserOutput,
  SkillsListUserAttachmentsInput,
  SkillsListUserAttachmentsOutput,
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/plugin.test.ts`
Expected: FAIL — manifest mismatch (two hooks missing) + `no-service` for `skills:attach-for-user` / `skills:list-user-attachments`.

- [ ] **Step 3: Wire the hooks in `plugin.ts`**

Add imports at the top of `plugin.ts`:

```typescript
import { createUserAttachmentsStore } from './user-attachments-store.js';
import { validateAttachmentBindings } from './attachment-validation.js';
import {
  SkillsAttachForUserOutputSchema,
  SkillsListUserAttachmentsOutputSchema,
} from './types.js';
```

Add to the `type` import block from `./types.js`:

```typescript
  SkillsAttachForUserInput,
  SkillsAttachForUserOutput,
  SkillsListUserAttachmentsInput,
  SkillsListUserAttachmentsOutput,
```

Append the two hooks to the manifest `registers` array (after `'skills:check-for-updates'`):

```typescript
        'skills:check-for-updates',
        'skills:attach-for-user',
        'skills:list-user-attachments',
```

In `init()`, after `const userStore = createUserSkillsStore(db);`, add:

```typescript
      const attachmentsStore = createUserAttachmentsStore(db);
```

After the existing `skills:check-for-updates` registration, register the two hooks:

```typescript
      bus.registerService<SkillsAttachForUserInput, SkillsAttachForUserOutput>(
        'skills:attach-for-user',
        PLUGIN_NAME,
        async (_ctx, input) => {
          // Resolve the skill (user-scoped content wins over global of the same
          // id — same precedence as skills:resolve) to read its declared slots.
          const resolved =
            (await userStore.resolve(input.userId, [input.skillId]))[0] ??
            (await store.resolve([input.skillId]))[0];
          if (resolved === undefined) {
            throw new PluginError({
              code: 'skill-not-found',
              plugin: PLUGIN_NAME,
              message: `skill '${input.skillId}' is not installed`,
            });
          }

          const check = validateAttachmentBindings(
            resolved.capabilities.credentials.map((c) => c.slot),
            input.credentialBindings,
          );
          if (!check.ok) {
            throw new PluginError({
              code: check.code,
              plugin: PLUGIN_NAME,
              message: check.message,
            });
          }

          const { created } = await attachmentsStore.upsert({
            ownerUserId: input.userId,
            agentId: input.agentId,
            skillId: input.skillId,
            credentialBindings: input.credentialBindings,
          });
          return { created };
        },
        { returns: SkillsAttachForUserOutputSchema },
      );

      bus.registerService<SkillsListUserAttachmentsInput, SkillsListUserAttachmentsOutput>(
        'skills:list-user-attachments',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const attachments = await attachmentsStore.listForUserAgent(
            input.userId,
            input.agentId,
          );
          return { attachments };
        },
        { returns: SkillsListUserAttachmentsOutputSchema },
      );
```

> **Capability note:** these hooks take no `actor` — capability is minimized to *validation + storage*. The (host-side, authenticated) caller supplies `userId`. There is no agent-reachable caller in this slice (half-wired write path); TASK-36 wires the post-approval host-side caller, which runs only after the user has authenticated and approved the bundled card.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test`
Expected: PASS (whole package green — manifest, attach/list, and the migration/store/validator tests).

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/plugin.ts packages/skills/src/__tests__/plugin.test.ts
git commit -m "feat(skills): register skills:attach-for-user + skills:list-user-attachments"
```

- [ ] **Step 6: Record the boundary-review note (for the PR body)**

Confirmed against §11 and the as-built code — paste this into the PR description:

- **Alternate impl this hook could have:** a `@ax/skills-fs` file-backed store, or a single JSON blob keyed by `(user, agent)` instead of a row-per-attachment. The payload names nothing storage-specific, so either implements the same contract.
- **Payload field names that might leak:** none. `userId` / `agentId` / `skillId` are opaque ids; `credentialBindings` is a slot → opaque-ref map (no `sha`/`pod`/`bucket`/`socket`/`generation`). Credential **refs**, never secrets, cross this hook (same posture as `agents:set-skill-attachments`).
- **Subscriber risk:** none — both are service hooks (single impl). The read result is consumed only by the orchestrator (and the future settings surface); no subscriber keys off a backend-specific field.
- **Wire surface (IPC):** none. Both hooks run **host-side** (the orchestrator union now; the post-approval card handler in TASK-36) — they are not agent→host IPC actions, so no schema goes in an IPC slice. (The agent-side trigger is the broker's `request_capability`, which yields a pending turn; the host does the attach.)

---

### Task 6: Orchestrator — fetch per-user attachments + union with precedence

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the skill-union `describe` block in `orchestrator.test.ts` (reuses the existing `buildProxyHooks`, `buildSkillsHooks`, `makeChatEndOpenSession`, `buildMocks`, `silentCtx`, `TEST_AGENT` helpers in that file):

```typescript
it('TASK-33: per-user attachment beats agent-global on id collision and unions a per-user-only skill', async () => {
  const proxy = buildProxyHooks();
  const skillsHooks = buildSkillsHooks({
    skills: {
      github: {
        id: 'github',
        capabilities: { allowedHosts: ['api.github.com'], credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }] },
        bodyMd: 'gh', manifestYaml: 'name: github\nversion: 1\n',
      },
      linear: {
        id: 'linear',
        capabilities: { allowedHosts: ['api.linear.app'], credentials: [] },
        bodyMd: 'ln', manifestYaml: 'name: linear\nversion: 1\n',
      },
    },
  });

  // Per-user attachments: github (overrides the agent-global binding) + a
  // per-user-only linear. Record the query args to assert (user, agent) scope.
  let listInput: unknown;
  skillsHooks.services['skills:list-user-attachments'] = async (_ctx, input) => {
    listInput = input;
    return {
      attachments: [
        { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'per-user-pat' } },
        { skillId: 'linear', credentialBindings: {} },
      ],
    };
  };

  const busRef: { current: HookBus | null } = { current: null };
  const mocks = buildMocks({
    agentsResolve: async () => ({
      agent: {
        ...TEST_AGENT,
        allowedHosts: ['api.anthropic.com'],
        requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } },
        // Agent-global attaches github with a DIFFERENT binding — per-user must win.
        skillAttachments: [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'agent-global-pat' } }],
      },
    }),
    openSession: makeChatEndOpenSession(busRef),
  });
  Object.assign(mocks.services, proxy.services, skillsHooks.services);
  const h = await createTestHarness({
    services: mocks.services,
    plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
  });
  busRef.current = h.bus;

  const outcome = await h.bus.call<unknown, AgentOutcome>(
    'agent:invoke',
    silentCtx('per-user-session'),
    { message: { role: 'user', content: 'hi' } },
  );
  expect(outcome.kind).toBe('complete');

  // Read hook queried per (user, agent).
  expect(listInput).toEqual({ userId: 'test-user', agentId: 'test-agent' });
  // resolve engaged the content-override path (ownerUserId threaded).
  expect((skillsHooks.state.lastResolveInput as { ownerUserId?: string }).ownerUserId).toBe('test-user');

  const openIn = proxy.state.lastOpenInput as {
    allowlist: string[];
    credentials: Record<string, { ref: string; kind: string }>;
  };
  // Per-user-only skill's host is unioned in.
  expect(openIn.allowlist).toContain('api.linear.app');
  expect(openIn.allowlist).toContain('api.github.com');
  // Per-user binding WINS over the agent-global binding for the same skill+slot.
  expect(openIn.credentials.GITHUB_TOKEN).toEqual({ ref: 'per-user-pat', kind: 'api-key' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/chat-orchestrator test`
Expected: FAIL — `skills:list-user-attachments` is never called (`listInput` undefined) and `GITHUB_TOKEN.ref` is `agent-global-pat`.

- [ ] **Step 3: Add the duplicated hook shapes (I2)**

In `orchestrator.ts`, in the duplicated-hook-shape block (right after the `SkillsResolveOutput` interface, ~line 220), add:

```typescript
// skills:list-user-attachments — registered by @ax/skills (TASK-33).
// Duplicated structurally per I2 (no @ax/skills import). Conditionally called
// via bus.hasService — NOT declared in the manifest, same convention as
// skills:resolve / skills:list-defaults.
interface SkillsListUserAttachmentsInput {
  userId: string;
  agentId: string;
}
interface SkillsListUserAttachmentsOutput {
  attachments: Array<{ skillId: string; credentialBindings: Record<string, string> }>;
}
```

- [ ] **Step 4: Fetch per-user attachments + redefine `attachments` as the union**

In `orchestrator.ts`, replace the single line:

```typescript
    let resolvedSkills: ResolvedSkillForOrch[] = [];
    const attachments = agent.skillAttachments ?? [];
```

with:

```typescript
    let resolvedSkills: ResolvedSkillForOrch[] = [];

    // TASK-33 — per-user skill attachments: a self-serve layer above the
    // admin-managed agent-global attachments, fetched per (user, agent).
    // Union precedence is per-user > agent-global > default-attached. Gated by
    // hasService (same convention as skills:resolve / skills:list-defaults —
    // conditionally called, NOT declared in the manifest): stripped presets
    // without @ax/skills no-op. Throws are non-fatal — log + treat as empty so
    // the session still opens on its agent-global + default skills.
    let userAttachments: Array<{
      skillId: string;
      credentialBindings: Record<string, string>;
    }> = [];
    if (bus.hasService('skills:list-user-attachments')) {
      try {
        const r = await bus.call<
          SkillsListUserAttachmentsInput,
          SkillsListUserAttachmentsOutput
        >('skills:list-user-attachments', ctx, {
          userId: ctx.userId,
          agentId: agent.id,
        });
        userAttachments = r.attachments;
      } catch (err) {
        ctx.logger.warn('skills_list_user_attachments_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        userAttachments = [];
      }
    }

    // Per-user wins over agent-global on skill-id collision: drop any
    // agent-global attachment whose skillId a per-user attachment already
    // covers, then list per-user FIRST so the credential/host merge loop below
    // resolves it as the slot owner. The downstream resolve + credential loop +
    // defaults filter all key off this single `attachments` list unchanged, so
    // the three-source union and per-user-binding-wins precedence fall out here.
    const userAttachedSkillIds = new Set(userAttachments.map((a) => a.skillId));
    const attachments = [
      ...userAttachments,
      ...(agent.skillAttachments ?? []).filter(
        (a) => !userAttachedSkillIds.has(a.skillId),
      ),
    ];
```

> Nothing else in the resolve / credential-merge / defaults-union / `installedSkills` build changes: `attachments.map((a) => a.skillId)` now resolves the union (per-user first), `skills:resolve` already receives `ownerUserId: ctx.userId` (content override preserved), the credential loop iterates the per-user-first list (so per-user bindings own their slots), and `explicitIds` / the defaults filter exclude every union id.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/chat-orchestrator test`
Expected: PASS (the new test + all existing skill-union tests still green — agent-global-only and defaults-only paths are unchanged when `skills:list-user-attachments` returns `[]` or is absent).

- [ ] **Step 6: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/__tests__/orchestrator.test.ts
git commit -m "feat(orchestrator): union per-user skill attachments (per-user > agent-global > default)"
```

---

### Task 7: End-to-end canary + full verification

**Files:**
- Modify: `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts`

- [ ] **Step 1: Extend the canary — per-user attachment unions through the real orchestrator**

The canary already boots the **real** `@ax/skills` + `@ax/agents` + `@ax/chat-orchestrator` with capturing proxy/sandbox fakes. Add a case that:

1. upserts a **global** catalog skill (e.g. `linear`, `allowedHosts: [api.linear.app]`, slot `LINEAR_TOKEN`) via `skills:upsert`;
2. calls `skills:attach-for-user` with `{ userId, agentId, skillId: 'linear', credentialBindings: { LINEAR_TOKEN: 'user-linear-ref' } }` (the same `userId`/`agentId` the invoke `ctx` carries);
3. runs `agent:invoke`;
4. asserts the captured `proxy:open-session` input has `api.linear.app` in `allowlist` and `credentials.LINEAR_TOKEN` resolving to the per-user ref `'user-linear-ref'`.

Then add a **precedence** assertion: attach the same `linear` skill **agent-global** (via the agents path the canary already uses for skill attachments) with a *different* binding ref, and assert the per-user ref wins in the captured proxy credentials.

Use the file's existing `makeAgentContext` / capturing-fake helpers; mirror the existing install-path assertions for the exact capture-array shape.

- [ ] **Step 2: Extend the canary — content override (user-scoped content wins)**

Add a second case proving the card's content-override clause end-to-end: upsert a **global** skill `gh` AND a **user-scoped** skill `gh` (same id, `scope: 'user'`, different `allowedHosts`/body), attach `gh` per-user, invoke, and assert the captured `sandbox:open-session` `installedSkills[].skillMd` for `gh` is the **user-scoped** body (not the global one). This exercises the `skills:resolve(ownerUserId)` `mergeUserWins` path the orchestrator already threads.

- [ ] **Step 3: Run the canary**

Run: `pnpm -F @ax/skills test -- src/__tests__/e2e/skill-install.canary.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the `security-checklist` skill (pre-PR gate)**

Invoke the `security-checklist` skill and answer all three threat models. Pre-stated threat model to confirm:

- **Sandbox escape:** N/A — no sandbox-boundary, IPC-transport, or materialization change. Per-user attachments are host-side rows unioned before `proxy:open-session`; nothing new crosses into the sandbox.
- **Prompt injection / capability over-grant (the live threat):** the write path has **no agent-reachable caller** in this slice. When TASK-36 wires it, the bundled approval card is the backstop (design §6/§10) — the user sees the declared hosts/creds before any spawn. Capability is minimized: a per-user attachment widens **only that user's own already-isolated session** (the orchestrator passes `ctx.userId` to `proxy:open-session`, which resolves refs in **user scope**); `credentialBindings` reference the **user's own** opaque refs (never secrets, never the model/transcript). The `binding-orphan` check (Task 2) blocks binding a credential to a slot the skill never declared. Cross-user isolation: every store query is scoped to `owner_user_id` + `agent_id`; the orchestrator queries `{ userId: ctx.userId, agentId: agent.id }` — no shared rows, no cross-tenant read.
- **Supply chain:** N/A — no new dependencies.

Paste the structured note into the PR.

- [ ] **Step 5: Full build + test + lint (green bar)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. (`pnpm build` catches undeclared workspace deps that vitest tolerates; `pnpm lint` confirms no cross-plugin import crept in and the new `skills_v1_user_attachments` queries live only in the store file — `skills_v1_` is not a tenant-prefixed table for `no-bare-tenant-tables`, so no `store.ts`-only constraint applies, but keeping them in `user-attachments-store.ts` matches the convention.)

- [ ] **Step 6: Commit + open PR**

```bash
git add packages/skills/src/__tests__/e2e/skill-install.canary.test.ts
git commit -m "test(skills): canary covers per-user attachment union + content override"
```

PR description must include:
- **Boundary review** (the note from Task 5 Step 6).
- **Half-wired window OPEN (write path):** `skills:attach-for-user` is registered + unit-tested + canary-reachable but has no production caller; the read path `skills:list-user-attachments` is fully wired into the orchestrator (returns `[]` today → no behavior change). Window CLOSES in **TASK-36**.
- The `security-checklist` note (Task 7 Step 4).

---

## Self-Review

**Spec coverage** (against card body + design §11.2 / Components #2 / Part II P1 / Appendix #12):

- "Per-user, user-scoped attachment layer that doesn't affect others" → Tasks 1 + 3 (`skills_v1_user_attachments`, PK `(owner_user_id, agent_id, skill_id)`, scoped queries). ✓
- "New hooks `skills:attach-for-user` / `skills:list-user-attachments`, fields `{ userId, agentId, skillId, credentialBindings }`, storage-agnostic" → Tasks 4 + 5 (exact field set; boundary-review note confirms no leak). ✓
- "Orchestrator unions three sources, precedence per-user > agent-global > default-attached on id collision" → Task 6 (per-user-first `attachments` union; defaults filtered by `explicitIds` unchanged). ✓
- "User-scoped skill's *content* overrides a global of the same id, consistent with `skills:resolve(ownerUserId)`" → preserved for free (orchestrator already threads `ownerUserId`); verified in Task 7 Step 2. ✓
- "Boundary review §11 (storage-agnostic)" → Task 5 Step 6. ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. No TBD/TODO. ✓

**Type consistency:** the attachment shape is `{ skillId: string; credentialBindings: Record<string, string> }` everywhere (`UserAttachment`, `UserSkillAttachment`, `SkillsListUserAttachmentsOutput.attachments`, the orchestrator's duplicated `SkillsListUserAttachmentsOutput`, the agent-global `skillAttachments`); the write input is `{ userId, agentId, skillId, credentialBindings }` in both `SkillsAttachForUserInput` and the card's locked field list. `validateAttachmentBindings(declaredSlots, credentialBindings)` returns `{ ok: true } | { ok: false; code; message }`; the plugin maps a failure to a `PluginError` whose `code` is the validator's `code`. Store factory is `createUserAttachmentsStore`; methods `upsert` / `listForUserAgent`. Hook names are `skills:attach-for-user` / `skills:list-user-attachments` consistently in the manifest, registrations, tests, and orchestrator guard.

**Stale-anchor check (hard requirement #1):** verified against `main` — `agents_v1_agents.skill_attachments` is JSONB `{ skillId, credentialBindings }[]` (agent-global, admin-only via `PATCH /admin/agents/:id/skill-attachments`); the orchestrator's two-source union lives at `orchestrator.ts` (the `resolvedSkills` resolve + the `for (const attachment of attachments)` credential/host loop + the `defaultSkillsForUnion` filter); `skills:resolve` already does `mergeUserWins` content override and the orchestrator already passes `ownerUserId: ctx.userId`; `skills:resolve` / `skills:list-defaults` are **not declared** in the orchestrator manifest (conditionally called) — so the new read hook follows the same no-declaration convention. `skills_v1_skill_files` (the Phase 1a bundle table) does **NOT** exist on `main` yet — this card's "Depends on" is `none`, so this plan touches **no** `files` field and is independent of TASK-32.

**Known residuals (acceptable for this slice):**
- **Cross-source slot collision** (per-user skill A and agent-global skill B, *different* ids, both declaring the same credential slot) still terminates the turn via the orchestrator's existing `skill-slot-collision` path — unchanged behavior, not made worse. A full vault-backed resolution is Part II P2 (service-keyed `account` tag), out of scope here. Same-id collisions never reach this path (per-user wins drops the agent-global copy).
- **No detach hook + no HTTP route/UI** this slice — `skills:attach-for-user` is the only write. Detach + the settings "Connections" surface that drives both are Part II P7 #1, and the in-chat caller is TASK-36 (the half-wired window).
