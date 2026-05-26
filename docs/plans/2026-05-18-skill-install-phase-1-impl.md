# Skill install — Phase 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the host-managed installed-skills workflow end-to-end on top of the Phase 0 (PR #95) wiring: a new `@ax/skills` plugin (manifest schema with `capabilities` block + DB-backed storage + admin HTTP CRUD), a `skillAttachments` field on agents, orchestrator integration that unions skill-declared `allowedHosts` and merges credential bindings into `proxy:open-session`, sandbox materialization of installed-skill `SKILL.md` files into `$CLAUDE_CONFIG_DIR/skills/<id>/` (chmod 0555 after write), and a channel-web admin UI tab + per-agent Skills section. End-to-end canary: admin installs a `github` skill → admin attaches to an agent + binds `GITHUB_TOKEN` slot → user chats with the agent → a request to `api.github.com` lands with the MITM-substituted token.

**Architecture:**
- New plugin `@ax/skills` owns the `skills` table, the manifest validator extensions, and five service hooks (`skills:list / :get / :upsert / :delete / :resolve`). Registers `/admin/skills*` HTTP routes via `http:register-route` (same duck-typed Request/Response surface as `@ax/credentials-admin-routes`).
- `@ax/agents` grows a `skill_attachments JSONB NOT NULL DEFAULT '[]'` column (additive migration) and the matching admin-routes patch endpoint. The `AgentRecord` shape (duplicated structurally inside `chat-orchestrator/src/orchestrator.ts` per I2) grows the `skillAttachments` field.
- `chat-orchestrator`'s `agent:invoke` path adds a union step BEFORE the existing `proxy:open-session` call (around `orchestrator.ts:742-767`): resolves attached skills via `skills:resolve`, unions `allowedHosts`, merges `credentialBindings` into `requiredCredentials`, and threads the resolved skill list into `sandbox:open-session` so the sandbox plugin can materialize the SKILL.md bodies under `$CLAUDE_CONFIG_DIR/skills/<id>/` before the runner spawns.
- `@ax/sandbox-subprocess` and `@ax/sandbox-k8s` accept an optional `installedSkills` field on the `sandbox:open-session` input and write each skill to disk + chmod 0555 the parent dir AFTER all writes complete. The Phase 0 `CLAUDE_CONFIG_DIR=$HOME/.ax/session` env + skills-dir scaffold are already in place from PR #95.
- `@ax/validator-skill` extends its existing `workspace:pre-apply` subscriber with a new `parseFrontmatterWithCapabilities` helper that recognizes the `capabilities` block. Workspace-authored SKILL.md → block is parsed and STRIPPED with a warning (agent cannot self-grant capabilities); installed-side parsing (called by `skills:upsert`) HONORS the block.
- Channel-web admin UI gains `/admin/skills` (Skills tab using existing shadcn primitives: `Card`, `Table`, `Dialog`, `FieldGroup`, `Alert`, `Textarea`) and an agent-edit Skills section reusing the existing credential-picker.

**Tech stack:** TypeScript, vitest, pnpm workspaces, kysely + PostgreSQL (via `@ax/storage-postgres` + `@ax/database-postgres`), zod for HTTP-body validation, js-yaml safe schema for frontmatter, React + shadcn primitives (`@ax/channel-web`), kind cluster for k8s-side acceptance.

**Spec:** `docs/plans/2026-05-17-skill-install-workflow-design.md`

**Prior PR:** PR #95 (Phase 0) merged 2026-05-18 — `settingSources: ['user', 'project']`, runner-side `CLAUDE_CONFIG_DIR` env forwarding, sandbox plugins scaffold an empty `$CLAUDE_CONFIG_DIR/skills/` and the `.claude/skills → .ax/skills` workspace symlink. Phase 1 fills the now-empty `$CLAUDE_CONFIG_DIR/skills/` at session-open.

---

## Open-question resolutions (folded into this plan)

1. **System-prompt fold vs SDK auto-discovery.** Phase 1 ships **SDK-only**. The SDK already indexes each skill's frontmatter `description` into the system prompt at startup, and the model invokes the built-in `Skill` tool to load bodies on demand. We do NOT also fold skill bodies into `system-prompt:augment` contributions. If the canary or MANUAL-ACCEPTANCE shows the model failing to invoke a skill it would have used with body-in-context, that becomes a Phase 1 follow-up — not in scope here.
2. **`capabilities.mcpServers`.** Still **forbidden** in v1. The validator rejects manifests that include any key named `mcpServers` under `capabilities`, with a "deferred to follow-up" error. MCP-skill bundling lives behind a later milestone.
3. **Slot-name collision handling.** **Loud at attach time** (admin-route validation rejects an attach that would collide with an existing slot on the same agent — across the new skill, already-attached skills, AND `agent.requiredCredentials`). Session-open keeps the same check as a **safety net** for stale data (e.g., a credentials record renamed by hand on the DB). The session-open path surfaces `skill-slot-collision` as a structured termination outcome, exactly as the design doc specifies.

---

## Phase 1 invariants (folded into the PR description)

These are the failure modes Phase 1 must not introduce. Each is a test target in the tasks below.

