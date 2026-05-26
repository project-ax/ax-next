# Skills Capability + Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three of the six Phase 1 follow-ups from PR #96 — the capability-surface and lifecycle items: (A) system-prompt fold for skill descriptions on non-SDK runners, (B) MCP-skill bundling via `capabilities.mcpServers`, and (C) skill versioning + upgrade flow.

**Architecture:** Each follow-up ships as its own PR (Phase A, B, C). All three live inside `@ax/skills` plus thin touches in the orchestrator + sandbox payloads; nothing else changes. Phase A is **parked** until a non-SDK runner exists. Phase B reuses the existing `capabilities` slot in the manifest and unions into proxy/MCP open-session inputs. Phase C uses the dormant `version` column with a new `source_url` column for fetch-based refresh, surfaced through one new admin hook.

**Tech Stack:** TypeScript, pnpm monorepo, Kysely + postgres (additive-only migrations per `@ax/skills` migration policy), vitest, shadcn primitives in `packages/channel-web`, hook bus per `ax-conventions` skill.

---

## Source of truth

- **Phase 1 baseline:** `docs/plans/2026-05-18-skill-install-phase-1-impl.md` (the PR #96 plan — I-P1-1..8 closed).
- **Current code:** `packages/skills/src/{manifest,types,store,migrations,plugin,admin-routes}.ts`.
- **Orchestrator integration point:** `packages/chat-orchestrator/src/orchestrator.ts:810-918` (skill resolve + union + sandbox payload).
- **Sandbox materialization:** `packages/agent-claude-sdk-runner/src/installed-skills.ts`, `packages/sandbox-{k8s,subprocess}/src/open-session.ts`.
- **Conventions:** `CLAUDE.md` invariants 1-6, especially I2 (no cross-plugin imports), I5 (capabilities explicit + minimized), and the **boundary review** checklist for new hooks.
- **Memory cues:** `feedback_half_wired_window_pattern.md` — every new-plugin-loading step must wire to CLI + k8s preset in the same PR.

## Scope

In scope:
- Manifest grammar for `capabilities.mcpServers` + Storage + Materialization (Phase B).
- Versioning fields on `skills_v1_skills`, refresh hook, admin UI badge (Phase C).
- Park Phase A formally with a recorded trigger.

Out of scope:
- User-installable / scope axis (Plan 2, Phase D).
- Workspace-promote (Plan 2, Phase E).
- E2e canary infra (Plan 2, Phase F).
- New runners. Phase A's actual fold lands when `agent-native-runner` ships.

## Half-wired-window policy

Each phase below loads any new plugin/hook in `@ax/cli` and the k8s preset in the same PR. PR descriptions must include an explicit "window CLOSED" line.

---

## Phase A — System-prompt fold for non-SDK runners (PARKED)

**Status:** PARKED. Do **not** implement until trigger fires.

**Trigger:** Either (a) `packages/agent-native-runner/` gains source files (non-empty `src/`), or (b) `packages/test-harness/` adds a code-path that calls a real LLM and needs skills folded into its system prompt.

**Why parked:** The TODO item ("SDK-only today") describes the gap between the SDK runner — which auto-discovers `$CLAUDE_CONFIG_DIR/skills/*/SKILL.md` and surfaces a `Skill` tool — and any future non-SDK runner that lacks that built-in. Today, `agent-native-runner/` has no `src/` and `test-harness` doesn't run a model. Restructuring the orchestrator-to-sandbox payload to expose `description` separately from `bodyMd` would be pure dead code under YAGNI ([[feedback_yagni_check_in_plans.md]]).

**When the trigger fires, the shape should be:**

1. Split `InstalledSkillForSandbox.skillMd` into `{ id, description, bodyMd, manifestYaml }` end-to-end:
   - `packages/chat-orchestrator/src/orchestrator.ts:915-918` — stop pre-concatenating `manifestYaml + bodyMd`.
   - `packages/sandbox-{k8s,subprocess}/src/open-session.ts` — accept the richer shape and serialize accordingly.
   - `packages/agent-claude-sdk-runner/src/installed-skills.ts` — keep current behavior (re-concat for SDK), but the source-of-truth fields are now separate.
2. Native runner reads `description` only into the system prompt as a one-line entry per skill, and exposes a `read_skill(id)` tool that returns `bodyMd` on demand. (`description` is already capped at 240 chars by `manifest.ts:120-122` — token-safe.)
3. Add a runner-side fold test that asserts: (a) every installed skill appears as a description line in the constructed system prompt, (b) a `read_skill` tool call for an installed id returns the body verbatim, (c) calling `read_skill` for an unknown id returns a structured error (not a throw).

**Tracker:** When the trigger fires, write a fresh `docs/plans/YYYY-MM-DD-skills-system-prompt-fold-impl.md` and link back here from `TODO.md`. No code lands under Phase A until then.

**Phase A produces no commits in this plan.** Phase B starts here.

---

## Phase B — MCP-skill bundling

**Goal:** Allow a SKILL.md to declare bundled MCP servers via `capabilities.mcpServers`. The orchestrator unions the skill's MCP servers into the agent's MCP set; the sandbox materializes them so the running agent can call those servers as tools.

**Files:**
- Create: `packages/skills/src/__tests__/manifest-mcp-servers.test.ts`
- Modify: `packages/skills/src/manifest.ts` (replace lines 150-153 capability-deferred guard with full parsing)
- Modify: `packages/skills/src/types.ts:15-18` (add `mcpServers` to `SkillCapabilities`)
- Modify: `packages/skills/src/__tests__/manifest.test.ts:113-119` (delete the "rejects reserved" test)
- Modify: `packages/skills/src/__tests__/admin-routes.test.ts:193-205` (replace 400 capability-deferred case with 200 + roundtrip)
- Modify: `packages/skills/src/admin-routes.ts:122-136` (remove `capability-deferred` from `badRequestCodes`)
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` (union skill `mcpServers` into the proxy/mcp open-session inputs)
- Modify: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` (new test: skill-bundled MCP appears in opened session)
- Modify: `packages/agent-claude-sdk-runner/src/installed-skills.ts` (write per-skill `.mcp.json` alongside `SKILL.md`)
- Modify: `packages/sandbox-{k8s,subprocess}/src/open-session.ts` — extend `InstalledSkillSchema` to allow `mcpServers`
- Update: `MANUAL-ACCEPTANCE.md` — add an MCP-bundled scenario.

### Design lock-in (do this BEFORE code)

- [ ] **Step B-design.1: Invoke `security-checklist` skill.**

  This phase mutates the manifest grammar AND adds a sandbox-spawn surface. Per CLAUDE.md invariant I5, the security-checklist is required. Walk all three threat models (sandbox escape, prompt injection, supply chain). Save the structured note as `docs/plans/2026-05-20-skills-mcp-bundling-security-note.md`. Reference it in the PR.

- [ ] **Step B-design.2: Lock the manifest grammar.**

  Capture in the security note and reflect in the test below:

  ```yaml
  capabilities:
    mcpServers:
      - name: github                  # required, NAME_RE (a-z, hyphen)
        transport: stdio              # required, enum: 'stdio' | 'http'
        # stdio-only:
        command: npx                  # required if transport=stdio; string
        args: ['-y', '@modelcontextprotocol/server-github']  # optional, string[]
        env: { LOG_LEVEL: info }      # optional, Record<string,string>, NON-secret values only
        # http-only:
        url: https://mcp.example.com  # required if transport=http; HOSTNAME_RE on host
        # both:
        allowedHosts: [api.github.com] # additive to skill.allowedHosts, scoped to this MCP server
        credentials:                   # additive to skill.credentials slots; same shape
          - slot: GITHUB_TOKEN
            kind: api-key
  ```

  **Hard rules baked into the grammar** (security-checklist must justify any deviation):
  - `command` whitelist: `npx`, `node`, `bun`, `uvx`, `python`, `python3`. No arbitrary binaries. Reject otherwise with `invalid-mcp-command`.
  - `args` length less than or equal to 32 entries, each string less than or equal to 256 chars.
  - `env` values are non-secret literals only; secret values come via `credentials` slots (same mechanism as the skill-level slots).
  - `url` (transport=http) is validated by the same `HOSTNAME_RE` used for `allowedHosts`. Adds its host to the unioned allowlist implicitly so callers don't have to duplicate it.
  - `mcpServers` array max length 8 per skill.

- [ ] **Step B-design.3: Boundary review for the orchestrator-to-MCP union.**

  No new hook signature is required (we reuse `mcp:open-session` / `proxy:open-session` shapes). But the orchestrator's behavior change does affect `proxy:open-session` payload field names. Boundary check:
  - Alternate impl: a future "single-tenant pre-spawned MCP gateway" plugin would consume the same union — it would receive `mcpServers: [{ name, transport, command?, args?, env?, url? }]`. Field names match an MCP-config dialect, not a backend-specific shape. OK.
  - Payload leak risk: `command` / `args` are command-line fields. They're MCP-config-canonical, not backend-specific. OK.
  - Subscriber risk: nothing subscribes to a "mcp opened" hook today; if added later, it would key off `name`, which is stable. OK.

  Record this in the PR description's "Boundary review" section.

### Manifest grammar — TDD walk

- [ ] **Step B.1: Write the failing manifest test.**

  File: `packages/skills/src/__tests__/manifest-mcp-servers.test.ts`

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { parseSkillManifest } from '../manifest.js';

  describe('parseSkillManifest -- capabilities.mcpServers', () => {
    it('parses a valid stdio MCP server', () => {
      const yaml = `name: x
  description: x
  capabilities:
    mcpServers:
      - name: github
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env: { LOG_LEVEL: info }
        allowedHosts: [api.github.com]
        credentials:
          - slot: GITHUB_TOKEN
            kind: api-key
  `;
      const r = parseSkillManifest(yaml);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.capabilities.mcpServers).toEqual([
        {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { LOG_LEVEL: 'info' },
          allowedHosts: ['api.github.com'],
          credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
        },
      ]);
    });

    it('parses a valid http MCP server and folds url host into allowedHosts implicitly', () => {
      const yaml = `name: x
  description: x
  capabilities:
    mcpServers:
      - name: remote
        transport: http
        url: https://mcp.example.com
  `;
      const r = parseSkillManifest(yaml);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.capabilities.mcpServers?.[0]?.allowedHosts).toContain('mcp.example.com');
    });

    it('rejects non-whitelisted command', () => {
      const yaml = `name: x
  description: x
  capabilities:
    mcpServers:
      - name: x
        transport: stdio
        command: /bin/sh
  `;
      const r = parseSkillManifest(yaml);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('invalid-mcp-command');
    });

    it('rejects secret-looking env values', () => {
      const yaml = `name: x
  description: x
  capabilities:
    mcpServers:
      - name: x
        transport: stdio
        command: npx
        env: { apiKey: sk-xxx }
  `;
      const r = parseSkillManifest(yaml);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('inline-secret-forbidden');
    });

    it('caps mcpServers array length at 8', () => {
      const items = Array.from({ length: 9 }, (_, i) => `      - name: s${i}\n        transport: stdio\n        command: npx`).join('\n');
      const yaml = `name: x\ndescription: x\ncapabilities:\n  mcpServers:\n${items}\n`;
      const r = parseSkillManifest(yaml);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('invalid-manifest');
    });
  });
  ```

- [ ] **Step B.2: Run the tests and verify they fail.**

  ```bash
  pnpm test --filter @ax/skills -- manifest-mcp-servers
  ```

  Expected: all five fail. The "rejects reserved" test in the existing `manifest.test.ts` still passes (delete it in step B.6).

- [ ] **Step B.3: Extend `SkillCapabilities` in `types.ts`.**

  Add after the existing `credentials` field (around `packages/skills/src/types.ts:18`):

  ```typescript
  export interface McpServerSpec {
    name: string;
    transport: 'stdio' | 'http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    allowedHosts: string[];     // unioned with the url host on parse
    credentials: CapabilitySlot[];
  }

  export interface SkillCapabilities {
    allowedHosts: string[];
    credentials: CapabilitySlot[];
    mcpServers: McpServerSpec[];   // NEW -- always present, defaults to []
  }
  ```

  Update `ResolvedSkill` / `SkillSummary` / `SkillDetail` already cover this since they embed `SkillCapabilities`.

- [ ] **Step B.4: Implement parsing in `manifest.ts`.**

  Replace lines 150-153 (the `capability-deferred` guard) with the actual parser. Add new error codes to `ManifestCode`:

  ```typescript
  | 'invalid-mcp-command'
  | 'invalid-mcp-transport'
  ```

  Add a `parseMcpServers(rawList: unknown, allowedHostsAcc: Set<string>): ParseResult-like` helper. Keep the inline-secret recursion already in `findSecretKey` (it walks env-values automatically).

  Whitelist:

  ```typescript
  const MCP_COMMAND_ALLOW = new Set(['npx', 'node', 'bun', 'uvx', 'python', 'python3']);
  ```

  Cap to 8 entries, dedupe by `name` (duplicate name within one skill -> reject with `invalid-manifest`).

- [ ] **Step B.5: Run the tests and verify they pass.**

  ```bash
  pnpm test --filter @ax/skills -- manifest-mcp-servers
  ```

  Expected: all five pass.

- [ ] **Step B.6: Delete the obsolete `capability-deferred` test in `manifest.test.ts:113-119`.**

  Replace it with a `'capability-deferred'` snapshot test that asserts the code **no longer appears** in the union of `ManifestCode`:

  ```typescript
  it('no longer reserves capability-deferred for mcpServers', () => {
    const yaml = `name: x\ndescription: x\ncapabilities:\n  mcpServers:\n    - name: x\n      transport: stdio\n      command: npx`;
    const r = parseSkillManifest(yaml);
    expect(r.ok).toBe(true);
  });
  ```

- [ ] **Step B.7: Remove `capability-deferred` from `admin-routes.ts:122-136` badRequestCodes.**

  Mechanical change. Leave the constant in `ManifestCode` itself (still reserved for any future capability key).

- [ ] **Step B.8: Update `admin-routes.test.ts:193-205`.**

  Replace the "POST with mcpServers -> 400 capability-deferred" case with a roundtrip test:

  ```typescript
  it('POST /admin/skills with capabilities.mcpServers persists and returns it on GET', async () => {
    const skillMd = `---\nname: ghub\ndescription: GitHub\ncapabilities:\n  mcpServers:\n    - name: github\n      transport: stdio\n      command: npx\n      args: ['-y', '@modelcontextprotocol/server-github']\n---\nbody`;
    const create = await postAsAdmin('/admin/skills', { skillMd });
    expect(create.status).toBe(200);
    const get = await getAsAdmin(`/admin/skills/${create.body.skillId}`);
    expect(get.body.capabilities.mcpServers).toHaveLength(1);
    expect(get.body.capabilities.mcpServers[0].name).toBe('github');
  });
  ```

- [ ] **Step B.9: Run the full skills suite + tsc.**

  ```bash
  pnpm build --filter @ax/skills && pnpm test --filter @ax/skills
  ```

  Expected: clean build (matches [[feedback_run_tsc_alongside_vitest.md]]) + green tests.

- [ ] **Step B.10: Commit.**

  ```bash
  git add packages/skills/src packages/skills/dist
  git commit -m "feat(skills): land capabilities.mcpServers manifest grammar (Phase B step 1/3)"
  ```

### Storage — TDD walk

The `manifest_yaml` and `body_md` columns already roundtrip the new grammar (they're opaque strings). The `SkillCapabilities` type now carries `mcpServers: McpServerSpec[]`. The `store.ts` Skill row -> `SkillSummary` mapper at `packages/skills/src/store.ts:73,92` already surfaces `capabilities.mcpServers` to consumers because `capabilities` is re-parsed from `manifest_yaml` on read.

- [ ] **Step B.11: Verify roundtrip via `store.ts`.**

  Add to `packages/skills/src/__tests__/store.test.ts`:

  ```typescript
  it('roundtrips capabilities.mcpServers through upsert + list + get', async () => {
    const yaml = 'name: x\ndescription: x\ncapabilities:\n  mcpServers:\n    - name: g\n      transport: stdio\n      command: npx';
    await store.upsert({ skillId: 'x', manifestYaml: yaml, bodyMd: 'b', description: 'x', version: 0 });
    const list = await store.list();
    expect(list[0]?.capabilities.mcpServers).toHaveLength(1);
    const detail = await store.get('x');
    expect(detail.capabilities.mcpServers?.[0]?.name).toBe('g');
  });
  ```

- [ ] **Step B.12: Run and verify; commit.**

  ```bash
  pnpm test --filter @ax/skills -- store
  git add packages/skills && git commit -m "test(skills): roundtrip capabilities.mcpServers via store (Phase B step 2/3)"
  ```

### Materialization — TDD walk

The hot path is `chat-orchestrator/orchestrator.ts:849-881` (the per-attachment union loop). Today it unions `allowedHosts` and `credentials`. We extend it to union `mcpServers`. The unioned list flows into a new field on the sandbox payload.

- [ ] **Step B.13: Add a failing orchestrator test.**

  File: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` — add a new `describe('skill mcpServers union', ...)` block:

  ```typescript
  it('unions skill-bundled mcpServers into the sandbox open-session input', async () => {
    const skill = makeResolvedSkill('github', {
      allowedHosts: ['api.github.com'],
      credentials: [],
      mcpServers: [{
        name: 'github', transport: 'stdio', command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        allowedHosts: ['api.github.com'],
        credentials: [],
      }],
    });
    const calls = recordingProxy();
    const ctx = makeAgentContext({ /* ... */ });
    // ... fixture wiring (agent with skillAttachments=[{skillId:'github',...}], bus has skills:resolve)
    await orchestrator.openSession(ctx);

    expect(calls.openSession.installedSkills[0].mcpServers).toEqual([
      expect.objectContaining({ name: 'github', transport: 'stdio' }),
    ]);
  });
  ```

  (Use the existing test helpers in the file — there are already `makeResolvedSkill` and recording-proxy fixtures used by the Phase 1 tests above.)

