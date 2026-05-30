# Skill authoring Phase 4 — lazy capability approval: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase-3 empty-caps projection of self-authored skills into the real lazy capability-approval wall: a draft's SKILL.md frontmatter `capabilities:` block becomes a *proposal*, a host-side approval store records what a human approved, and the projection grants only `proposal ∩ approved`.

**Architecture:** Three stacked PRs (strangler). **This plan details PR-A in full** (the store + projection-fill foundation, behind an empty-approved-by-default so nothing regresses) and outlines PR-B (hybrid approval timing) and PR-C (remove the dead caps-strip) at task level — their concrete code depends on PR-A's merged interfaces and CodeRabbit only reviews main-based PRs.

**Tech Stack:** TypeScript, pnpm workspaces, Kysely + Postgres (testcontainers), Vitest, the `@ax` hook-bus plugin kernel, `@ax/skills-parser` (frontmatter parse/build), `@ax/test-harness`.

**Design doc:** `docs/plans/2026-05-29-skill-authoring-phase-4-lazy-approval-design.md`

---

## Verified ground truth (do not re-litigate — confirmed against `main` @ `c761a887`)

- **Frontmatter caps survive into committed storage.** `@ax/validator-skill`'s `stripCapabilitiesFromFrontmatter` rewrite is **discarded on the apply path** (`packages/validator-skill/src/plugin.ts:215-216,234-235` — "the pre-apply transform is discarded on the apply path"). The validator NEVER vetoes SKILL.md content; quarantine is set only on safety-scan hits (injection patterns in the *body*), never on caps-presence. So a draft that declares frontmatter caps + has a clean body commits, is **not** quarantined, and its caps reach the projection. **PR-A touches no validator code.**
- **The projection source** is `agents:resolve-authored-skills` (`packages/agents/src/plugin.ts:360-394`), which calls `listAuthoredBundles` (`packages/agents/src/authored-skills.ts:196-284`, returns `{id, manifestYaml, bodyMd, files}` — already parses the manifest for *validity* but discards caps) and currently hardcodes empty caps.
- **Parser/builder:** `parseSkillManifest(yaml): ParseResult` returns `{ok:true, value:{id, description, version, sourceUrl?, capabilities: SkillCapabilities}}`; `version` defaults to **0** when absent. `buildSkillManifestYaml({id, description, version, capabilities})` emits `name/description/version` and a `capabilities:` block **only when non-empty**. Both exported from `@ax/skills-parser` (a shared lib, not a plugin — `@ax/agents` already imports `parseSkillManifest`).
- **Store template:** `packages/skills/src/quarantine-store.ts` + its test `packages/skills/src/__tests__/quarantine-store.test.ts` (postgres testcontainer, `makeKysely`, `freshStore`). Migration lives in `packages/skills/src/migrations.ts` (`runSkillsMigration`, `SkillsDatabase` interface). Service types in `packages/skills/src/types.ts`; registration in `packages/skills/src/plugin.ts` (store created at init ~`:253`, services registered ~`:921-947`).
- **Agents test harness:** `packages/agents/src/__tests__/authored-skills.test.ts` boots real `@ax/agents` + postgres + `createMockWorkspacePlugin` and already has `makeSkillMd(id, {withCapabilities})` (emits `allowedHosts: [api.evil.com]`) + `seedFile`. With no `@ax/skills` loaded, `skills:approved-caps-list` and `skills:quarantine-get` are absent → the handler's `hasService` guards yield `approved = []` → the unapproved default.
- **No existing test asserts `manifestYaml` by exact equality** (the Phase-3 canary uses `toContain('name: good')`), so rebuilding the manifest caps-stripped is safe.

---

## File Structure (PR-A)

**Create:**
- `packages/skills/src/approved-caps-store.ts` — the `(user, agent, skill, cap_kind, cap_value)` approval store. One responsibility: CRUD over `skills_v1_approved_caps`. Mirrors `quarantine-store.ts`.
- `packages/skills/src/__tests__/approved-caps-store.test.ts` — store unit tests (postgres testcontainer).
- `packages/agents/src/authored-caps.ts` — pure capability-set algebra: `intersectProposalWithApproved`, `EMPTY_CAPABILITIES`, the structural `ApprovedCapEntry` type. No I/O. One responsibility: compute `proposal ∩ approved` and `proposal − approved`.
- `packages/agents/src/__tests__/authored-caps.test.ts` — pure unit tests for the algebra.

**Modify:**
- `packages/skills/src/migrations.ts` — add the `skills_v1_approved_caps` DDL + `ApprovedCapRow` + the `SkillsDatabase` entry.
- `packages/skills/src/types.ts` — add `ApprovedCapEntry`, `SkillsApprovedCapsListInput/Output` + Zod schema.
- `packages/skills/src/index.ts` — export the new public types.
- `packages/skills/src/plugin.ts` — create the store at init; register `skills:approved-caps-list`; add it to `manifest.registers`.
- `packages/agents/src/types.ts` — widen `AuthoredResolvedSkill.capabilities` to `SkillCapabilities`, add `proposalDelta: SkillCapabilities`, update the Zod schema.
- `packages/agents/src/plugin.ts` — rewrite the `agents:resolve-authored-skills` per-bundle body to parse the proposal, read approved caps (soft dep), project `proposal ∩ approved` + `proposalDelta`, and emit a caps-stripped `manifestYaml`; add `skills:approved-caps-list` to `manifest.optionalCalls`.
- `packages/agents/src/__tests__/authored-skills.test.ts` — add the unapproved-default projection test.
- `presets/k8s/src/__tests__/acceptance.test.ts` — add the PR-A security canary.

**Boundary note (one source of truth, invariant #4):** the bundle frontmatter is the *proposal* source; `skills_v1_approved_caps` is thin *approval* metadata; the projection is a *view*. The `ApprovedCapEntry` shape crosses the `skills:approved-caps-list` hook and is duplicated structurally in `@ax/agents` (invariant #2 — no cross-plugin type import, same as `AuthoredResolvedSkill` mirrors `ResolvedSkillForOrch`).

---

## PR-A — Approval store + projection fill (half-wired window OPEN)

After PR-A, drafts still project empty caps (no approvals exist yet) — behavior-preserving. The store + intersection + `proposalDelta` are proven; the approve path + cards land in PR-B.

### Task 1: `skills_v1_approved_caps` store + migration

**Files:**
- Create: `packages/skills/src/approved-caps-store.ts`
- Create: `packages/skills/src/__tests__/approved-caps-store.test.ts`
- Modify: `packages/skills/src/migrations.ts`

- [ ] **Step 1: Write the failing store test**

Create `packages/skills/src/__tests__/approved-caps-store.test.ts` (mirrors `quarantine-store.test.ts`):

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runSkillsMigration, type SkillsDatabase } from '../migrations.js';
import { createApprovedCapsStore } from '../approved-caps-store.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<SkillsDatabase>[] = [];