- **I-P1-1** — Manifest validator is hardened. Schema validation runs on every `skills:upsert`. Inline-secret rejection: any field at any depth named `apiKey`/`token`/`password`/`secret` rejects with code `'inline-secret-forbidden'`. The reserved `capabilities.mcpServers` key rejects with code `'capability-deferred'`. `allowedHosts` entries reject schemes, paths, wildcards (`*`), and IP literals. Slot names enforce `/^[A-Z][A-Z0-9_]{0,63}$/` and are unique within a manifest. `kind` is restricted to the v1 enum `{'api-key'}`. Caught at admin route (4xx) BEFORE any DB write.
- **I-P1-2** — Workspace SKILL.md `capabilities` block is **strip-and-warn**, never **honor**. Agent-authored writes through `workspace:pre-apply` cannot grant the agent new hosts or credentials. The veto for protected SDK-config paths from Phase 0 (PR #95) continues to fire unchanged.
- **I-P1-3** — Installed-skill SKILL.md bodies materialize under `$CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md` with the parent skills-dir chmod'd to **0555 AFTER** all files are written. Agent has no path through `workspace:apply` to reach `$HOME`; chmod is the belt against `tool-bash` `chmod`/`rm`. Files written before runner spawn — the SDK's `'user'` discovery sees them at boot.
- **I-P1-4** — Slot-name collision detected at **attach time** AND at **session-open**. Attach-time check covers all already-attached skills + `agent.requiredCredentials`. Session-open check is the safety net for data drift (`skill-slot-collision` termination outcome).
- **I-P1-5** — Orchestrator unions `allowedHosts` (set-dedup) and merges `credentialBindings` (per-slot) into `proxy:open-session`. Three new termination outcomes ride alongside `proxy-not-loaded` / `agent-proxy-config-incomplete`: `skill-binding-missing`, `skill-slot-collision`, `skill-resolve-failed`. Each surfaces via `chat:end` with `kind: 'terminated'`.
- **I-P1-6** — `skills:delete` is blocked when any agent has the skill attached (code `'skill-in-use'`, HTTP 409). Cannot orphan `agent.skillAttachments[].skillId` references. Admin must detach first.
- **I-P1-7** — Half-wired window CLOSED in the same PR. CLI preset + k8s preset both load `@ax/skills`. Canary install→attach→chat passes. MANUAL-ACCEPTANCE.md gains one new bullet covering the workflow.
- **I-P1-8** — One UI design language. Admin UI lives in `packages/channel-web` and composes existing shadcn primitives + semantic tokens (CLAUDE.md invariant #6). No new Vite SPA. No hand-rolled forms. No raw color values.

---

## File map (decomposition lock-in)

### New package — `@ax/skills`

- `packages/skills/package.json`
- `packages/skills/tsconfig.json`
- `packages/skills/src/index.ts` — public re-exports
- `packages/skills/src/plugin.ts` — `createSkillsPlugin`; registers 5 service hooks + 5 admin routes
- `packages/skills/src/manifest.ts` — `parseSkillManifest`, capability schema, slot regex, allowed-host validator, inline-secret rejection
- `packages/skills/src/store.ts` — kysely-backed CRUD on the new `skills_v1_skills` table
- `packages/skills/src/migrations.ts` — `runSkillsMigration` (CREATE TABLE skills_v1_skills)
- `packages/skills/src/admin-routes.ts` — duck-typed HTTP handlers for `/admin/skills[/:id]`
- `packages/skills/src/types.ts` — public hook payload types
- `packages/skills/src/__tests__/manifest.test.ts`
- `packages/skills/src/__tests__/store.test.ts`
- `packages/skills/src/__tests__/plugin.test.ts`
- `packages/skills/src/__tests__/admin-routes.test.ts`
- `packages/skills/src/__tests__/resolve.test.ts`

### New UI components

- `packages/channel-web/src/components/admin/SkillsTab.tsx`
- `packages/channel-web/src/components/admin/SkillEditor.tsx` (left: textarea, right: parsed preview)
- `packages/channel-web/src/components/admin/SkillAttachmentsSection.tsx` (rendered inside `AgentForm.tsx`)
- `packages/channel-web/src/lib/skills.ts` — typed wire client (mirrors `lib/credentials.ts`)
- `packages/channel-web/src/components/admin/__tests__/SkillsTab.test.tsx`
- `packages/channel-web/src/components/admin/__tests__/SkillEditor.test.tsx`
- `packages/channel-web/src/components/admin/__tests__/SkillAttachmentsSection.test.tsx`

### Modified files

- `packages/validator-skill/src/frontmatter.ts` — add `parseFrontmatterCapabilities` (parse-only — does not validate full installed-side schema; that lives in `@ax/skills/manifest.ts`). Existing `parseFrontmatter` is unchanged for name/description.
- `packages/validator-skill/src/plugin.ts` — strip-and-warn on `capabilities` block in workspace SKILL.md writes; fire `skill-capabilities-stripped` event when stripping occurs.
- `packages/agents/src/migrations.ts` — additive `ALTER TABLE agents_v1_agents ADD COLUMN IF NOT EXISTS skill_attachments JSONB NOT NULL DEFAULT '[]'`.
- `packages/agents/src/types.ts` — `Agent` interface gains `skillAttachments: SkillAttachment[]`; new `SkillAttachment` type.
- `packages/agents/src/store.ts` — read/write `skill_attachments` column.
- `packages/agents/src/admin-routes.ts` — new `PATCH /admin/agents/:id/skill-attachments` route; slot-collision validation; new zod schemas.
- `packages/agents/src/plugin.ts` — register new admin route via `http:register-route`.
- `packages/chat-orchestrator/src/orchestrator.ts` — extend `AgentRecord` (duck-typed) with `skillAttachments`; add resolve+union step before `proxy:open-session`; thread `installedSkills` through `sandbox:open-session`; add the three new termination outcomes.
- `packages/sandbox-subprocess/src/open-session.ts` — accept `installedSkills` on input; write each skill file under `installedSkillsDir`; chmod 0555 the dir after all writes.
- `packages/sandbox-subprocess/src/types.ts` (or wherever `OpenSessionInput` lives) — add `installedSkills?: InstalledSkill[]`.
- `packages/sandbox-k8s/src/open-session.ts` — same `installedSkills` plumbing; init-container reused from Phase 0, but the main-container's pre-spawn step writes the files (the init container only created the empty dir).
- `packages/channel-web/src/lib/admin.ts` — add `'skills'` to `AdminView` union.
- `packages/channel-web/src/components/admin/AdminPanel.tsx` (or `AdminShell.tsx` depending on current layout — verify in Phase 1.6) — render `<SkillsTab />` when view === 'skills'.
- `packages/channel-web/src/components/admin/AgentForm.tsx` — embed `<SkillAttachmentsSection />` between the existing Tools and Allowed-Hosts sections.
- `packages/cli/src/main.ts` — load `@ax/skills` before `@ax/agents`.
- `presets/k8s/src/index.ts` — load `@ax/skills` before `@ax/agents`; surface no new env vars (admin route is always-on; same pattern as `@ax/agents` admin routes).
- `presets/k8s/src/__tests__/preset.test.ts` — extend the load-list assertion with `@ax/skills`.
- `presets/k8s/src/__tests__/acceptance.test.ts` — add `@ax/skills` to the canary's load path; if a `PLUGINS_TO_DROP` list exists for infra-stripping, do NOT add it there (see `feedback_preset_drop_vs_load_lists`).
- `deploy/MANUAL-ACCEPTANCE.md` — add one new bullet for the install→attach→chat→GitHub workflow.
- `packages/test-harness/src/canary/` (or wherever the existing canary lives) — extend with the install-skill→attach→chat scenario.

### Reference files (READ ONLY — code we touch indirectly)

- `packages/credential-proxy/src/listener.ts` — per-session allowlist + MITM substitution; unchanged in Phase 1.
- `packages/credentials-admin-routes/src/admin-routes.ts` — pattern reference for HTTP route shape (duck-typed Request/Response, zod-validated body, 64 KiB cap).
- `packages/credentials-admin-routes/src/plugin.ts` — pattern reference for plugin registration.
- `packages/agents/src/admin-routes.ts:1-120` — pattern reference for zod schemas + auth gate.

---

## PHASE 1.1 — `@ax/skills` manifest + validator extensions

**Outcome:** A new `@ax/skills` package exists with `parseSkillManifest()` and the validator-skill plugin strips `capabilities` blocks from agent-authored SKILL.md writes. No DB, no HTTP yet — pure logic, all unit-tested. The shape of the manifest is locked.

**PR-internal scope:** ~6 commits.

### Task 1.1.1: Scaffold the `@ax/skills` package

**Files:**
- Create: `packages/skills/package.json`
- Create: `packages/skills/tsconfig.json`
- Create: `packages/skills/src/index.ts`
- Create: `packages/skills/src/types.ts`

- [ ] **Step 1: Create the package skeleton.**

Write `packages/skills/package.json`:

```json
{
  "name": "@ax/skills",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "lint": "eslint src --max-warnings 0"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "js-yaml": "^4.1.0",
    "kysely": "^0.27.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20",
    "vitest": "^1"
  }
}
```

(Match the exact versions any other recent plugin in `packages/` uses. Verify by reading `packages/agents/package.json` and matching js-yaml/zod/kysely versions.)

Write `packages/skills/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../core" }
  ]
}
```

(Verify `tsconfig.base.json` path against any other plugin; copy whatever shape it uses.)

Create empty `packages/skills/src/index.ts`:

```ts
// Public surface for @ax/skills. Filled in by later tasks.
export {};
```

Create `packages/skills/src/types.ts`:

```ts
/**
 * @ax/skills public hook payload types.
 *
 * Inter-plugin API. A future @ax/skills-fs (file-backed impl) would
 * register the same `skills:*` service hooks with these exact shapes —
 * no field here mentions postgres, rows, or any storage detail.
 */

export interface CapabilitySlot {
  slot: string;
  kind: 'api-key';
  description?: string;
}

export interface SkillCapabilities {
  allowedHosts: string[];
  credentials: CapabilitySlot[];
}

export interface SkillSummary {
  id: string;
  description: string;
  version: number;
  capabilities: SkillCapabilities;
  updatedAt: string;
}

export interface SkillDetail extends SkillSummary {
  bodyMd: string;
  manifestYaml: string;
}

export interface ResolvedSkill {
  id: string;
  capabilities: SkillCapabilities;
  bodyMd: string;
  manifestYaml: string;
}

export type SkillsListInput = Record<string, never>;
export interface SkillsListOutput {
  skills: SkillSummary[];
}

export interface SkillsGetInput {
  skillId: string;
}
export type SkillsGetOutput = SkillDetail;

export interface SkillsUpsertInput {
  manifestYaml: string;
  bodyMd: string;
}
export interface SkillsUpsertOutput {
  skillId: string;
  created: boolean;
}

export interface SkillsDeleteInput {
  skillId: string;
}
export type SkillsDeleteOutput = Record<string, never>;

export interface SkillsResolveInput {
  skillIds: string[];
}
export interface SkillsResolveOutput {
  skills: ResolvedSkill[];
}
```

- [ ] **Step 2: Verify pnpm workspace globs the new package.**

The workspace already globs `packages/*`. Verify:

```
grep -A2 packages /Users/vpulim/dev/ai/ax-next/pnpm-workspace.yaml
```

Expected: a `'packages/*'` line. If absent, add it.

- [ ] **Step 3: Add to root tsconfig project references.**

Inspect the root tsconfig for a `references` list. If present, append:

```json
    { "path": "./packages/skills" },
```

- [ ] **Step 4: Verify the package builds (it's empty, should be trivial).**

```
pnpm install
pnpm --filter @ax/skills build
```

Expected: clean.

- [ ] **Step 5: Commit.**

```
git add packages/skills tsconfig.json pnpm-workspace.yaml
git commit -m "feat(skills): scaffold @ax/skills package skeleton"
```

---

### Task 1.1.2: Manifest parser + capability schema

**Files:**
- Create: `packages/skills/src/manifest.ts`
- Create: `packages/skills/src/__tests__/manifest.test.ts`

- [ ] **Step 1: Write the failing tests.**

Create `packages/skills/src/__tests__/manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSkillManifest } from '../manifest.js';

const SAMPLE_OK = `name: github
description: Access the GitHub REST API with a personal access token.
version: 1
capabilities:
  allowedHosts:
    - api.github.com
  credentials:
    - slot: GITHUB_TOKEN
      kind: api-key
      description: GitHub PAT.
`;

describe('parseSkillManifest', () => {
  it('accepts a well-formed manifest', () => {
    const r = parseSkillManifest(SAMPLE_OK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('github');
    expect(r.value.description).toMatch(/GitHub/);
    expect(r.value.version).toBe(1);
    expect(r.value.capabilities.allowedHosts).toEqual(['api.github.com']);
    expect(r.value.capabilities.credentials).toEqual([
      { slot: 'GITHUB_TOKEN', kind: 'api-key', description: 'GitHub PAT.' },
    ]);
  });

  it('defaults version to 0 when absent', () => {
    const r = parseSkillManifest(`name: x\ndescription: x desc`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.version).toBe(0);
  });

  it('rejects name not matching kebab-case-ish regex', () => {
    for (const bad of ['GitHub', '_github', '0github', 'a'.repeat(65)]) {
      const r = parseSkillManifest(`name: ${bad}\ndescription: x`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid-name');
    }
  });

  it('rejects description over 240 chars', () => {
    const r = parseSkillManifest(`name: ok\ndescription: ${'x'.repeat(241)}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-description');
  });

  it('rejects allowedHosts with scheme / path / wildcard / IP literal', () => {
    for (const bad of [
      'https://api.github.com',
      'api.github.com/foo',
      '*.github.com',
      '192.168.1.1',
    ]) {
      const r = parseSkillManifest(
        `name: x\ndescription: x\ncapabilities:\n  allowedHosts: [${bad}]\n  credentials: []`,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid-host');
    }
  });

  it('deduplicates allowedHosts', () => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  allowedHosts: [a.example.com, a.example.com]\n  credentials: []`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.capabilities.allowedHosts).toEqual(['a.example.com']);
  });

  it('rejects slot name that is not SCREAMING_SNAKE_CASE', () => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  credentials:\n    - slot: github_token\n      kind: api-key`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-slot');
  });

  it('rejects duplicate slot names within a manifest', () => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  credentials:\n    - slot: A\n      kind: api-key\n    - slot: A\n      kind: api-key`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('duplicate-slot');
  });

  it('rejects unknown kind enum value', () => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  credentials:\n    - slot: A\n      kind: oauth`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-kind');
  });

  it('rejects inline secret fields at top level', () => {
    for (const key of ['apiKey', 'token', 'password', 'secret']) {
      const r = parseSkillManifest(`name: x\ndescription: x\n${key}: hunter2`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('inline-secret-forbidden');
    }
  });

  it('rejects inline secret fields nested inside capabilities', () => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  apiKey: hunter2\n  credentials: []`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('inline-secret-forbidden');
  });

  it('rejects reserved capabilities.mcpServers', () => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  mcpServers:\n    - name: foo`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('capability-deferred');
  });

  it('rejects malformed YAML (loud, not silent)', () => {
    const r = parseSkillManifest(`name: x\n  description: bad indent`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-yaml');
  });
});
```

- [ ] **Step 2: Run tests — expect failures.**

```
pnpm --filter @ax/skills test manifest.test
```

Expected: every test fails with `parseSkillManifest is not exported`.

- [ ] **Step 3: Implement the parser.**

Create `packages/skills/src/manifest.ts` with `parseSkillManifest(yaml: string): ParseResult`. The function:

1. Calls `yamlLoad(text)` (js-yaml safe schema). On `YAMLException` → `{ ok: false, code: 'invalid-yaml', message }`.
2. Rejects if parsed is not a plain mapping object.
3. Recursively walks the parsed tree rejecting any key in `{'apiKey', 'token', 'password', 'secret'}` at any depth → `inline-secret-forbidden`.
4. Validates `name` against `/^[a-z][a-z0-9-]{0,63}$/` → `invalid-name`.
5. Validates `description` is a non-empty string ≤ 240 chars → `invalid-description`.
6. If `version` present, must be a non-negative integer → `invalid-version`. Default 0.
7. If `capabilities.mcpServers` present → `capability-deferred`.
8. For each `capabilities.allowedHosts` entry: must match a hostname regex (`/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/`), NOT match IPv4 (`/^\d{1,3}(\.\d{1,3}){3}$/`), must not contain `*`. Dedupe via Set. Errors → `invalid-host`.
9. For each `capabilities.credentials` entry: `slot` matches `/^[A-Z][A-Z0-9_]{0,63}$/` (`invalid-slot`), unique within the manifest (`duplicate-slot`), `kind === 'api-key'` (`invalid-kind`), optional string `description`.
10. Returns `{ ok: true, value: { id: name, description, version, capabilities: { allowedHosts, credentials } } }`.

The `ParseResult` is a discriminated union of `{ ok: true; value: ParsedManifest }` vs `{ ok: false; code: ManifestCode; message: string }`.

- [ ] **Step 4: Run tests — expect pass.**

- [ ] **Step 5: Build + lint.**

```
pnpm --filter @ax/skills build && pnpm --filter @ax/skills lint
```

- [ ] **Step 6: Commit.**

```
git add packages/skills/src/manifest.ts packages/skills/src/__tests__/manifest.test.ts
git commit -m "feat(skills): parseSkillManifest with hardened capability schema (I-P1-1)"
```

---

### Task 1.1.3: Extend `@ax/validator-skill` to strip workspace `capabilities` blocks

**Files:**
- Modify: `packages/validator-skill/src/frontmatter.ts`
- Modify: `packages/validator-skill/src/plugin.ts`
- Test: `packages/validator-skill/src/__tests__/frontmatter.test.ts` (or wherever existing tests live)
- Test: `packages/validator-skill/src/__tests__/plugin.test.ts`

**Critical pre-implementation step:** Before writing any code, READ `packages/core/src/...` to understand whether `workspace:pre-apply` supports **rewriting** the `FileChange[]` or only **vetoing** it. The plan below assumes rewrite is supported; if not, fall back to **veto** with a reject reason of "SKILL.md cannot declare capabilities; that block is host-only" — equally safe, simpler to implement.

- [ ] **Step 1: Inspect the pre-apply contract.**

```
grep -rn "workspace:pre-apply\|PreApplyPayload\|rewriteChanges" packages/core/src/
```

Note the return-type shape of pre-apply handlers. Decide: rewrite-supported → strip-and-warn. Not supported → veto-with-reason.

- [ ] **Step 2: Write the failing tests.**

Append to `packages/validator-skill/src/__tests__/frontmatter.test.ts`:

```ts
import { stripCapabilitiesFromFrontmatter } from '../frontmatter.js';