- [ ] **Step B.14: Extend the orchestrator union (orchestrator.ts:849-881).**

  In the per-attachment loop, after the existing allowedHosts/credentials union:

  ```typescript
  // Phase B: union skill-bundled MCP servers into the sandbox's per-skill payload.
  // Sandbox is responsible for spawning them; orchestrator just passes them through.
  const skillMcpServers = skill.capabilities.mcpServers ?? [];
  ```

  Then, where `installedSkillsForSandbox` is constructed (line 915-918), include `mcpServers` per-skill:

  ```typescript
  const installedSkillsForSandbox: InstalledSkillForSandbox[] = unionedSkills.map((s) => ({
    id: s.id,
    skillMd: '---\n' + s.manifestYaml + (s.manifestYaml.endsWith('\n') ? '' : '\n') + '---\n' + s.bodyMd,
    mcpServers: s.capabilities.mcpServers,   // NEW
  }));
  ```

  Update the `InstalledSkillForSandbox` type at `packages/chat-orchestrator/src/orchestrator.ts:307,343` to include the new field.

- [ ] **Step B.15: Extend the sandbox schemas.**

  Update `InstalledSkillSchema` in both `packages/sandbox-k8s/src/open-session.ts:64-67` and `packages/sandbox-subprocess/src/open-session.ts:86-88`:

  ```typescript
  const McpServerSchema = z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    transport: z.enum(['stdio', 'http']),
    command: z.string().optional(),
    args: z.array(z.string().max(256)).max(32).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().url().optional(),
    allowedHosts: z.array(z.string()).default([]),
    credentials: z.array(z.object({ slot: z.string(), kind: z.literal('api-key') })).default([]),
  });

  const InstalledSkillSchema = z.object({
    id: z.string(),
    skillMd: z.string().min(1).max(512 * 1024),
    mcpServers: z.array(McpServerSchema).max(8).default([]),  // NEW
  });
  ```

