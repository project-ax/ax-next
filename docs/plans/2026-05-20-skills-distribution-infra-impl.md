# Skills Distribution + Infra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining three Phase 1 follow-ups from PR #96 — the distribution + infra items: (D) user-installable skills, (E) workspace-to-installed "promote" flow, and (F) automated e2e canary for skill-install.

**Architecture:** Three sequential PRs. (D) adds a `user` scope alongside the existing admin/global scope, mirroring the credentials scope axis. (E) adds an admin surface that ingests SKILL.md files an agent authored in its workspace and promotes them to installed skills with admin-chosen capability grants. (F) wires a real-Postgres testcontainer + mocked-fetch end-to-end test that walks install -> attach -> resolve -> materialize. Each phase ships standalone.

**Tech Stack:** TypeScript, pnpm monorepo, Kysely + postgres (additive-only side-tables for new scopes), vitest, `@testcontainers/postgresql` (already used elsewhere in the repo), shadcn primitives in `packages/channel-web`, hook bus per `ax-conventions` skill.

**Sequencing:** This plan executes AFTER `2026-05-20-skills-capability-lifecycle-impl.md` (Plan 1). The capability + lifecycle phases ship first so the distribution surface inherits the full Phase B grammar (mcpServers) and Phase C lifecycle (sourceUrl). If Plan 1 has not landed when starting Plan 2, narrow each phase to only touch fields that already exist.

---

## Source of truth