describe('stripCapabilitiesFromFrontmatter', () => {
  it('returns the original text unchanged when no capabilities block is present', () => {
    const src = '---\nname: foo\ndescription: bar\n---\nbody';
    const r = stripCapabilitiesFromFrontmatter(src);
    expect(r.stripped).toBe(false);
    expect(r.text).toBe(src);
  });

  it('strips the capabilities block and returns stripped=true', () => {
    const src =
      '---\n' +
      'name: foo\n' +
      'description: bar\n' +
      'capabilities:\n' +
      '  allowedHosts: [api.example.com]\n' +
      '---\n' +
      'body';
    const r = stripCapabilitiesFromFrontmatter(src);
    expect(r.stripped).toBe(true);
    expect(r.text).not.toMatch(/capabilities/);
    expect(r.text).toMatch(/name: foo/);
    expect(r.text).toMatch(/description: bar/);
    expect(r.text).toMatch(/body/);
  });

  it('returns ok:false when the source has no frontmatter fence', () => {
    const r = stripCapabilitiesFromFrontmatter('no fence here');
    expect(r.stripped).toBe(false);
    expect(r.text).toBe('no fence here');
  });
});
```

In `packages/validator-skill/src/__tests__/plugin.test.ts`, append (use whichever return-shape the pre-apply contract supports):

```ts
it('strip path: handles workspace SKILL.md with capabilities block', async () => {
  const src =
    '---\nname: x\ndescription: y\ncapabilities:\n  allowedHosts: [a.example.com]\n---\nbody';
  const decision = await runValidator({
    changes: [
      { kind: 'put', path: '.ax/skills/x/SKILL.md', content: new TextEncoder().encode(src) },
    ],
  });
  // EITHER (rewrite supported): decision.rewriteChanges[0] contains stripped text
  // OR (veto-only): decision is a reject with reason mentioning "capabilities"
});
```

- [ ] **Step 3: Run tests — expect failures.**

- [ ] **Step 4: Implement `stripCapabilitiesFromFrontmatter` in `frontmatter.ts`.**

The pure function:
1. Match the `FRONTMATTER_FENCE` regex (already in the file).
2. `yamlLoad` the inner block (safe schema).
3. If not an object or `capabilities` key absent → return `{ text, stripped: false }`.
4. `delete obj.capabilities`.
5. Re-serialize via `yamlDump(obj)` (add `dump` to the js-yaml import at the top of the file).
6. Re-fence: `'---\n' + serialized + '---\n' + textAfterFence`.

Wire it into `plugin.ts`'s `workspace:pre-apply` handler: after the existing SKILL_PATH match, decode the bytes, call the strip helper, fire a `skills:capabilities-stripped` event when stripping occurred, and either rewrite the change content (rewrite-supported path) or veto with a clear reason (veto-only fallback path).

- [ ] **Step 5: Run tests — expect pass.**

- [ ] **Step 6: Build + lint.**

```
pnpm build && pnpm lint
```

- [ ] **Step 7: Commit.**

```
git add packages/validator-skill/src/frontmatter.ts \
        packages/validator-skill/src/plugin.ts \
        packages/validator-skill/src/__tests__/
git commit -m "feat(validator-skill): strip capabilities from workspace SKILL.md (I-P1-2)"
```

---

## PHASE 1.2 — Skills storage + service hooks

**Outcome:** `@ax/skills` plugin loads, runs the migration, and registers five service hooks (`skills:list / :get / :upsert / :delete / :resolve`). Storage is DB-backed via the existing `database:get-instance` hook. No HTTP yet.

**PR-internal scope:** ~5 commits.

### Task 1.2.1: Migration — create `skills_v1_skills` table

**Files:**
- Create: `packages/skills/src/migrations.ts`
- Create: `packages/skills/src/__tests__/migrations.test.ts`

**Critical pre-implementation step:** Other plugins in this repo use postgres-only DDL (see `packages/agents/src/migrations.ts` — `JSONB`, `TIMESTAMPTZ`). A pure-sqlite test path may not exist. READ `packages/agents/src/__tests__/migrations.test.ts` first to see whether tests use a real postgres / testcontainer / in-memory shim, and match that pattern.

- [ ] **Step 1: Write the failing test.**

Pattern this on the existing agents migration test. Assertions:
1. After `runSkillsMigration(db)`, the `skills_v1_skills` table exists.
2. Columns: `skill_id`, `description`, `manifest_yaml`, `body_md`, `version`, `created_at`, `updated_at`.
3. Running migration twice is idempotent.

- [ ] **Step 2: Run — expect failure (export missing).**

- [ ] **Step 3: Implement.**

`packages/skills/src/migrations.ts`:

```ts
import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/skills owns the `skills_v1_skills` table —
 * never reach in from another plugin (Invariant I4). Forward-only via
 * a future v2 side table; never in-place ALTER for shape changes.
 */
export async function runSkillsMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_skills (
      skill_id      TEXT PRIMARY KEY,
      description   TEXT NOT NULL,
      manifest_yaml TEXT NOT NULL,
      body_md       TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
}