- [ ] **Step B.16: Materialize per-skill `.mcp.json`.**

  In `packages/agent-claude-sdk-runner/src/installed-skills.ts`, alongside the existing SKILL.md write (around line 72), also write `${skillDir}/.mcp.json` when `mcpServers.length > 0`:

  ```typescript
  if (skill.mcpServers.length > 0) {
    await fs.writeFile(
      path.join(skillDir, '.mcp.json'),
      JSON.stringify({ mcpServers: Object.fromEntries(skill.mcpServers.map((s) => [s.name, toMcpJsonShape(s)])) }, null, 2),
      { mode: 0o444 },
    );
  }
  ```

  `toMcpJsonShape` converts our spec into the SDK's expected `.mcp.json` shape:

  ```typescript
  function toMcpJsonShape(s: McpServerSpec): unknown {
    if (s.transport === 'stdio') {
      return { command: s.command, args: s.args ?? [], env: s.env ?? {} };
    }
    return { url: s.url, type: 'http' };
  }
  ```

  This matches Anthropic's MCP server configuration format — the SDK auto-discovers `.mcp.json` next to skills it loads.

- [ ] **Step B.17: Add a materialization test.**

  File: `packages/agent-claude-sdk-runner/src/__tests__/installed-skills.test.ts` — add:

  ```typescript
  it('writes .mcp.json alongside SKILL.md when the skill declares mcpServers', async () => {
    await writeInstalledSkills(tmpRoot, [{
      id: 'github',
      skillMd: '---\nname: github\n---\nbody',
      mcpServers: [{ name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], allowedHosts: [], credentials: [] }],
    }]);
    const mcpJson = JSON.parse(await fs.readFile(path.join(tmpRoot, 'skills', 'github', '.mcp.json'), 'utf8'));
    expect(mcpJson.mcpServers.github).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: {} });
  });
  ```