- **Phase 1 baseline:** `docs/plans/2026-05-18-skill-install-phase-1-impl.md` (PR #96).
- **Credentials scope axis (template for Phase D):** `packages/credentials-admin-routes/src/destination-routes.ts:122-317`. The pattern: enum `scope: 'global' | 'user' | 'agent'`, `forceUser` distinction between `/admin/*` and `/settings/*` routes.
- **Existing acceptance canary (template for Phase F):** `packages/presets-k8s/src/__tests__/acceptance.test.ts` (mocked DB seed) and `packages/skills/src/__tests__/admin-routes.test.ts` (admin-route smoke).
- **Memory cues:** `feedback_one_design_language_invariant.md` (UI lives in channel-web), `feedback_half_wired_window_pattern.md` (close window same PR), `feedback_no_synthetic_actors_through_agents_resolve.md` (Phase E note: do NOT mint a synthetic actor when promoting — the admin's own session is the actor).

## Scope

In scope:
- `user` scope on skills (Phase D).
- Admin-driven promote of workspace-authored SKILL.md to installed (Phase E).
- Real-Postgres + mocked-fetch e2e canary covering install -> attach -> resolve -> materialize (Phase F).

Out of scope:
- Cross-user / team skills (Phase D leaves `team` scope explicitly deferred).
- Auto-promote / auto-discover from workspaces (Phase E requires admin click — no automatic ingestion).
- Production observability / metrics on skill use (orthogonal).

## Half-wired-window policy

Each phase wires every new hook into the CLI preset + k8s preset within the same PR. PR descriptions must include an explicit "Window CLOSED" line.

---

## Phase D — User-installable skills

**Goal:** Add the `user` scope to skills, so a user can install their own private skill (visible only to that user's agents) without admin involvement. Admin retains the existing `/admin/skills/*` surface for global skills.

**Files:**
- Modify: `packages/skills/src/migrations.ts` (add `skills_v1_user_skills` parallel side-table; the existing `skills_v1_skills` remains the global namespace, additive-only)
- Modify: `packages/skills/src/store.ts` (add `userStore` alongside `store`; both register the same shape)
- Modify: `packages/skills/src/types.ts` (add `scope: 'global' | 'user'`, `ownerUserId?: string` to `SkillSummary` / `SkillDetail`)
- Modify: `packages/skills/src/plugin.ts` (`skills:list` / `skills:get` / `skills:upsert` / `skills:delete` accept optional `scope` + `ownerUserId` input; resolve unions both)
- Create: `packages/skills/src/settings-routes.ts` (mirrors `admin-routes.ts` but with `forceUser` semantics)
- Modify: `packages/skills/src/plugin.ts` (register both route batches at the right mount points)
- Modify: `packages/channel-web/src/settings/SettingsPanel.tsx` (new "My Skills" tab)
- Create: `packages/channel-web/src/settings/SkillsTab.tsx`
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:817-832` (extend `skills:resolve` request with the requesting user's id so the resolver can union user-scoped skills)
- Update: presets — `presets/cli/src/index.ts`, `presets/k8s/src/index.ts` to load the same `@ax/skills` plugin (no change — already loaded, but the route registration grows).

### Design lock-in

- [ ] **Step D-design.1: Boundary review for `skills:list` / `skills:get` / `skills:upsert` / `skills:delete` shape change.**

  Current shape: `SkillsListInput = Record<string, never>`. New shape:

  ```typescript
  // BEFORE
  export type SkillsListInput = Record<string, never>;

  // AFTER (additive — `scope` defaults to 'all', `ownerUserId` required when scope=user)
  export interface SkillsListInput {
    scope?: 'all' | 'global' | 'user';
    ownerUserId?: string;  // required iff scope='user'
  }
  ```

  - Alternate impl: a future "file-backed skills" plugin reads `~/.ax/skills/<user>/<id>/SKILL.md` for user scope and `/etc/ax/skills/<id>/SKILL.md` for global. Same `scope` enum, same `ownerUserId` semantics. OK.
  - Payload leak: `ownerUserId` is a user identifier — already standard across the codebase (matches `auth:get-user` shape). OK.
  - Subscriber risk: existing callers pass `{}` — they get `scope='all'` semantics, which today means just global since no user rows exist. After Phase D rollout, `{}` from an admin-context caller would include both — that's the intended union semantic for the orchestrator. Any caller wanting "global-only" behavior must pass `scope: 'global'` explicitly. The existing admin-routes already operates on `'global'` semantics; bump it to pass `scope: 'global'` explicitly in the same PR.

  Record this in the PR's "Boundary review" section.

- [ ] **Step D-design.2: Decide name-collision rule.**

  Same skill id `github` may exist in global scope AND in any number of user scopes. Resolution rule when both exist for a given user:
  - **User-scoped wins.** A user who installs their own `github` skill overrides the global one for their agents. This matches the orchestrator's existing precedence rule for skill attachments (explicit attachments override defaults, see `chat-orchestrator/src/orchestrator.ts:909-913` "explicitIds wins on id collision, I-S4").

  Lock this in the PR description. Add a test in step D.10 below.

- [ ] **Step D-design.3: Team scope explicitly out.**

  The credentials scope axis is `global | user | agent`. Skills Phase D ships only `global | user`. `team` and `agent` scopes are deferred — `team` until multi-tenant ships ([[project_mvp_direction.md]] Week 9.5 slice), `agent` because skills are explicitly intended to be reusable across an owner's agents.

### Migration + storage

- [ ] **Step D.1: Failing migration test.**

  File: `packages/skills/src/__tests__/migrations.test.ts` — add:

  ```typescript
  it('creates skills_v1_user_skills with compound PK and idempotently', async () => {
    await runSkillsMigration(db);
    await runSkillsMigration(db);
    const tables = (await db.introspection.getTables()).map((t) => t.name);
    expect(tables).toContain('skills_v1_user_skills');
    const userCols = (await db.introspection.getTables()).find((t) => t.name === 'skills_v1_user_skills')?.columns ?? [];
    expect(userCols.find((c) => c.name === 'owner_user_id')).toBeDefined();
  });
  ```

- [ ] **Step D.2: Run + verify failure.**

- [ ] **Step D.3: Add the side-table.**

  In `packages/skills/src/migrations.ts`, after the existing global-skills CREATE block:

  ```typescript
  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_user_skills (
      owner_user_id TEXT NOT NULL,
      skill_id      TEXT NOT NULL,
      description   TEXT NOT NULL,
      manifest_yaml TEXT NOT NULL,
      body_md       TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 0,
      source_url    TEXT NULL,
      default_attached BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, skill_id)
    )
  `.execute(db);
  ```

  Add the matching `UserSkillsRow` and `UserSkillsDatabase` interfaces.

  Note: the side-table includes `source_url` because Plan 1's Phase C lands the same field on the global table; mirror it here so user-scoped skills also support sourceUrl refresh from day one. If Plan 1 hasn't shipped, omit it and add via additive ALTER in a follow-up.

- [ ] **Step D.4: Run + verify; commit.**

  ```bash
  pnpm test --filter @ax/skills -- migrations
  git add packages/skills && git commit -m "feat(skills): add skills_v1_user_skills side-table for user-scoped skills (Phase D step 1/4)"
  ```

### Store + types + hooks

- [ ] **Step D.5: Extend `SkillSummary` and `SkillDetail`.**

  In `packages/skills/src/types.ts:20-32`:

  ```typescript
  export interface SkillSummary {
    id: string;
    scope: 'global' | 'user';     // NEW
    ownerUserId?: string;          // NEW; present iff scope='user'
    description: string;
    version: number;
    capabilities: SkillCapabilities;
    defaultAttached: boolean;
    updatedAt: string;
    sourceUrl?: string;
  }

  export interface SkillDetail extends SkillSummary { /* ... */ }
  ```

  Extend `SkillsListInput`, `SkillsGetInput`, `SkillsUpsertInput`, `SkillsDeleteInput` per step D-design.1.

- [ ] **Step D.6: Add `userStore`.**

  Create `packages/skills/src/user-store.ts` mirroring `store.ts` but operating on `skills_v1_user_skills` and accepting `ownerUserId` on every method:

  ```typescript
  export interface UserSkillsStore {
    list(ownerUserId: string): Promise<SkillSummary[]>;
    get(ownerUserId: string, skillId: string): Promise<SkillDetail>;
    upsert(input: UpsertUserSkillInput): Promise<{ skillId: string; created: boolean }>;
    delete(ownerUserId: string, skillId: string): Promise<void>;
    getDefaults(ownerUserId: string): Promise<ResolvedSkill[]>;
  }
  ```

  Reuse the parsing helpers from `store.ts` (extract `rowToSummary` and `rowToDetail` into a shared `_row-mappers.ts` if not already).

- [ ] **Step D.7: Update hook implementations in `plugin.ts`.**

  ```typescript
  bus.registerService<SkillsListInput, SkillsListOutput>(
    'skills:list', PLUGIN_NAME,
    async (_ctx, input) => {
      const scope = input.scope ?? 'all';
      const out: SkillSummary[] = [];
      if (scope === 'global' || scope === 'all') {
        out.push(...(await store.list()).map((s) => ({ ...s, scope: 'global' as const })));
      }
      if (scope === 'user' || scope === 'all') {
        if (input.ownerUserId === undefined && scope === 'user') {
          throw new PluginError('missing-owner', 'scope=user requires ownerUserId');
        }
        if (input.ownerUserId !== undefined) {
          const userSkills = await userStore.list(input.ownerUserId);
          // Per D-design.2: user-scoped wins on id collision.
          const userIds = new Set(userSkills.map((s) => s.id));
          out.push(...userSkills.map((s) => ({ ...s, scope: 'user' as const, ownerUserId: input.ownerUserId })));
          // Drop globals that the user already overrode.
          for (let i = out.length - 1; i >= 0; i--) {
            const item = out[i];
            if (item.scope === 'global' && userIds.has(item.id)) out.splice(i, 1);
          }
        }
      }
      return { skills: out };
    },
  );
  ```

  Do the same shape change for `skills:get`, `skills:upsert`, `skills:delete`, and `skills:resolve` (which is the orchestrator's entry point — must accept `ownerUserId` and prefer user-scoped on collision).

- [ ] **Step D.8: Wire `ctx.userId` through `skills:resolve` in the orchestrator.**

  `packages/chat-orchestrator/src/orchestrator.ts:817-822` currently passes only `{ skillIds: ... }`. Update to:

  ```typescript
  const r = await bus.call<SkillsResolveInput, SkillsResolveOutput>(
    'skills:resolve', ctx,
    { skillIds: attachments.map((a) => a.skillId), ownerUserId: ctx.userId },
  );
  ```

  Update `SkillsResolveInput` accordingly.

- [ ] **Step D.9: Bump existing admin-route callers to `scope: 'global'`.**

  `packages/skills/src/admin-routes.ts:205-209,227-231` currently call `skills:list` and `skills:get` with `{}`. Update both to explicitly request global-only:

  ```typescript
  const out = await deps.bus.call('skills:list', ctx, { scope: 'global' });
  ```

  (Otherwise the admin UI would suddenly start showing every user's user-scoped skills under "global skills" once Phase D lands — that would be a leak.)

- [ ] **Step D.10: Add collision + scope tests.**

  ```typescript
  it('skills:list — scope=all unions global + user, user wins on id collision', async () => {
    await store.upsert({ skillId: 'github', /* ... global */ });
    await userStore.upsert({ ownerUserId: 'alice', skillId: 'github', /* ... user */ });
    const r = await bus.call('skills:list', ctx, { scope: 'all', ownerUserId: 'alice' });
    const githubs = r.skills.filter((s) => s.id === 'github');
    expect(githubs).toHaveLength(1);
    expect(githubs[0].scope).toBe('user');
  });

  it('skills:list — scope=global ignores user rows even when ownerUserId is provided', async () => {
    await store.upsert({ skillId: 'github', /* ... global */ });
    await userStore.upsert({ ownerUserId: 'alice', skillId: 'github', /* ... user */ });
    const r = await bus.call('skills:list', ctx, { scope: 'global', ownerUserId: 'alice' });
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].scope).toBe('global');
  });
  ```

- [ ] **Step D.11: Run + commit.**

  ```bash
  pnpm build --filter @ax/skills && pnpm test --filter @ax/skills
  git add packages/skills && git commit -m "feat(skills): user-scoped store + scope-aware hooks (Phase D step 2/4)"
  ```

### Routes — `/settings/skills*`

- [ ] **Step D.12: Create `settings-routes.ts`.**

  Mirror `admin-routes.ts`. Key differences:
  - `requireAdmin` -> `requireUser` (whatever the codebase calls the user-session guard; check what `credentials-admin-routes/destination-routes.ts` uses for `/settings/*` routes).
  - All handlers force `scope: 'user'` and `ownerUserId: actor.id` regardless of body input.
  - Route mount path is `/settings/skills` not `/admin/skills`.

  Skeleton:

  ```typescript
  // packages/skills/src/settings-routes.ts
  export function createSettingsSkillsHandlers(deps: { bus: HookBus }) {
    return {
      async list(req, res) {
        const actor = await requireUser(deps.bus, ctx, req, res);
        if (actor === null) return;
        const out = await deps.bus.call('skills:list', ctx, { scope: 'user', ownerUserId: actor.id });
        res.status(200).json(out);
      },
      async get(req, res) {
        const actor = await requireUser(deps.bus, ctx, req, res);
        if (actor === null) return;
        const { id } = req.params;
        const detail = await deps.bus.call('skills:get', ctx, { scope: 'user', ownerUserId: actor.id, skillId: id });
        res.status(200).json(detail);
      },
      async create(req, res) { /* same as admin.create but force scope+ownerUserId */ },
      async update(req, res) { /* ... */ },
      async destroy(req, res) { /* ... */ },
    };
  }

  export function settingsSkillsRoutes(handlers): RouteSpec[] {
    return [
      { method: 'GET', path: '/settings/skills', handler: handlers.list },
      { method: 'GET', path: '/settings/skills/:id', handler: handlers.get },
      { method: 'POST', path: '/settings/skills', handler: handlers.create },
      { method: 'PUT', path: '/settings/skills/:id', handler: handlers.update },
      { method: 'DELETE', path: '/settings/skills/:id', handler: handlers.destroy },
    ];
  }
  ```

- [ ] **Step D.13: Tests for settings routes.**

  Mirror admin-routes tests. Key cases:
  - Anonymous request -> 401.
  - Authenticated as alice -> CRUD operations land in `skills_v1_user_skills` with `owner_user_id='alice'`.
  - Alice cannot see bob's skills via `GET /settings/skills`.
  - Alice cannot modify a global skill via `/settings/skills/:id` (404 — the row simply isn't visible).

- [ ] **Step D.14: Wire into plugin.**

  In `packages/skills/src/plugin.ts`, register both route batches via the existing `http:register-route` hook bus pattern.

- [ ] **Step D.15: Run + commit.**

  ```bash
  pnpm build --filter @ax/skills && pnpm test --filter @ax/skills
  git add packages/skills && git commit -m "feat(skills): /settings/skills CRUD with forced user scope (Phase D step 3/4)"
  ```

### UI — Settings panel tab

- [ ] **Step D.16: Invoke `shadcn` skill.** Confirm the components needed for a list+upload tab are installed (`Card`, `Button`, `Textarea`, `Dialog`). Add anything missing with `pnpm dlx shadcn@latest add <name> -c packages/channel-web`.

- [ ] **Step D.17: Create `packages/channel-web/src/settings/SkillsTab.tsx`.**

  Copy the existing admin `SkillsTab.tsx` shape; swap fetch URLs from `/admin/skills*` to `/settings/skills*`. No scope/owner UI controls — the route forces those.

- [ ] **Step D.18: Add the tab to `SettingsPanel.tsx`.**

  Mirror the existing tab list pattern. Tab label: "My Skills".

- [ ] **Step D.19: Walk MANUAL-ACCEPTANCE.**

  Add a scenario:

  ```markdown
  ## User-installable skill end-to-end
  1. As user alice, navigate to Settings -> My Skills. Install a skill.
  2. Verify alice's agent sessions see the skill in their resolved set.
  3. As user bob, Settings -> My Skills shows zero skills.
  4. Bob's agent sessions do NOT see alice's skill.
  5. Admin -> /admin/skills still shows only global skills.
  ```

  Walk against `kind ax-next-dev`.

- [ ] **Step D.20: Ship as PR.**

  PR title: `feat(skills): user-installable skills (Phase 1 follow-up D)`.

  PR body: scope-axis boundary review (step D-design.1), name-collision rule (D-design.2), team-scope deferral note (D-design.3), window-closed confirmation.

---

## Phase E — Workspace-to-installed "promote" flow

**Goal:** An agent operating in its own workspace authors a SKILL.md at `.ax/skills/<id>/SKILL.md` (no capabilities — agents can't grant themselves capabilities). An admin sees that file listed in the agent's detail page and clicks "Promote to installed", choosing which capabilities to grant. The promoted skill becomes a normal installed skill at admin-chosen scope (global or, post-D, the agent owner's user scope).

**Files:**
- Modify: `packages/agents/src/plugin.ts` (new `workspace:list-authored-skills` service hook)
- Create: `packages/agents/src/authored-skills.ts` (scans `/permanent/.ax/skills/*/SKILL.md` via the existing `workspace:read` IPC action shipped in PR #94)
- Modify: `packages/agents/src/admin-routes.ts` (new `GET /admin/agents/:id/authored-skills` and `POST /admin/agents/:id/authored-skills/promote`)
- Modify: `packages/channel-web/src/admin/AgentDetailPage.tsx` (new "Authored Skills" section)
- Update: `MANUAL-ACCEPTANCE.md`.

### Design lock-in

- [ ] **Step E-design.1: How to enumerate authored skills.**

  Two options:
  - **(a) List-on-demand.** On admin-route invocation, call `workspace:read` repeatedly to list `/permanent/.ax/skills/`, then read each `SKILL.md`. Stateless, simple, but each list call touches the workspace.
  - **(b) Indexed.** The workspace-apply path subscribes to writes under `.ax/skills/**/SKILL.md` and maintains an `agents_v1_authored_skills` table. Lower-latency reads but adds a write-time subscriber.

  **Default recommendation:** (a) list-on-demand. Agents authoring skills is a low-frequency operation; the read latency is acceptable. (b) is a YAGNI escalation until a real workload demands it.

- [ ] **Step E-design.2: Capability grants UX.**

  When promoting, the admin must explicitly grant any capability the SKILL.md declares. Agent-authored SKILL.md MUST NOT include `capabilities` at all (per the half-trust principle — an agent declaring "give me network reach to evil.com" is not a request anyone should grant by clicking through).

  Two enforcement layers:
  1. **Parse-time on read.** When `workspace:list-authored-skills` parses an authored SKILL.md, reject any file that has a non-empty `capabilities:` block. Surface the file as `{ id, description, version, hasForbiddenCapabilities: true }` so the UI can show "this skill has capabilities that must be removed before promotion."
  2. **Promote-time.** The promote endpoint accepts an admin-chosen `capabilities: { allowedHosts, credentials, mcpServers }` block. The endpoint splices that block INTO the manifest YAML before passing to `skills:upsert`. The authored file's `capabilities` is ignored even if present.

- [ ] **Step E-design.3: Boundary review for `workspace:list-authored-skills`.**

  ```typescript
  export interface WorkspaceListAuthoredSkillsInput {
    agentId: string;
  }
  export interface AuthoredSkillSummary {
    id: string;
    description: string;
    version: number;
    bodyMd: string;
    hasForbiddenCapabilities: boolean;
  }
  export interface WorkspaceListAuthoredSkillsOutput {
    skills: AuthoredSkillSummary[];
  }
  ```

  - Alternate impl: a future `git-backed` workspace alternate-impl reads the same path through a different transport. Same shape. OK.
  - Field-leak check: no `sha`, `bucket`, `pod_name`. OK.
  - Subscriber risk: none — admin-route is the only caller.

- [ ] **Step E-design.4: Promote endpoint shape.**

  ```typescript
  // POST /admin/agents/:agentId/authored-skills/promote
  {
    skillId: 'foo',                            // matches the authored .ax/skills/foo/SKILL.md
    targetScope: 'global' | 'user',            // 'user' = the agent owner's user-scoped namespace
    grants: {                                  // admin-chosen, replaces the authored file's capabilities entirely
      allowedHosts: string[],
      credentials: { slot: string, kind: 'api-key' }[],
      mcpServers: McpServerSpec[],             // from Plan 1 Phase B types
    },
  }
  ```

  - No synthetic actor — the admin's session is the actor for the resulting `skills:upsert` call ([[feedback_no_synthetic_actors_through_agents_resolve.md]]).

### `workspace:list-authored-skills` — TDD walk

- [ ] **Step E.1: Failing test for the hook + the `capabilities`-rejection rule.**

  File: `packages/agents/src/__tests__/authored-skills.test.ts`

  ```typescript
  it('lists each .ax/skills/<id>/SKILL.md under the agent workspace', async () => {
    // Fixture: workspace has /permanent/.ax/skills/foo/SKILL.md and /permanent/.ax/skills/bar/SKILL.md
    const r = await bus.call('workspace:list-authored-skills', ctx, { agentId: 'a1' });
    expect(r.skills.map((s) => s.id).sort()).toEqual(['bar', 'foo']);
  });

  it('marks skills with a capabilities block as hasForbiddenCapabilities=true', async () => {
    // Fixture: SKILL.md includes `capabilities: { allowedHosts: [evil.com] }`
    const r = await bus.call('workspace:list-authored-skills', ctx, { agentId: 'a1' });
    expect(r.skills[0].hasForbiddenCapabilities).toBe(true);
  });

  it('returns empty array when the workspace has no .ax/skills dir', async () => {
    const r = await bus.call('workspace:list-authored-skills', ctx, { agentId: 'empty-a1' });
    expect(r.skills).toEqual([]);
  });
  ```

- [ ] **Step E.2: Resolve the cross-plugin parse problem.**

  Per invariant I2 (no cross-plugin imports), `@ax/agents` can't import `parseSkillManifest` from `@ax/skills` directly. Cleanest path: extract a new `@ax/skills-parser` package containing only types + the pure `parseSkillManifest` function. Both `@ax/skills` and `@ax/agents` depend on it.

- [ ] **Step E.3: Extract `@ax/skills-parser`.**

  ```bash
  mkdir -p packages/skills-parser/src
  ```

  Move `parseSkillManifest`, `ManifestCode`, `ParsedManifest`, `ParseResult`, `SkillCapabilities`, `CapabilitySlot`, `McpServerSpec` into a new package `@ax/skills-parser`. The existing `@ax/skills` re-exports the types so external consumers don't notice.

  Update `packages/skills/package.json` to depend on `@ax/skills-parser`. Add the dep to `packages/agents/package.json`.

  This is the only cross-plugin coupling Phase E adds. Document in the PR.

- [ ] **Step E.4: Implement scanning.**

  ```typescript
  // packages/agents/src/authored-skills.ts
  import { parseSkillManifest } from '@ax/skills-parser';
  import type { AuthoredSkillSummary } from './types.js';

  export async function listAuthoredSkills(
    bus: HookBus, ctx: AgentContext, agentId: string,
  ): Promise<AuthoredSkillSummary[]> {
    // List directories under /permanent/.ax/skills/ via workspace:read with a glob.
    // The exact API is `workspace:read` (per PR #94). Adapt to the shipped shape.
    let entries: { path: string; content: string }[];
    try {
      const r = await bus.call('workspace:read', ctx, {
        agentId,
        glob: '.ax/skills/*/SKILL.md',
        sourceRoot: 'permanent',
      });
      entries = r.entries;
    } catch {
      // No such dir, or workspace unreachable -> empty list (non-fatal).
      return [];
    }

    const out: AuthoredSkillSummary[] = [];
    for (const entry of entries) {
      // Extract skill id from path: `.ax/skills/<id>/SKILL.md`
      const idMatch = entry.path.match(/\.ax\/skills\/([^/]+)\/SKILL\.md$/);
      if (idMatch === null) continue;
      const id = idMatch[1];

      // Parse the manifest (YAML between the --- fences).
      const fmMatch = entry.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch === null) continue;
      const parsed = parseSkillManifest(fmMatch[1] ?? '');
      if (!parsed.ok) continue;  // Skip unparseable files silently.

      // Per E-design.2: agent-authored files MUST NOT declare capabilities.
      const hasForbiddenCapabilities =
        parsed.value.capabilities.allowedHosts.length > 0 ||
        parsed.value.capabilities.credentials.length > 0 ||
        (parsed.value.capabilities.mcpServers ?? []).length > 0;

      out.push({
        id,
        description: parsed.value.description,
        version: parsed.value.version,
        bodyMd: entry.content.slice(fmMatch[0].length).replace(/^\r?\n/, ''),
        hasForbiddenCapabilities,
      });
    }
    return out;
  }
  ```

- [ ] **Step E.5: Register the service hook.**

  In `packages/agents/src/plugin.ts`:

  ```typescript
  bus.registerService('workspace:list-authored-skills', PLUGIN_NAME, async (ctx, input) => ({
    skills: await listAuthoredSkills(bus, ctx, input.agentId),
  }));
  ```

  Add to `provides:` in the manifest.

- [ ] **Step E.6: Run + commit.**

  ```bash
  pnpm build --filter @ax/skills-parser && pnpm build --filter @ax/skills && pnpm build --filter @ax/agents
  pnpm test --filter @ax/skills-parser && pnpm test --filter @ax/skills && pnpm test --filter @ax/agents
  git add packages && git commit -m "feat(agents): workspace:list-authored-skills + @ax/skills-parser extract (Phase E step 1/3)"
  ```

### Promote endpoint

- [ ] **Step E.7: Add `POST /admin/agents/:agentId/authored-skills/promote`.**

  In `packages/agents/src/admin-routes.ts`:

  ```typescript
  async promoteAuthoredSkill(req, res) {
    const actor = await requireAdmin(deps.bus, ctx, req, res);
    if (actor === null) return;
    const { agentId } = req.params;
    const body = parsePromoteBody(req.body);
    if (!body.ok) { res.status(400).json({ error: body.message }); return; }

    // 1. Load the authored skill from workspace.
    const authored = await deps.bus.call('workspace:list-authored-skills', ctx, { agentId });
    const target = authored.skills.find((s) => s.id === body.value.skillId);
    if (target === undefined) { res.status(404).json({ error: 'authored-skill-not-found' }); return; }

    // 2. Build the canonical manifest YAML with admin-chosen grants.
    const newManifest = buildPromotedManifest({
      id: target.id,
      description: target.description,
      version: target.version,
      capabilities: body.value.grants,
    });

    // 3. Construct the final SKILL.md = frontmatter + body.
    const finalSkillMd = '---\n' + newManifest + '\n---\n' + target.bodyMd;

    // 4. Upsert at the chosen scope.
    if (body.value.targetScope === 'global') {
      await deps.bus.call('skills:upsert', ctx, { skillMd: finalSkillMd, scope: 'global' });
    } else {
      // Resolve the agent's owner user id.
      const agent = await deps.bus.call('agents:get', ctx, { agentId });
      await deps.bus.call('skills:upsert', ctx, {
        skillMd: finalSkillMd, scope: 'user', ownerUserId: agent.ownerUserId,
      });
    }

    res.status(200).json({ promoted: true, skillId: target.id, targetScope: body.value.targetScope });
  }
  ```

- [ ] **Step E.8: Implement `buildPromotedManifest`.**

  In `packages/agents/src/promote-manifest.ts`:

  ```typescript
  import { dump as yamlDump } from 'js-yaml';
  import type { SkillCapabilities } from '@ax/skills-parser';

  export function buildPromotedManifest(input: {
    id: string;
    description: string;
    version: number;
    capabilities: SkillCapabilities;
  }): string {
    // Produce a deterministic YAML output. Field order matches the docs.
    const doc: Record<string, unknown> = {
      name: input.id,
      description: input.description,
      version: input.version,
    };
    if (
      input.capabilities.allowedHosts.length > 0 ||
      input.capabilities.credentials.length > 0 ||
      (input.capabilities.mcpServers ?? []).length > 0
    ) {
      doc.capabilities = {
        ...(input.capabilities.allowedHosts.length > 0 ? { allowedHosts: input.capabilities.allowedHosts } : {}),
        ...(input.capabilities.credentials.length > 0 ? { credentials: input.capabilities.credentials } : {}),
        ...((input.capabilities.mcpServers ?? []).length > 0 ? { mcpServers: input.capabilities.mcpServers } : {}),
      };
    }
    return yamlDump(doc, { noRefs: true });
  }
  ```

  Test:

  ```typescript
  it('builds a manifest with only the granted capability fields present', () => {
    const yaml = buildPromotedManifest({
      id: 'foo', description: 'bar', version: 1,
      capabilities: { allowedHosts: ['api.x.com'], credentials: [], mcpServers: [] },
    });
    expect(yaml).toContain('allowedHosts');
    expect(yaml).not.toContain('credentials:');
    expect(yaml).not.toContain('mcpServers:');
    // Re-parse to confirm.
    const r = parseSkillManifest(yaml);
    expect(r.ok).toBe(true);
  });
  ```

- [ ] **Step E.9: Add the route.**

  ```typescript
  { method: 'POST', path: '/admin/agents/:agentId/authored-skills/promote', handler: handlers.promoteAuthoredSkill },
  { method: 'GET', path: '/admin/agents/:agentId/authored-skills', handler: handlers.listAuthoredSkills },
  ```

  Implement `listAuthoredSkills` as a thin GET wrapper around the service hook.

- [ ] **Step E.10: Tests for promote.**

  ```typescript
  it('promotes an authored skill to global scope with admin-chosen grants', async () => {
    // Fixture: workspace has .ax/skills/foo/SKILL.md without capabilities.
    const r = await postAsAdmin('/admin/agents/a1/authored-skills/promote', {
      skillId: 'foo',
      targetScope: 'global',
      grants: { allowedHosts: ['api.foo.com'], credentials: [], mcpServers: [] },
    });
    expect(r.status).toBe(200);
    // Verify the skill is now in skills_v1_skills with the admin's grants.
    const skill = await deps.bus.call('skills:get', ctx, { skillId: 'foo', scope: 'global' });
    expect(skill.capabilities.allowedHosts).toEqual(['api.foo.com']);
  });

  it('ignores capabilities present in the authored file (E-design.2 rule)', async () => {
    // Fixture: workspace SKILL.md HAS `capabilities: { allowedHosts: [evil.com] }`.
    const r = await postAsAdmin('/admin/agents/a1/authored-skills/promote', {
      skillId: 'foo',
      targetScope: 'global',
      grants: { allowedHosts: ['api.foo.com'], credentials: [], mcpServers: [] },
    });
    expect(r.status).toBe(200);
    const skill = await deps.bus.call('skills:get', ctx, { skillId: 'foo', scope: 'global' });
    expect(skill.capabilities.allowedHosts).toEqual(['api.foo.com']);
    expect(skill.capabilities.allowedHosts).not.toContain('evil.com');
  });
  ```

- [ ] **Step E.11: Run + commit.**

  ```bash
  pnpm build && pnpm test --filter @ax/agents && pnpm test --filter @ax/skills
  git add packages && git commit -m "feat(agents): promote authored skill to installed with admin grants (Phase E step 2/3)"
  ```

### UI — Authored Skills section

- [ ] **Step E.12: Invoke shadcn skill.** Confirm `Card`, `Dialog`, `Tabs` (for grants editor), `Input` are installed. Install missing with `pnpm dlx shadcn@latest add ... -c packages/channel-web`.

- [ ] **Step E.13: Add "Authored Skills" section to `AgentDetailPage.tsx`.**

  ```tsx
  function AuthoredSkillsSection({ agentId }: { agentId: string }) {
    const { data: authored } = useFetch(`/admin/agents/${agentId}/authored-skills`);
    return (
      <Card>
        <h3>Authored Skills</h3>
        {authored?.skills.map((s) => (
          <AuthoredSkillRow key={s.id} agentId={agentId} skill={s} />
        ))}
      </Card>
    );
  }

  function AuthoredSkillRow({ agentId, skill }: ...) {
    const [openDialog, setOpenDialog] = useState(false);
    return (
      <>
        <div>
          <span>{skill.id}</span>
          {skill.hasForbiddenCapabilities && (
            <Badge variant="destructive">capabilities present — remove before promoting</Badge>
          )}
          <Button onClick={() => setOpenDialog(true)} disabled={skill.hasForbiddenCapabilities}>
            Promote
          </Button>
        </div>
        {openDialog && <PromoteDialog agentId={agentId} skill={skill} onClose={() => setOpenDialog(false)} />}
      </>
    );
  }
  ```

  `PromoteDialog` renders three sections — allowedHosts (Input + add/remove), credentials (Input pairs), mcpServers (the most complex; Phase B's schema gives the shape). On submit, POST to `/promote` with the chosen grants + targetScope.

- [ ] **Step E.14: Walk MANUAL-ACCEPTANCE.**

  ```markdown
  ## Workspace-to-installed promote
  1. As an agent, write `.ax/skills/foo/SKILL.md` containing only `name: foo`, `description: x`, and a body.
  2. As admin, navigate to the agent's detail page -> Authored Skills section. See "foo" listed.
  3. Click Promote. Grant `api.foo.com` allowedHost, no credentials, no mcpServers. Submit.
  4. Verify foo appears under Admin -> Skills with the granted capability.
  5. Repeat for a SKILL.md that declares `capabilities`. UI should show "capabilities present — remove before promoting" and the Promote button should be disabled.
  ```

  Walk against `kind ax-next-dev`.

- [ ] **Step E.15: Ship as PR.**

  PR title: `feat(agents): workspace-to-installed skill promote flow (Phase 1 follow-up E)`.

  PR body:
  - List-on-demand vs indexed decision (E-design.1).
  - Capability-grants enforcement (E-design.2).
  - Boundary review (E-design.3).
  - Cross-plugin extraction: `@ax/skills-parser` is a new package consumed by `@ax/skills` and `@ax/agents` (acceptable per I2 since it carries only types + a pure function).
  - Window-closed confirmation.

---

## Phase F — Automated e2e canary for skill-install

**Goal:** Replace the manual MANUAL-ACCEPTANCE walk with an automated test that boots a real Postgres, runs `@ax/skills` migrations, installs a skill via the real admin route, attaches it to a real agent, opens a real session via the orchestrator, and asserts that the sandbox layer would materialize the correct `SKILL.md`. The remote-fetch parts (Phase C `sourceUrl` refresh) are exercised against a mocked-fetch fake.

**Files:**
- Create: `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts`
- Create: `packages/skills/src/__tests__/e2e/fixtures/` — helper for bringing up the Postgres testcontainer, running migrations, building a minimal bus with `@ax/skills` + `@ax/agents` + a fake proxy + a fake workspace.
- Modify: `vitest.workspace.ts` (or equivalent — confirm the existing pattern) to mark `.canary.test.ts` with a longer timeout + appropriate `testTimeout`.
- Modify: `.github/workflows/<ci>.yml` (or the existing CI file) — add an explicit step that runs the canary suite with a 10-minute timeout and Docker available.

### Design lock-in

- [ ] **Step F-design.1: Decide where the canary lives.**

  Two options:
  - **(a) Inside `@ax/skills`** as a `*.canary.test.ts` file in `src/__tests__/e2e/`. Lives next to the unit tests; runs with `pnpm test --filter @ax/skills -- canary`.
  - **(b) In a new `@ax/skills-canary` package.** Pure overhead — no production code lives there.

  **Default recommendation:** (a). The canary tests `@ax/skills`'s public surface against a real DB; it belongs in that package's test tree.

- [ ] **Step F-design.2: Reuse the testcontainer pattern.**

  The repo already uses testcontainers somewhere (confirm via `grep -rn '@testcontainers' packages/`). Reuse whatever helper exists. If none, add a thin one at `packages/skills/src/__tests__/e2e/fixtures/pg.ts`:

  ```typescript
  import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
  import { Kysely, PostgresDialect } from 'kysely';
  import { Pool } from 'pg';

  export async function startPg(): Promise<{ db: Kysely<unknown>; stop: () => Promise<void> }> {
    const container: StartedPostgreSqlContainer =
      await new PostgreSqlContainer('postgres:16-alpine').start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    return {
      db,
      async stop() {
        await db.destroy();
        await pool.end();
        await container.stop();
      },
    };
  }
  ```

- [ ] **Step F-design.3: Mocked fetch for Phase C refresh path.**

  Don't pull in msw. A trivial in-memory mock is enough:

  ```typescript
  function makeMockFetch(routes: Record<string, { status: number; body: string }>) {
    return async (url: string) => {
      const r = routes[url];
      if (r === undefined) return { ok: false, status: 404, text: async () => 'not found' };
      return { ok: r.status === 200, status: r.status, text: async () => r.body };
    };
  }
  ```

  Inject via the existing `checkForUpdates(detail, { fetch })` seam from Plan 1 Phase C.

### Implementation

- [ ] **Step F.1: Bring up Postgres + run migrations in a `beforeAll`.**

  ```typescript
  // packages/skills/src/__tests__/e2e/skill-install.canary.test.ts
  import { afterAll, beforeAll, describe, it, expect } from 'vitest';
  import { startPg } from './fixtures/pg.js';
  import { runSkillsMigration } from '../../migrations.js';
  import { runAgentsMigration } from '@ax/agents';
  import { makeBus } from '@ax/core';
  import { registerSkillsPlugin } from '../../plugin.js';
  import { registerAgentsPlugin } from '@ax/agents';

  describe('e2e: skill install canary', () => {
    let db: Kysely<unknown>;
    let stopPg: () => Promise<void>;
    let bus: HookBus;
    let proxyCalls: ProxyCall[];

    beforeAll(async () => {
      const pg = await startPg();
      db = pg.db;
      stopPg = pg.stop;
      await runSkillsMigration(db);
      await runAgentsMigration(db);
      bus = makeBus();
      registerSkillsPlugin(bus, { db });
      registerAgentsPlugin(bus, { db });
      proxyCalls = [];
      bus.registerService('proxy:open-session', '@test/fake-proxy', async (_ctx, input) => {
        proxyCalls.push(input);
        return { sessionToken: 'fake' };
      });
    }, 60_000);

    afterAll(() => stopPg());

    it('install -> attach -> session walk-through', async () => {
      // 1. Install a skill via the admin hook.
      const installRes = await bus.call('skills:upsert', ctx, {
        skillMd: '---\nname: github\ndescription: GitHub\ncapabilities:\n  allowedHosts: [api.github.com]\n  credentials:\n    - slot: GITHUB_TOKEN\n      kind: api-key\n---\nBody.',
      });
      expect(installRes.created).toBe(true);

      // 2. Create an agent that attaches the skill.
      await bus.call('agents:upsert', ctx, {
        agentId: 'a1',
        ownerUserId: 'alice',
        skillAttachments: [{
          skillId: 'github',
          credentialBindings: { GITHUB_TOKEN: 'cred-ref-alice-gh' },
        }],
        // ... other fields as agents:upsert requires
      });

      // 3. Open a session via the orchestrator.
      await orchestrator.openSession(makeAgentContext({ agentId: 'a1', userId: 'alice', sessionId: 's1' }));

      // 4. Assert proxy:open-session received the unioned allowlist + creds.
      expect(proxyCalls).toHaveLength(1);
      const call = proxyCalls[0];
      expect(call.allowlist).toContain('api.github.com');
      expect(call.credentials.GITHUB_TOKEN).toEqual({ ref: 'cred-ref-alice-gh', kind: 'api-key' });
      expect(call.installedSkills).toHaveLength(1);
      expect(call.installedSkills[0].skillMd).toContain('name: github');
    }, 30_000);
  });
  ```

- [ ] **Step F.2: Add a refresh-from-source case (uses Phase C).**

  ```typescript
  it('sourceUrl refresh updates the row when remote version is higher', async () => {
    await bus.call('skills:upsert', ctx, {
      skillMd: '---\nname: github\ndescription: GH\nversion: 1\nsourceUrl: https://example.com/github.md\n---\nold body',
    });
    // Stub fetch on the plugin: re-register skills:check-for-updates with injected mock.
    bus.registerService('skills:check-for-updates', '@test/skills', async () => ({
      available: true, currentVersion: 1, latestVersion: 2,
      latestSkillMd: '---\nname: github\ndescription: GH\nversion: 2\n---\nnew body',
    }));
    const refreshRes = await postAsAdmin('/admin/skills/github/refresh-from-source');
    expect(refreshRes.body.updated).toBe(true);
    expect(refreshRes.body.newVersion).toBe(2);
    const updated = await bus.call('skills:get', ctx, { skillId: 'github', scope: 'global' });
    expect(updated.bodyMd).toBe('new body');
  });
  ```

- [ ] **Step F.3: Add a Phase D scope case (only if Plan 1 + Phase D shipped).**

  ```typescript
  it('user-scoped skill is invisible to a different user', async () => {
    await bus.call('skills:upsert', ctx, {
      scope: 'user', ownerUserId: 'alice',
      skillMd: '---\nname: secret\ndescription: alice secret\n---\nbody',
    });
    const aliceView = await bus.call('skills:list', ctx, { scope: 'user', ownerUserId: 'alice' });
    expect(aliceView.skills.map((s) => s.id)).toContain('secret');
    const bobView = await bus.call('skills:list', ctx, { scope: 'user', ownerUserId: 'bob' });
    expect(bobView.skills.map((s) => s.id)).not.toContain('secret');
  });
  ```

- [ ] **Step F.4: CI wiring.**

  Add a job step in the CI config (find via `ls .github/workflows/`):

  ```yaml
  - name: Skill-install canary
    run: pnpm test --filter @ax/skills -- canary
    timeout-minutes: 10
  ```

  Ensure Docker is available in the CI environment (testcontainers requires it).

- [ ] **Step F.5: Run locally to verify.**

  ```bash
  pnpm test --filter @ax/skills -- canary
  ```

  Expected: the new canary suite passes within 60s on a warm Docker daemon. If it times out cold-pulling the postgres:16 image, mention the manual `docker pull postgres:16-alpine` step in the test file's preamble comment.

- [ ] **Step F.6: Update MANUAL-ACCEPTANCE.md.**

  Mark the existing manual skill-install scenario as "now auto-canaried in `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts`. Manual walk still encouraged for UI surfaces."

- [ ] **Step F.7: Ship as PR.**

  PR title: `test(skills): e2e canary for install -> attach -> session (Phase 1 follow-up F)`.

  PR body:
  - Canary location decision (F-design.1).
  - Testcontainer pattern (F-design.2).
  - Mocked-fetch approach (F-design.3).
  - Note: if Plan 1's Phase B/C and this plan's Phase D haven't shipped, narrow the canary to the install -> attach -> session walk only (Step F.1); add the other cases in the PR for whichever phase ships them.

---

## Self-review checklist (run before opening any PR in this plan)

1. **Spec coverage.** Walk the three Phase 1 follow-ups (D user-installable, E promote, F canary). Every item is mapped to a phase.
2. **Invariants.** Every new hook has a boundary-review section in its PR. Cross-plugin imports: only the `@ax/skills-parser` extract in Phase E, which carries only types + a pure parser (acceptable per I2).
3. **Half-wired discipline.** D wires settings routes + UI + orchestrator-resolve update in the same PR. E wires service hook + admin route + UI same PR. F is test-only. ([[feedback_half_wired_window_pattern.md]])
4. **YAGNI.** Phase D defers `team` and `agent` scopes. Phase E uses list-on-demand not indexed. Phase F doesn't add msw. ([[feedback_yagni_check_in_plans.md]])
5. **No synthetic actors.** Phase E's promote endpoint uses the admin's session as the actor for `skills:upsert`, not a synthesized agent identity. ([[feedback_no_synthetic_actors_through_agents_resolve.md]])
6. **Build + lint + test.** `pnpm build && pnpm test && pnpm -w lint` green at each commit. ([[feedback_run_lint_before_pr.md]], [[feedback_run_tsc_alongside_vitest.md]])
7. **Manual acceptance.** D and E each walked against `kind ax-next-dev`. F replaces the manual walk for the install path with a canary. ([[k8s-acceptance-loop]])

## Execution

This plan ships AFTER Plan 1 (`2026-05-20-skills-capability-lifecycle-impl.md`). When you finish Plan 1's Phase C, hand off to this plan's Phase D.