export interface SkillsRow {
  skill_id: string;
  description: string;
  manifest_yaml: string;
  body_md: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface SkillsDatabase {
  skills_v1_skills: SkillsRow;
}
```

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit.**

```
git add packages/skills/src/migrations.ts packages/skills/src/__tests__/migrations.test.ts
git commit -m "feat(skills): skills_v1_skills migration"
```

---

### Task 1.2.2: Store implementation (CRUD)

**Files:**
- Create: `packages/skills/src/store.ts`
- Create: `packages/skills/src/__tests__/store.test.ts`

- [ ] **Step 1: Write failing tests** covering each store method:

1. `upsert` of a new skill returns `{ created: true }`.
2. `upsert` of an existing skill (same id) returns `{ created: false }` and updates the row.
3. `list()` returns summary records for all skills, ordered by skill_id.
4. `get(id)` returns the full detail or `null`.
5. `delete(id)` removes the row.
6. `resolve(['missing', 'a', 'also-missing'])` returns ONLY the existing skill, with body and capabilities populated from re-parsing the stored manifest yaml.

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Implement.**

`packages/skills/src/store.ts` exports `createSkillsStore(db)` returning an object with methods `list`, `get`, `upsert`, `delete`, `resolve`. Key design choices:

- **Capabilities are re-parsed from `manifest_yaml` on every read path** (not denormalized into separate columns). The hot path is `list()` which parses N manifests; for v1's expected admin-managed skill counts (~10s), that's fine. If profiling later shows it's an issue, denormalize `allowedHosts` and `credentials` into JSONB columns in a v2 migration.
- **`upsert` does a SELECT-then-INSERT-or-UPDATE round-trip** rather than `ON CONFLICT DO UPDATE`, so we can report `created` accurately. The race window (two admins upserting the same id at the same instant) is acceptable for v1; postgres-level uniqueness is enforced by the PRIMARY KEY constraint.
- **`resolve` preserves input order, drops unknown ids silently.** A deleted-skill-still-attached state must not block session-open (the design doc specifies this); the silent-drop policy lives here.

The capability-re-parse uses `parseSkillManifest` from `./manifest.js`. On parse failure (stored manifest somehow malformed), default to `{ allowedHosts: [], credentials: [] }` — defensive, doesn't crash list.

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit.**

```
git add packages/skills/src/store.ts packages/skills/src/__tests__/store.test.ts
git commit -m "feat(skills): SkillsStore CRUD (upsert/get/list/delete/resolve)"
```

---

### Task 1.2.3: Plugin — register service hooks

**Files:**
- Create: `packages/skills/src/plugin.ts`
- Create: `packages/skills/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write failing tests.**

Use whichever in-memory storage+db plugins the project already uses in tests. Read `packages/agents/src/__tests__/plugin.test.ts` for the exact bootstrap pattern.

Test cases:
1. `skills:upsert` of well-formed manifest → returns `{ skillId, created: true }`.
2. Second upsert with same name → `created: false` and stored body updated.
3. Upsert of malformed manifest → throws `PluginError` with one of the manifest codes.
4. `skills:list` returns the upserted skill with its capabilities.
5. `skills:get` returns full detail.
6. `skills:get` of nonexistent id throws `PluginError` with code `skill-not-found`.
7. `skills:resolve(['missing', 'github'])` returns ONLY github, preserves order.
8. `skills:delete` of an existing skill removes it; subsequent `:get` throws.

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Implement.**

`createSkillsPlugin()` returns a `Plugin` whose `init({bus})`:

1. Calls `database:get-instance` to get the kysely handle.
2. Runs the migration.
3. Builds a `SkillsStore` instance.
4. Registers the five service hooks:

```ts
bus.register<SkillsListInput, SkillsListOutput>('skills:list', PLUGIN_NAME, async () => ({
  skills: await store.list(),
}));

bus.register<SkillsGetInput, SkillsGetOutput>('skills:get', PLUGIN_NAME, async (_ctx, input) => {
  const found = await store.get(input.skillId);
  if (!found) throw new PluginError({ code: 'skill-not-found', plugin: PLUGIN_NAME, message: `skill '${input.skillId}' does not exist` });
  return found;
});

bus.register<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', PLUGIN_NAME, async (_ctx, input) => {
  const parsed = parseSkillManifest(input.manifestYaml);
  if (!parsed.ok) {
    throw new PluginError({ code: parsed.code, plugin: PLUGIN_NAME, message: parsed.message });
  }
  if (typeof input.bodyMd !== 'string') {
    throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message: 'bodyMd must be a string' });
  }
  const r = await store.upsert({
    id: parsed.value.id,
    description: parsed.value.description,
    manifestYaml: input.manifestYaml,
    bodyMd: input.bodyMd,
    version: parsed.value.version,
    capabilities: parsed.value.capabilities,
  });
  return { skillId: parsed.value.id, created: r.created };
});

bus.register<SkillsDeleteInput, SkillsDeleteOutput>('skills:delete', PLUGIN_NAME, async (ctx, input) => {
  // I-P1-6: refuse delete when any agent has the skill attached.
  // The check is structural (bus.hasService) so this plugin doesn't form
  // a hard dep on @ax/agents — useful for stripped presets.
  if (bus.hasService('agents:any-attached-to-skill')) {
    const { attached } = await bus.call<{ skillId: string }, { attached: boolean }>(
      'agents:any-attached-to-skill', ctx, { skillId: input.skillId },
    );
    if (attached) {
      throw new PluginError({
        code: 'skill-in-use', plugin: PLUGIN_NAME,
        message: `skill '${input.skillId}' is attached to one or more agents — detach first`,
      });
    }
  }
  await store.delete(input.skillId);
  return {};
});

bus.register<SkillsResolveInput, SkillsResolveOutput>('skills:resolve', PLUGIN_NAME, async (_ctx, input) => ({
  skills: await store.resolve(input.skillIds),
}));
```

Manifest must declare `registers: ['skills:list', 'skills:get', 'skills:upsert', 'skills:delete', 'skills:resolve']` and `calls: ['database:get-instance']`.

(NOTE: the `agents:any-attached-to-skill` service is added in Task 1.4.2. Until that ships in the same PR, the structural `hasService` check no-ops; the canary in Phase 1.7 verifies the end-to-end protection.)

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit.**

```
git add packages/skills/src/plugin.ts packages/skills/src/__tests__/plugin.test.ts
git commit -m "feat(skills): plugin registers 5 service hooks (list/get/upsert/delete/resolve)"
```

---

## PHASE 1.3 — Admin HTTP routes

**Outcome:** `/admin/skills*` is reachable. Admin can POST/PUT a full SKILL.md, GET the list, GET one, DELETE one. CSRF + admin gate same as `/admin/credentials`. Body-cap 64 KiB. Zod-validated.

**PR-internal scope:** ~3 commits.

### Task 1.3.1: Admin routes + zod schemas

**Files:**
- Create: `packages/skills/src/admin-routes.ts`
- Create: `packages/skills/src/__tests__/admin-routes.test.ts`

**Pattern reference:** `packages/credentials-admin-routes/src/admin-routes.ts`. Read it BEFORE writing this file — duck-typed Request/Response surface, 64 KiB body cap, zod-validated payloads, PluginError → HTTP-status mapping. Match exactly.

- [ ] **Step 1: Locate shared helpers.**

```
grep -rn "requireAdmin\|verifyCsrf\|signedCookie" packages/credentials-admin-routes/src/
```

Identify the auth + CSRF helpers. If they're exported, import. If not (per the existing no-cross-plugin-imports policy), copy-paste into `@ax/skills/src/admin-routes.ts` — same surface, no cross-plugin import.

- [ ] **Step 2: Write failing tests.**

Mirror `packages/credentials-admin-routes/src/__tests__/admin-routes.test.ts`. Coverage:

1. `POST /admin/skills` with valid manifest → 201, returns `{ skillId, created: true }`.
2. `POST /admin/skills` with malformed manifest yaml → 400 with parse-error message.
3. `POST /admin/skills` with manifest containing `apiKey: foo` → 400, code `inline-secret-forbidden`.
4. `POST /admin/skills` with manifest containing `capabilities.mcpServers` → 400, code `capability-deferred`.
5. `PUT /admin/skills/:id` with new body → 200, content updated.
6. `GET /admin/skills` → returns list of summary records.
7. `GET /admin/skills/:id` → returns full detail.
8. `GET /admin/skills/nonexistent` → 404.
9. `DELETE /admin/skills/:id` (no attachments) → 204.
10. `DELETE /admin/skills/:id` (attachments exist — wire a stub `agents:any-attached-to-skill` returning `{ attached: true }`) → 409 with code `skill-in-use`.
11. Body over 64 KiB → 413.
12. Non-admin session → 403.
13. Missing auth cookie → 401.
14. Missing/bad CSRF token on POST/PUT/DELETE → 403.

- [ ] **Step 3: Implement.**

`packages/skills/src/admin-routes.ts` exports `registerAdminSkillsRoutes(bus): Array<() => void>` (returns unregister callbacks). The route table:

| Method | Path | Auth | Body | Response |
|--------|------|------|------|----------|
| GET | `/admin/skills` | admin | — | `{ skills: SkillSummary[] }` |
| GET | `/admin/skills/:id` | admin | — | `SkillDetail` |
| POST | `/admin/skills` | admin | `{ skillMd: string }` | `{ skillId, created }` (201 or 200) |
| PUT | `/admin/skills/:id` | admin | `{ skillMd: string }` | `{ skillId, created }` |
| DELETE | `/admin/skills/:id` | admin | — | `204` or `409` |

The POST/PUT handler splits `skillMd` at the second `---\n` boundary into `manifestYaml` + `bodyMd`, then calls `skills:upsert`. The split helper returns null on shape mismatch; null → 400 "missing frontmatter fence".

PluginError → HTTP mapping:

```
'skill-not-found'                  → 404
'skill-in-use'                     → 409
'invalid-name' / 'invalid-description' / 'invalid-host' / 'invalid-slot' /
'duplicate-slot' / 'invalid-kind' / 'invalid-yaml' / 'invalid-shape' /
'invalid-version' / 'inline-secret-forbidden' / 'capability-deferred' → 400 (with the error message)
default                            → 500
```

Each route handler follows the `try { admin gate -> csrf -> size -> zod -> bus.call -> catch (PluginError) -> map status } catch` pattern in `credentials-admin-routes/src/admin-routes.ts`.

- [ ] **Step 4: Wire the routes into the plugin's `init`.**

In `packages/skills/src/plugin.ts`, extend the manifest:

```ts
calls: ['database:get-instance', 'http:register-route', 'auth:require-user'],
```

…and in `init`, after the service-hook registrations:

```ts
const unregisterRoutes = registerAdminSkillsRoutes(bus);
```

Store the unregister callbacks and call them from `shutdown()`.

- [ ] **Step 5: Run tests + build + lint.**

- [ ] **Step 6: Commit.**

```
git add packages/skills/src/admin-routes.ts \
        packages/skills/src/plugin.ts \
        packages/skills/src/__tests__/admin-routes.test.ts
git commit -m "feat(skills): /admin/skills HTTP CRUD"
```

---

### Task 1.3.2: Wire client in channel-web

**Files:**
- Create: `packages/channel-web/src/lib/skills.ts`

- [ ] **Step 1: Mirror `packages/channel-web/src/lib/credentials.ts`.**

Read it first. Match the CSRF cookie name + header name. The new file exports `listSkills`, `getSkill`, `upsertSkill`, `updateSkill`, `deleteSkill` — each is a small `fetch` wrapper that:

1. Sends `credentials: 'same-origin'`.
2. For mutating methods, includes the CSRF header.
3. Throws on non-2xx with the status text + body excerpt.
4. Parses JSON on 2xx responses (returns `undefined` on 204).

Return types come from `@ax/skills` types module (`SkillSummary`, `SkillDetail`).

- [ ] **Step 2: Build + lint.**

- [ ] **Step 3: Commit.**

```
git add packages/channel-web/src/lib/skills.ts \
        packages/channel-web/package.json
git commit -m "feat(channel-web): typed wire client for /admin/skills"
```

(Don't forget to add `@ax/skills: workspace:*` to `packages/channel-web/package.json` so the type import resolves.)

---

## PHASE 1.4 — `@ax/agents` extension: `skillAttachments`

**Outcome:** Agent records carry `skillAttachments` (additive column + service-hook payload). Admin route `PATCH /admin/agents/:id/skill-attachments` validates with slot-collision checks AT ATTACH TIME (I-P1-4). `agents:any-attached-to-skill` service hook supports the delete-blocker (I-P1-6).

**PR-internal scope:** ~4 commits.

### Task 1.4.1: Migration + type extension

**Files:**
- Modify: `packages/agents/src/migrations.ts`
- Modify: `packages/agents/src/types.ts`
- Modify: `packages/agents/src/store.ts`
- Test: `packages/agents/src/__tests__/migrations.test.ts`

- [ ] **Step 1: Write the failing test.**

In `migrations.test.ts`, add an assertion that the `skill_attachments` column exists with the right JSONB type after `runAgentsMigration(db)`.

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Append the additive ALTER to `runAgentsMigration`.**

```ts
await sql`
  ALTER TABLE agents_v1_agents
    ADD COLUMN IF NOT EXISTS skill_attachments JSONB NOT NULL DEFAULT '[]'
`.execute(db);
```

…and extend `AgentsRow`:

```ts
export interface AgentsRow {
  // ...existing fields...
  skill_attachments: unknown; // JSONB; validated by store
}
```

- [ ] **Step 4: Extend the `Agent` type in `types.ts`.**

```ts
export interface SkillAttachment {
  skillId: string;
  credentialBindings: Record<string /* slot */, string /* credential ref */>;
}

export interface Agent {
  // ...existing fields...
  skillAttachments: SkillAttachment[];
}
```

- [ ] **Step 5: Read+write the column in `store.ts`.**

In the row-to-Agent mapper:

```ts
const skillAttachments = Array.isArray(row.skill_attachments)
  ? (row.skill_attachments as SkillAttachment[])
  : [];
return {
  // ...existing fields...
  skillAttachments,
};
```

In insert/update paths, marshal `skillAttachments ?? []` to JSONB:

```ts
skill_attachments: sql`${JSON.stringify(input.skillAttachments ?? [])}::jsonb` as never,
```

- [ ] **Step 6: Run — expect pass.**

- [ ] **Step 7: Audit `AgentRecord` literal constructions.**

```
grep -rn "AgentRecord\b" packages/
```

Update each test fixture that constructs an `AgentRecord` literal to default `skillAttachments: []` so adding the required field doesn't break existing tests.

- [ ] **Step 8: Commit.**

```
git add packages/agents/src/migrations.ts packages/agents/src/types.ts \
        packages/agents/src/store.ts packages/agents/src/__tests__/migrations.test.ts
git commit -m "feat(agents): additive skill_attachments column + Agent.skillAttachments"
```

---

### Task 1.4.2: New service hook — `agents:any-attached-to-skill`

**Files:**
- Modify: `packages/agents/src/plugin.ts`
- Modify: `packages/agents/src/store.ts`
- Test: `packages/agents/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
it('agents:any-attached-to-skill returns true when at least one agent has the skill', async () => {
  // seed: create an agent with skillAttachments: [{ skillId: 'github', credentialBindings: {} }]
  const r = await bus.call('agents:any-attached-to-skill', adminCtx, { skillId: 'github' });
  expect(r).toEqual({ attached: true });
});

it('returns false when no agent has it', async () => {
  const r = await bus.call('agents:any-attached-to-skill', adminCtx, { skillId: 'nope' });
  expect(r).toEqual({ attached: false });
});
```

- [ ] **Step 2: Implement.**

`store.ts` gains:

```ts
async function anyAttachedToSkill(skillId: string): Promise<boolean> {
  // JSONB containment: array contains an object with the given skillId.
  const row = await db
    .selectFrom('agents_v1_agents')
    .select(sql<number>`1`.as('one'))
    .where(sql`skill_attachments @> ${JSON.stringify([{ skillId }])}::jsonb`)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}
```

`plugin.ts` registers the hook:

```ts
manifest: {
  // ...
  registers: [
    // ...existing...
    'agents:any-attached-to-skill',
  ],
},
init({ bus }) {
  // ...existing registrations...
  bus.register<{ skillId: string }, { attached: boolean }>(
    'agents:any-attached-to-skill',
    PLUGIN_NAME,
    async (_ctx, input) => ({ attached: await store.anyAttachedToSkill(input.skillId) }),
  );
},
```

- [ ] **Step 3: Run — expect pass.**

- [ ] **Step 4: Commit.**

```
git add packages/agents/src/store.ts packages/agents/src/plugin.ts \
        packages/agents/src/__tests__/plugin.test.ts
git commit -m "feat(agents): agents:any-attached-to-skill service hook (I-P1-6)"
```

---

### Task 1.4.3: Admin route — `PATCH /admin/agents/:id/skill-attachments`

**Files:**
- Modify: `packages/agents/src/admin-routes.ts`
- Test: `packages/agents/src/__tests__/admin-routes.test.ts`

This route handles attach-time slot-collision detection (I-P1-4).

- [ ] **Step 1: Write failing tests.**

1. `PATCH /admin/agents/:id/skill-attachments` with valid attachments → 200, agent updated.
2. Attach two skills declaring the same slot → 400, code `slot-collision`, message names the slot.
3. Attach a skill whose slot collides with `agent.requiredCredentials` → 400, code `slot-collision`.
4. Attach with a binding missing for a slot the skill declares → 400, code `binding-missing`.
5. Attach with a binding key NOT in the skill's slot list → 400, code `binding-orphan`.
6. Attach a nonexistent `skillId` → 400, code `skill-not-found`.

- [ ] **Step 2: Implement.**

`packages/agents/src/admin-routes.ts` adds:

```ts
const skillAttachmentSchema = z.object({
  skillId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'skillId has invalid shape'),
  credentialBindings: z.record(
    z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'slot has invalid shape'),
    z.string().min(1).max(256),
  ),
});

const patchAttachmentsBodySchema = z.object({
  skillAttachments: z.array(skillAttachmentSchema).max(20),
});
```

Route handler logic:

1. `requireAdmin` + `verifyCsrf` + size cap (existing helpers).
2. zod-parse body → `parsed.skillAttachments`.
3. Resolve every referenced skill via `skills:resolve`. Any id missing from the result → 400 `skill-not-found`.
4. Resolve the current agent via `agents:resolve`. Read its `requiredCredentials` keys to seed the slot-ownership map.
5. Walk the new attachments. For each: validate that every skill-declared slot has a binding (else `binding-missing`); validate that every binding key matches a declared slot (else `binding-orphan`); check the slot-ownership map (other attachment OR agent.requiredCredentials) and if already owned → `slot-collision` with the colliding owner named.
6. Persist via the existing `agents:update` hook — extend its patch shape to accept `skillAttachments`. (If the existing update path's zod schema doesn't fit, add a sibling hook `agents:set-skill-attachments` with the smallest patch shape needed. Read `store.ts` first; one of these is the cleaner seam.)
7. Return 200 with the updated agent.

Factor the collision-detection logic into a pure function `validateNewAttachments(skills, attachments, requiredCredentials)` returning a discriminated-union result. Unit-test it in isolation BEFORE wiring the route.

- [ ] **Step 3: Run — expect pass.**

- [ ] **Step 4: Commit.**

```
git add packages/agents/src/admin-routes.ts packages/agents/src/__tests__/admin-routes.test.ts
git commit -m "feat(agents): PATCH /admin/agents/:id/skill-attachments with slot-collision (I-P1-4)"
```

---

## PHASE 1.5 — Orchestrator + sandbox integration

**Outcome:** `chat-orchestrator` resolves attached skills at session-open, unions `allowedHosts`, merges `credentialBindings` into `proxy:open-session`, and threads `installedSkills` through `sandbox:open-session`. Both sandbox plugins materialize the SKILL.md bodies under `$CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md` and chmod 0555 the parent dir AFTER writes.

**PR-internal scope:** ~5 commits.

### Task 1.5.1: Extend `AgentRecord` + `OpenSessionInput`

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` (`AgentRecord`, `OpenSessionInput`)

Per I2, the orchestrator duplicates the agent shape structurally (does not import `@ax/agents`). Add `skillAttachments` to the local interface AND add `installedSkills` to the local `OpenSessionInput` shape that is duplicated for the `sandbox:open-session` bus call.

```ts
interface AgentRecord {
  // ...existing fields...
  skillAttachments: Array<{
    skillId: string;
    credentialBindings: Record<string, string>;
  }>;
}

interface InstalledSkillForSandbox {
  id: string;
  // Full SKILL.md content: '---\n' + manifestYaml + '---\n' + bodyMd
  skillMd: string;
}

interface OpenSessionInput {
  // ...existing fields...
  installedSkills?: InstalledSkillForSandbox[];
}
```

- [ ] **Step 1: Run tsc; expect breakages where the structural shapes drift.** Fix any test fixtures that construct `AgentRecord` literals; default `skillAttachments: []` everywhere.

- [ ] **Step 2: Commit.**

```
git add packages/chat-orchestrator/src/orchestrator.ts
git commit -m "feat(orchestrator): structural AgentRecord.skillAttachments + InstalledSkill payload"
```

---

### Task 1.5.2: Union step + three new termination outcomes

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`
- Test: orchestrator unit-test file (find by grep)

- [ ] **Step 1: Write failing tests.**

1. Unions skill `allowedHosts` into `proxy:open-session.allowlist` (set-dedup with agent's own hosts).
2. Merges `credentialBindings` into `proxy:open-session.credentials` (per slot).
3. Emits `skill-binding-missing` termination outcome when an attachment lacks a required binding (no `proxy:open-session` call made).
4. Emits `skill-slot-collision` when two attached skills declare the same slot.
5. Emits `skill-slot-collision` when a skill slot collides with `agent.requiredCredentials` (safety-net path for data drift past PATCH validation).
6. Emits `skill-resolve-failed` when `skills:resolve` throws.
7. Threads `installedSkills` into `sandbox:open-session` with full SKILL.md content reconstructed from `manifestYaml + bodyMd`.
8. Drops unknown skill ids silently (deleted-skill-still-attached state).

- [ ] **Step 2: Run — expect failures.**

- [ ] **Step 3: Implement the union step.**

Find the block at `orchestrator.ts:742-767` (where `useAnthropicDefaults` is computed and `proxy:open-session` is called). BEFORE that bus call, insert:

```ts
// Phase 1: resolve installed skills attached to this agent and union
// their declared allowedHosts + credentialBindings into the proxy
// open-session call. Skills are the v1 primary path by which an agent
// gains access to a new credentialed host; see
// docs/plans/2026-05-17-skill-install-workflow-design.md.
let resolvedSkills: ResolvedSkill[] = [];
if ((agent.skillAttachments?.length ?? 0) > 0 && bus.hasService('skills:resolve')) {
  try {
    const r = await bus.call<SkillsResolveInput, SkillsResolveOutput>(
      'skills:resolve', ctx,
      { skillIds: agent.skillAttachments!.map((a) => a.skillId) },
    );
    resolvedSkills = r.skills;
  } catch (err) {
    const outcome: AgentOutcome = { kind: 'terminated', reason: 'skill-resolve-failed', error: err };
    await bus.fire('chat:end', ctx, { outcome });
    return outcome;
  }
}

const skillById = new Map(resolvedSkills.map((s) => [s.id, s]));

// Build the union allowlist + credentials, starting from agent defaults.
const baseAllowlist = useAnthropicDefaults
  ? new Set<string>(['api.anthropic.com'])
  : new Set<string>(agent.allowedHosts ?? []);
const baseCreds: Record<string, { ref: string; kind: string }> = useAnthropicDefaults
  ? { ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } }
  : { ...(agent.requiredCredentials ?? {}) };

// Track slot ownership so the collision error names the culprit.
const slotOwners = new Map<string, string>(
  Object.keys(baseCreds).map((slot) => [slot, '<agent.requiredCredentials>']),
);

for (const attachment of agent.skillAttachments ?? []) {
  const skill = skillById.get(attachment.skillId);
  if (!skill) continue; // deleted-skill-still-attached — drop silently
  for (const host of skill.capabilities.allowedHosts) baseAllowlist.add(host);
  for (const slotDef of skill.capabilities.credentials) {
    const ref = attachment.credentialBindings[slotDef.slot];
    if (ref === undefined) {
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: 'skill-binding-missing',
        details: { slot: slotDef.slot, skillId: skill.id },
      };
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }
    if (slotOwners.has(slotDef.slot)) {
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: 'skill-slot-collision',
        details: {
          slot: slotDef.slot,
          existingOwner: slotOwners.get(slotDef.slot)!,
          newOwner: skill.id,
        },
      };
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }
    baseCreds[slotDef.slot] = { ref, kind: slotDef.kind };
    slotOwners.set(slotDef.slot, skill.id);
  }
}

const unionedAllowlist = [...baseAllowlist];
const unionedCreds = baseCreds;
```

Replace the `proxy:open-session` call's `allowlist` and `credentials` args:

```ts
allowlist: unionedAllowlist,
credentials: unionedCreds,
```

Build the `installedSkills` array for sandbox plumbing:

```ts
const installedSkills: InstalledSkillForSandbox[] = resolvedSkills.map((s) => ({
  id: s.id,
  skillMd: '---\n' + s.manifestYaml + (s.manifestYaml.endsWith('\n') ? '' : '\n') + '---\n' + s.bodyMd,
}));

const sandboxInput: OpenSessionInput = {
  // ...existing fields...
  ...(installedSkills.length > 0 ? { installedSkills } : {}),
};
```

Extend `AgentOutcome` (find its union; mirror the existing `reason` value shapes) with the three new reasons and the optional `details` field for structured extras.

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit.**

```
git add packages/chat-orchestrator/src/
git commit -m "feat(orchestrator): union skill allowedHosts + merge bindings; 3 new outcomes (I-P1-5)"
```

---

### Task 1.5.3: Sandbox-subprocess — materialize installed-skill files

**Files:**
- Modify: `packages/sandbox-subprocess/src/open-session.ts`
- Modify: `packages/sandbox-subprocess/src/types.ts` (or wherever `OpenSessionInput` lives — verify)
- Test: `packages/sandbox-subprocess/src/__tests__/open-session.test.ts`

- [ ] **Step 1: Add the `installedSkills` field to `OpenSessionInput`.**

The Phase 0 PR already added `installedSkillsDir` (`packages/sandbox-subprocess/src/open-session.ts:217`) — verify by reading. Phase 1 adds the optional input field plus the write loop.

```ts
export interface InstalledSkillInput {
  id: string;
  skillMd: string;
}

export interface OpenSessionInput {
  // ...existing fields...
  installedSkills?: InstalledSkillInput[];
}
```

- [ ] **Step 2: Write failing tests.**

1. `openSession({ installedSkills: [{ id: 'github', skillMd: '---\\nname: github\\ndescription: x\\n---\\nBody' }] })` → `$CLAUDE_CONFIG_DIR/skills/github/SKILL.md` exists with the full content.
2. After writes complete, the parent skills dir is chmod 0555.
3. When `installedSkills` is empty/absent, the skills dir stays 0755 (Phase 0's default — only chmod tight when there's content to lock).
4. Reopening the session on the same workspace with different content overwrites the file.
5. Invalid skill id (doesn't match the kebab-case regex) → throws `invalid-skill-id` with `sandbox-prep-failed` code wrapping.

- [ ] **Step 3: Run — expect failures.**

- [ ] **Step 4: Implement.**

In `open-session.ts`, AFTER the existing `installedSkillsDir` mkdir (Phase 0 left it empty + 0755) and AFTER the workspace-symlink block (line ~274), but BEFORE the `session:create` call (~line 297), add:

```ts
// Phase 1: materialize installed-skill SKILL.md bodies into
// $CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md. The SDK's 'user' source
// discovers these at runner startup (Phase 0 set settingSources +
// CLAUDE_CONFIG_DIR; Phase 1 fills the directory).
//
// chmod 0555 the parent skills dir AFTER all writes so the runner's
// own tool calls can't overwrite or extend the directory. Workspace:
// apply has no path to HOME, so the workspace-side defense is automatic;
// chmod is the belt against tool-bash echo > path.
if (input.installedSkills !== undefined && input.installedSkills.length > 0) {
  try {
    for (const skill of input.installedSkills) {
      // Defend against id-spoofing at the trust boundary. parseSkillManifest
      // already validated at upsert time, but this re-check is cheap.
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(skill.id)) {
        throw new PluginError({
          code: 'invalid-skill-id',
          plugin: PLUGIN_NAME,
          hookName: HOOK_NAME,
          message: `installed skill id '${skill.id}' has invalid shape`,
        });
      }
      const skillDir = path.join(installedSkillsDir, skill.id);
      await fs.mkdir(skillDir, { recursive: true, mode: 0o755 });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        skill.skillMd,
        { mode: 0o444, encoding: 'utf-8' },
      );
    }
    // chmod 0555 AFTER all writes — runner cannot add new skill dirs or replace.
    await fs.chmod(installedSkillsDir, 0o555);
  } catch (cause) {
    await fs.rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    throw new PluginError({
      code: 'sandbox-prep-failed',
      plugin: PLUGIN_NAME,
      hookName: HOOK_NAME,
      message: 'failed to materialize installed skills',
      cause,
    });
  }
}
```

- [ ] **Step 5: Run — expect pass.**

- [ ] **Step 6: Commit.**

```
git add packages/sandbox-subprocess/src/
git commit -m "feat(sandbox-subprocess): materialize installedSkills + chmod 0555 (I-P1-3)"
```

---

### Task 1.5.4: Sandbox-k8s — materialize installed-skill files via runner env

**Files:**
- Modify: `packages/sandbox-k8s/src/open-session.ts` (or `pod-spec.ts`)
- Modify: `packages/agent-claude-sdk-runner/src/main.ts`
- Modify: `packages/agent-claude-sdk-runner/src/proxy-startup.ts` (ENV_ALLOWLIST extension)
- Test: `packages/sandbox-k8s/src/__tests__/...`
- Test: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`

K8s pods can't have the host write files inside them at pod-creation time. Three impractical approaches:

- **(a)** Extend the Phase 0 init container with a multi-arg invocation. Drawback: cmd-line length cap; init container becomes data-coupled to orchestrator.
- **(b)** Materialize through the workspace volume. Drawback: violates trust separation.
- **(c)** Mount per-pod ConfigMaps. Drawback: ConfigMap create+delete on every session open/close.

**Chosen approach: (d)** — pass installed-skill content as an env var (`AX_INSTALLED_SKILLS_JSON`) and have the runner's main.ts write the files BEFORE invoking the SDK. This:

- Keeps the k8s pod-spec change minimal (one env var entry).
- Matches the sandbox-subprocess pattern philosophically (the trusted process writes the files).
- Plays naturally with the Phase 0 init container, which already created the empty parent dir.

**Critical drift risk:** the env var must survive the `ENV_ALLOWLIST` filter in `packages/agent-claude-sdk-runner/src/proxy-startup.ts`. This is the EXACT same class of bug as the Phase 0 PR #95 finding (`CLAUDE_CONFIG_DIR` was dropped). Adding the new var to the allowlist + pinning it with a regression test is non-optional.

- [ ] **Step 1: Add `AX_INSTALLED_SKILLS_JSON` to `ENV_ALLOWLIST`.**

```
grep -n "ENV_ALLOWLIST" packages/agent-claude-sdk-runner/src/
```

Find the allowlist constant. Add the new var name. Add a regression test in `main.test.ts` asserting that when the runner is spawned with this env var set, the value is forwarded into the SDK subprocess (mirror the Phase 0 `CLAUDE_CONFIG_DIR` regression test pattern from commit `f085ffe7`).

- [ ] **Step 2: Write failing tests for the k8s pod-spec.**

1. `buildPodSpec({ installedSkills: [{ id: 'github', skillMd: '...' }] })` → pod env contains `AX_INSTALLED_SKILLS_JSON` with the JSON-encoded array.
2. `buildPodSpec({})` with no installedSkills → env does NOT contain `AX_INSTALLED_SKILLS_JSON`.
3. Total `installedSkills` payload over 256 KiB → throws `installed-skills-too-large`.

- [ ] **Step 3: Implement in `pod-spec.ts` / `open-session.ts`.**

```ts
if (input.installedSkills && input.installedSkills.length > 0) {
  const encoded = JSON.stringify(input.installedSkills);
  if (Buffer.byteLength(encoded, 'utf-8') > 256 * 1024) {
    throw new PluginError({
      code: 'installed-skills-too-large',
      plugin: PLUGIN_NAME,
      message: 'AX_INSTALLED_SKILLS_JSON payload over 256 KiB',
    });
  }
  env.push({ name: 'AX_INSTALLED_SKILLS_JSON', value: encoded });
}
```

- [ ] **Step 4: Write failing tests for the runner-side materializer.**

In `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`:

1. With `AX_INSTALLED_SKILLS_JSON` set + `CLAUDE_CONFIG_DIR` pointing at a tempdir, calling the materialize function creates `<ccd>/skills/<id>/SKILL.md` for each entry.
2. After materialization, the parent skills dir is chmod 0555.
3. `AX_INSTALLED_SKILLS_JSON` set but `CLAUDE_CONFIG_DIR` missing → throws.
4. Invalid JSON in the env var → throws.
5. Non-array root → throws.
6. Entry shape `{ id: <not-string>, skillMd: <not-string> }` → throws.
7. Entry id failing the kebab-case regex → throws.

- [ ] **Step 5: Implement in `main.ts`.**

```ts
async function materializeInstalledSkillsFromEnv(): Promise<void> {
  const json = process.env.AX_INSTALLED_SKILLS_JSON;
  if (!json) return;
  const ccd = process.env.CLAUDE_CONFIG_DIR;
  if (!ccd) {
    throw new Error('AX_INSTALLED_SKILLS_JSON set but CLAUDE_CONFIG_DIR missing');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('AX_INSTALLED_SKILLS_JSON is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('AX_INSTALLED_SKILLS_JSON must be an array');
  }
  const skillsDir = path.join(ccd, 'skills');
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Record<string, unknown>)['id'] !== 'string' ||
      typeof (entry as Record<string, unknown>)['skillMd'] !== 'string'
    ) {
      throw new Error('AX_INSTALLED_SKILLS_JSON entries must be { id, skillMd } objects');
    }
    const e = entry as { id: string; skillMd: string };
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(e.id)) {
      throw new Error(`installed skill id '${e.id}' has invalid shape`);
    }
    const skillDir = path.join(skillsDir, e.id);
    await fs.mkdir(skillDir, { recursive: true, mode: 0o755 });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      e.skillMd,
      { mode: 0o444, encoding: 'utf-8' },
    );
  }
  await fs.chmod(skillsDir, 0o555);
}