- [ ] **Step B.18: Run all touched suites + full build.**

  ```bash
  pnpm build
  pnpm test --filter @ax/skills
  pnpm test --filter @ax/chat-orchestrator
  pnpm test --filter @ax/agent-claude-sdk-runner
  pnpm test --filter @ax/sandbox-k8s
  pnpm test --filter @ax/sandbox-subprocess
  pnpm -w lint
  ```

  Expected: green across the board. ([[feedback_run_lint_before_pr.md]])

- [ ] **Step B.19: Update MANUAL-ACCEPTANCE.md.**

  Add a new scenario after the existing Phase 1 skill scenarios:

  ```markdown
  ## MCP-bundled skill end-to-end
  1. Install a skill whose YAML declares one stdio MCP server pointing at a real or fake MCP binary (`@modelcontextprotocol/server-everything` is fine).
  2. Attach to an agent. Open a session.
  3. In the chat, ask the agent: "list the tools you have." Expect the bundled MCP server's tools to appear in the list.
  4. Delete the skill. New sessions must not have those tools.
  ```

- [ ] **Step B.20: Commit + walk MANUAL-ACCEPTANCE against `kind ax-next-dev`.**

  Per [[k8s-acceptance-loop]] skill — drive Playwright against the local cluster, verify the scenario above. If it fails, fix in this PR.

