# JIT — Open-Mode Agent-Authored Skills (flow C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In **open mode** (`allow_user_installed_skills`), let the agent author a skill in its workspace and *install* it as a **user-scoped** skill on the fly — gated by the same bundled approval card (the backstop), with a banner: *"⚠ This is a new skill your assistant just wrote."* After this card, an agent (when the deployment opts in) can write `.ax/skills/<id>/SKILL.md` (+ helper files), call one gated tool naming the hosts/keys it needs, and — once the user approves on the card — answer using the new skill, as one continuous exchange (reusing the TASK-36 re-spawn/resume path).

**Architecture:** Open-mode authoring is implemented as an **in-chat, user-approved version of the existing admin `promoteAuthoredSkill` flow** (`packages/agents/src/admin-routes.ts:629`). The agent writes the skill **body + helper files** into the writable `.ax/skills/<id>/` workspace domain (validator-policed, capability-free — `@ax/validator-skill` strips any self-declared capabilities, unchanged). A new gated host tool **`install_authored_skill`** (registered by `@ax/skill-broker` **only when `allowUserInstalledSkills` is on** — closing TASK-38's half-wired pin) carries the **requested hosts + credential slot names** as arguments. It calls a new `@ax/agents` service hook **`agents:install-authored-skill`**, which reads the authored bundle, builds a manifest carrying *those requested* capabilities (via `buildSkillManifestYaml`), **`skills:upsert`s it to the USER skill store with the bundle's `files[]`** (the first production caller of TASK-32's multi-file write path — **closing the TASK-32 half-wired window**), and **retires the `.ax/skills/<id>/` draft** (the §6D cross-domain move — avoids the project/user duplicate-id collision and stops the agent editing the skill between request and approval). The tool then fires the existing `chat:permission-request` card with `authored: true`. On approval, the card reuses **TASK-36** wholesale: `POST /api/chat/permission-decision` → `agent:apply-capability-grant` resolves the now-existing user-scoped skill, binds its slots, attaches it, retires the warm session; the browser re-issues the turn (`regenerate()`) and the re-spawn's orchestrator union materializes the skill read-only into `.ax/session/skills/` with its declared hosts allowlisted + keys bound. **No change to TASK-36, the orchestrator union, the runner, or the validator.**

**Tech Stack:** TypeScript (pnpm workspace, strict + `exactOptionalPropertyTypes`), the in-process hook bus, kysely + Postgres (testcontainers in the canary), `@ax/skills-parser` (`buildSkillManifestYaml`/`parseSkillManifest`/`splitSkillMd`), React + shadcn primitives in `packages/channel-web`, vitest + `@testing-library/react` (jsdom).

---

## Scope guardrails

- **One new service hook: `agents:install-authored-skill`** (registered by `@ax/agents`; called host-side by `@ax/skill-broker`'s gated tool). Boundary-review note (refining design §11 component #1/#6): *Alternate impl* — today's **workspace-backed** authoring (read the draft from `.ax/skills/<id>/`, upsert to the user store); a future **direct-authoring** backend could accept the bundle inline with no workspace round-trip. The hook abstracts *"promote the agent's just-authored draft into a usable user-scoped skill,"* not "read the workspace." *Payload fields* — in `{ agentId, skillId, hosts, slots }`, out `{ description, hosts, slots }`: all are domain identifiers + **public** manifest data (hostnames, slot **names**) — **no** `sha`/`pod`/`socket`/`bucket`/`generation`/`path` vocabulary, and **never a secret** (the key the user types posts straight to the host credential store via the card, §10). *Subscriber risk* — none; it's a service hook (single impl). *Wire surface* — **NOT an IPC action**: the hook is host-side (`@ax/skill-broker` → `@ax/agents`). The **agent-facing** surface is the new **tool** `tool:execute:install_authored_skill`, whose input schema lives in `@ax/skill-broker` (each plugin owns its slice of the agent→host wire surface).
- **One changed subscriber payload: `chat:permission-request` gains `authored?: boolean`** (an optional, public banner flag). Backend-agnostic; no leak; the channel-web SSE subscriber forwards it verbatim. Re-declared independently at the broker, the channel-web server type, and the client store (I2 — no shared import).
- **No cross-plugin imports (invariant I2).** `@ax/skill-broker` reaches `@ax/agents` only through the bus (`agents:install-authored-skill`); `@ax/agents` reaches `@ax/skills`/the workspace only through the bus (`skills:upsert`, `workspace:list`/`read`/`apply`). No new `@ax/*` import beyond `@ax/core`. The `skill:<id>:<slot>` credential-ref scheme is **not** referenced here — TASK-36's grant re-derives it on approval.
- **One source of truth (invariant I4).** The authored skill's canonical home is the **user skill store** (`@ax/skills`), reached via `skills:upsert`. The `.ax/skills/<id>/` workspace draft is **retired** on install (no second copy → no SDK duplicate-id collision). Manifest validation (host/slot shape) is owned by `skills:upsert`'s `parseSkillManifest` — the broker tool only loose-checks shapes for an early, friendly tool error. Per-user attachment + the credential the user typed are owned by `@ax/skills` / the host credential store exactly as in the curated path; TASK-39 adds **no** new store.
- **Capabilities minimized (invariant I5).** The authoring tool **exists only when `allow_user_installed_skills` is on** (default off — §10's conservative default, pinned by TASK-38). It grants exactly: write **one user-scoped skill for the actor's own agent** + surface a card. Never an admin, never another user, never blanket egress. The requested `hosts`/`slots` are **untrusted model input** — they are surfaced on the card for explicit **user** approval (the backstop) and never take effect until the user attaches via TASK-36's grant. The authored bundle **code** grants nothing beyond the agent's existing Bash tool in the same sandbox (design §9.2 open-mode caveat).
- **Security-checklist applies** (untrusted-content-steering-authoring + sandbox bundle materialization + credential path) — it is a **pre-PR gate** (Task 6 Step 4). The card body flags it; design §10 mandates it for the JIT surface. Pre-stated threat model in [Security threat model](#security-threat-model-pre-stated).
- **UI uses the `shadcn` skill** (invariant #6). Task 5 only *extends* TASK-35's `<PermissionCard>` (adds an `Alert` banner — an installed primitive); invoke the `shadcn` skill before editing it and keep semantic tokens / installed primitives (workspace flag `-c packages/channel-web`).
- **Half-wired window (stated):** see [Half-wired window](#half-wired-window) — this card **CLOSES** the TASK-32 `skills:upsert files[]` write-path window (first production caller) **and** TASK-38's "broker registers the same tools in both modes" pin. The approval→attach→re-spawn half is owned by **TASK-36** (a dep, merged before this drains); share-to-catalog (§6D), the admit queue, the service-keyed vault (P2), and the settings mirror (P3) are other cards / Part II.

## Dependency status & as-built re-verification (READ FIRST)

This card **Depends on TASK-36** (re-spawn/resume) **and TASK-38** (the mode flag). `yolo-ship` only pulls it once **both are Done**, so by execution time TASK-32/33/34/35/36/38 are merged to `main`. **Verified at authoring time (2026-05-26):**

- **TASK-38 — MERGED** (`c989a14a`, PR #186; the board lane briefly lagged at "In Progress" but the code is on `main`). `createSkillBrokerPlugin(config: SkillBrokerConfig = {})` accepts `{ allowUserInstalledSkills?: boolean }` and returns `SkillBrokerPlugin` with `readonly allowUserInstalledSkills` (`packages/skill-broker/src/plugin.ts:43-46`). **Build directly on it** — Task 4 makes the broker *read* this flag to register the authoring tool, closing the TASK-38 half-wired pin (`packages/skill-broker/src/__tests__/plugin.test.ts:193-206`, the "registers the same tools whether open mode is on or off" test — Task 4 **rewrites** it).
- **TASK-36 — NOT on `main` at authoring time** (In Progress). `agent:apply-capability-grant`, `POST /api/chat/permission-decision`, the card `Connect → decision → continueAfterGrant()` evolution, and `resume-actions` are taken from the **committed TASK-36 impl plan** (`docs/plans/2026-05-26-jit-pending-turn-re-spawn-resume-orchestration-impl.md`). TASK-39's approval path **reuses TASK-36 unchanged** (an authored, upserted user-scoped skill is resolvable + attachable exactly like a catalog skill). **Re-confirm before Task 5/6** (hard requirement #1) and adjust if any of these moved.

Re-confirm against `main` before Task 1 (do not trust file:line anchors):

- [ ] **Validator strips authored capabilities (UNCHANGED, on `main`).** `@ax/validator-skill` matches `.ax/skills/<id>/SKILL.md` (`packages/validator-skill/src/plugin.ts:51`) and `stripCapabilitiesFromFrontmatter` removes any `capabilities:` block before storage (`plugin.ts:147`). So the authored workspace file is **capability-free** — TASK-39 carries the requested hosts/slots as **tool arguments**, not in the file. Confirm the strip + the `.ax/skills/<id>/SKILL.md` match are still in place.
- [ ] **`agents:list-authored-skills` + `listAuthoredSkills` (on `main`).** `packages/agents/src/authored-skills.ts` reads `.ax/skills/*/SKILL.md` via `workspace:list`/`workspace:read` (soft deps via `hasService`) and flags `hasForbiddenCapabilities`; the hook handler resolves the agent + restricts to **personal agents** (`ownerType === 'user'`) and routes a ctx rooted in `agent.ownerId` (`packages/agents/src/plugin.ts:308-323`). Task 1/2 mirror this ctx-routing + personal-agent restriction.
- [ ] **Admin `promoteAuthoredSkill` precedent (on `main`).** `packages/agents/src/admin-routes.ts:629-740` builds the manifest from **admin grants** (the authored file's caps are **ignored**) and `skills:upsert`s to **global or user** scope. Task 2 is the in-chat, user-approved, user-scope-only analog (grants come from the tool args, approved on the card).
- [ ] **`skills:upsert` user-scope + `files[]` (TASK-32/33, on `main`).** `packages/skills/src/plugin.ts:261-353`: validates `manifestYaml` via `parseSkillManifest` (throws `invalid-host`/`invalid-slot`/etc.), validates optional `files` via `validateBundleFiles` (throws `invalid-bundle-file` for traversal / `.mcp.json` / `.claude/` / `.git/` / caps — `plugin.ts:316`), and for `scope: 'user'` + `ownerUserId` writes to the user store (`plugin.ts:333-352`). `SkillsUpsertInput.files?: BundleFile[]` (`packages/skills/src/types.ts:69-84`). Confirm the user-scope path + `files` threading are intact.
- [ ] **Orchestrator union materializes attached user-scoped skills (TASK-33, on `main`).** A skill in `skills:list-user-attachments` → resolved via `skills:resolve({ ownerUserId })` → its `capabilities.allowedHosts` unioned into the proxy allowlist + `credentialBindings[slot]` bound, and its `files[]` materialized read-only into `.ax/session/skills/<id>/` (`packages/chat-orchestrator/src/orchestrator.ts:1088-1285`). This is how the authored skill's hosts/keys take effect after attach — **no new orchestrator code**. Confirm `installedSkillsForSandbox` builds `files: [SKILL.md, ...s.files]` (`orchestrator.ts:1253-1285`).
- [ ] **Runner materialization + SDK sources (on `main`).** `installed-skills.ts` writes `$CLAUDE_CONFIG_DIR/skills/<id>/` (= `.ax/session/skills/`) at `0o444`/`0o555` with the extract-boundary re-validation (path/veto/no-exec-bit) unchanged; `git-workspace.ts:208-211` lays the `.claude/skills → ../.ax/skills` symlink; `main.ts:869` runs `settingSources: ['user', 'project']`. So a skill id present in **both** `.ax/session/skills/` (user) and `.ax/skills/` (project) **collides** (design §6D) — which is why Task 2 **retires** the draft.
- [ ] **`chat:permission-request` + `<PermissionCard>` (TASK-35, on `main`).** Server payload `PermissionRequest { skillId, description, hosts, slots: { slot, kind }[] }` (`packages/channel-web/src/server/types.ts:105`); SSE subscriber forwards it verbatim (`packages/channel-web/src/server/sse.ts:354-359`); transport routes the frame to `permissionCardActions.show(...)` (`packages/channel-web/src/lib/transport.ts:673-674`); client store mirror (`packages/channel-web/src/lib/permission-card-store.ts:12-17`); `<PermissionCard>` renders it (`packages/channel-web/src/components/PermissionCard.tsx`). Task 5 adds `authored?: boolean` to all three independent declarations + a banner. **NOTE:** TASK-36 also edits `<PermissionCard>` (Connect → decision POST). Apply Task 5 **on top of** TASK-36's version (it only adds a banner block — orthogonal to the Connect handler).
- [ ] **Broker tool-registration pattern + `toolCtx` identity (on `main`).** `registerSearchCatalog`/`registerRequestCapability` call `bus.call('tool:register', descriptor)` then `bus.registerService('tool:execute:<name>', …)` (`packages/skill-broker/src/tools/*.ts`). Confirm the execute `toolCtx` carries the real **`agentId`** (request_capability already relies on `toolCtx.conversationId`); Task 3 passes `toolCtx.agentId` to the agents hook. If `agentId` is not populated on the tool ctx, route the agent another way (e.g. resolve the conversation's agent) — flag it.
- [ ] **`workspace:list` glob (on `main`).** `packages/workspace-git-core/src/impl.ts:912` matches `pathGlob` with `picomatch(input.pathGlob, { dot: true })`. Confirm `'.ax/skills/<id>/**'` matches both `SKILL.md` and nested files (e.g. `scripts/run.py`) with dotfiles included; if `**` semantics differ, list `'.ax/skills/<id>/*'` plus a recursive pass.

> **Implementation forks resolved (hard requirement #7):**
>
> 1. **Where the authored skill lives + how it carries capabilities — RESOLVED WITH THE HUMAN (this session): promote-to-user-store via tool args.** The agent writes the skill **body + helper files** into `.ax/skills/<id>/` (validator-policed, capability-free); the install tool carries the requested **hosts/slots** as arguments; the host `skills:upsert`s a **user-scoped** skill (body + `files[]` + requested caps); on approval TASK-36's grant attaches + re-spawns. **Rationale:** mirrors the existing admin `promoteAuthoredSkill` precedent; closes the TASK-32 `skills:upsert files[]` window; reuses TASK-33/35/36 wholesale; the user store (→ `.ax/session/skills/`, SDK `user` source) is the canonical home for a *usable* user-scoped skill; the validator's capability-strip security control is **unchanged**. Decision #8's `.ax/skills` RW domain is honored as the **authoring/draft** domain; the move to the user store mirrors §6D's cross-domain promotion. (The rejected alternatives — relaxing the validator to honor self-declared caps, or a pure-workspace tool that never upserts — either weaken a security control or fail to close the TASK-32 window.)
> 2. **Upsert at request vs. approval — RESOLVED: at request** (when the tool is called). **Rationale:** the user-scoped skill must already exist for TASK-36's `agent:apply-capability-grant` to resolve+attach it on approval — upserting at request keeps the **approval path unchanged** (it's a plain user-scoped skill). The skill is **inert until attached** (the orchestrator union only grants hosts/binds keys for *attached* skills, and `defaultAttached` is false), so upsert-before-approval grants nothing.
> 3. **Retire the draft at request vs. approval — RESOLVED: at request** (right after upsert). **Rationale:** (a) collision-safety — the draft is gone before any re-spawn materializes the user-store copy to `.ax/session/skills/`; (b) integrity — the agent cannot edit the skill between request and approval (mirrors §6D's working-copy retirement: "an editable local copy would let the agent fork the vetted skill and re-add egress"); (c) keeps authoring-specific cleanup out of TASK-36's generic grant hook. **Known residual:** if the user **declines**, the user-store skill is left unattached (invisible to the SDK — not materialized — and harmless) and the draft is gone → re-author to retry (the §6D "re-edit = new draft" pattern). Part II "Connections" settings will surface/remove orphaned user skills.
> 4. **Capabilities from tool args vs. authored manifest — RESOLVED: tool args.** The validator strips `capabilities:` from `.ax/skills/<id>/SKILL.md` (I-P1-2, unchanged), so the authored file is capability-free. The agent declares the requested `hosts`/`slots` as **tool arguments**; the host builds the upserted manifest from them via `buildSkillManifestYaml`. Functionally identical to "the manifest declares them," but keeps the workspace security control intact. `skills:upsert`'s `parseSkillManifest` is the **one** authority that validates host/slot shapes (`invalid-host`/`invalid-slot`).
> 5. **Which plugin owns read+build+upsert+retire — RESOLVED: `@ax/agents`** (new `agents:install-authored-skill` hook). **Rationale:** `@ax/agents` already owns authored-skill workspace reading (`listAuthoredSkills` + `agents:list-authored-skills`) and the promote→`skills:upsert` flow (`promoteAuthoredSkill`), and already soft-deps `workspace:list/read` + `skills:upsert`. The broker stays the thin surfacing spine (registers the gated tool + fires the card).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/agents/src/authored-skills.ts` | authored-skill workspace reads | **add** `readAuthoredBundle` (reads SKILL.md + extra files for one id) + `AuthoredBundle` type |
| `packages/agents/src/types.ts` | public hook payload types | **add** `AgentsInstallAuthoredSkill{Input,Output}` + `AgentsInstallAuthoredSkillOutputSchema` |
| `packages/agents/src/plugin.ts` | hook registration + manifest | **register** `agents:install-authored-skill`; **add** it to `registers`; **add** `optionalCalls` for `skills:upsert`/`workspace:list`/`workspace:read`/`workspace:apply` |
| `packages/agents/src/__tests__/install-authored-skill.test.ts` | **new** — hook unit tests | **create** |
| `packages/agents/src/__tests__/authored-skills.test.ts` | bundle-read tests | **extend** — `readAuthoredBundle` multi-file + missing/malformed |
| `packages/skill-broker/src/tools/install-authored-skill.ts` | **new** — gated authoring tool | **create** |
| `packages/skill-broker/src/plugin.ts` | broker factory | **conditionally register** the tool when `allowUserInstalledSkills`; add `optionalCalls` |
| `packages/skill-broker/src/index.ts` | package surface | **export** `INSTALL_AUTHORED_SKILL_DESCRIPTOR` |
| `packages/skill-broker/src/__tests__/plugin.test.ts` | broker tests | **rewrite** the TASK-38 half-wired pin → "authoring tool registered ONLY in open mode"; **add** tool behavior tests |
| `packages/channel-web/src/server/types.ts` | SSE `PermissionRequest` | **add** `authored?: boolean` |
| `packages/channel-web/src/lib/permission-card-store.ts` | client `PermissionRequest` | **add** `authored?: boolean` |
| `packages/channel-web/src/components/PermissionCard.tsx` | the bundled approval card | **add** the open-mode banner (`Alert`) when `authored` |
| `packages/channel-web/src/__tests__/permission-card.test.tsx` | card tests | **extend** — banner renders iff `authored` |
| `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` | end-to-end canary | **extend** — open-mode authoring: tool → user-store bundle (`files[]`) + draft retired + card `authored:true`; attach → fresh open includes it + its files |

---

## Shared rule: building the upserted manifest (referenced by Task 2)

For an authored skill `<skillId>` whose draft body lives at `.ax/skills/<skillId>/SKILL.md` (capability-free) and whose user-**requested** hosts/slots are `hosts[]` / `slots[]`, the upserted user-scoped manifest is:

```
buildSkillManifestYaml({
  id: <skillId>,
  description: <from the authored SKILL.md>,
  version:     <from the authored SKILL.md, or 1>,
  capabilities: { allowedHosts: hosts, credentials: slots.map(s => ({ slot: s, kind: 'api-key' })), mcpServers: [], packages: { npm: [], pypi: [] } },
})
```

— the same shape the admin `promoteAuthoredSkill` builds from admin grants (`packages/agents/src/admin-routes.ts:688-698`), except the grants come from the **tool arguments** (surfaced on the card for the **user** to approve). `skills:upsert` re-validates this manifest (`parseSkillManifest`) and the bundle `files[]` (`validateBundleFiles`) — those are the single source of truth for validity; the broker tool only loose-checks shapes for an early tool error.

---

### Task 1: `@ax/agents` — `readAuthoredBundle` (read SKILL.md + helper files for one id)

**Files:**
- Modify: `packages/agents/src/authored-skills.ts`
- Test: `packages/agents/src/__tests__/authored-skills.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/agents/src/__tests__/authored-skills.test.ts` (reuse the file's `createTestHarness({ services })` workspace-mock pattern — `workspace:list`/`workspace:read` over an in-memory snapshot; mirror the existing `listAuthoredSkills` cases):

```typescript
import { readAuthoredBundle } from '../authored-skills.js';

it('readAuthoredBundle returns the manifest body + extra files (paths relative to the skill dir)', async () => {
  const files = new Map<string, string>([
    ['.ax/skills/notes/SKILL.md', '---\nname: notes\ndescription: Take notes\nversion: 2\n---\nBody here'],
    ['.ax/skills/notes/scripts/run.py', 'print(1)'],
    ['.ax/skills/notes/data/x.json', '{}'],
  ]);
  const h = await createTestHarness({
    services: {
      'workspace:list': async (_c, input: unknown) => {
        const glob = (input as { pathGlob: string }).pathGlob;
        const prefix = glob.replace(/\*\*$/, '');
        return { paths: [...files.keys()].filter((p) => p.startsWith(prefix)) };
      },
      'workspace:read': async (_c, input: unknown) => {
        const p = (input as { path: string }).path;
        const v = files.get(p);
        return v === undefined ? { found: false } : { found: true, bytes: new TextEncoder().encode(v) };
      },
    },
  });

  const bundle = await readAuthoredBundle(h.bus, 'user-1', 'agent-1', 'notes');
  expect(bundle).not.toBeNull();
  expect(bundle!.description).toBe('Take notes');
  expect(bundle!.version).toBe(2);
  expect(bundle!.bodyMd).toBe('Body here');
  expect(bundle!.files).toEqual([
    { path: 'data/x.json', contents: '{}' },
    { path: 'scripts/run.py', contents: 'print(1)' },
  ]);
});

it('readAuthoredBundle returns null when there is no SKILL.md', async () => {
  const h = await createTestHarness({
    services: {
      'workspace:list': async () => ({ paths: ['.ax/skills/empty/notes.txt'] }),
      'workspace:read': async () => ({ found: true, bytes: new TextEncoder().encode('x') }),
    },
  });
  expect(await readAuthoredBundle(h.bus, 'user-1', 'agent-1', 'empty')).toBeNull();
});

it('readAuthoredBundle rejects a traversal-shaped skill id', async () => {
  const h = await createTestHarness({ services: {} });
  await expect(readAuthoredBundle(h.bus, 'user-1', 'agent-1', '../evil')).rejects.toThrow(/invalid/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/agents test -- src/__tests__/authored-skills.test.ts`
Expected: FAIL — `readAuthoredBundle` is not exported.

- [ ] **Step 3: Implement `readAuthoredBundle`**

In `packages/agents/src/authored-skills.ts`, add (reuse the existing `splitSkillMd`/`parseSkillManifest` imports + the ctx-routing comment from `listAuthoredSkills`):

```typescript
/** An extra (non-SKILL.md) bundle file, path relative to the skill dir. */
export interface AuthoredBundleFile {
  path: string;
  contents: string;
}

/** A full agent-authored bundle read from `.ax/skills/<id>/`. */
export interface AuthoredBundle {
  id: string;
  description: string;
  version: number;
  bodyMd: string;
  files: AuthoredBundleFile[];
}

// Re-validated at this trust boundary (I2/I5) — never interpolate an
// unvalidated id into a workspace glob. Mirrors @ax/skill-broker's SKILL_ID_RE.
const AUTHORED_SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * Read the FULL agent-authored bundle (SKILL.md → manifest+body, plus every
 * helper file) under `.ax/skills/<skillId>/`. Returns null when there is no
 * canonical SKILL.md (missing / no frontmatter / malformed YAML) — the caller
 * surfaces a friendly "author it first" message rather than throwing.
 *
 * Same ctx routing as listAuthoredSkills: workspace:list/read key off
 * ctx.userId + ctx.agentId (hashed to a workspace shard), so we root a fresh
 * ctx in the agent OWNER's identity to read THAT agent's workspace.
 */
export async function readAuthoredBundle(
  bus: HookBus,
  ownerUserId: string,
  agentId: string,
  skillId: string,
): Promise<AuthoredBundle | null> {
  if (!AUTHORED_SKILL_ID_RE.test(skillId)) {
    throw new Error(`invalid authored skill id: ${JSON.stringify(skillId)}`);
  }
  if (!bus.hasService('workspace:list') || !bus.hasService('workspace:read')) {
    return null;
  }
  const ctx = makeAgentContext({ userId: ownerUserId, agentId, sessionId: 'authored-bundle-read' });
  const dir = `.ax/skills/${skillId}`;
  const { paths } = await bus.call<{ pathGlob: string }, { paths: string[] }>(
    'workspace:list',
    ctx,
    { pathGlob: `${dir}/**` },
  );

  let manifestSeen = false;
  let description = '';
  let version = 1;
  let bodyMd = '';
  const files: AuthoredBundleFile[] = [];

  for (const p of [...paths].sort()) {
    const read = await bus.call<
      { path: string },
      { found: true; bytes: Uint8Array } | { found: false }
    >('workspace:read', ctx, { path: p });
    if (!read.found) continue; // deleted between list and read — skip
    const rel = p.slice(dir.length + 1); // strip ".ax/skills/<id>/"
    if (rel.length === 0) continue;

    if (rel === 'SKILL.md') {
      const content = new TextDecoder().decode(read.bytes);
      const split = splitSkillMd(content);
      if (split === null) return null; // not a canonical SKILL.md
      const parsed = parseSkillManifest(split.manifestYaml);
      if (!parsed.ok) return null; // malformed — let the agent fix it
      manifestSeen = true;
      description = parsed.value.description;
      version = parsed.value.version;
      bodyMd = split.bodyMd;
    } else {
      files.push({ path: rel, contents: new TextDecoder().decode(read.bytes) });
    }
  }

  if (!manifestSeen) return null; // no SKILL.md → not an authored skill
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { id: skillId, description, version, bodyMd, files };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/agents test -- src/__tests__/authored-skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/authored-skills.ts packages/agents/src/__tests__/authored-skills.test.ts
git commit -m "feat(agents): readAuthoredBundle — read SKILL.md + helper files for one authored skill"
```

---

### Task 2: `@ax/agents` — `agents:install-authored-skill` hook

**Files:**
- Modify: `packages/agents/src/types.ts`, `packages/agents/src/plugin.ts`
- Test: `packages/agents/src/__tests__/install-authored-skill.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/__tests__/install-authored-skill.test.ts` (mirror `promote-authored-skills.test.ts`'s `createTestHarness` + a personal-agent row in the local store + workspace + `skills:upsert` mocks):

```typescript
import { describe, it, expect } from 'vitest';
import { makeAgentContext } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createAgentsPlugin } from '../index.js';

interface UpsertCall { manifestYaml: string; bodyMd: string; files?: unknown; scope?: string; ownerUserId?: string }

async function harness(opts: { ownerType?: 'user' | 'team' } = {}) {
  const ownerType = opts.ownerType ?? 'user';
  const upserts: UpsertCall[] = [];
  const applied: Array<{ changes: Array<{ path: string; kind: string }> }> = [];
  const ws = new Map<string, string>([
    ['.ax/skills/notes/SKILL.md', '---\nname: notes\ndescription: Take notes\nversion: 1\n---\nBody'],
    ['.ax/skills/notes/scripts/run.py', 'print(1)'],
  ]);
  const h = await createTestHarness({
    services: {
      // Personal agent owned by user-1 (so the hook resolves the owner).
      // NOTE: the agents plugin reads its OWN store; in this harness we stub
      // the minimum the hook needs. If createAgentsPlugin requires a real DB
      // row, seed it via the plugin's agents:create instead (see existing
      // promote-authored-skills.test.ts setup).
      'workspace:list': async (_c, input: unknown) => {
        const glob = (input as { pathGlob: string }).pathGlob.replace(/\*\*$/, '');
        return { paths: [...ws.keys()].filter((p) => p.startsWith(glob)) };
      },
      'workspace:read': async (_c, input: unknown) => {
        const v = ws.get((input as { path: string }).path);
        return v === undefined ? { found: false } : { found: true, bytes: new TextEncoder().encode(v) };
      },
      'workspace:apply': async (_c, input: unknown) => {
        const changes = (input as { changes: Array<{ path: string; kind: string }> }).changes;
        applied.push({ changes });
        for (const c of changes) if (c.kind === 'delete') ws.delete(c.path);
        return { version: 'v1', delta: { before: null, after: 'v1', changes: [] } };
      },
      'skills:upsert': async (_c, input: unknown) => {
        upserts.push(input as UpsertCall);
        return { skillId: 'notes', created: true };
      },
    },
    plugins: [createAgentsPlugin()],
  });
  // Seed a personal agent the hook can resolve (use the file's existing helper
  // / agents:create; pseudo-shown here):
  const agentId = await seedPersonalAgent(h, { ownerUserId: 'user-1', ownerType });
  return { h, agentId, upserts, applied, ws };
}

function ctx(agentId: string) {
  return makeAgentContext({ sessionId: 's', agentId, userId: 'user-1', conversationId: 'cnv-1' });
}

describe('agents:install-authored-skill', () => {
  it('upserts a user-scoped skill with the bundle files + requested caps, then retires the draft', async () => {
    const { h, agentId, upserts, ws } = await harness();
    const out = await h.bus.call('agents:install-authored-skill', ctx(agentId), {
      agentId, skillId: 'notes', hosts: ['api.example.com'], slots: ['api_key'],
    });
    expect(out).toEqual({
      description: 'Take notes',
      hosts: ['api.example.com'],
      slots: [{ slot: 'api_key', kind: 'api-key' }],
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.scope).toBe('user');
    expect(upserts[0]!.ownerUserId).toBe('user-1');
    expect(upserts[0]!.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
    expect(upserts[0]!.manifestYaml).toContain('api.example.com');
    expect(upserts[0]!.manifestYaml).toContain('api_key');
    // Draft retired: every .ax/skills/notes/* path is gone from the workspace.
    expect([...ws.keys()].some((p) => p.startsWith('.ax/skills/notes/'))).toBe(false);
  });

  it('throws authored-skill-not-found when no SKILL.md exists for the id', async () => {
    const { h, agentId } = await harness();
    await expect(
      h.bus.call('agents:install-authored-skill', ctx(agentId), {
        agentId, skillId: 'ghost', hosts: [], slots: [],
      }),
    ).rejects.toThrow(/authored-skill-not-found|no authored skill/i);
  });

  it('rejects authoring on a team agent (no single-owner workspace)', async () => {
    const { h, agentId } = await harness({ ownerType: 'team' });
    await expect(
      h.bus.call('agents:install-authored-skill', ctx(agentId), {
        agentId, skillId: 'notes', hosts: [], slots: [],
      }),
    ).rejects.toThrow(/unsupported|personal/i);
  });
});
```

> `seedPersonalAgent` is a placeholder for the file's real agent-seeding (use the existing `promote-authored-skills.test.ts` setup — create a personal agent via the plugin's `agents:create` so `localStore.getById` returns `ownerType: 'user'`, `ownerId: 'user-1'`). Match its idioms.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/agents test -- src/__tests__/install-authored-skill.test.ts`
Expected: FAIL — `no service registered for 'agents:install-authored-skill'`.

- [ ] **Step 3: Add the I/O types + return schema**

In `packages/agents/src/types.ts` (next to the `AgentsListAuthoredSkills*` types; import `z`/`ZodType` if not present — mirror the existing return-schema casts in this file):

```typescript
// --- agents:install-authored-skill (TASK-39, open-mode authoring) ------------
//
// Promote an agent-authored workspace draft (.ax/skills/<id>/) into a USABLE
// USER-scoped skill carrying the user-REQUESTED capabilities, then retire the
// draft. The requested hosts/slots are surfaced on the approval card for the
// user to approve (design §6C/§10). Storage-agnostic: `hosts`/`slots` are
// public manifest data; no secret, no backend vocabulary. Alternate impl: a
// non-workspace authoring backend that accepts the bundle inline.
export interface AgentsInstallAuthoredSkillInput {
  agentId: string;
  skillId: string;
  /** Hostnames the skill needs to reach (user-approved on the card). */
  hosts: string[];
  /** Credential slot names the skill needs (user-approved on the card). */
  slots: string[];
}
export interface AgentsInstallAuthoredSkillOutput {
  /** From the authored SKILL.md — shown on the card. */
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
}

export const AgentsInstallAuthoredSkillOutputSchema = z.object({
  description: z.string(),
  hosts: z.array(z.string()),
  slots: z.array(z.object({ slot: z.string(), kind: z.literal('api-key') })),
}) as unknown as ZodType<AgentsInstallAuthoredSkillOutput>;
```

- [ ] **Step 4: Register the hook + extend the manifest**

In `packages/agents/src/plugin.ts`, import the new types + `readAuthoredBundle` + `buildSkillManifestYaml` (from `@ax/skills-parser`, already a dep) + `PluginError` (from `@ax/core`), then register the service after `agents:list-authored-skills`:

```typescript
bus.registerService<AgentsInstallAuthoredSkillInput, AgentsInstallAuthoredSkillOutput>(
  'agents:install-authored-skill',
  PLUGIN_NAME,
  async (ctx, input) => {
    // Personal agents only — same restriction as agents:list-authored-skills
    // (team agents have no single-owner workspace to route the read/retire).
    const agent = await localStore.getById(input.agentId);
    if (agent === null || agent.ownerType !== 'user') {
      throw new PluginError({
        code: 'authored-skill-unsupported',
        plugin: PLUGIN_NAME,
        message: 'authoring is supported only for personal agents',
      });
    }
    const ownerUserId = agent.ownerId;

    // 1. Read the writable draft bundle (body + helper files), capability-free
    //    (the validator strips caps at the .ax/skills boundary — I-P1-2).
    const bundle = await readAuthoredBundle(bus, ownerUserId, input.agentId, input.skillId);
    if (bundle === null) {
      throw new PluginError({
        code: 'authored-skill-not-found',
        plugin: PLUGIN_NAME,
        message: `no authored skill '${input.skillId}' in the workspace`,
      });
    }

    // 2. Build the manifest from the user-REQUESTED capabilities (the card
    //    surfaces these). Like admin promoteAuthoredSkill, the authored file's
    //    own caps are NOT used (they were stripped at write time).
    const slots = input.slots.map((s) => ({ slot: s, kind: 'api-key' as const }));
    const manifestYaml = buildSkillManifestYaml({
      id: bundle.id,
      description: bundle.description,
      version: bundle.version,
      capabilities: {
        allowedHosts: input.hosts,
        credentials: slots,
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
    });

    // 3. Upsert to the USER skill store WITH the bundle's helper files — the
    //    first production caller of TASK-32's files[] write path (CLOSES the
    //    window). skills:upsert validates the manifest (invalid-host/-slot) and
    //    the files (validateBundleFiles: traversal / .mcp.json / .claude / caps);
    //    those PluginErrors propagate to the broker tool unchanged.
    if (!bus.hasService('skills:upsert')) {
      throw new PluginError({
        code: 'skills-plugin-not-loaded',
        plugin: PLUGIN_NAME,
        message: 'skills:upsert is required to install an authored skill',
      });
    }
    await bus.call<
      {
        manifestYaml: string;
        bodyMd: string;
        files: Array<{ path: string; contents: string }>;
        scope: 'user';
        ownerUserId: string;
      },
      { skillId: string; created: boolean }
    >('skills:upsert', ctx, {
      manifestYaml,
      bodyMd: bundle.bodyMd,
      files: bundle.files,
      scope: 'user',
      ownerUserId,
    });

    // 4. Retire the writable .ax/skills/<id>/ draft (the §6D cross-domain move):
    //    the canonical copy is now the user store. Prevents the project/user
    //    duplicate-id collision after re-spawn AND stops the agent editing the
    //    skill between request and approval (integrity). Best-effort; on a
    //    workspace-less preset it no-ops.
    if (bus.hasService('workspace:list') && bus.hasService('workspace:apply')) {
      const wsCtx = makeAgentContext({
        userId: ownerUserId,
        agentId: input.agentId,
        sessionId: 'authored-bundle-retire',
      });
      const { paths } = await bus.call<{ pathGlob: string }, { paths: string[] }>(
        'workspace:list',
        wsCtx,
        { pathGlob: `.ax/skills/${input.skillId}/**` },
      );
      if (paths.length > 0) {
        await bus.call<
          { changes: Array<{ path: string; kind: 'delete' }>; parent: null },
          unknown
        >('workspace:apply', wsCtx, {
          changes: paths.map((p) => ({ path: p, kind: 'delete' as const })),
          parent: null,
        });
      }
    }

    return { description: bundle.description, hosts: input.hosts, slots };
  },
  { returns: AgentsInstallAuthoredSkillOutputSchema },
);
```

Add `'agents:install-authored-skill'` to the manifest `registers` array, and add an `optionalCalls` block (these are the soft deps the new hook — and the existing `agents:list-authored-skills` — use via `hasService`; declaring them at the manifest level is the convention-correct upgrade over a bare comment):

```typescript
optionalCalls: [
  { hook: 'skills:upsert', degradation: 'open-mode authoring (agents:install-authored-skill) cannot persist a skill; agent-authored installs are unavailable' },
  { hook: 'workspace:list', degradation: 'authored-skill discovery + retire are skipped (no workspace backend)' },
  { hook: 'workspace:read', degradation: 'authored-skill bodies cannot be read (no workspace backend)' },
  { hook: 'workspace:apply', degradation: 'the .ax/skills/<id>/ draft is not retired after install (leaves a duplicate-id risk if the same id is later attached)' },
],
```

(If the manifest-shape test in this package asserts the absence of `optionalCalls`, this is an additive change — `PluginManifestSchema` permits the field; update the assertion if needed.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/agents test -- src/__tests__/install-authored-skill.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/types.ts packages/agents/src/plugin.ts packages/agents/src/__tests__/install-authored-skill.test.ts
git commit -m "feat(agents): agents:install-authored-skill (promote draft -> user-scoped bundle + retire)"
```

---

### Task 3: `@ax/skill-broker` — the gated `install_authored_skill` tool

**Files:**
- Create: `packages/skill-broker/src/tools/install-authored-skill.ts`
- Test: `packages/skill-broker/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/skill-broker/src/__tests__/plugin.test.ts`. Extend `busWithStubs()` (or add a local variant) so it also stubs `agents:install-authored-skill` + captures `chat:permission-request` fires:

```typescript
import { registerInstallAuthoredSkill } from '../tools/install-authored-skill.js';
import { makeAgentContext } from '@ax/core';

function busForAuthoring() {
  const { bus, registered } = busWithStubs();
  const grants: unknown[] = [];
  const cards: unknown[] = [];
  bus.registerService('agents:install-authored-skill', 'agents', async (_c, input: unknown) => {
    grants.push(input);
    return { description: 'Take notes', hosts: ['api.example.com'], slots: [{ slot: 'api_key', kind: 'api-key' }] };
  });
  bus.subscribe('chat:permission-request', 'test/card', async (_c, payload) => {
    cards.push(payload);
    return undefined;
  });
  return { bus, registered, grants, cards };
}

function toolCtx() {
  return makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'user-1', conversationId: 'cnv-1' });
}

describe('install_authored_skill tool', () => {
  it('registers the descriptor', async () => {
    const { bus, registered } = busForAuthoring();
    await registerInstallAuthoredSkill(bus);
    expect(registered).toContain('install_authored_skill');
  });

  it('calls agents:install-authored-skill then fires an authored permission card', async () => {
    const { bus, grants, cards } = busForAuthoring();
    await registerInstallAuthoredSkill(bus);
    const out = await bus.call('tool:execute:install_authored_skill', toolCtx(), {
      name: 'install_authored_skill',
      input: { skillId: 'notes', hosts: ['api.example.com'], slots: ['api_key'] },
    });
    expect(out).toEqual({ status: 'requested', skillId: 'notes' });
    expect(grants).toEqual([{ agentId: 'agent-1', skillId: 'notes', hosts: ['api.example.com'], slots: ['api_key'] }]);
    expect(cards).toEqual([{
      skillId: 'notes',
      description: 'Take notes',
      hosts: ['api.example.com'],
      slots: [{ slot: 'api_key', kind: 'api-key' }],
      authored: true,
    }]);
  });

  it('rejects a traversal-shaped skillId before reaching the agents hook', async () => {
    const { bus, grants } = busForAuthoring();
    await registerInstallAuthoredSkill(bus);
    await expect(
      bus.call('tool:execute:install_authored_skill', toolCtx(), {
        name: 'install_authored_skill', input: { skillId: '../evil', hosts: [], slots: [] },
      }),
    ).rejects.toThrow(/valid "skillId"|invalid/i);
    expect(grants).toEqual([]);
  });

  it('drops malformed hosts/slots (filtered before the card)', async () => {
    const { bus, grants } = busForAuthoring();
    await registerInstallAuthoredSkill(bus);
    await bus.call('tool:execute:install_authored_skill', toolCtx(), {
      name: 'install_authored_skill',
      input: { skillId: 'notes', hosts: ['ok.example.com', 'bad host!'], slots: ['api_key', 'no-dashes!'] },
    });
    expect(grants[0]).toEqual({ agentId: 'agent-1', skillId: 'notes', hosts: ['ok.example.com'], slots: ['api_key'] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skill-broker test`
Expected: FAIL — cannot find module `../tools/install-authored-skill.js`.

- [ ] **Step 3: Implement the tool**

Create `packages/skill-broker/src/tools/install-authored-skill.ts` (mirror `request-capability.ts`'s structure: descriptor, ID re-validation, `tool:register`, `registerService`, fire the card):

```typescript
import { makeAgentContext, PluginError, type HookBus, type ToolDescriptor } from '@ax/core';

const PLUGIN_NAME = '@ax/skill-broker';
// Re-validated independently at this trust boundary (I2/I5) — never trust the
// model's id/host/slot shapes. skills:upsert's parseSkillManifest is the
// downstream authority (invalid-host / invalid-slot); these are just an early,
// friendly tool-level filter.
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,253}[a-z0-9])?$/i;
const SLOT_RE = /^[A-Za-z0-9_]{1,64}$/;

export const INSTALL_AUTHORED_SKILL_DESCRIPTOR: ToolDescriptor = {
  name: 'install_authored_skill',
  description:
    'Install a skill you authored in this workspace so the user can approve and use it. ' +
    'First write the skill to .ax/skills/<id>/SKILL.md (plus any helper files under that ' +
    'directory), then call this with that id and the hosts + credential slot NAMES the skill ' +
    'needs. The user is shown one approval card listing exactly those hosts/keys before ' +
    'anything runs — do not narrate this step or restate any keys. Once the user approves, the ' +
    'conversation continues automatically; do not ask the user to repeat their request.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      skillId: { type: 'string', description: 'The id you used under .ax/skills/<id>/.' },
      hosts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Hostnames the skill must reach, e.g. api.example.com. May be empty.',
      },
      slots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Credential slot names the skill needs, e.g. api_key. May be empty.',
      },
    },
    required: ['skillId'],
  },
};

// The bundled approval card payload (design §11.3) with the open-mode banner
// flag. Public manifest data only — never a secret. Re-declared (I2) on the
// channel-web server + client; kept in sync by the canary + card tests.
interface PermissionRequestEvent {
  skillId: string;
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
  /** TASK-39: "⚠ This is a new skill your assistant just wrote." */
  authored: true;
}

interface InstallAuthoredSkillResult {
  status: 'requested';
  skillId: string;
}

export async function registerInstallAuthoredSkill(bus: HookBus): Promise<void> {
  const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', initCtx, INSTALL_AUTHORED_SKILL_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, InstallAuthoredSkillResult>(
    'tool:execute:install_authored_skill',
    PLUGIN_NAME,
    async (toolCtx, call) => {
      const input = (call?.input ?? {}) as { skillId?: unknown; hosts?: unknown; slots?: unknown };
      const skillId = typeof input.skillId === 'string' ? input.skillId.trim() : '';
      if (skillId.length === 0 || !SKILL_ID_RE.test(skillId)) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:install_authored_skill',
          message: 'install_authored_skill requires a valid "skillId"',
        });
      }
      const hosts = Array.isArray(input.hosts)
        ? input.hosts.filter((h): h is string => typeof h === 'string' && HOST_RE.test(h))
        : [];
      const slots = Array.isArray(input.slots)
        ? input.slots.filter((s): s is string => typeof s === 'string' && SLOT_RE.test(s))
        : [];

      // Open-mode authoring requires @ax/agents (gated soft dep). Clear tool
      // error (not a boot crash) on a hypothetical agents-less open-mode preset.
      if (!bus.hasService('agents:install-authored-skill')) {
        throw new PluginError({
          code: 'authoring-unavailable',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:install_authored_skill',
          message: 'open-mode authoring is not available in this deployment',
        });
      }

      // Promote the workspace draft → a user-scoped skill carrying the
      // REQUESTED capabilities; @ax/agents reads .ax/skills/<id>/, upserts to
      // the user store with files[], and retires the draft. Returns the card
      // payload (description from the authored manifest). PluginErrors
      // (invalid-host / invalid-slot / authored-skill-not-found / invalid-
      // bundle-file) propagate to the model as a structured tool error.
      const out = await bus.call<
        { agentId: string; skillId: string; hosts: string[]; slots: string[] },
        { description: string; hosts: string[]; slots: { slot: string; kind: 'api-key' }[] }
      >('agents:install-authored-skill', toolCtx, {
        agentId: toolCtx.agentId,
        skillId,
        hosts,
        slots,
      });

      // Surface the ONE bundled approval card with the open-mode banner
      // (design §6C/§10). The user approves hosts + enters keys — the backstop.
      const card: PermissionRequestEvent = {
        skillId,
        description: out.description,
        hosts: out.hosts,
        slots: out.slots,
        authored: true,
      };
      await bus.fire('chat:permission-request', toolCtx, card);

      return { status: 'requested', skillId };
    },
    { timeoutMs: 30_000 },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skill-broker test`
Expected: the new `install_authored_skill` cases PASS. (The TASK-38 "same tools in both modes" pin still **fails** here — Task 4 rewrites it; run order doesn't matter since both are in this package's suite. If you prefer green between tasks, do Task 4 immediately after.)

- [ ] **Step 5: Commit**

```bash
git add packages/skill-broker/src/tools/install-authored-skill.ts packages/skill-broker/src/__tests__/plugin.test.ts
git commit -m "feat(skill-broker): install_authored_skill tool (gated authoring -> approval card)"
```

---

### Task 4: `@ax/skill-broker` — register the tool only in open mode (close the TASK-38 pin)

**Files:**
- Modify: `packages/skill-broker/src/plugin.ts`, `packages/skill-broker/src/index.ts`
- Test: `packages/skill-broker/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Rewrite the failing pin test**

In `packages/skill-broker/src/__tests__/plugin.test.ts`, **replace** the TASK-38 pin (`'registers the same tools whether open mode is on or off'`, ~lines 193-206) with:

```typescript
it('registers the authoring tool ONLY when open mode is on (closes the TASK-38 half-wired pin)', async () => {
  const off = busWithStubs();
  await (createSkillBrokerPlugin({ allowUserInstalledSkills: false }) as SkillBrokerPlugin).init({
    bus: off.bus, config: {} as never,
  });
  const on = busWithStubs();
  await (createSkillBrokerPlugin({ allowUserInstalledSkills: true }) as SkillBrokerPlugin).init({
    bus: on.bus, config: {} as never,
  });
  expect(off.registered.sort()).toEqual(['request_capability', 'search_catalog']);
  expect(on.registered.sort()).toEqual(['install_authored_skill', 'request_capability', 'search_catalog']);
});

it("the manifest registers tool:execute:install_authored_skill only in open mode", () => {
  const off = createSkillBrokerPlugin({ allowUserInstalledSkills: false });
  const on = createSkillBrokerPlugin({ allowUserInstalledSkills: true });
  expect(off.manifest.registers).not.toContain('tool:execute:install_authored_skill');
  expect(on.manifest.registers).toContain('tool:execute:install_authored_skill');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skill-broker test`
Expected: FAIL — the `on` case does not register `install_authored_skill` (init doesn't call `registerInstallAuthoredSkill`); the manifest never lists the tool.

- [ ] **Step 3: Wire conditional registration in the factory**

In `packages/skill-broker/src/plugin.ts`, import the new registrar and gate registration on the flag:

```typescript
import { registerInstallAuthoredSkill } from './tools/install-authored-skill.js';
// ...
export function createSkillBrokerPlugin(
  config: SkillBrokerConfig = {},
): SkillBrokerPlugin {
  const allowUserInstalledSkills = config.allowUserInstalledSkills ?? false;
  return {
    allowUserInstalledSkills,
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [
        'tool:execute:search_catalog',
        'tool:execute:request_capability',
        // Open mode (TASK-39): the gated authoring tool exists ONLY when the
        // deployment enabled allow_user_installed_skills. Conditional
        // registration closes TASK-38's "same tools in both modes" pin.
        ...(allowUserInstalledSkills
          ? (['tool:execute:install_authored_skill'] as const)
          : []),
      ],
      calls: ['tool:register', 'skills:search-catalog', 'skills:get'],
      // The authoring tool calls agents:install-authored-skill — only when open
      // mode is on, and it hasService-guards + surfaces a tool error if absent,
      // so it's optional, not a hard boot dep.
      optionalCalls: allowUserInstalledSkills
        ? [{
            hook: 'agents:install-authored-skill',
            degradation: 'open-mode authoring is unavailable; the agent cannot install user-scoped skills',
          }]
        : [],
      subscribes: [],
    },
    async init({ bus }) {
      await registerSearchCatalog(bus);
      await registerRequestCapability(bus);
      if (allowUserInstalledSkills) {
        await registerInstallAuthoredSkill(bus);
      }
    },
  };
}
```

- [ ] **Step 4: Export the descriptor**

In `packages/skill-broker/src/index.ts`, add alongside the existing exports:

```typescript
export { INSTALL_AUTHORED_SKILL_DESCRIPTOR } from './tools/install-authored-skill.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/skill-broker test`
Expected: PASS (whole package green — Task 3's tool tests + the rewritten pin + the manifest case).

- [ ] **Step 6: Commit**

```bash
git add packages/skill-broker/src/plugin.ts packages/skill-broker/src/index.ts packages/skill-broker/src/__tests__/plugin.test.ts
git commit -m "feat(skill-broker): register install_authored_skill only in open mode (close TASK-38 pin)"
```

---

### Task 5: `@ax/channel-web` — open-mode banner on the approval card

**Files:**
- Modify: `packages/channel-web/src/server/types.ts`, `packages/channel-web/src/lib/permission-card-store.ts`, `packages/channel-web/src/components/PermissionCard.tsx`
- Test: `packages/channel-web/src/__tests__/permission-card.test.tsx`

> Invoke the **`shadcn`** skill first (invariant #6) — this only adds an `Alert` (an installed primitive) with semantic tokens; workspace flag `-c packages/channel-web`. Apply on top of TASK-36's `<PermissionCard>` edits (orthogonal — TASK-36 changes the Connect handler; this adds a banner block).

- [ ] **Step 1: Write the failing test**

Add to `packages/channel-web/src/__tests__/permission-card.test.tsx` (reuse the file's `linear` fixture + `permissionCardActions.show`; mirror its render/query idioms):

```typescript
it('shows the "new skill" banner when the request is authored', async () => {
  render(<PermissionCard />);
  permissionCardActions.show({
    skillId: 'notes', description: 'Take notes', hosts: ['api.example.com'],
    slots: [{ slot: 'api_key', kind: 'api-key' }], authored: true,
  });
  expect(await screen.findByText(/new skill your assistant just wrote/i)).toBeInTheDocument();
});

it('shows no authored banner for a curated (catalog) request', () => {
  render(<PermissionCard />);
  permissionCardActions.show({
    skillId: 'linear', description: 'Read your issues', hosts: ['api.linear.app'],
    slots: [{ slot: 'api_key', kind: 'api-key' }],
  });
  expect(screen.queryByText(/new skill your assistant just wrote/i)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: FAIL — `authored` is not on `PermissionRequest` (TS) and no banner renders.

- [ ] **Step 3: Add `authored?` to both `PermissionRequest` declarations**

In `packages/channel-web/src/server/types.ts`, extend the `PermissionRequest` interface (`:105`):

```typescript
export interface PermissionRequest {
  skillId: string;
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
  /**
   * TASK-39 open-mode banner. When true, the skill was just AUTHORED by the
   * agent (not a vetted catalog skill) — the card shows a warning. Optional +
   * public (no secret); the SSE subscriber forwards it verbatim.
   */
  authored?: boolean;
}
```

In `packages/channel-web/src/lib/permission-card-store.ts`, mirror it on the client `PermissionRequest` (`:12`):

```typescript
export interface PermissionRequest {
  skillId: string;
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
  /** TASK-39: open-mode banner — the agent just wrote this skill. */
  authored?: boolean;
}
```

- [ ] **Step 4: Render the banner in `<PermissionCard>`**

In `packages/channel-web/src/components/PermissionCard.tsx`, add the banner at the top of `<CardContent>` (the `Alert`/`AlertDescription` primitives are already imported). Keep the default (non-destructive) variant — it's a heads-up, not an error:

```tsx
<CardContent className="flex flex-col gap-4">
  {request.authored === true && (
    <Alert>
      <AlertDescription>
        ⚠ This is a new skill your assistant just wrote. Approve the access below only if you
        expected it.
      </AlertDescription>
    </Alert>
  )}
  {request.hosts.length > 0 && (
    /* ...existing hosts block unchanged... */
  )}
  {/* ...rest unchanged... */}
</CardContent>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/server/types.ts packages/channel-web/src/lib/permission-card-store.ts packages/channel-web/src/components/PermissionCard.tsx packages/channel-web/src/__tests__/permission-card.test.tsx
git commit -m "feat(channel-web): open-mode 'new skill' banner on the approval card"
```

---

### Task 6: End-to-end canary + full verification + security-checklist + PR

**Files:**
- Modify: `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts`

- [ ] **Step 1: Extend the canary**

In `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` (it already boots `createAgentsPlugin()` + `createSkillsPlugin()` + `createChatOrchestratorPlugin()` + `createSkillBrokerPlugin()` over the real Postgres catalog and captures `sandbox:open-session` `installedSkills` via a fake), add a case that walks open-mode authoring **end to end up to attach** (the approve→grant→re-spawn half is TASK-36's canary + the manual walk). Boot the broker in **open mode** and provide in-memory `workspace:*` mocks holding a multi-file draft:

```typescript
it('open mode: author -> install_authored_skill upserts a user-scoped bundle, retires the draft; attach -> a fresh re-spawn includes it + its files', async () => {
  // In-memory workspace with a multi-file agent-authored draft (capability-free
  // body — the validator would have stripped caps at write time).
  const ws = new Map<string, string>([
    ['.ax/skills/notes/SKILL.md', '---\nname: notes\ndescription: Take notes\nversion: 1\n---\nUse curl to call $NOTES_KEY.'],
    ['.ax/skills/notes/scripts/run.py', 'print("hi")'],
  ]);
  const fakes = makeFakes(); // the file's existing sandbox:open-session capture
  const h = await createTestHarness({
    services: {
      ...fakes.services,
      'workspace:list': async (_c, input: unknown) => {
        const g = (input as { pathGlob: string }).pathGlob.replace(/\*\*$/, '');
        return { paths: [...ws.keys()].filter((p) => p.startsWith(g)) };
      },
      'workspace:read': async (_c, input: unknown) => {
        const v = ws.get((input as { path: string }).path);
        return v === undefined ? { found: false } : { found: true, bytes: new TextEncoder().encode(v) };
      },
      'workspace:apply': async (_c, input: unknown) => {
        for (const c of (input as { changes: Array<{ path: string; kind: string }> }).changes) {
          if (c.kind === 'delete') ws.delete(c.path);
        }
        return { version: 'v', delta: { before: null, after: 'v', changes: [] } };
      },
    },
    plugins: [
      createAgentsPlugin(),
      createSkillsPlugin(),
      createChatOrchestratorPlugin(/* same args the file uses */),
      createSkillBrokerPlugin({ allowUserInstalledSkills: true }),
    ],
  });
  const agentId = await seedPersonalAgent(h, { ownerUserId: 'user-1' }); // file's helper
  const convCtx = makeAgentContext({ sessionId: 's', agentId, userId: 'user-1', conversationId: 'cnv-1' });

  // Capture the card.
  const cards: unknown[] = [];
  h.bus.subscribe('chat:permission-request', 'canary/card', async (_c, p) => { cards.push(p); return undefined; });

  // (TASK-39) the gated tool: read draft -> upsert user-scoped bundle -> retire -> card.
  const ack = await h.bus.call('tool:execute:install_authored_skill', convCtx, {
    name: 'install_authored_skill', input: { skillId: 'notes', hosts: ['api.example.com'], slots: ['NOTES_KEY'] },
  });
  expect(ack).toEqual({ status: 'requested', skillId: 'notes' });
  expect(cards).toEqual([{
    skillId: 'notes', description: 'Take notes', hosts: ['api.example.com'],
    slots: [{ slot: 'NOTES_KEY', kind: 'api-key' }], authored: true,
  }]);

  // The user-scoped skill now exists WITH its helper file, and the draft is gone.
  const got = await h.bus.call('skills:get', convCtx, { skillId: 'notes', scope: 'user', ownerUserId: 'user-1' });
  expect((got as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual(['scripts/run.py']);
  expect([...ws.keys()].some((p) => p.startsWith('.ax/skills/notes/'))).toBe(false);

  // Attach for the user (TASK-33; on approval TASK-36's grant does this with the
  // user-typed key bound to skill:notes:NOTES_KEY — here we bind the ref directly).
  await h.bus.call('skills:attach-for-user', convCtx, {
    userId: 'user-1', agentId, skillId: 'notes', credentialBindings: { NOTES_KEY: 'skill:notes:NOTES_KEY' },
  });

  // A fresh agent:invoke re-spawns and MUST carry the authored skill + its files.
  const installed = await openFreshAndCaptureInstalledSkills(h, fakes, { userId: 'user-1', agentId, conversationId: 'cnv-2' });
  const skill = installed.find((s) => s.id === 'notes');
  expect(skill).toBeDefined();
  expect(skill!.files.find((f) => f.path === 'scripts/run.py')?.contents).toBe('print("hi")');
  expect(skill!.allowedHosts).toContain('api.example.com');
});
```

(`makeFakes`/`seedPersonalAgent`/`openFreshAndCaptureInstalledSkills` are placeholders for the file's existing capture + seeding helpers — adapt to the canary's real harness. The credential `skill:notes:NOTES_KEY` need not exist for this assertion: attach validates binding *presence*, and the captured open is a mock that doesn't run the proxy resolve — same as TASK-36's canary note.)

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
Expected: all green. `pnpm build` (tsc project refs) catches the new `@ax/agents` I/O types not threading through `plugin.ts`, the broker descriptor export, and the channel-web `PermissionRequest` shape change at both declarations. `pnpm lint` catches an accidental cross-plugin import (`no-restricted-imports`) in `@ax/skill-broker`/`@ax/agents` and a raw color / non-shadcn primitive if `PermissionCard.tsx` drifted. Bug-fix-test policy: any bug found here gets a regression test before the fix is considered done.

- [ ] **Step 4: Run the `security-checklist` skill (pre-PR gate)**

Invoke the `security-checklist` skill and answer all three threat models against the [pre-stated model](#security-threat-model-pre-stated). Confirm: the authoring tool exists only in open mode (`allow_user_installed_skills`, default off); the requested hosts/slots are untrusted model input surfaced on the card for **user** approval and inert until attached (decision #6, §10); the authored bundle materializes read-only via TASK-32's contract (path/veto/no-exec-bit re-validated at the runner boundary — unchanged) and `skills:upsert` rejects `.mcp.json`/`.claude/`/traversal/over-caps files; the draft is retired so no `.ax/skills` ↔ `.ax/session/skills` duplicate-id collision; the credential never enters the model/transcript/SSE/any hook payload; the grant (TASK-36) widens only the user's own sandbox; no new third-party dependency. Paste the structured note into the PR.

- [ ] **Step 5: Commit + open the PR**

```bash
git add packages/skills/src/__tests__/e2e/skill-install.canary.test.ts
git commit -m "test(skills): canary — open-mode authoring upserts a user-scoped bundle + a fresh re-spawn includes it"
```

PR description MUST include:
- **Boundary review** (new hook `agents:install-authored-skill`): *Alternate impl* — workspace-backed authoring today, inline-bundle authoring tomorrow; the hook abstracts "promote the agent's just-authored draft into a usable user-scoped skill." *Fields* — `{ agentId, skillId, hosts, slots }` / `{ description, hosts, slots }`, domain ids + public manifest data only, **no secret**, no backend vocabulary. *Subscriber risk* — none (single-impl service hook). *Wire surface* — **NOT an IPC action**; the agent-facing surface is the tool `tool:execute:install_authored_skill` (schema in `@ax/skill-broker`). Also note the `chat:permission-request` payload gained an optional public `authored` flag.
- **Half-wired window** (see below) — this card CLOSES the TASK-32 `skills:upsert files[]` window (first production caller) and the TASK-38 "same tools in both modes" pin; the open-mode authoring path is fully wired + canary-proven to attach.
- The `security-checklist` structured note.

---

## Security threat model (pre-stated)

The `security-checklist` skill is a **pre-PR gate** (Task 6 Step 4). Starting model (the card flags it; design §10 mandates it):

- **Prompt injection / untrusted content steering authoring (the flagged threat).** Injected content can make the agent author a skill wanting `evil.com` + arbitrary helper files and call `install_authored_skill`. Contained by: (1) **the card backstop** — the user sees the **declared hosts + slot names** on the card (with the *"⚠ new skill your assistant just wrote"* banner) before anything takes effect, and nothing is granted until the user clicks Connect (decision #6, §10); (2) **user-scoped** — blast radius is self (`scope: 'user'`, `ownerUserId` = the actor); (3) **inert until attached** — the upserted skill grants no egress/credentials until TASK-36's grant attaches it (the orchestrator union only widens the allowlist + binds keys for *attached* skills, and `defaultAttached` is false); (4) the bundle **code** grants nothing beyond the agent's existing Bash tool in the same sandbox (§9.2 open-mode caveat). The requested `hosts`/`slots` are untrusted — they are validated for *shape* (`parseSkillManifest` → `invalid-host`/`invalid-slot`) and surfaced for explicit user approval; they never silently widen anything.
- **Sandbox / bundle materialization.** The authored bundle → user store (`files[]`) → materialized read-only (`0o444`/`0o555`) into `.ax/session/skills/<id>/` via TASK-32's contract, with path-safety + veto-list + no-exec-bit re-validated at the runner extract boundary (**unchanged**). `skills:upsert`'s `validateBundleFiles` rejects `.mcp.json` / `.claude/` / `.git/` / `..` traversal / over-caps files at the host boundary. The `.ax/skills/<id>/` draft is **retired** on install, so there is no `.ax/skills` (project) ↔ `.ax/session/skills` (user) duplicate-id collision — the §8/§6D integrity backbone holds.
- **Credential trust path (invariant).** Same posture as the curated path: the key the user types posts **straight to the host credential store** at `skill:<id>:<slot>` (TASK-35; user-scoped, encrypted, CSRF-guarded), never through the model/transcript/SSE/this hook's payload. The authored manifest + the card carry slot **names** only. TASK-36's grant binds the **ref**; the proxy resolves it to an `ax-cred:` placeholder so the secret never enters the sandbox in plaintext.
- **Capability minimization.** The authoring tool **does not exist** unless `allow_user_installed_skills` is on (default off — §10's conservative default, pinned at three layers by TASK-38). When on, the tool grants exactly: write **one user-scoped skill for the actor's own personal agent** + surface a card. Team agents are rejected (no single-owner workspace). No admin, no other user, no blanket egress.
- **Trust-domain / shadowing.** An authored user-scoped skill may shadow a same-id **global catalog** skill **for that user only** (the existing `skills:resolve(ownerUserId)` user-wins behavior). Blast radius = self; capabilities are still card-gated. Accepted (consistent with the existing user-scope override + the admin user-scope promote).
- **Supply chain.** No new third-party dependency — workspace-only changes across `@ax/agents`, `@ax/skill-broker`, `@ax/channel-web`, `@ax/skills` (test). Confirm the `pnpm-lock.yaml` diff shows no new registry packages.

## Half-wired window

Stated explicitly per hard requirement #5:

1. **This card CLOSES the TASK-32 `skills:upsert files[]` window.** The Phase 1a plan left the multi-file *write* path with no production caller ("CLOSES in P5 authoring"). `agents:install-authored-skill` is that first caller — it `skills:upsert`s a user-scoped skill **with the authored bundle's `files[]`**, proven by the canary (the user-store skill carries `scripts/run.py`, and a fresh re-spawn materializes it).
2. **This card CLOSES TASK-38's "registers the same tools in both modes" pin.** Open mode now registers `install_authored_skill` (Task 4 rewrites the pin test to assert the tool is present iff open mode is on).
3. **The approval half is owned by TASK-36 (a dep), not half-wired by TASK-39.** On Connect, the card reuses TASK-36's `POST /api/chat/permission-decision` → `agent:apply-capability-grant` (which resolves the now-existing user-scoped skill, binds its slots, attaches, retires the warm session) → `regenerate()` re-spawn + resume. TASK-39 needs **no** change to TASK-36, the orchestrator union, the runner, or the validator. The canary stops at "attach → fresh open includes it"; the live approve→answer is TASK-36's canary + the design §14 manual `(walk)`.
4. **What remains open is owned by OTHER cards / Part II** (not half-wired *by* TASK-39): **share-to-catalog** promotion + the **admit queue** (§6D / Part II P5) — an authored user-scoped skill is *not* org-wide until separately submitted + admin-reviewed; the **service-keyed credential vault** (P2); the **settings "Connections"/"My Keys" mirror** (P3), which will also surface/remove the decline-orphaned user skills (fork #3).
5. **Known residual (graceful, not a window).** A user who **declines** the card leaves an unattached user-scoped skill (invisible to the SDK — not materialized) and a retired draft → re-author to retry (the §6D "re-edit = new draft" pattern). Documented in fork #3.

`agents:install-authored-skill`, the gated `install_authored_skill` tool, and the card banner are **fully wired** end-to-end (author → user-store bundle with `files[]` → draft retired → card with `authored:true` → attach → fresh re-spawn includes it + its files), proven by the canary over the real Postgres catalog.

---

## Self-Review

**Spec coverage** (against design §6C, §9.2 open-mode caveat, §10 card-as-backstop, decisions #5/#6, and the card body):

- "Open mode — the agent may author + install a user-scoped skill on the fly, gated by the same approval card" → Task 3 (gated tool) + Task 2 (read draft → upsert user-scope → retire) + Task 5 (the card banner) + the reused TASK-36 approval. ✓
- "Card banner: ⚠ This is a new skill your assistant just wrote" → Task 5 (`authored` flag + `Alert`). ✓
- "Written to `.ax/skills/`, promoted via the existing workspace path, policed by @ax/validator-skill" → the agent writes the body there (validator-policed, capability-free, unchanged); fork #1/#4 resolve the capability-carrying via tool args + user store. ✓
- "User-scoped (blast radius = self)" → `skills:upsert` scope `user` + `ownerUserId`; personal agents only. ✓
- "Opens the bundle write path → CLOSES the TASK-32 half-wired window" → `agents:install-authored-skill` is the first `skills:upsert` `files[]` caller; canary-proven. ✓
- "Security-checklist (untrusted content steering authoring; contained by the card + user-scope)" → pre-PR gate (Task 6 Step 4) + pre-stated threat model. ✓
- "Depends on TASK-36 (re-spawn/resume), TASK-38 (mode flag)" → TASK-38 read by the broker (Task 4, merged); TASK-36 reused on approval (dep gate + the as-built re-verification section handle ordering — TASK-36 NOT on `main` at authoring time). ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step gives the exact `pnpm -F` command + expected result. The harness-bound steps name the existing helpers they reuse (`createTestHarness({ services, plugins })`; `busWithStubs()`; the canary's `makeFakes`/`seedPersonalAgent`/`openFreshAndCaptureInstalledSkills`; `promote-authored-skills.test.ts`'s agent-seeding) and provide concrete assertions — matching the template's harness-bound canary task. No TBD/TODO in shipped code. ✓

**Type consistency:** the new hook is `agents:install-authored-skill({ agentId, skillId, hosts, slots }) → { description, hosts, slots: { slot, kind:'api-key' }[] }` at every hop — `AgentsInstallAuthoredSkill{Input,Output}` (types), the `plugin.ts` registration generic, the broker tool's `bus.call` generic, and the canary/broker assertions. `AuthoredBundle.files` and the upsert `files[]` are both `{ path: string; contents: string }[]`, with SKILL.md excluded from `files` (it becomes `manifestYaml`/`bodyMd`). The card payload `{ skillId, description, hosts, slots, authored: true }` matches the broker `PermissionRequestEvent`, the channel-web server + client `PermissionRequest` (both gained `authored?: boolean`), and the canary card assertion. The tool name is `install_authored_skill` and the service hook `tool:execute:install_authored_skill` consistently across the descriptor, the conditional `registers` entry, and both broker tests.

**Known residual / forks (resolved):** (1) authored skill lives in the user store, body drafted in `.ax/skills/` then retired (fork #1, decided with the human); (2) upsert + (3) retire both at request time (forks #2/#3 — keeps TASK-36's approval path unchanged + collision-safe + integrity-positive; decline leaves a harmless unattached orphan, surfaced in Part II settings); (4) capabilities from tool args, validator strip unchanged (fork #4); (5) `@ax/agents` owns the read+build+upsert+retire (fork #5). The shadowing of a global id by a user-scoped authored skill is the existing user-scope-override behavior (blast radius = self, card-gated) — noted, accepted.