// Call BEFORE the SDK is invoked.
await materializeInstalledSkillsFromEnv();
```

- [ ] **Step 6: Run — expect pass.**

- [ ] **Step 7: Commit.**

```
git add packages/sandbox-k8s/src/ packages/agent-claude-sdk-runner/src/
git commit -m "feat(sandbox-k8s,runner): AX_INSTALLED_SKILLS_JSON materialization (I-P1-3)"
```

---

## PHASE 1.6 — channel-web admin UI

**Outcome:** Admin can browse, install, edit, and delete skills via `/admin/skills`. Agent edit form has a Skills section using existing shadcn primitives. The credential dropdown in the slot-binding sub-form filters by matching `kind`.

**PR-internal scope:** ~5 commits.

**Before starting Phase 1.6**, invoke the `shadcn` skill — it loads the installed-component list, the rule files, and the monorepo workspace flag (`-c packages/channel-web`). Per CLAUDE.md invariant #6: any missing primitive must be installed via `pnpm dlx shadcn@latest add <name> -c packages/channel-web`, not hand-rolled.

### Task 1.6.1: Admin route registration in `lib/admin.ts`

**Files:**
- Modify: `packages/channel-web/src/lib/admin.ts`
- Modify: `packages/channel-web/src/components/admin/AdminSidebar.tsx`

- [ ] **Step 1: Add `'skills'` to the `AdminView` union in `lib/admin.ts`.**

- [ ] **Step 2: Add the nav entry in `AdminSidebar.tsx`** mirroring the other entries' shape.

- [ ] **Step 3: Build; verify the nav renders.**

- [ ] **Step 4: Commit.**

```
git add packages/channel-web/src/lib/admin.ts \
        packages/channel-web/src/components/admin/AdminSidebar.tsx