function makeKysely(): Kysely<SkillsDatabase> {
  const k = new Kysely<SkillsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('skills_v1_approved_caps').ifExists().execute();
    } catch {
      /* */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

async function freshStore() {
  const db = makeKysely();
  await runSkillsMigration(db);
  return createApprovedCapsStore(db);
}

describe('skills approved-caps store', () => {
  const key = { ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' };

  it('list returns [] for a skill with no approvals', async () => {
    const s = await freshStore();
    expect(await s.list(key)).toEqual([]);
  });

  it('set then list returns the entry; set is idempotent', async () => {
    const s = await freshStore();
    expect(await s.set({ ...key, kind: 'host', value: 'api.linear.app' })).toEqual({ created: true });
    expect(await s.set({ ...key, kind: 'host', value: 'api.linear.app' })).toEqual({ created: false });
    expect(await s.list(key)).toEqual([{ kind: 'host', value: 'api.linear.app' }]);
  });

  it('list returns multiple kinds for one skill, sorted by (kind, value)', async () => {
    const s = await freshStore();
    await s.set({ ...key, kind: 'slot', value: 'LINEAR_API_KEY', detail: { kind: 'api-key', account: 'linear' } });
    await s.set({ ...key, kind: 'host', value: 'api.linear.app' });
    await s.set({ ...key, kind: 'npm', value: '@linear/sdk' });
    expect(await s.list(key)).toEqual([
      { kind: 'host', value: 'api.linear.app' },
      { kind: 'npm', value: '@linear/sdk' },
      { kind: 'slot', value: 'LINEAR_API_KEY' },
    ]);
  });

  it('clear removes one entry (idempotent)', async () => {
    const s = await freshStore();
    await s.set({ ...key, kind: 'host', value: 'api.linear.app' });
    expect(await s.clear({ ...key, kind: 'host', value: 'api.linear.app' })).toEqual({ cleared: true });
    expect(await s.clear({ ...key, kind: 'host', value: 'api.linear.app' })).toEqual({ cleared: false });
    expect(await s.list(key)).toEqual([]);
  });

  it('is scoped: user/agent/skill never bleed', async () => {
    const s = await freshStore();
    await s.set({ ownerUserId: 'uA', agentId: 'a1', skillId: 'linear', kind: 'host', value: 'h' });
    expect(await s.list({ ownerUserId: 'uB', agentId: 'a1', skillId: 'linear' })).toEqual([]);
    expect(await s.list({ ownerUserId: 'uA', agentId: 'a2', skillId: 'linear' })).toEqual([]);
    expect(await s.list({ ownerUserId: 'uA', agentId: 'a1', skillId: 'other' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm --filter @ax/skills exec vitest run src/__tests__/approved-caps-store.test.ts`
Expected: FAIL — `Cannot find module '../approved-caps-store.js'`.

- [ ] **Step 3: Add the migration DDL + row type + DB entry**

In `packages/skills/src/migrations.ts`, append a new `sql\`...\`.execute(db)` block at the end of `runSkillsMigration` (after the `skills_v1_quarantine` block, before the closing `}`):

```ts
  // skills_v1_approved_caps — per-(user, agent, skill, capability) approval
  // metadata (Phase 4). Each row records ONE capability a human approved at the
  // wall for a self-authored draft. `approved = union of rows`; the host
  // discovery projection grants `proposal ∩ approved`. The bundle frontmatter is
  // the proposal source of truth; this table is thin approval metadata (I4).
  // `agent_id` is an opaque scoping key — no FK to agents_v1_agents (cross-plugin
  // FKs are banned). `cap_detail` is optional display/audit JSON (slot kind +
  // account, or an MCP spec); the projection matches on (cap_kind, cap_value)
  // only. Additive-only.
  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_approved_caps (
      owner_user_id TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      skill_id      TEXT NOT NULL,
      cap_kind      TEXT NOT NULL,
      cap_value     TEXT NOT NULL,
      cap_detail    JSONB NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, agent_id, skill_id, cap_kind, cap_value)
    )
  `.execute(db);
```

Then add the row interface (after `QuarantineRow`, before `export interface SkillsDatabase`):

```ts
/**
 * Per-(user, agent, skill, capability) approval row (Phase 4). One row per
 * approved capability. `cap_kind` ∈ 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';
 * `cap_value` is the host / slot name / package name / mcp server name. Storage
 * detail only — the hook surface carries {kind, value}, never row vocabulary.
 */
export interface ApprovedCapRow {
  owner_user_id: string;
  agent_id: string;
  skill_id: string;
  cap_kind: string;
  cap_value: string;
  cap_detail: unknown; // JSONB; nullable
  created_at: Date;
}
```

And add to the `SkillsDatabase` interface:

```ts
  skills_v1_approved_caps: ApprovedCapRow;
```

- [ ] **Step 4: Implement the store**

Create `packages/skills/src/approved-caps-store.ts`:

```ts
/**
 * @ax/skills approved-capabilities store (Phase 4). Per-(owner_user_id,
 * agent_id, skill_id, cap_kind, cap_value) record of what a human approved at
 * the wall for a self-authored draft. Every query is scoped to the compound key
 * — user A's rows MUST NEVER touch user B's. Owns `skills_v1_approved_caps`
 * only (Invariant I4 — one source of truth per concept).
 */
import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';

/** The capability kinds an approval row can carry. */
export type ApprovedCapKind = 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';

/**
 * One approved capability, storage-agnostic. The projection matches a draft's
 * proposal against (kind, value); `detail` (slot kind/account, MCP spec) is
 * audit/display metadata only and is NOT returned by list().
 */
export interface ApprovedCapEntry {
  kind: ApprovedCapKind;
  value: string;
}

export interface ApprovedCapsStore {
  set(input: {
    ownerUserId: string;
    agentId: string;
    skillId: string;
    kind: ApprovedCapKind;
    value: string;
    detail?: unknown;
  }): Promise<{ created: boolean }>;
  clear(input: {
    ownerUserId: string;
    agentId: string;
    skillId: string;
    kind: ApprovedCapKind;
    value: string;
  }): Promise<{ cleared: boolean }>;
  list(input: {
    ownerUserId: string;
    agentId: string;
    skillId: string;
  }): Promise<ApprovedCapEntry[]>;
}

export function createApprovedCapsStore(db: Kysely<SkillsDatabase>): ApprovedCapsStore {
  return {
    async set({ ownerUserId, agentId, skillId, kind, value, detail }) {
      // Idempotent: a duplicate (kind, value) for the same skill is a no-op.
      // Accept the PK-violation race (mirrors host-grants / quarantine).
      const res = await db
        .insertInto('skills_v1_approved_caps')
        .values({
          owner_user_id: ownerUserId,
          agent_id: agentId,
          skill_id: skillId,
          cap_kind: kind,
          cap_value: value,
          cap_detail: detail === undefined ? null : (detail as never),
          created_at: new Date(),
        })
        .onConflict((oc) =>
          oc
            .columns(['owner_user_id', 'agent_id', 'skill_id', 'cap_kind', 'cap_value'])
            .doNothing(),
        )
        .executeTakeFirst();
      return { created: Number(res.numInsertedOrUpdatedRows ?? 0n) > 0 };
    },

    async clear({ ownerUserId, agentId, skillId, kind, value }) {
      const res = await db
        .deleteFrom('skills_v1_approved_caps')
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('skill_id', '=', skillId)
        .where('cap_kind', '=', kind)
        .where('cap_value', '=', value)
        .executeTakeFirst();
      return { cleared: Number(res.numDeletedRows ?? 0n) > 0 };
    },

    async list({ ownerUserId, agentId, skillId }) {
      const rows = await db
        .selectFrom('skills_v1_approved_caps')
        .select(['cap_kind', 'cap_value'])
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('skill_id', '=', skillId)
        .orderBy('cap_kind', 'asc')
        .orderBy('cap_value', 'asc')
        .execute();
      return rows.map((r) => ({ kind: r.cap_kind as ApprovedCapKind, value: r.cap_value }));
    },
  };
}
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `pnpm --filter @ax/skills exec vitest run src/__tests__/approved-caps-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/approved-caps-store.ts \
        packages/skills/src/__tests__/approved-caps-store.test.ts \
        packages/skills/src/migrations.ts
git commit -m "feat(skills): approved-caps store + migration (Phase 4 PR-A)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2: `skills:approved-caps-list` service + types + exports

PR-A registers only `-list` (the one production consumes via `resolve-authored-skills`). `-set`/`-revoke` services land in PR-B with the grant path; the store class already carries `set`/`clear` for that.

**Files:**
- Modify: `packages/skills/src/types.ts`
- Modify: `packages/skills/src/index.ts`
- Modify: `packages/skills/src/plugin.ts`

- [ ] **Step 1: Add the service types + Zod schema**

In `packages/skills/src/types.ts`, after the Quarantine block (after `SkillsQuarantineListOutputSchema`, ~`:496`), add:

```ts
// ---- Approved capabilities (Phase 4) --------------------------------------
// Per-(user, agent, skill) approved-capability metadata. Read by the host
// discovery projection (agents:resolve-authored-skills) to grant only the
// approved subset of a self-authored draft's frontmatter proposal. Written by
// the approval grant path (PR-B). The bundle frontmatter is the proposal source
// of truth; these rows are thin approval metadata (I4).

/** A capability a human approved, storage-agnostic. */
export interface ApprovedCapEntry {
  kind: 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';
  value: string;
}

export interface SkillsApprovedCapsListInput {
  ownerUserId: string;
  agentId: string;
  skillId: string;
}
export interface SkillsApprovedCapsListOutput {
  capabilities: ApprovedCapEntry[];
}

export const SkillsApprovedCapsListOutputSchema = z.object({
  capabilities: z.array(
    z.object({
      kind: z.union([
        z.literal('host'),
        z.literal('slot'),
        z.literal('npm'),
        z.literal('pypi'),
        z.literal('mcp'),
      ]),
      value: z.string(),
    }),
  ),
}) as unknown as ZodType<SkillsApprovedCapsListOutput>;
```

(`z` and `ZodType` are already imported at the top of `types.ts`.)

- [ ] **Step 2: Export the public types**

In `packages/skills/src/index.ts`, add to the `export type { ... } from './types.js'` block:

```ts
  ApprovedCapEntry,
  SkillsApprovedCapsListInput,
  SkillsApprovedCapsListOutput,
```

- [ ] **Step 3: Register the service + create the store + declare it**

In `packages/skills/src/plugin.ts`:

(a) Add the import near the other store imports (~`:22`):
```ts
import { createApprovedCapsStore } from './approved-caps-store.js';
```

(b) Add the type imports to the existing `from './types.js'` import group:
```ts
  SkillsApprovedCapsListInput,
  SkillsApprovedCapsListOutput,
  SkillsApprovedCapsListOutputSchema,
```

(c) Add to `manifest.registers` (after `'skills:quarantine-list'`, ~`:213`):
```ts
        'skills:approved-caps-list',
```

(d) Create the store at init (after `const quarantineStore = createSkillsQuarantineStore(db);`, ~`:253`):
```ts
      const approvedCapsStore = createApprovedCapsStore(db);
```

(e) Register the service (after the `skills:quarantine-list` registration, ~`:947`):
```ts
      bus.registerService<SkillsApprovedCapsListInput, SkillsApprovedCapsListOutput>(
        'skills:approved-caps-list',
        PLUGIN_NAME,
        async (_ctx, input) => ({ capabilities: await approvedCapsStore.list(input) }),
        { returns: SkillsApprovedCapsListOutputSchema },
      );
```

- [ ] **Step 4: Verify the package builds + existing suite green**

Run: `pnpm --filter @ax/skills build`
Expected: tsc PASS (no errors).

Run: `pnpm --filter @ax/skills exec vitest run src/__tests__/return-schemas.test.ts src/__tests__/plugin.test.ts`
Expected: PASS. (`return-schemas.test.ts` validates every registered service declares a `returns` schema — the new service does.)

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/types.ts packages/skills/src/index.ts packages/skills/src/plugin.ts
git commit -m "feat(skills): skills:approved-caps-list service (Phase 4 PR-A)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3: capability-set algebra (`intersectProposalWithApproved`)

**Files:**
- Create: `packages/agents/src/authored-caps.ts`
- Create: `packages/agents/src/__tests__/authored-caps.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `packages/agents/src/__tests__/authored-caps.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { SkillCapabilities } from '@ax/skills-parser';
import {
  intersectProposalWithApproved,
  EMPTY_CAPABILITIES,
  type ApprovedCapEntry,
} from '../authored-caps.js';

function proposal(over: Partial<SkillCapabilities> = {}): SkillCapabilities {
  return {
    allowedHosts: ['api.linear.app'],
    credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key', account: 'linear' }],
    mcpServers: [],
    packages: { npm: ['@linear/sdk'], pypi: [] },
    ...over,
  };
}

describe('intersectProposalWithApproved', () => {
  it('with NO approvals: capabilities is empty, delta is the full proposal', () => {
    const { capabilities, delta } = intersectProposalWithApproved(proposal(), []);
    expect(capabilities).toEqual(EMPTY_CAPABILITIES);
    expect(delta).toEqual(proposal());
  });

  it('approving the host moves only the host into capabilities; the rest stays in delta', () => {
    const approved: ApprovedCapEntry[] = [{ kind: 'host', value: 'api.linear.app' }];
    const { capabilities, delta } = intersectProposalWithApproved(proposal(), approved);
    expect(capabilities.allowedHosts).toEqual(['api.linear.app']);
    expect(capabilities.credentials).toEqual([]);
    expect(capabilities.packages.npm).toEqual([]);
    expect(delta.allowedHosts).toEqual([]);
    expect(delta.credentials).toEqual([{ slot: 'LINEAR_API_KEY', kind: 'api-key', account: 'linear' }]);
    expect(delta.packages.npm).toEqual(['@linear/sdk']);
  });

  it('approving a slot matches by slot NAME and carries the proposal slot detail', () => {
    const approved: ApprovedCapEntry[] = [{ kind: 'slot', value: 'LINEAR_API_KEY' }];
    const { capabilities, delta } = intersectProposalWithApproved(proposal(), approved);
    expect(capabilities.credentials).toEqual([
      { slot: 'LINEAR_API_KEY', kind: 'api-key', account: 'linear' },
    ]);
    expect(delta.credentials).toEqual([]);
  });

  it('approving an npm package matches by package name', () => {
    const approved: ApprovedCapEntry[] = [{ kind: 'npm', value: '@linear/sdk' }];
    const { capabilities } = intersectProposalWithApproved(proposal(), approved);
    expect(capabilities.packages.npm).toEqual(['@linear/sdk']);
  });

  it('approving an mcp server matches by server name and carries its spec', () => {
    const mcp = {
      name: 'linear-mcp',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', 'linear-mcp'],
      allowedHosts: ['api.linear.app'],
      credentials: [],
    };
    const p = proposal({ mcpServers: [mcp] });
    const approved: ApprovedCapEntry[] = [{ kind: 'mcp', value: 'linear-mcp' }];
    const { capabilities, delta } = intersectProposalWithApproved(p, approved);
    expect(capabilities.mcpServers).toEqual([mcp]);
    expect(delta.mcpServers).toEqual([]);
  });

  it('an approval that is not in the proposal is ignored (no phantom grant)', () => {
    const approved: ApprovedCapEntry[] = [{ kind: 'host', value: 'evil.test' }];
    const { capabilities } = intersectProposalWithApproved(proposal(), approved);
    expect(capabilities.allowedHosts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm --filter @ax/agents exec vitest run src/__tests__/authored-caps.test.ts`
Expected: FAIL — `Cannot find module '../authored-caps.js'`.

- [ ] **Step 3: Implement the algebra**

Create `packages/agents/src/authored-caps.ts`:

```ts
/**
 * Pure capability-set algebra for the self-authored skill projection (Phase 4).
 *
 * A self-authored draft declares its desired capabilities in SKILL.md
 * frontmatter — this is a PROPOSAL, never a grant. The host discovery
 * projection grants only `proposal ∩ approved`, where `approved` is the set of
 * capabilities a human approved at the wall (host-side store, outside the
 * agent's reach — invariant #5, no self-grant). The `delta = proposal −
 * approved` drives the upfront approval card (PR-B).
 *
 * `ApprovedCapEntry` is duplicated structurally here rather than imported from
 * @ax/skills — invariant #2 (no cross-plugin imports; the hook bus IS the API).
 * It mirrors @ax/skills' SkillsApprovedCapsListOutput entry shape.
 */
import type { CapabilitySlot, McpServerSpec, SkillCapabilities } from '@ax/skills-parser';

export type ApprovedCapKind = 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';

export interface ApprovedCapEntry {
  kind: ApprovedCapKind;
  value: string;
}

/** A capabilities object that grants nothing — the safe projection default. */
export const EMPTY_CAPABILITIES: SkillCapabilities = {
  allowedHosts: [],
  credentials: [],
  mcpServers: [],
  packages: { npm: [], pypi: [] },
};

/**
 * Split a frontmatter proposal into the approved subset (projected into the
 * skill's live caps) and the unapproved delta (drives the approval card).
 * Matching is by identity key per kind: host string, slot NAME, package name,
 * MCP server NAME. The proposal is the source of each entry's detail (slot
 * kind/account, MCP spec) — `approved` only gates which entries pass.
 */
export function intersectProposalWithApproved(
  proposal: SkillCapabilities,
  approved: ApprovedCapEntry[],
): { capabilities: SkillCapabilities; delta: SkillCapabilities } {
  const has = (kind: ApprovedCapKind, value: string): boolean =>
    approved.some((e) => e.kind === kind && e.value === value);

  const capHosts: string[] = [];
  const deltaHosts: string[] = [];
  for (const h of proposal.allowedHosts) (has('host', h) ? capHosts : deltaHosts).push(h);

  const capCreds: CapabilitySlot[] = [];
  const deltaCreds: CapabilitySlot[] = [];
  for (const c of proposal.credentials) (has('slot', c.slot) ? capCreds : deltaCreds).push(c);

  const capNpm: string[] = [];
  const deltaNpm: string[] = [];
  for (const p of proposal.packages.npm) (has('npm', p) ? capNpm : deltaNpm).push(p);

  const capPypi: string[] = [];
  const deltaPypi: string[] = [];
  for (const p of proposal.packages.pypi) (has('pypi', p) ? capPypi : deltaPypi).push(p);

  const capMcp: McpServerSpec[] = [];
  const deltaMcp: McpServerSpec[] = [];
  for (const m of proposal.mcpServers) (has('mcp', m.name) ? capMcp : deltaMcp).push(m);

  return {
    capabilities: {
      allowedHosts: capHosts,
      credentials: capCreds,
      mcpServers: capMcp,
      packages: { npm: capNpm, pypi: capPypi },
    },
    delta: {
      allowedHosts: deltaHosts,
      credentials: deltaCreds,
      mcpServers: deltaMcp,
      packages: { npm: deltaNpm, pypi: deltaPypi },
    },
  };
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm --filter @ax/agents exec vitest run src/__tests__/authored-caps.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/authored-caps.ts packages/agents/src/__tests__/authored-caps.test.ts
git commit -m "feat(agents): capability-set algebra for authored-skill projection (Phase 4 PR-A)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4: wire `resolve-authored-skills` to project `proposal ∩ approved`

**Files:**
- Modify: `packages/agents/src/types.ts`
- Modify: `packages/agents/src/plugin.ts`
- Modify: `packages/agents/src/__tests__/authored-skills.test.ts`

- [ ] **Step 1: Write the failing projection test**

In `packages/agents/src/__tests__/authored-skills.test.ts`, add inside the existing top-level `describe` (alongside the other `it(...)` blocks). It reuses the file's `makeHarness`, `createPersonalAgent`, `seedFile`, `makeSkillMd`:

```ts
  it('Phase 4: a draft declaring frontmatter capabilities projects with EMPTY approved caps + a proposalDelta; the projected manifest is caps-stripped', async () => {
    const h = await makeHarness(); // no @ax/skills → skills:approved-caps-list absent → approved = []
    const userId = 'u-phase4-caps';
    const agentId = await createPersonalAgent(h, userId);
    // makeSkillMd(..., {withCapabilities: true}) declares allowedHosts: [api.evil.com].
    await seedFile(
      h,
      '.ax/draft-skills/linear/SKILL.md',
      makeSkillMd('linear', { withCapabilities: true }),
      userId,
      agentId,
      null,
    );

    const out = await h.bus.call<AgentsResolveAuthoredSkillsInput, AgentsResolveAuthoredSkillsOutput>(
      'agents:resolve-authored-skills',
      h.ctx({ userId }),
      { ownerUserId: userId, agentId },
    );

    const linear = out.skills.find((s) => s.id === 'linear');
    expect(linear).toBeDefined();
    // Unapproved → empty projected caps (the safe default). The proxy will block.
    expect(linear!.capabilities.allowedHosts).toEqual([]);
    // The proposal is preserved as the unapproved delta (drives PR-B's card).
    expect(linear!.proposalDelta.allowedHosts).toEqual(['api.evil.com']);
    // The materialized manifest is caps-stripped — no capabilities block, no host.
    expect(linear!.manifestYaml).not.toContain('capabilities');
    expect(linear!.manifestYaml).not.toContain('api.evil.com');
    expect(linear!.manifestYaml).toContain('name: linear');
  });
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm --filter @ax/agents exec vitest run src/__tests__/authored-skills.test.ts -t "Phase 4"`
Expected: FAIL — `proposalDelta` is undefined and `manifestYaml` still contains `capabilities`/`api.evil.com` (the handler hasn't been rewired).

- [ ] **Step 3: Widen the output type + schema**

In `packages/agents/src/types.ts`:

(a) Add the import at the top (after the existing imports):
```ts
import type { SkillCapabilities } from '@ax/skills-parser';
```

(b) Replace the `AuthoredResolvedSkill` interface (currently ~`:312-323`) with:
```ts
/** Resolved-skill projection shape (structurally mirrors the orchestrator's
 * ResolvedSkillForOrch — NOT an @ax/skills import, per invariant #2).
 *
 * `capabilities` is the APPROVED subset (proposal ∩ approved-store) — the
 * enforcement source the orchestrator feeds to proxy:open-session. `proposalDelta`
 * is the UNAPPROVED remainder (proposal − approved) — Phase 4 PR-B fires the
 * upfront approval card from it. `manifestYaml` is caps-stripped (name +
 * description + version only): the materialized SKILL.md the SDK sees never
 * carries a capabilities block, so frontmatter alone grants nothing. */
export interface AuthoredResolvedSkill {
  id: string;
  capabilities: SkillCapabilities;
  proposalDelta: SkillCapabilities;
  bodyMd: string;
  manifestYaml: string;
  files: Array<{ path: string; contents: string }>;
}
```

(c) Replace `AgentsResolveAuthoredSkillsOutputSchema` (currently ~`:334-349`) with a schema that validates the full `SkillCapabilities` shape for both fields:
```ts
const CapabilitySlotSchema = z.object({
  slot: z.string(),
  kind: z.literal('api-key'),
  description: z.string().optional(),
  account: z.string().optional(),
});
const McpServerSpecSchema = z.object({
  name: z.string(),
  transport: z.union([z.literal('stdio'), z.literal('http')]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  allowedHosts: z.array(z.string()),
  credentials: z.array(CapabilitySlotSchema),
});
const SkillCapabilitiesSchema = z.object({
  allowedHosts: z.array(z.string()),
  credentials: z.array(CapabilitySlotSchema),
  mcpServers: z.array(McpServerSpecSchema),
  packages: z.object({ npm: z.array(z.string()), pypi: z.array(z.string()) }),
});

export const AgentsResolveAuthoredSkillsOutputSchema = z.object({
  skills: z.array(
    z.object({
      id: z.string(),
      capabilities: SkillCapabilitiesSchema,
      proposalDelta: SkillCapabilitiesSchema,
      bodyMd: z.string(),
      manifestYaml: z.string(),
      files: z.array(z.object({ path: z.string(), contents: z.string() })),
    }),
  ),
}) as unknown as ZodType<AgentsResolveAuthoredSkillsOutput>;
```

- [ ] **Step 4: Rewire the handler + add the soft-dep manifest entry**

In `packages/agents/src/plugin.ts`:

(a) Add imports (with the existing `@ax/skills-parser` / local imports near the top):
```ts
import { parseSkillManifest, buildSkillManifestYaml } from '@ax/skills-parser';
import {
  intersectProposalWithApproved,
  EMPTY_CAPABILITIES,
  type ApprovedCapEntry,
} from './authored-caps.js';
```
(If `parseSkillManifest` is already imported, extend that import to add `buildSkillManifestYaml` rather than duplicating.)

(b) Add the soft-dep to `manifest.optionalCalls` (after the `skills:quarantine-get` entry, ~`:136`):
```ts
        {
          hook: 'skills:approved-caps-list',
          degradation:
            'a self-authored draft projects with EMPTY approved capabilities (no approval store) — the safe default; frontmatter alone grants nothing',
        },
```

(c) Replace the per-bundle body of the `agents:resolve-authored-skills` handler (the `skills.push({...empty caps...})` block at ~`:378-389`) so the loop body becomes:
```ts
          for (const b of bundles) {
            if (bus.hasService('skills:quarantine-get')) {
              const q = await bus.call<
                { ownerUserId: string; agentId: string; skillId: string },
                { quarantined: boolean; reason?: string }
              >('skills:quarantine-get', _ctx, {
                ownerUserId: input.ownerUserId,
                agentId: input.agentId,
                skillId: b.id,
              });
              if (q.quarantined) continue; // omit — the model never sees its name/description
            }

            // Phase 4: the frontmatter capabilities block is the agent's PROPOSAL.
            // listAuthoredBundles only surfaces parseable manifests, so this parse
            // succeeds; guard defensively anyway (a failure simply skips the draft).
            const parsed = parseSkillManifest(b.manifestYaml);
            if (!parsed.ok) continue;

            // Read what the human approved (soft dep). Absent store → [] → the
            // safe empty-caps default; frontmatter alone grants nothing (#5).
            let approved: ApprovedCapEntry[] = [];
            if (bus.hasService('skills:approved-caps-list')) {
              const r = await bus.call<
                { ownerUserId: string; agentId: string; skillId: string },
                { capabilities: ApprovedCapEntry[] }
              >('skills:approved-caps-list', _ctx, {
                ownerUserId: input.ownerUserId,
                agentId: input.agentId,
                skillId: b.id,
              });
              approved = r.capabilities;
            }

            const { capabilities, delta } = intersectProposalWithApproved(
              parsed.value.capabilities,
              approved,
            );

            // The materialized SKILL.md is caps-stripped: rebuild the frontmatter
            // with EMPTY capabilities so the read-only projection the SDK sees
            // carries no capabilities block. Enforcement reads `capabilities`
            // above, never this text. (sourceUrl is intentionally dropped — a
            // self-authored draft has none; refresh provenance is a catalog concept.)
            const manifestYaml = buildSkillManifestYaml({
              id: parsed.value.id,
              description: parsed.value.description,
              version: parsed.value.version,
              capabilities: EMPTY_CAPABILITIES,
            });

            skills.push({
              id: b.id,
              capabilities,
              proposalDelta: delta,
              bodyMd: b.bodyMd,
              manifestYaml,
              files: b.files,
            });
          }
```

- [ ] **Step 5: Run the new test + the full authored-skills suite**

Run: `pnpm --filter @ax/agents exec vitest run src/__tests__/authored-skills.test.ts`
Expected: PASS — the new Phase 4 test passes AND the existing `agents:list-authored-skills` / projection tests stay green.

- [ ] **Step 6: Verify the package builds**

Run: `pnpm --filter @ax/agents build`
Expected: tsc PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/types.ts packages/agents/src/plugin.ts \
        packages/agents/src/__tests__/authored-skills.test.ts
git commit -m "feat(agents): project proposal ∩ approved for authored skills (Phase 4 PR-A)

resolve-authored-skills now parses the frontmatter proposal, reads the
approved-caps store (soft dep, empty-by-default), projects only the approved
subset, returns the unapproved proposalDelta, and emits a caps-stripped
manifest. Empty approved => behavior-preserving empty caps.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5: PR-A security canary (real executors, no fire-spy)

Proves end-to-end that a self-authored draft declaring a frontmatter host **projects with empty caps** (unapproved) and a populated `proposalDelta`, and that the materialized manifest is caps-stripped — the security gate behind PR-A.

**Files:**
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts`

- [ ] **Step 1: Add the canary (write it as the failing test)**

Add a new `it(...)` block immediately AFTER the Phase-3 quarantine-omit canary (after the block ending ~`:1486`). It reuses the same imports/harness already in the file (`createWorkspaceGitServer`, `simulateRunnerTurn`, `workspaceCommitNotifyHandler`, `createSkillsPlugin`, `createAgentsPlugin`, `PLUGINS_TO_DROP`, etc.). Copy the Phase-3 canary's setup verbatim and change only the drafts + assertions:

```ts
  it(
    'Phase 4 PR-A canary: a self-authored draft that DECLARES a frontmatter host projects with EMPTY caps (unapproved) + a proposalDelta; the projected manifest is caps-stripped (real executors)',
    { timeout: 30_000 },
    async () => {
      // SECURITY-CRITICAL Phase-4 PR-A gate. Through REAL executors (real
      // @ax/skills approved-caps store returning EMPTY, real @ax/agents
      // projection, real workspace-git-server + commit-notify scan) it proves:
      //   1. A draft whose frontmatter declares allowedHosts is committed and
      //      NOT quarantined (caps-presence is not a scan hit).
      //   2. With NO approval rows, agents:resolve-authored-skills projects it
      //      with EMPTY capabilities (the proxy would block the declared host).
      //   3. The unapproved host appears in proposalDelta (drives PR-B's card).
      //   4. The materialized manifestYaml is caps-stripped (no capabilities
      //      block, no host) — frontmatter alone grants nothing.
      const connectionString = await ensurePostgresStarted();
      const serverToken = randomBytes(32).toString('hex');
      const serverRepoRoot = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'ax-phase4-pra-canary-')),
      );
      let server: WorkspaceGitServer | null = null;
      let handle: Awaited<ReturnType<typeof bootstrap>> | null = null;
      try {
        server = await createWorkspaceGitServer({
          repoRoot: serverRepoRoot,
          host: '127.0.0.1',
          port: 0,
          token: serverToken,
        });
        const presetConfig: K8sPresetConfig = {
          database: { connectionString: 'postgres://stub:5432/stub' },
          eventbus: { connectionString: 'postgres://stub:5432/stub' },
          session: { connectionString: 'postgres://stub:5432/stub' },
          workspace: {
            backend: 'git-protocol',
            baseUrl: `http://127.0.0.1:${server.port}`,
            token: serverToken,
          },
          sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
          ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
          chat: { runnerBinary: stubRunnerPath, chatTimeoutMs: 60_000 },
          http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
        };
        const presetPlugins = createK8sPlugins(presetConfig);
        const kept = presetPlugins.filter((p) => !PLUGINS_TO_DROP.has(p.manifest.name));
        const sqlitePath = path.join(tmp, 'phase4-pra-canary.sqlite');
        const replacements: Plugin[] = [
          createDatabasePostgresPlugin({ connectionString }),
          createSkillsPlugin(), // real skills:approved-caps-list (returns [] — nothing approved)
          createAgentsPlugin(), // real agents:resolve-authored-skills (the gate)
          createHttpRegisterRouteStubPlugin(),
          createAuthRequireUserStubPlugin(),
          createStorageSqlitePlugin({ databasePath: sqlitePath }),
          createSessionInmemoryPlugin(),
          createSandboxSubprocessPlugin(),
          createIpcServerPlugin(),
          createTestProxyPlugin({ script: { entries: [{ kind: 'finish', reason: 'end_turn' }] } }),
          createMcpClientPlugin(),
        ];
        const plugins: Plugin[] = [...kept, ...replacements];
        const bus = new HookBus();
        handle = await bootstrap({ bus, plugins, config: {} });

        const sessionId = 'phase4-pra';
        const userId = `phase4-user-${sessionId}`;
        const agentId = `phase4-agent-${sessionId}`;
        const ctx = makeAgentContext({ sessionId, agentId, userId, workspace: { rootPath: tmp } });
        const workspaceId = workspaceIdFor({ userId, agentId });
        const bareRepoPath = path.join(serverRepoRoot, `${workspaceId}.git`);

        // A draft that PROPOSES a host + credential in frontmatter, clean body.
        const proposingSkillMd =
          '---\n' +
          'name: linear\n' +
          'description: Query Linear issues\n' +
          'capabilities:\n' +
          '  allowedHosts:\n' +
          '    - api.linear.app\n' +
          '  credentials:\n' +
          '    - slot: LINEAR_API_KEY\n' +
          '      kind: api-key\n' +
          '---\n' +
          '# Linear\nQuery issues with the Linear API.\n';

        const { bundleB64 } = await simulateRunnerTurn({
          baselineFiles: [],
          turnFiles: { '.ax/draft-skills/linear/SKILL.md': proposingSkillMd },
          parentDir: tmp,
        });
        const result = await workspaceCommitNotifyHandler(
          { parentVersion: null, reason: 'turn', bundleBytes: bundleB64 },
          ctx,
          bus,
        );
        expect(result.status).toBe(200);
        expect((result.body as { accepted: true }).accepted).toBe(true);
        const ls = await git(['-C', bareRepoPath, 'ls-tree', '-r', 'main']);
        expect(ls.stdout).toContain('.ax/draft-skills/linear/SKILL.md');

        // Caps-presence is NOT a scan hit — the draft is not quarantined.
        const q = await bus.call<
          { ownerUserId: string; agentId: string; skillId: string },
          { quarantined: boolean; reason?: string }
        >('skills:quarantine-get', ctx, { ownerUserId: userId, agentId, skillId: 'linear' });
        expect(q.quarantined).toBe(false);

        // ── THE GATE ─────────────────────────────────────────────────────
        const projection = await bus.call<
          { ownerUserId: string; agentId: string },
          {
            skills: Array<{
              id: string;
              capabilities: { allowedHosts: string[]; credentials: Array<{ slot: string }> };
              proposalDelta: { allowedHosts: string[]; credentials: Array<{ slot: string }> };
              manifestYaml: string;
            }>;
          }
        >('agents:resolve-authored-skills', ctx, { ownerUserId: userId, agentId });

        const linear = projection.skills.find((s) => s.id === 'linear');
        expect(linear).toBeDefined();
        // Nothing approved → empty projected caps. The proxy would block api.linear.app.
        expect(linear!.capabilities.allowedHosts).toEqual([]);
        expect(linear!.capabilities.credentials).toEqual([]);
        // The proposal is preserved as the unapproved delta.
        expect(linear!.proposalDelta.allowedHosts).toEqual(['api.linear.app']);
        expect(linear!.proposalDelta.credentials.map((c) => c.slot)).toEqual(['LINEAR_API_KEY']);
        // The materialized manifest is caps-stripped.
        expect(linear!.manifestYaml).not.toContain('capabilities');
        expect(linear!.manifestYaml).not.toContain('api.linear.app');
        expect(linear!.manifestYaml).toContain('name: linear');
      } finally {
        if (handle !== null) await handle.shutdown();
        if (server !== null) await server.close();
        await fs.rm(serverRepoRoot, { recursive: true, force: true });
      }
    },
  );
```

- [ ] **Step 2: Run the canary — verify it passes**

Run: `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/acceptance.test.ts -t "Phase 4 PR-A"`
Expected: PASS. (If the package name differs, find it with `grep '"name"' presets/k8s/package.json` and use that filter.)

- [ ] **Step 3: Run the surrounding Phase-3 canaries — verify no regression**

Run: `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/acceptance.test.ts -t "Phase 3 canary"`
Expected: PASS (the caps-strip rebuild preserves `toContain('name: good')` etc.).

- [ ] **Step 4: Commit**

```bash
git add presets/k8s/src/__tests__/acceptance.test.ts
git commit -m "test(preset-k8s): Phase 4 PR-A canary — unapproved proposal projects empty caps (real executors)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 6: full verification + boundary/security notes + open PR-A

- [ ] **Step 1: Full build + test + lint (scoped to the touched packages)**

Run:
```bash
pnpm build
pnpm --filter @ax/skills test
pnpm --filter @ax/agents test
pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/acceptance.test.ts
pnpm exec eslint packages/skills/src/approved-caps-store.ts packages/skills/src/migrations.ts packages/skills/src/types.ts packages/skills/src/index.ts packages/skills/src/plugin.ts packages/agents/src/authored-caps.ts packages/agents/src/types.ts packages/agents/src/plugin.ts
```
Expected: build PASS; all suites PASS; lint clean. (Scope eslint to changed files — repo-wide `pnpm lint` trips on stale `.worktrees/` copies.)

- [ ] **Step 2: ax-code-reviewer pass (whole-branch diff vs main)**

Dispatch the `ax-code-reviewer` subagent on `git diff main...HEAD`. Address findings before opening the PR. Focus it on: the six invariants, the trust split (self-authored-only, catalog untouched), the half-wired window, and silent-failure hunting on the new soft-dep call.

- [ ] **Step 3: security-checklist skill**

Invoke `security-checklist` (touches plugin loading + untrusted-content handling). Headline for the note: discovery grants instructions; frontmatter caps are an inert proposal; the projection grants only `proposal ∩ approved`; approval state is host-side, outside the agent's reach; PR-A's empty-approved default means an unapproved declared host is unreachable (proxy blocks).

- [ ] **Step 4: Push + open PR-A against main**

PR body MUST include:
- **Half-wired window: OPEN.** The store + `skills:approved-caps-list` + projection-fill land here; the approve path + cards + `-set`/`-revoke` services land in PR-B. Self-authored caps stay empty-by-default at every commit (no approvals exist yet).
- **Boundary review.** Alternate impl for the approval store: a per-skill snapshot blob (rejected — coarse revoke, non-queryable delta). Leaking field names: none (`kind`/`value` are backend-neutral; no `sha`/path/row vocabulary). New `proposalDelta` is a `SkillCapabilities` shape. Trust split: self-authored-only; catalog/admin frontmatter caps stay on `skills:resolve`.
- **Security note** from Step 3.
- **Deviation from the handoff prompt:** D1 — proposal lives in SKILL.md frontmatter, not the prompt's `capabilities.json` sidecar (rationale in the design doc).

```bash
git push -u origin feat/skill-authoring-phase-4-pr-a-projection-store
gh pr create --base main --title "Skill-authoring Phase 4 PR-A: approval store + proposal∩approved projection (window OPEN)" --body "<the body above>"
```

---

## PR-B — Hybrid approval timing (window CLOSED for approval)

Detailed-plan this PR after PR-A merges (its code binds to PR-A's merged interfaces; CodeRabbit only reviews main-based PRs). Task-level outline:

- **B1 — `-set` / `-revoke` services.** Register `skills:approved-caps-set` + `skills:approved-caps-revoke` in `@ax/skills` (store methods already exist), with types + schemas + index exports. Load in CLI + k8s presets (already loaded — services only).
- **B2 — authored-grant path.** A new orchestrator path (NOT the catalog `agent:apply-capability-grant`): given `(conversationId/userId/agentId, skillId)` + the approved proposal, write `skills:approved-caps-set` rows for the delta, then classify: host-only delta (incl. npm/pypi registry hosts) → `proxy:add-host` LIVE; any credential slot or MCP server → `session:terminate` → fresh re-spawn (reuse `respawnSessions`). Register as `agent:apply-authored-capability-grant`.
- **B3 — upfront card at-spawn.** In the orchestrator's spawn path, for each active authored skill with a non-empty `proposalDelta` (now returned by PR-A), fire one `chat:permission-request` `kind:'skill'` with `authored: true`, deduped per `(conversationId, skillId, proposalHash)`. Build the card payload from the delta (hosts/slots/packages). Reuse the SSE frame + `PermissionCard.tsx` (already renders `authored`).
- **B4 — reactive top-up enrichment.** When the existing `kind:'host'` egress wall fires for a host that appears in an active draft's proposal with a credential slot, the grant also approves that slot (→ re-spawn). Otherwise the plain host grant path is unchanged.
- **B5 — decision routing.** `routes-chat.ts` `postPermissionDecision`: detect authored (skillId resolves to a draft / `authored` card) → call `agent:apply-authored-capability-grant`; catalog skills keep calling `agent:apply-capability-grant`.
- **B6 — quarantine-clear affordance.** channel-web UI to list (`skills:quarantine-list`) + clear (`skills:quarantine-clear`) a quarantined draft.
- **B7 — canary.** Approve → projected → reachable; a credential grant flips re-spawn while a host-only grant goes live; a bundled MCP server loads once approved (`.mcp.json` under `settingSources:['user']`). PR body: window CLOSED for approval.

## PR-C — Remove the dead caps-strip + lazy structural validity

- **C1 — remove `stripCapabilitiesFromFrontmatter`** + the `skill_capabilities_stripped` warn in `@ax/validator-skill` (`frontmatter.ts` + the PASS-2 block in `plugin.ts:234-247`). The rewrite is already discarded on apply and is now wrong (frontmatter caps are the proposal). Update `validator-skill` tests.
- **C2 — `authored-skills.ts` cleanup.** Remove the obsolete `hasForbiddenCapabilities` flag + "caps stripped at write time" comments from `summarizeAuthoredSkill` / `listAuthoredSkills` (the promote path), now that frontmatter caps are expected. (If `agents:list-authored-skills` is itself dead post-Phase-3, delete it — confirm no caller first.)
- **C3 — move structural frontmatter validity to lazy/at-use** per the parent design (a malformed SKILL.md surfaces its reason in-context, file still present), confirming nothing on the apply path vetoes structural invalidity.
- **C4 — confirm inertness** end-to-end: a self-authored draft with frontmatter caps is honored ONLY via `s.capabilities` from the approval store; the SDK ignores the (now-absent) caps block.

---

## Self-Review (run against the design doc)

**Spec coverage:** D1 (frontmatter proposal) → Task 4 parses frontmatter, Task 5 canary proves caps-stripped manifest. D2 (per-cap store) → Task 1. D3 (at-spawn upfront card) → PR-B/B3 (PR-A returns the `proposalDelta` it consumes). D4 (separate authored-grant path) → PR-B/B2. Re-spawn-vs-live asymmetry → PR-B/B2. Caps-stripped manifest → Task 4 + Task 5. 3-PR strangler → this structure. Canary → Task 5. Security/boundary notes → Task 6.

**Placeholder scan:** none — every code step shows complete code; PR-B/PR-C are explicitly labelled outline-only (to be detailed post-merge), not placeholders within PR-A.

**Type consistency:** `ApprovedCapEntry` `{kind, value}` is identical in `@ax/skills` (Task 2) and `@ax/agents` (Task 3, structural duplicate per #2). `intersectProposalWithApproved` signature/returns match between Task 3 definition and Task 4 use. `SkillCapabilities` from `@ax/skills-parser` is the single shape for `capabilities` + `proposalDelta`. Store method names (`set`/`clear`/`list`) consistent across Tasks 1, 2, and PR-B/B1.

**Scope check:** PR-A is a single coherent, shippable slice (store + projection, behind empty-default). PR-B/PR-C are correctly deferred to their own plans.