- [ ] **Step B.21: Ship as PR.**

  ```bash
  /commit-commands:commit-push-pr
  ```

  PR title: `feat(skills): MCP-skill bundling (Phase 1 follow-up B)`.

  PR body must include:
  - Reference to `docs/plans/2026-05-20-skills-mcp-bundling-security-note.md` (the security-checklist note from step B-design.1).
  - The boundary-review section from step B-design.3.
  - "Window: CLOSED in this PR — orchestrator, both sandbox impls, and SDK runner all consume `mcpServers` in the same commit."
  - Half-wired-window discipline confirmation.

---

## Phase C — Skill versioning + upgrade flow

**Goal:** Make the `version` field actually mean something at the lifecycle level. Today it's parsed and stored but never compared. After Phase C:
- An admin who re-uploads the same skill id with a higher `version:` sees the bump persist + displays in the UI.
- Skills can optionally point at a `sourceUrl` (e.g. a GitHub raw URL to the SKILL.md). A `skills:check-for-updates` hook fetches that URL, parses the manifest, compares versions, and produces an "update available" signal.
- The admin UI shows a badge on stale skills and an "Update" button that re-fetches + upserts.

**Files:**
- Modify: `packages/skills/src/migrations.ts` (add `source_url TEXT NULL`)
- Modify: `packages/skills/src/store.ts` (read/write `source_url`)
- Modify: `packages/skills/src/types.ts` (add `sourceUrl?: string` to `SkillSummary` / `SkillDetail`)
- Modify: `packages/skills/src/manifest.ts` (recognize optional `sourceUrl:` top-level field — outside `capabilities` since it's a metadata pointer, not a capability)
- Modify: `packages/skills/src/plugin.ts` (register `skills:check-for-updates` service hook)
- Create: `packages/skills/src/check-updates.ts` (the fetch + parse + compare logic, behind a `fetch` dep injection for testing)
- Create: `packages/skills/src/__tests__/check-updates.test.ts`
- Modify: `packages/skills/src/admin-routes.ts` (add `POST /admin/skills/:id/check-update` and `POST /admin/skills/:id/refresh-from-source`)
- Modify: `packages/channel-web/src/admin/SkillsTab.tsx` (badge + button) — invoke [[shadcn]] skill before writing UI.

### Design lock-in

- [ ] **Step C-design.1: Decide attachment-pinning policy.**

  Two options:
  - **(a) Latest-wins:** agent attachments do NOT pin a version. When the installed skill version moves, all agents pick up the new body on next session. Simpler.
  - **(b) Pinned:** agent attachments include `pinnedVersion?: number`. When a refresh bumps the version, the agent shows "skill X has a newer version available" until the operator re-pins or unpins.

  **Default recommendation:** (a) latest-wins. The skill is admin-managed, the admin chose to refresh, the admin owns the agent. Pinning is a YAGNI feature ([[feedback_yagni_check_in_plans.md]]) until a multi-tenant scenario demands it.

  Lock the choice in the PR description.

- [ ] **Step C-design.2: Decide `sourceUrl` scheme allowlist.**

  Initial scheme: HTTPS only. No raw IPs (matches `HOSTNAME_RE` from `manifest.ts:53`). No `file://` or `http://`. Hostnames not on a per-server allowlist are rejected by the fetcher.

  Capture the rule in the security-checklist note (if Phase B's note exists, append; else write a new shorter one).

- [ ] **Step C-design.3: Boundary review for `skills:check-for-updates`.**

  - Alternate impl: a future "skill registry index" plugin could implement this hook against an internal index instead of fetching the source URL. Field names: `{ skillId } -> { available: boolean, currentVersion: number, latestVersion?: number, latestSkillMd?: string }`. Storage-agnostic. OK.
  - Payload leak risk: `skillMd` is a doc string; no leak. `sourceUrl` is in storage but not in this hook's payload — good. OK.
  - Subscriber risk: nothing subscribes to this hook today (admin-routes calls it directly).

### Migration + storage

- [ ] **Step C.1: Failing migration test.**

  File: `packages/skills/src/__tests__/migrations.test.ts` — add:

  ```typescript
  it('adds source_url column idempotently', async () => {
    await runSkillsMigration(db);
    await runSkillsMigration(db);  // second run = no-op
    const cols = await db.introspection.getTables();
    const skillsCols = cols.find((t) => t.name === 'skills_v1_skills')?.columns ?? [];
    expect(skillsCols.find((c) => c.name === 'source_url')).toBeDefined();
  });
  ```

- [ ] **Step C.2: Run + verify failure.**

  ```bash
  pnpm test --filter @ax/skills -- migrations
  ```

  Expected: fails because the column doesn't exist yet.

- [ ] **Step C.3: Add the column.**

  In `packages/skills/src/migrations.ts:29-33` block (where `default_attached` was added):

  ```typescript
  await sql`
    ALTER TABLE skills_v1_skills
      ADD COLUMN IF NOT EXISTS source_url TEXT NULL
  `.execute(db);
  ```

  Also add `source_url: string | null` to the `SkillsRow` interface at line 39-48.

- [ ] **Step C.4: Run + verify passing.**

  ```bash
  pnpm test --filter @ax/skills -- migrations
  ```

- [ ] **Step C.5: Add a roundtrip store test + thread `sourceUrl` through `SkillSummary` / `SkillDetail`.**

  In `packages/skills/src/store.ts:73,92`, include:

  ```typescript
  sourceUrl: row.source_url ?? undefined,
  ```

  In `packages/skills/src/types.ts:20-32`, add `sourceUrl?: string` to both `SkillSummary` and `SkillDetail`.

  Store test:

  ```typescript
  it('persists and reads back sourceUrl', async () => {
    await store.upsert({
      skillId: 'x', manifestYaml: 'name: x\ndescription: x',
      bodyMd: 'b', description: 'x', version: 1, sourceUrl: 'https://example.com/skill.md',
    });
    const s = await store.get('x');
    expect(s.sourceUrl).toBe('https://example.com/skill.md');
  });
  ```

- [ ] **Step C.6: Run + verify; commit.**

  ```bash
  pnpm test --filter @ax/skills
  git add packages/skills && git commit -m "feat(skills): persist sourceUrl + version on skill rows (Phase C step 1/4)"
  ```

### Manifest top-level `sourceUrl`

- [ ] **Step C.7: Add manifest grammar + test.**

  `sourceUrl` is recognized but NOT stored as part of `SkillCapabilities` (it's metadata, not capability). Extend `manifest.ts`:

  ```typescript
  // After step 6 (version) parsing, before step 7 (capabilities):
  let sourceUrl: string | undefined;
  if ('sourceUrl' in doc) {
    const raw = doc['sourceUrl'];
    if (typeof raw !== 'string') {
      return err('invalid-manifest', '"sourceUrl" must be a string.');
    }
    let u: URL;
    try { u = new URL(raw); } catch { return err('invalid-manifest', '"sourceUrl" must be a valid URL.'); }
    if (u.protocol !== 'https:') return err('invalid-manifest', '"sourceUrl" must use https://.');
    if (!HOSTNAME_RE.test(u.hostname)) return err('invalid-manifest', '"sourceUrl" host is not a valid hostname.');
    sourceUrl = raw;
  }
  ```

  Extend `ParsedManifest` to include `sourceUrl?: string`.

  Test (in `manifest.test.ts`):

  ```typescript
  it('accepts top-level sourceUrl (https only)', () => {
    const r = parseSkillManifest('name: x\ndescription: x\nsourceUrl: https://example.com/skill.md');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sourceUrl).toBe('https://example.com/skill.md');
  });
  it('rejects http:// sourceUrl', () => {
    const r = parseSkillManifest('name: x\ndescription: x\nsourceUrl: http://example.com');
    expect(r.ok).toBe(false);
  });
  ```

- [ ] **Step C.8: Run + commit.**

  ```bash
  pnpm test --filter @ax/skills -- manifest
  git add packages/skills && git commit -m "feat(skills): parse top-level sourceUrl on manifest (Phase C step 2/4)"
  ```

### `skills:check-for-updates` service hook

- [ ] **Step C.9: Define the hook type.**

  Add to `packages/skills/src/types.ts`:

  ```typescript
  export interface SkillsCheckForUpdatesInput {
    skillId: string;
  }
  export interface SkillsCheckForUpdatesOutput {
    available: boolean;       // false if sourceUrl is unset OR latestVersion <= currentVersion
    currentVersion: number;
    latestVersion?: number;
    latestSkillMd?: string;   // present iff available=true
  }
  ```

- [ ] **Step C.10: Implement `check-updates.ts` with injected fetch.**

  ```typescript
  // packages/skills/src/check-updates.ts
  import { parseSkillManifest } from './manifest.js';
  import type { SkillsCheckForUpdatesOutput, SkillDetail } from './types.js';

  export interface FetchFn {
    (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  }

  export async function checkForUpdates(
    detail: SkillDetail,
    deps: { fetch: FetchFn },
  ): Promise<SkillsCheckForUpdatesOutput> {
    const currentVersion = detail.version;
    if (detail.sourceUrl === undefined) {
      return { available: false, currentVersion };
    }
    const r = await deps.fetch(detail.sourceUrl);
    if (!r.ok) {
      throw new Error(`skill-source-fetch-failed: ${detail.sourceUrl} returned ${r.status}`);
    }
    const text = await r.text();
    // Split out the manifest YAML (same regex as admin-routes.ts splitSkillMd).
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (m === null) throw new Error('skill-source-missing-frontmatter');
    const parsed = parseSkillManifest(m[1] ?? '');
    if (!parsed.ok) throw new Error(`skill-source-manifest-invalid: ${parsed.code}`);
    if (parsed.value.version <= currentVersion) {
      return { available: false, currentVersion, latestVersion: parsed.value.version };
    }
    return {
      available: true,
      currentVersion,
      latestVersion: parsed.value.version,
      latestSkillMd: text,
    };
  }
  ```

- [ ] **Step C.11: Add tests.**

  File: `packages/skills/src/__tests__/check-updates.test.ts`

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { checkForUpdates } from '../check-updates.js';

  const detail = (over: object = {}) => ({
    skillId: 'x', description: 'x', version: 1,
    manifestYaml: 'name: x\ndescription: x\nversion: 1',
    bodyMd: 'b', capabilities: { allowedHosts: [], credentials: [], mcpServers: [] },
    defaultAttached: false, updatedAt: new Date().toISOString(),
    sourceUrl: 'https://example.com/skill.md', ...over,
  });

  const mockFetch = (text: string, ok = true, status = 200) => ({
    fetch: async () => ({ ok, status, text: async () => text }),
  });

  describe('checkForUpdates', () => {
    it('returns available=false when sourceUrl is missing', async () => {
      const r = await checkForUpdates(detail({ sourceUrl: undefined }), mockFetch(''));
      expect(r.available).toBe(false);
      expect(r.latestVersion).toBeUndefined();
    });

    it('returns available=true when remote version > current', async () => {
      const remote = '---\nname: x\ndescription: x\nversion: 5\n---\nnew body';
      const r = await checkForUpdates(detail({ version: 2 }), mockFetch(remote));
      expect(r.available).toBe(true);
      expect(r.latestVersion).toBe(5);
      expect(r.latestSkillMd).toBe(remote);
    });

    it('returns available=false when remote version == current', async () => {
      const remote = '---\nname: x\ndescription: x\nversion: 2\n---\nsame body';
      const r = await checkForUpdates(detail({ version: 2 }), mockFetch(remote));
      expect(r.available).toBe(false);
      expect(r.latestVersion).toBe(2);
    });

    it('throws on fetch failure', async () => {
      await expect(
        checkForUpdates(detail(), mockFetch('', false, 404)),
      ).rejects.toThrow(/skill-source-fetch-failed/);
    });

    it('throws on invalid remote manifest', async () => {
      await expect(
        checkForUpdates(detail(), mockFetch('---\nnotmanifest\n---\n')),
      ).rejects.toThrow(/skill-source-manifest-invalid/);
    });
  });
  ```

- [ ] **Step C.12: Run + verify all pass.**

  ```bash
  pnpm test --filter @ax/skills -- check-updates
  ```

- [ ] **Step C.13: Register the hook + admin route.**

  In `packages/skills/src/plugin.ts`, after the existing `skills:list-defaults` registration:

  ```typescript
  bus.registerService<SkillsCheckForUpdatesInput, SkillsCheckForUpdatesOutput>(
    'skills:check-for-updates', PLUGIN_NAME,
    async (_ctx, { skillId }) => {
      const detail = await store.get(skillId);
      return checkForUpdates(detail, { fetch: globalThis.fetch });
    },
  );
  ```

  Add to `provides:` in the manifest at the top of `plugin.ts:45-50`.

  Then `admin-routes.ts`:

  ```typescript
  // POST /admin/skills/:id/check-update
  async checkUpdate(req, res) {
    const actor = await requireAdmin(deps.bus, ctx, req, res);
    if (actor === null) return;
    const { id } = req.params;
    if (!id) { res.status(400).json({ error: 'missing skill id' }); return; }
    try {
      const out = await deps.bus.call('skills:check-for-updates', ctx, { skillId: id });
      res.status(200).json(out);
    } catch (err) {
      if (writeServiceError(res, err)) return;
      throw err;
    }
  },

  // POST /admin/skills/:id/refresh-from-source
  // Convenience: check + if available, upsert.
  async refresh(req, res) {
    const actor = await requireAdmin(deps.bus, ctx, req, res);
    if (actor === null) return;
    const { id } = req.params;
    const check = await deps.bus.call('skills:check-for-updates', ctx, { skillId: id });
    if (!check.available || check.latestSkillMd === undefined) {
      res.status(200).json({ updated: false, currentVersion: check.currentVersion });
      return;
    }
    await deps.bus.call('skills:upsert', ctx, { skillMd: check.latestSkillMd });
    res.status(200).json({ updated: true, newVersion: check.latestVersion });
  },
  ```

  Register the routes alongside the others (line 397-403):

  ```typescript
  { method: 'POST', path: '/admin/skills/:id/check-update', handler: handlers.checkUpdate },
  { method: 'POST', path: '/admin/skills/:id/refresh-from-source', handler: handlers.refresh },
  ```

- [ ] **Step C.14: Admin-route tests.**

  In `packages/skills/src/__tests__/admin-routes.test.ts`, mock the registered service hook (the suite already does this for `skills:list` etc.):

  ```typescript
  it('POST /admin/skills/:id/check-update returns the hook output', async () => {
    bus.registerService('skills:check-for-updates', '@ax/skills',
      async () => ({ available: true, currentVersion: 1, latestVersion: 2, latestSkillMd: '---\nname:x\n---' }));
    const r = await postAsAdmin('/admin/skills/x/check-update');
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);
    expect(r.body.latestVersion).toBe(2);
  });

  it('POST /admin/skills/:id/refresh-from-source upserts when available', async () => {
    // ... set up bus.registerService for both check-for-updates and skills:upsert
    // assert that refresh returns { updated: true, newVersion: 2 } and that skills:upsert was called.
  });
  ```

- [ ] **Step C.15: Run + commit.**

  ```bash
  pnpm build --filter @ax/skills && pnpm test --filter @ax/skills
  git add packages/skills && git commit -m "feat(skills): skills:check-for-updates hook + /check-update + /refresh routes (Phase C step 3/4)"
  ```

### Admin UI badge + button

- [ ] **Step C.16: Invoke shadcn skill.**

  Per CLAUDE.md invariant I6, any UI work goes through the shadcn skill. The shadcn workspace flag is `-c packages/channel-web` (from CLAUDE.md). Confirm `Badge`, `Button`, and `AlertDialog` are installed. If `Badge` is missing, install:

  ```bash
  pnpm dlx shadcn@latest add badge -c packages/channel-web
  ```

- [ ] **Step C.17: Extend `SkillsTab.tsx`.**

  Locate the existing admin Skills tab. For each row, after fetch:

  ```tsx
  const [updateInfo, setUpdateInfo] = useState<Record<string, CheckUpdateOutput>>({});

  // On mount, for every skill with sourceUrl, fire check-update (best-effort, ignore errors).
  useEffect(() => {
    skills.filter((s) => s.sourceUrl !== undefined).forEach((s) => {
      fetch(`/admin/skills/${s.id}/check-update`, { method: 'POST' })
        .then((r) => r.json())
        .then((j) => setUpdateInfo((m) => ({ ...m, [s.id]: j })))
        .catch(() => { /* swallow -- non-fatal */ });
    });
  }, [skills]);
  ```

  In each row, when `updateInfo[s.id]?.available === true`, render:

  ```tsx
  <Badge variant="secondary">Update available: v{updateInfo[s.id].latestVersion}</Badge>
  <Button size="sm" variant="outline" onClick={() => refresh(s.id)}>Update</Button>
  ```

  `refresh` POSTs to `/admin/skills/:id/refresh-from-source` then reloads the list.

- [ ] **Step C.18: Walk MANUAL-ACCEPTANCE.**

  Add to `MANUAL-ACCEPTANCE.md`:

  ```markdown
  ## Skill versioning + refresh
  1. Install a skill with sourceUrl pointing at a static URL serving v1.
  2. Update the static URL to serve v2.
  3. Reload the admin Skills tab -> "Update available: v2" badge appears.
  4. Click Update -> skill body bumps in DB; reload shows no badge.
  ```

  Walk against `kind ax-next-dev` per [[k8s-acceptance-loop]].

- [ ] **Step C.19: Ship as PR.**

  PR title: `feat(skills): version-aware refresh from sourceUrl (Phase 1 follow-up C)`.

  PR body includes:
  - Attachment-pinning decision from step C-design.1 ("latest-wins, no per-attachment pin").
  - Boundary-review section from step C-design.3.
  - Half-wired window: CLOSED (hook + route + UI all land same PR).

---

## Self-review checklist (run before opening any PR in this plan)

1. **Spec coverage.** Walk the three Phase 1 follow-ups (A parked, B mcpServers, C versioning). Every item is mapped to a Phase or explicitly parked.
2. **Invariants.** Each new hook has a boundary-review section. No cross-plugin imports added.
3. **Half-wired discipline.** Both B and C wire the new code through orchestrator + sandbox + UI in the same PR. ([[feedback_half_wired_window_pattern.md]])
4. **YAGNI.** Phase A is parked rather than pre-built. Phase C does NOT add per-attachment pinning. ([[feedback_yagni_check_in_plans.md]])
5. **Build + lint + test.** `pnpm build && pnpm test && pnpm -w lint` green at each commit. ([[feedback_run_lint_before_pr.md]], [[feedback_run_tsc_alongside_vitest.md]])
6. **Manual acceptance.** Each phase's MANUAL-ACCEPTANCE scenario walked against `kind ax-next-dev` before merge. ([[k8s-acceptance-loop]])
7. **Security note.** Phase B has a saved security-checklist note linked from its PR.

## Execution

When ready to start: see Plan 2 (`2026-05-20-skills-distribution-infra-impl.md`) for the user-installable / promote / canary follow-ups. Plan 1 ships first per the chosen ordering (capability + lifecycle before distribution + infra).