git commit -m "feat(channel-web): add Skills entry to admin nav"
```

---

### Task 1.6.2: SkillsTab (list + create + delete)

**Files:**
- Create: `packages/channel-web/src/components/admin/SkillsTab.tsx`
- Modify: `packages/channel-web/src/components/admin/AdminPanel.tsx` (or `AdminShell.tsx`)
- Test: `packages/channel-web/src/components/admin/__tests__/SkillsTab.test.tsx`

- [ ] **Step 1: Write failing component tests.**

Use `@testing-library/react` (verify the project's helper by reading existing channel-web tests). Cases:

1. Renders a list of skills (mock `listSkills`).
2. Empty state when no skills (mock returns `[]`).
3. Loading state visible during fetch.
4. Error state with `<Alert>` when fetch fails.
5. Click `[+ New skill]` opens the editor dialog.
6. Click `Edit` on a row opens the editor with that skill loaded.
7. Click `Delete` shows a confirmation, then calls `deleteSkill`.
8. Server-side delete error (409 attached) surfaces in the alert.

- [ ] **Step 2: Implement using ONLY existing shadcn primitives** (`Card`, `CardHeader`, `CardTitle`, `CardContent`, `Button`, `Table` family, `Dialog` family, `Alert`, `AlertDescription`). Verify each primitive's import exists in `packages/channel-web/src/components/ui/`. Install missing primitives via `pnpm dlx shadcn@latest add <name> -c packages/channel-web`. Compose semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`) — no raw color values.

Component shape:

```
<Card>
  <CardHeader>
    <CardTitle>Skills</CardTitle>
    <Dialog ...> <Button>+ New skill</Button> ... </Dialog>
  </CardHeader>
  <CardContent>
    {error && <Alert>...</Alert>}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Hosts</TableHead>
          <TableHead>Slots</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead/>
        </TableRow>
      </TableHeader>
      <TableBody>
        { skills.map(s => <TableRow>...</TableRow>) }
      </TableBody>
    </Table>
    { editing && <Dialog open><SkillEditor skillId={editing} .../></Dialog> }
  </CardContent>
</Card>
```

Embed the SkillEditor (Task 1.6.3) inside the create + edit dialogs.

- [ ] **Step 3: Wire `<SkillsTab />` into `AdminPanel.tsx` when `view === 'skills'`.**

- [ ] **Step 4: Run tests + build.**

- [ ] **Step 5: Commit.**

```
git add packages/channel-web/src/components/admin/SkillsTab.tsx \
        packages/channel-web/src/components/admin/AdminPanel.tsx \
        packages/channel-web/src/components/admin/__tests__/SkillsTab.test.tsx
git commit -m "feat(channel-web): /admin/skills list + delete"
```

---

### Task 1.6.3: SkillEditor (paste-a-full-SKILL.md textarea + live-parsed preview)

**Files:**
- Create: `packages/channel-web/src/components/admin/SkillEditor.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/SkillEditor.test.tsx`

- [ ] **Step 1: Write failing tests.**

1. Renders the textarea with the existing skill content when `skillId` prop is given (mocks `getSkill`).
2. Renders an empty template when no `skillId`.
3. Shows a parse error inline (in `<Alert variant="destructive">`) when the user types malformed yaml or content lacking frontmatter.
4. Disables `Save` when content is invalid.
5. Live preview shows host chips and slot list when content parses.
6. Calls `upsertSkill` (or `updateSkill` if editing) and invokes `onSaved` on success.
7. Server-side error surfaces inline.

- [ ] **Step 2: Implement.**

Two-pane editor using existing shadcn primitives:
- Left pane: `<Textarea>` with `className="font-mono min-h-[400px]"` bound to a `text` state.
- Right pane: live preview. The component imports `parseSkillManifest` from `@ax/skills` (pure JS — no Node-only deps, safe in the browser) and parses the YAML between the first two `---` fences on every change. On successful parse, render:
  - Allowed hosts as `<span className="inline-block px-2 py-1 mr-1 bg-secondary rounded text-xs">` chips.
  - Credential slots as a `<ul>` of `<code>{slot}</code> ({kind}) — {description}`.
- Bottom: `<Button onClick={save} disabled={saving || !!liveError}>` → "Install" (create) or "Update" (edit).

On save: read CSRF token from cookie (use the same helper `lib/credentials.ts` uses), call `upsertSkill(text, csrf)` or `updateSkill(skillId, text, csrf)`, then `onSaved()`.

The textarea content is the COMPLETE SKILL.md (with `---` fences). The wire client receives the whole string; the server splits it.

- [ ] **Step 3: Run tests + build.**

- [ ] **Step 4: Commit.**

```
git add packages/channel-web/src/components/admin/SkillEditor.tsx \
        packages/channel-web/src/components/admin/__tests__/SkillEditor.test.tsx
git commit -m "feat(channel-web): SkillEditor with live-parsed preview"
```

---

### Task 1.6.4: SkillAttachmentsSection inside AgentForm

**Files:**
- Create: `packages/channel-web/src/components/admin/SkillAttachmentsSection.tsx`
- Modify: `packages/channel-web/src/components/admin/AgentForm.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/SkillAttachmentsSection.test.tsx`

- [ ] **Step 1: Locate the existing credential-picker.**

```
grep -rn "credential.*picker\|CredentialPicker\|CredentialSelect" packages/channel-web/src/components/
```

If a picker with `kind` filter exists, reuse directly. If not, drive `listCredentials({ kind: 'api-key' })` + render a `<Select>` shadcn primitive.

- [ ] **Step 2: Write failing tests.**

1. Renders existing attachments with their slot bindings displayed.
2. Click `[+ Attach skill]` opens a picker showing skills NOT already attached.
3. Selecting a skill renders a slot-binding sub-form: one row per declared slot, with a credential dropdown filtered by `kind`.
4. Click `Save` PATCHes `/admin/agents/:id/skill-attachments`.
5. Server-side slot-collision error surfaces inline near the offending row.
6. Click `Detach` on an existing attachment removes it from the in-memory list before save.

- [ ] **Step 3: Implement.**

The section renders inside `<AgentForm>` between the existing Tools and Allowed-Hosts sections. Layout:

```
Skills
  + skill: github       slot GITHUB_TOKEN ← [Select credential ▾]   [Detach]
  + skill: openai       slot OPENAI_API_KEY ← [Select credential ▾]   [Detach]
  [ + Attach skill ]
```

Internal state holds the in-progress `skillAttachments` array; `Save` calls `PATCH /admin/agents/:id/skill-attachments` with the new array. On success, refresh the parent agent record.

- [ ] **Step 4: Embed into `AgentForm.tsx`.** Also convert the existing Allowed-Hosts field to a **read-only computed view** showing the union of `agent.allowedHosts` + attached-skill allowedHosts (use `listSkills` to fetch capabilities for already-attached skills on render). Add a tooltip noting that hosts come from attached skills.

- [ ] **Step 5: Run tests + build.**

- [ ] **Step 6: Commit.**

```
git add packages/channel-web/src/components/admin/SkillAttachmentsSection.tsx \
        packages/channel-web/src/components/admin/AgentForm.tsx \
        packages/channel-web/src/components/admin/__tests__/SkillAttachmentsSection.test.tsx
git commit -m "feat(channel-web): per-agent SkillAttachmentsSection with slot binding (I-P1-8)"
```

---

## PHASE 1.7 — Preset wiring + canary + PR

**Outcome:** `@ax/skills` is loaded in CLI + k8s presets. Canary test installs the github skill, attaches it to an agent, opens a chat, asserts a request to `api.github.com` is permitted by the proxy with the bound credential substituted. MANUAL-ACCEPTANCE walked. PR opened with I-P1-1..8 audit.

**PR-internal scope:** ~3 commits + PR creation.

### Task 1.7.1: Preset wiring

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `presets/k8s/src/index.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts`
- Modify: `packages/cli/package.json`
- Modify: `presets/k8s/package.json`

- [ ] **Step 1: Add the imports + plugin push in CLI.**

In `packages/cli/src/main.ts` (alongside `createValidatorSkillPlugin` at line ~18):

```ts
import { createSkillsPlugin } from '@ax/skills';
```

…and push BEFORE `createAgentsPlugin` so `agents:any-attached-to-skill` is registered when delete checks fire:

```ts
plugins.push(createSkillsPlugin());
```

In `presets/k8s/src/index.ts`:

```ts
import { createSkillsPlugin } from '@ax/skills';
// ...
plugins.push(createSkillsPlugin());
```

- [ ] **Step 2: Update package.json files.**

Add `"@ax/skills": "workspace:*"` to `packages/cli/package.json` and `presets/k8s/package.json` dependencies.

- [ ] **Step 3: Update `presets/k8s/src/__tests__/preset.test.ts`.**

Per `feedback_preset_drop_vs_load_lists`, the preset test has a full loaded-plugin assertion list. Add `@ax/skills` there. Do NOT add it to any `PLUGINS_TO_DROP` list — `@ax/skills` is load-bearing.

- [ ] **Step 4: Run preset tests.**

```
pnpm test --filter @ax-presets/k8s
```

- [ ] **Step 5: Commit.**

```
git add packages/cli/src/main.ts presets/k8s/src/ \
        packages/cli/package.json presets/k8s/package.json
git commit -m "feat(presets): load @ax/skills in CLI + k8s (I-P1-7)"
```

---

### Task 1.7.2: Canary acceptance test

**Files:**
- Modify: `packages/test-harness/src/canary/` (existing canary) or create `skill-install.acceptance.test.ts`
- Modify: `deploy/MANUAL-ACCEPTANCE.md`

- [ ] **Step 1: Locate the existing canary.**

```
ls packages/test-harness/src/canary/ 2>/dev/null
grep -rn "MANUAL-ACCEPTANCE\|canary.*test\|acceptance" packages/test-harness/src/
```

- [ ] **Step 2: Add the install→attach→chat scenario.**

Test cases:

1. **install→attach→chat happy path.** Admin upserts the github skill manifest. Admin creates a credential (kind=api-key, ref='gh-pat', value='ghp_FAKE_TOKEN_FOR_TEST'). Admin creates an agent and attaches the skill via `PATCH /admin/agents/:id/skill-attachments`. Open a chat session. Inside the sandbox, make a request to `api.github.com` with `Authorization: Bearer ax-cred:<placeholder>`. Mock GitHub server asserts the auth header value matches the real token. Response returns 200. Turn completes successfully.

2. **SDK Skill tool was invoked.** Verify via tool-call inspection that the SDK's built-in `Skill` tool fired at least once during the turn, surfacing the canary skill's body.

3. **skills:delete is blocked when an agent has the skill attached.** Try `DELETE /admin/skills/github` → expect 409 with code `skill-in-use`.

4. **`skill-binding-missing` termination outcome.** Hand-edit the agent's `skill_attachments` JSONB to remove a required binding; reopen the session; expect `kind: 'terminated', reason: 'skill-binding-missing'`.

The mock GitHub server: read `packages/credential-proxy/src/__tests__/` for the existing HTTP-mock pattern. If a github mock doesn't exist, write the smallest possible one (a single `http.createServer(...)` returning 200 + asserting on the inbound `Authorization` header).

- [ ] **Step 3: Run the canary.**

```
pnpm test --filter @ax/test-harness
```

- [ ] **Step 4: Extend `deploy/MANUAL-ACCEPTANCE.md`** with one new bullet covering the install→attach→chat walk on the kind cluster:

```
## Skills install → attach → chat (Phase 1)

1. Sign in as admin, navigate to Admin → Skills.
2. Click + New skill, paste a minimal `github` skill manifest, click Install.
3. Verify the skill appears in the list with `api.github.com` host and GITHUB_TOKEN slot.
4. Navigate to Admin → Agents, edit any test agent.
5. In the Skills section, click + Attach skill, pick `github`, bind GITHUB_TOKEN to a credential, save.
6. Open a chat with that agent; ask it to "fetch the public profile for user 'torvalds' from the GitHub API."
7. Verify in the network panel that the agent's tool call to api.github.com/users/torvalds returned a successful response. The proxy substituted the placeholder with the real PAT.
8. Navigate back to Admin → Skills; try Delete on the `github` skill. Verify it 409s with "skill is attached".
9. Detach the skill from the agent; retry delete. Verify it succeeds.
```

- [ ] **Step 5: Commit.**

```
git add packages/test-harness/src/canary/ deploy/MANUAL-ACCEPTANCE.md
git commit -m "test(canary): install→attach→chat skill scenario (I-P1-7)"
```

---

### Task 1.7.3: Open the PR with invariant audit

- [ ] **Step 1: Final pre-PR check.**

```
pnpm build && pnpm test && pnpm lint
```

All three (per `feedback_run_lint_before_pr`).

- [ ] **Step 2: Review commit log.**

```
git log --oneline origin/main..HEAD
```

Expected: ~28-30 commits across the seven phases.

- [ ] **Step 3: Open the PR via `gh pr create`** with title `feat(skills): Phase 1 — installed-skills workflow (manifest + DB + admin UI + orchestrator union)` and body containing:

- **Summary** — one paragraph + a sentence on the end-to-end canary.
- **Phase 1 invariants** — list I-P1-1 through I-P1-8 with one-line each on what test covers it.
- **Half-wired window — CLOSED** — name `@ax/skills` as the new plugin, list the CLI + k8s preset wiring, name the canary as the reach-test.
- **Boundary review** — name the alternate impl (`@ax/skills-fs` future filesystem-backed sibling), confirm payload field names are storage-agnostic, confirm no risky subscriber risk.
- **Test plan** — checklist of unit/component/canary scopes.
- **Follow-ups** — system-prompt fold (deferred to SDK-only); MCP-skill bundling (reserved); versioning/upgrade flow; user-installable skills; workspace→installed promote flow.

- [ ] **Step 4: Surface the PR URL to the user.**

---

## Self-review

### Spec coverage

Every Phase 1 section of the design doc maps to a task:

- "Skill manifest schema" → Task 1.1.2.
- "Workspace SKILL.md strip-and-warn" → Task 1.1.3.
- "Data model — new table skills" → Tasks 1.2.1 + 1.2.2.
- "Data model — extended agent record" → Task 1.4.1.
- "Hook surface — skills:list/get/upsert/delete/resolve" → Task 1.2.3.
- "Admin HTTP routes" → Task 1.3.1.
- "Session-open flow — union step + outcomes" → Task 1.5.2.
- "Materialization details — installed-side `$CLAUDE_CONFIG_DIR/skills/`" → Tasks 1.5.3 (subprocess) + 1.5.4 (k8s/runner).
- "Admin UI sketch" → Tasks 1.6.1–1.6.4.
- "Half-wired window plan" → Task 1.7.1.
- "Canary acceptance" → Task 1.7.2.
- All three open questions resolved at the top of this doc.

### Placeholder scan

- No "TBD"/"implement later"/"similar to Task N" — each task carries concrete code blocks or concrete commands.
- The k8s materialization decision (Task 1.5.4) is fully specified — env var name, JSON shape, runner-side function body, ENV_ALLOWLIST extension.
- The route-handler implementation in Task 1.3.1 references the established `credentials-admin-routes` pattern instead of inlining a 200-line copy-paste that would risk drift — this is "follow the existing pattern" rather than "fill in details."

### Type consistency

- `SkillSummary` / `SkillDetail` / `ResolvedSkill` defined once in `types.ts` (Task 1.1.1); used consistently in `store.ts` (Task 1.2.2), `plugin.ts` (Task 1.2.3), `admin-routes.ts` (Task 1.3.1), `lib/skills.ts` (Task 1.3.2), and orchestrator (Task 1.5.2).
- `SkillAttachment` declared once in `packages/agents/src/types.ts` (Task 1.4.1); duplicated structurally in `orchestrator.ts` per I2 (Task 1.5.1). Field names must match exactly: `skillId` (string) + `credentialBindings` (Record<string, string>). The plan calls this out at both ends.
- `AgentOutcome` extensions: three new `reason` values + optional `details` field. Match the existing outcomes' shape in `orchestrator.ts` exactly.

### YAGNI audit

Per `feedback_yagni_check_in_plans`, scanning for components whose only call-site at MVP scale is identity:

- **`version` field on manifests.** Stored, never consumed. KEPT — no-op cost, forward-compat is cheap.
- **`bus.hasService('skills:resolve')` gate in orchestrator.** Both presets always load `@ax/skills`, so the gate looks dead. KEPT — lets us drop `@ax/skills` from a future stripped preset (runner-only CLI build) without crashing. Same logic for `bus.hasService('agents:any-attached-to-skill')` in `skills:delete`.
- **No shard-routing.** No per-tenant skill config. No plugin-options struct for things one user has. The whole plan is structured around N=1 admin / N=few skills / N=tens of agents. Verified.

### Risks worth restating before execution

- **The `workspace:pre-apply` rewrite-vs-veto contract.** Task 1.1.3 hinges on whether the hook lets a subscriber rewrite the `FileChange[]`. The task tells the implementer to read `packages/core/src/...` BEFORE writing. If rewrite isn't supported, fall back to veto with a clear reason. This decision must be made early so the rest of Phase 1.1 doesn't have to be rewritten.

- **Migration test scaffolding.** Other plugins use postgres-only DDL (`JSONB`, `TIMESTAMPTZ`). A pure-sqlite test path may not exist. Task 1.2.1 explicitly tells the implementer to read `packages/agents/src/__tests__/migrations.test.ts` first and match.

- **CSRF + admin-gate helpers duplication.** `credentials-admin-routes/src/shared.ts` likely owns them. Task 1.3.1 says to copy-paste rather than import. Verify by checking whether the helpers are already exported through `@ax/core` (in which case prefer importing). The repo policy is "duplicate before extracting" for cross-plugin code, but if the helpers are in `@ax/core` they're shared infra and should be imported.

- **AX_INSTALLED_SKILLS_JSON env-allowlist drop.** Same class of bug as the Phase 0 PR #95 finding (`CLAUDE_CONFIG_DIR` was dropped from `ENV_ALLOWLIST`). Task 1.5.4 calls it out explicitly and adds a regression test. Whoever does the final whole-PR review MUST trace `installedSkills` from orchestrator → sandbox → runner main → SDK subprocess and assert it reaches the SKILL.md write path. This is the single most likely silent failure in the PR.

- **`AgentRecord` literal-fixture churn.** Adding the required `skillAttachments: []` field will break every test that constructs an `AgentRecord` literal. Task 1.4.1 Step 7 catches this with a grep audit; if the audit gets skipped, expect ~15-20 unrelated test failures during Phase 1.5 typecheck.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-05-18-skill-install-phase-1-impl.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per phase (Phase 1.1 through Phase 1.7), with two-stage review between phases. Best for keeping the main context clean across what's likely a 25–30 commit PR. Each phase produces a stable working state (build+test+lint green), so review-and-checkpoint between phases is cheap.

2. **Inline Execution** — Execute the plan in this session using `superpowers:executing-plans`, batching with checkpoints between phases. Best if you'd rather watch it happen in one session.

Which approach?
