# Skill install workflow — design

**Status:** Proposed
**Date:** 2026-05-17
**Related:**
- `CLAUDE.md` (six invariants this lands against; invariant #5 in particular)
- `packages/credential-proxy/src/listener.ts` (per-session allowlist + MITM substitution)
- `packages/chat-orchestrator/src/orchestrator.ts:742-767` (where `agent.allowedHosts` + `requiredCredentials` flow into `proxy:open-session`)
- `packages/validator-skill/src/frontmatter.ts` (existing SKILL.md frontmatter parser — extended here)
- Prior memory: `project_credential_egress_via_skills.md` (direction agreed 2026-05-17)
- Prior PR: #51 credentials admin UI (scope axis + admin tab — pattern reused)

---

## Goal

Make **installed skills** the primary path by which an agent gains access to a new credentialed host. A skill is an admin-reviewed, host-managed bundle that declares:

1. **Allowed hosts** — domains the agent's per-session proxy should permit.
2. **Credential slots** — named env vars the agent will need, with a kind hint.
3. **Instructions** — markdown body that surfaces to the agent at session start so it knows *how* to use the host.

Admin installs the skill once (UI in channel-web, mirroring the credentials admin tab from PR #51). Admin then attaches the skill to one or more agents, binding each slot to a specific credential record (global / user / agent scope, exactly the axis credentials already use). At `chat:open-session`, the orchestrator unions every attached skill's `allowedHosts` and `requiredCredentials` into the existing `proxy:open-session` call — no proxy-side changes.

### Non-goals (deferred)

- **In-session approval gates for credentialed hosts.** This is the path being replaced. The uncredentialed-GET tier-split mentioned in the brainstorm is filed as a follow-up, not this PR.
- **User-installable skills / marketplace.** v1 is admin-only install. A second-actor "publish" mechanism with signing + scope-down lives behind this milestone.
- **MCP server bundling inside skills.** A skill declaring an MCP server (stdio command or streamable-http URL + slot bindings) is a natural extension and the manifest schema is forward-compatible, but the first PR keeps to host + credential capability. Today MCP servers ship via `@ax/mcp-client`'s own admin routes (PR-era).
- **Workspace-skill capability grants.** Skills authored by the agent into its own workspace (`<workspace>/.ax/skills/<name>/SKILL.md`) remain **instruction-only** — the agent cannot grant itself capabilities. The `capabilities` block in a workspace SKILL.md is parsed and ignored (with a warning), not honored. Capability grants require host-side install.
- **Versioning, upgrade flows, conflict resolution between two skills declaring the same slot name on the same agent.** v1 errors loud at attach time on slot-name collision; richer conflict UX is later.
- **Hot reload of an installed-skill body into a running session.** Same env-snapshot constraint as the credential-rotation note: installed-skill changes only take effect on next session spawn. Documented, not engineered around.

---

## Vocabulary (read this before the rest)

The word "skill" is overloaded. This doc consistently distinguishes:

- **Workspace skill** — `<workspace>/.ax/skills/<name>/SKILL.md` inside an agent's git workspace. Authored by the agent itself (model output → tool write). Validated by `@ax/validator-skill`. Pure instruction. No capability grant. Loaded by the Claude Agent SDK as the `'project'` setting source via a sandbox-created symlink `<workspace>/.claude/skills` → `<workspace>/.ax/skills`.
- **Installed skill** — host-managed bundle, stored in a database table by `@ax/skills` (new plugin). Authored by humans, reviewed by admin, installed via the admin UI. Capability grants honored. Body materialized into the runner's `$HOME/.ax/session/skills/<id>/SKILL.md` at session-open (separate root, host-controlled, `'user'` setting source — discovered by the SDK because `CLAUDE_CONFIG_DIR=$HOME/.ax/session` is set in the runner env).

When this doc says "skill" unqualified, it means **installed skill**.

### Why these specific paths (SDK contract — refined)

The `@anthropic-ai/claude-agent-sdk` discovers skills from exactly **two roots**, controlled by `settingSources`:

- `<cwd>/.claude/skills/*/SKILL.md` when `settingSources` includes `'project'`.
- `<user-config-root>/skills/*/SKILL.md` when `settingSources` includes `'user'`.

Where `<user-config-root>` is **`process.env.CLAUDE_CONFIG_DIR`** if set, else `$HOME/.claude`. (Verified against the installed SDK source — `sdk.mjs` line 16: `process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")`.)

We exploit both knobs to keep our existing `.ax/` namespace:

1. **Set `CLAUDE_CONFIG_DIR=$HOME/.ax/session`** in the runner env (`sandbox:open-session` injects it alongside HOME). Host-installed skills land at `$HOME/.ax/session/skills/<id>/SKILL.md`. Side benefits: the SDK's `.credentials.json` and `<config>/projects/<...>/<sessionId>.jsonl` transcripts also relocate under `.ax/`, consolidating everything SDK-owned in one namespace. Plays naturally with runner-owned-sessions Phase A's HOME-redirect — the existing redirect controls HOME; the env var controls the SDK's config sub-root within HOME.

2. **Symlink `<workspace>/.claude/skills` → `<workspace>/.ax/skills`** at sandbox session-open. Git tracks `.ax/skills/<name>/SKILL.md` (native namespace preserved); the SDK reads through the symlink and is none the wiser. The symlink is sandbox-ephemeral — it's created by the sandbox plugin before the runner starts, never committed, and lives only for the session's lifetime. (For sandbox-k8s, the symlink is a relative `../.ax/skills` inside the agent's checked-out workspace mount; for sandbox-subprocess, same shape.) The project source remains `.claude/skills/` from the SDK's perspective — invariant unchanged — but file authoring (`workspace:apply`, `file_write`, etc.) targets `.ax/skills/`.

This earlier draft suggested either migrating workspace skills to `.claude/skills/` outright or putting installed skills under `.ax/installed-skills/` (which the SDK would have ignored). The current approach — env-var redirect for user source + symlink for project source — keeps `.ax/` as the single user-visible namespace without fighting the SDK contract.

### Phase 0 prerequisite: wire the SDK to discover skills at all

Today's `@ax/agent-claude-sdk-runner` does NOT pass `settingSources` or include `'Skill'` in `allowedTools`. The validator-skill plugin validates a SKILL.md convention the SDK never sees. Before any of this design is useful, the runner needs:

```ts
// in main.ts where ClaudeAgentOptions is built
settingSources: ['user', 'project'],
allowedTools: [...existing, 'Skill'],
```

…and the sandbox plugins (subprocess + k8s) need:

```ts
// before runner process spawn
env.CLAUDE_CONFIG_DIR = path.join(homeDir, '.ax', 'session');
fs.mkdirSync(path.join(env.CLAUDE_CONFIG_DIR, 'skills'), { recursive: true });
// for each installed skill from the orchestrator:
fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'skills', skill.id, 'SKILL.md'), skill.skillMd);
fs.chmodSync(path.join(env.CLAUDE_CONFIG_DIR, 'skills'), 0o555);
// symlink workspace .claude/skills -> .ax/skills for the project source
fs.symlinkSync('../.ax/skills', path.join(workspaceDir, '.claude', 'skills'));
```

This is a small-but-load-bearing precursor. Treat it as Phase 0 of the impl plan (or its own micro-PR ahead of the main work). Without it, both workspace skills AND installed skills are invisible to the model — the user can't invoke them via the SDK's built-in `Skill` tool.

No workspace-skill migration needed. The existing `.ax/skills/<name>/SKILL.md` paths validated by `@ax/validator-skill` stay as they are — the sandbox-side symlink makes them visible to the SDK without moving any files in git history.

---

## How this design lands the six invariants

| Invariant | How this design satisfies it |
|---|---|
| **I1** — Transport/storage-agnostic hooks | New hooks (`skills:list`, `skills:resolve`, `skills:get`, `skills:upsert`, `skills:delete`) carry skill-domain vocab only: `skillId`, `slot`, `allowedHosts`, `credentialBindings`. No `row_id`, no `manifest_blob`, no DB-shape leaks. Alternate impl: a future filesystem-backed `@ax/skills-fs` plugin would register the same hooks with the same shapes; the in-process DB impl swaps. |
| **I2** — No cross-plugin imports | `@ax/skills` (new) reaches `@ax/storage-postgres` via bus only. `@ax/chat-orchestrator` reaches `@ax/skills` only through `skills:resolve`. `@ax/credentials` is not imported — credential bindings travel as opaque `ref` strings exactly as `agent.requiredCredentials` does today. |
| **I3** — No half-wired plugins | Day-1 PR ships the canary path: admin installs `github` skill → admin attaches to an agent + binds `GITHUB_TOKEN` slot → user chats with the agent → the agent makes a request to `api.github.com` with a placeholder that the MITM proxy substitutes → request lands successfully. The validator-skill veto path for capability-declaring workspace SKILL.md files lands in the same PR. Plugin loaded in CLI + k8s preset same PR. |
| **I4** — One source of truth | The `skills` table is the only store of installed-skill manifests. Agent → skill linkage lives on the agent record (`skillAttachments: Array<{ skillId, credentialBindings: Record<slot, ref> }>`), NOT in a separate join table — keeps the existing agent-resolve hook the single resolution path. Workspace materialization is a derived view, never authoritative. |
| **I5** — Capabilities explicit and minimized | This IS the invariant-5 story. Every host the agent can reach is named in some installed skill's `allowedHosts` (or the legacy default `['api.anthropic.com']` fallback for the model itself). Every credential the agent can use is bound by name at admin install time. The agent has no way to expand its own surface mid-session. Untrusted-content handling: skill manifests are validated by the same hardened parser as workspace SKILL.md (strict UTF-8, js-yaml safe schema, no inline secrets — refs only). |
| **I6** — One UI design language | Admin UI lives in `packages/channel-web` under `/admin/skills`, composing the same shadcn primitives as the credentials admin tab from PR #51 (`Card`, `Table`, `Dialog`, `FieldGroup`, `Alert`). The slot-binding sub-form reuses the credential picker component that already exists. No new design tokens, no separate Vite SPA. |

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Admin (browser, channel-web SPA)                                     │
│                                                                      │
│   /admin/skills      ──┐                                             │
│     create / edit /    │  HTTP CRUD (auth+CSRF, admin role)          │
│     delete skill       │                                             │
│                        │                                             │
│   /admin/agents/:id ───┤                                             │
│     attach skill +     │                                             │
│     bind slots         │                                             │
│                        ▼                                             │
├──────────────────────────────────────────────────────────────────────┤
│ Host process                                                         │
│                                                                      │
│   @ax/skills (NEW)                                                   │
│   ├── HTTP routes  /admin/skills[/:id]                               │
│   ├── service hook skills:list / skills:get / skills:upsert / delete │
│   ├── service hook skills:resolve  ← orchestrator calls this         │
│   ├── DB table     skills(id, name, description, manifest_yaml,      │
│   │                       body_md, created_at, updated_at)           │
│   └── validator    extended frontmatter parser (capabilities block)  │
│                                                                      │
│   @ax/agents (extended)                                              │
│   └── adds field   skillAttachments: Array<{                         │
│                      skillId, credentialBindings: Record<slot, ref>  │
│                    }>                                                │
│                                                                      │
│   @ax/chat-orchestrator (extended)                                   │
│   └── at chat:open-session, after agents:resolve:                    │
│       1. call skills:resolve({ skillIds: agent.skillAttachments.* }) │
│       2. union  skill.allowedHosts into proxy allowlist              │
│       3. merge  bindings → requiredCredentials                       │
│       4. fold   skill.body_md into system-prompt:augment contribs    │
│       5. pass   skill bodies to sandbox:open-session for HOME write  │
│                                                                      │
│   @ax/credential-proxy (UNCHANGED)                                   │
│   └── proxy:open-session receives the unioned allowlist + creds      │
│       just like today — no listener-side changes                     │
│                                                                      │
│   @ax/validator-skill (extended)                                     │
│   └── frontmatter parser learns `capabilities` block (parse-only;    │
│       workspace path → warn-and-strip; installed path → honored)     │
└──────────────────────────────────────────────────────────────────────┘
```

The key architectural property: **all the new flow happens in the orchestrator at session-open**. The proxy listener, the runner, the sandbox plugins, the credential store all stay unchanged. The orchestrator already unions defaults and agent-record fields into the `proxy:open-session` call (`orchestrator.ts:761-767`); we extend that union step.

---

## Skill manifest schema

A skill is one SKILL.md file. Same YAML-frontmatter-then-markdown shape as workspace skills, with an optional `capabilities` block.

```yaml
---
name: github
description: Access the GitHub REST API with a personal access token.
version: 1
capabilities:
  allowedHosts:
    - api.github.com
  credentials:
    - slot: GITHUB_TOKEN
      kind: api-key
      description: |
        GitHub personal access token. Suggested scopes: `repo`, `read:user`.
        Generate at https://github.com/settings/tokens.
---

# How to use the GitHub API

You can make authenticated requests to `https://api.github.com` using the
`GITHUB_TOKEN` environment variable in the `Authorization: Bearer` header.

Example via curl in a tool call:

```bash
curl -H "Authorization: Bearer $GITHUB_TOKEN" \
     https://api.github.com/user
```

Common endpoints: ...
```

**Validation rules (enforced by `@ax/validator-skill`):**

- `name`: non-empty string, kebab-case-ish (matches `^[a-z][a-z0-9-]{0,63}$`), unique across installed skills. Reused as the URL slug.
- `description`: non-empty string, ≤ 240 chars.
- `version`: optional non-negative integer; defaults to 0. Used by future upgrade flows.
- `capabilities.allowedHosts`: optional array of hostname strings. Each must be a plausible hostname (no scheme, no path, no `*` wildcards in v1, no IP literals). Deduplicated.
- `capabilities.credentials`: optional array of slot definitions.
  - `slot`: non-empty string matching `^[A-Z][A-Z0-9_]{0,63}$` (env-var-safe). Unique within the manifest.
  - `kind`: one of the values the credentials facade understands today (`'api-key'`; future kinds enumerated as the facade grows). v1: only `'api-key'`.
  - `description`: optional human-readable hint shown in the admin slot-binding UI.
- **No inline secret fields** anywhere in the manifest — same rule as `@ax/mcp-client` config (`mcp-client/src/config.ts:34`). Validator rejects keys named `apiKey`/`token`/`password`/`secret` at any depth with a "use bindings instead" error.

**For workspace SKILL.md files** (`<workspace>/.ax/skills/<name>/SKILL.md`): if `capabilities` is present, the validator emits a warning event and strips the block from the parsed result. It does NOT veto the change — the file is still useful as instruction. This keeps the agent's authoring path open while making the capability-grant-by-self attack impossible.

**For installed SKILL.md files** (host-side, never agent-written): the validator honors `capabilities`. Validation happens at `skills:upsert` time, BEFORE storing — a malformed installed-skill manifest is a 4xx at the admin route.

---

## Data model

### New table: `skills`

```sql
CREATE TABLE skills (
  id            TEXT PRIMARY KEY,            -- slug from manifest `name`
  description   TEXT NOT NULL,               -- manifest `description`
  manifest_yaml TEXT NOT NULL,               -- the raw frontmatter YAML
  body_md       TEXT NOT NULL,               -- the markdown body after frontmatter
  version       INTEGER NOT NULL DEFAULT 0,  -- manifest `version`
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The full SKILL.md file is reconstructable as `'---\n' + manifest_yaml + '\n---\n' + body_md` — we store the parts split so the orchestrator can fold the body into the system prompt without re-parsing frontmatter.

No `tenant_id` / `owner_id` column in v1 — installed skills are global to the deployment (admin-managed). Multi-tenant scoping is a future axis.

### Extended agent record

The `AgentRecord` interface in `chat-orchestrator/src/orchestrator.ts:109` gains:

```ts
interface AgentRecord {
  // ... existing fields ...
  skillAttachments?: Array<{
    skillId: string;
    credentialBindings: Record<string /* slot */, string /* credential ref */>;
  }>;
}
```

The `@ax/agents` plugin's storage row gains a `skill_attachments JSONB NOT NULL DEFAULT '[]'` column (additive migration; old rows get `[]`).

### No new credentials concept

A `credentialBinding`'s value is exactly the same `ref` string used elsewhere — a key into the existing credentials store, scope-agnostic at the orchestrator level (the credentials facade resolves the scope when the proxy calls `credentials:get`). The slot-binding admin UI uses the existing credential-picker that PR #51 already shipped.

---

## Hook surface

All new hooks registered by `@ax/skills`.

### `skills:list` — service hook

```ts
type SkillsListInput = Record<string, never>;
interface SkillsListOutput {
  skills: Array<{
    id: string;
    description: string;
    version: number;
    capabilities: {
      allowedHosts: string[];
      credentials: Array<{ slot: string; kind: string; description?: string }>;
    };
    updatedAt: string; // ISO
  }>;
}
```

Used by the admin UI's list view and by the agent edit form's "attach skill" picker.

### `skills:get` — service hook

```ts
interface SkillsGetInput { skillId: string; }
interface SkillsGetOutput {
  id: string;
  description: string;
  version: number;
  capabilities: { /* same as above */ };
  bodyMd: string;
  manifestYaml: string;
}
```

Used by the admin "view / edit" detail view.

### `skills:upsert` — service hook

```ts
interface SkillsUpsertInput {
  manifestYaml: string;  // raw frontmatter YAML (without the --- fences)
  bodyMd: string;        // markdown body (without the leading --- fences)
}
interface SkillsUpsertOutput { skillId: string; created: boolean; }
```

Validates the manifest against the schema, then INSERTs or UPDATEs by `id` (the `name` field from the manifest). Returns `created: true` on insert, `false` on update.

### `skills:delete` — service hook

```ts
interface SkillsDeleteInput { skillId: string; }
type SkillsDeleteOutput = Record<string, never>;
```

Errors with `code: 'skill-in-use'` if any agent has the skill attached. Admin must detach first. (Cheap, explicit, avoids orphaned `skillAttachments[].skillId` references.)

### `skills:resolve` — service hook

```ts
interface SkillsResolveInput {
  skillIds: string[];
}
interface SkillsResolveOutput {
  skills: Array<{
    id: string;
    capabilities: {
      allowedHosts: string[];
      credentials: Array<{ slot: string; kind: string; description?: string }>;
    };
    bodyMd: string;
  }>;
}
```

Called by the orchestrator at session-open. Unknown `skillId` entries are dropped silently with a warn log — a deleted-skill-still-attached situation should not block session open (admin gets a "detach orphaned skill" prompt on next visit to agent edit). Order in the response matches order in the input.

### Admin HTTP routes (registered by `@ax/skills` via `http:register-route`)

| Method | Path                 | Auth     | Body shape (in)               | Body shape (out)               |
|--------|----------------------|----------|-------------------------------|--------------------------------|
| GET    | `/admin/skills`      | admin    | —                             | `SkillsListOutput`             |
| GET    | `/admin/skills/:id`  | admin    | —                             | `SkillsGetOutput`              |
| POST   | `/admin/skills`      | admin    | `{ skillMd: string }`         | `SkillsUpsertOutput` (201/200) |
| PUT    | `/admin/skills/:id`  | admin    | `{ skillMd: string }`         | `SkillsUpsertOutput`           |
| DELETE | `/admin/skills/:id`  | admin    | —                             | `204` or `409` `skill-in-use`  |

The `skillMd` field is the **full SKILL.md** (fenced frontmatter + body). The route splits at the fence before calling `skills:upsert`. This matches how human users actually compose skill files — copy/paste a complete file rather than reasoning about which part is "frontmatter" vs "body".

CSRF cookie + admin role required, same middleware as `/admin/credentials`.

---

## Session-open flow (the interesting part)

Existing flow at `orchestrator.ts:742-767`:

```
agent ← agents:resolve(agentId)
allowlist ← agent.allowedHosts ?? ['api.anthropic.com']
creds ← agent.requiredCredentials ?? { ANTHROPIC_API_KEY: ... }
proxy ← proxy:open-session({ sessionId, userId, agentId, allowlist, credentials: creds })
```

New flow:

```
agent ← agents:resolve(agentId)

# Resolve attached skills
attachments ← agent.skillAttachments ?? []
skillIds ← attachments.map(a => a.skillId)
{ skills } ← skills:resolve({ skillIds })

# Build the union allowlist
allowlist ← (agent.allowedHosts ?? ['api.anthropic.com'])
            ∪ ⋃ skill.capabilities.allowedHosts for each resolved skill

# Build the merged credentials map
creds ← agent.requiredCredentials ?? { ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } }
for each attachment:
  let skill = skills.find(s => s.id === attachment.skillId)  # may be missing if deleted
  if skill === undefined: continue
  for each slot in skill.capabilities.credentials:
    let ref = attachment.credentialBindings[slot.slot]
    if ref === undefined:
      throw structured outcome: skill-binding-missing (slot, skillId)
    if creds[slot.slot] !== undefined and creds[slot.slot].ref !== ref:
      throw structured outcome: skill-slot-collision (slot, skillIds)
    creds[slot.slot] = { ref, kind: slot.kind }

proxy ← proxy:open-session({ ..., allowlist, credentials: creds })

# Materialize installed-skill bodies under the sandbox's HOME
# (passed as part of sandbox:open-session — the sandbox plugin writes
# the files before the runner process starts)
skillsForSandbox ← resolved skills.map(s => ({
  id: s.id,
  skillMd: '---\n' + s.manifestYaml + '\n---\n' + s.bodyMd
}))
sandbox ← sandbox:open-session({ ..., installedSkills: skillsForSandbox })
```

Three new failure outcomes (each `kind: 'terminated'`, surfaced via `chat:end` like the existing proxy-not-loaded / agent-proxy-config-incomplete outcomes):

- `skill-binding-missing` — attachment refers to a slot the manifest doesn't declare, or binding for a declared slot is absent. Admin needs to re-edit the attachment.
- `skill-slot-collision` — two attached skills declare the same slot, OR a skill's slot collides with `agent.requiredCredentials`. Detected at session-open; admin must rename slot or detach skill. (Future: detect at attach time, but session-open detection is the safety net.)
- `skill-resolve-failed` — `skills:resolve` threw. Distinct from missing-skill (silent skip) — a thrown error indicates plugin malfunction, not data state.

System-prompt fold (optional, open question #1): skill bodies could ALSO become contributions to `system-prompt:augment` so the model knows about installed skills at turn 1 without needing to invoke the `Skill` tool. The SDK's built-in `Skill` discovery already surfaces a one-line index of each skill's frontmatter `description` into the system prompt automatically — that may be enough on its own. Decide before impl.

---

## Materialization details (revised — SDK paths)

Installed skills surface to the agent through the runner's `$HOME/.ax/session/skills/<skillId>/` directory — the SDK's `'user'` setting source, redirected via `CLAUDE_CONFIG_DIR`. Workspace-authored skills live at `<workspace>/.ax/skills/<name>/` and are surfaced to the SDK's `'project'` source through a sandbox-created symlink at `<workspace>/.claude/skills`. Two distinct filesystem regions, two distinct trust levels.

- **Location (installed):** `$HOME/.ax/session/skills/<skillId>/SKILL.md`. `$HOME` resolves to whatever the sandbox's HOME-redirect produced — for k8s sandbox a tmpfs path the pod-spec controls; for subprocess sandbox a per-session tempdir.
- **Author:** the sandbox plugin writes these files BEFORE starting the runner process and sets `CLAUDE_CONFIG_DIR` in the runner env. The orchestrator passes the resolved skill list through `sandbox:open-session.installedSkills`; the sandbox plugin materializes them onto disk in its session-open path. Not a `workspace:apply` — `$HOME` is not the workspace and shouldn't traverse workspace machinery.
- **Lifecycle:** ephemeral, tied to the sandbox session. Materialized at session-open, removed when the session terminates (the sandbox's existing tmpfs / tempdir cleanup handles this). No incremental update, no detach-deletes — a freshly-attached skill on a future session just appears; a detached one just doesn't get materialized next time.
- **Agent visibility:** the agent's tools can read `$HOME/.ax/session/skills/**` (the SDK needs to read them, so file_read works), but the sandbox prevents writes — the directory is chmod 0555 after the sandbox plugin writes the files. The agent has no path through `workspace:apply` to reach HOME, so the workspace-side defense is automatic; the chmod defends against `tool-bash` trying to overwrite.

- **Location (workspace):** `<workspace>/.ax/skills/<name>/SKILL.md`. Git-tracked. Same path the existing `@ax/validator-skill` already enforces.
- **Author:** the agent itself, via `workspace:apply` / file_write tool. `workspace:pre-apply` runs the validator, which strips any `capabilities` block and warns.
- **Visibility to the SDK:** the sandbox creates a symlink `<workspace>/.claude/skills` → `<workspace>/.ax/skills` at session-open (after workspace materialization, before runner spawn). The SDK sees its expected `.claude/skills/` path; git sees `.ax/skills/`. Symlink is sandbox-ephemeral, never committed.

Why two filesystem roots (HOME vs workspace) rather than one with a name-prefix scheme?

1. **The SDK does the splitting for us.** `settingSources: ['user', 'project']` already distinguishes user-source (host-controlled) from project-source (workspace-controlled). We don't need to invent a `host__<id>` / `agent__<name>` name prefix.
2. **Trust boundary tracks the filesystem.** Workspace is agent-writable (model output → `workspace:apply` → git commit). HOME is host-only. The trust property "agent can't author capability grants" is enforced by HOME being unreachable from any agent-controlled write path. The `.claude/skills` symlink in the workspace points BACK INTO the workspace; it doesn't give the agent a route to HOME.
3. **Audit clarity.** Capability grants come from `skills:upsert` writes to the DB → orchestrator reads at session-open → sandbox writes to HOME. Workspace skills come from agent tool calls → `workspace:apply` → git commit. Two distinct provenance chains, two distinct paths — `git log` over the workspace and the `skills` table audit trail cover them separately.
4. **`.ax/` namespace consistency.** Both kinds of skill live under `.ax/` from the user/operator's perspective (`.ax/skills/` in the workspace, `$HOME/.ax/session/skills/` in the runner). The SDK contract (`.claude/skills/`) is satisfied by env-var redirect + symlink — implementation detail of the sandbox, not a user-visible namespace change.

---

## Admin UI sketch

Lives at `/admin/skills` in channel-web, alongside the existing credentials and MCP-servers admin tabs.

**List view (`/admin/skills`):**

```
┌─ Skills ──────────────────────────────────────────────────────────┐
│  Skills package up the hosts and credentials an agent needs to    │
│  access a service. Install once, attach to any number of agents.  │
│                                                                   │
│  [ + New skill ]                                                  │
│                                                                   │
│  ┌─────────┬──────────────────────┬──────────────┬──────┬───────┐ │
│  │ ID      │ Description          │ Hosts        │ Slots│ Used  │ │
│  ├─────────┼──────────────────────┼──────────────┼──────┼───────┤ │
│  │ github  │ Access GitHub REST   │ api.github.. │ 1    │ 2 ag. │ │
│  │ openai  │ Direct OpenAI API    │ api.openai.. │ 1    │ 0 ag. │ │
│  └─────────┴──────────────────────┴──────────────┴──────┴───────┘ │
└───────────────────────────────────────────────────────────────────┘
```

**Edit view (`/admin/skills/:id`):**

A two-pane editor:
- Left: monospace textarea containing the full SKILL.md. Save validates and surfaces parse errors inline.
- Right: live-parsed preview — host list as chips, credential slots as a table, body rendered as markdown. This is the same value-add as the YAML view in the credentials admin tab from PR #51 — gives admins a "what is this thing about to do" view before saving.

**Agent edit view extension:**

The existing agent edit form (in channel-web admin, shipped via `@ax/agents` admin routes) gains a "Skills" section between "Tools" and "Allowed hosts" (which becomes a read-only computed view: union of agent-record + attached-skill hosts):

```
Skills
  [ github  ]  GITHUB_TOKEN  ← [Select credential ▾ ]   [Detach]
  [ + Attach skill ]
```

The credential dropdown is the existing component, filtered to credentials whose `kind` matches the slot's `kind`.

---

## Trust model and untrusted-content discipline

**What is the trust boundary?**

- Installed skills are authored by **whoever can call POST/PUT `/admin/skills`** — the admin role. Same trust level as creating a credential record. Skill bodies are NOT user-generated content from an end user — they are operator-provided. The threat model is "operator typo'd the manifest" or "operator pasted a manifest they didn't read carefully", not "external attacker controls the manifest."
- The skill BODY (markdown) is, however, rendered into the agent's context window. A malicious body could prompt-inject the agent. Mitigation: same as system prompt — operator-trusted content. We don't try to render skill bodies from untrusted sources.
- **Workspace SKILL.md files are agent-controlled.** The agent can write anything into `<workspace>/.ax/skills/<name>/SKILL.md`. Capability blocks there are stripped. This is the load-bearing security property.

**What does `@ax/validator-skill` enforce (extended)?**

- Strict UTF-8 (already enforced today).
- `js-yaml` safe schema for frontmatter parse (already enforced today).
- New: capability schema validation (host shape, slot regex, kind enum).
- New: inline-secret rejection (any field at any depth named `apiKey`/`token`/`password`/`secret` → reject).
- New: differentiates by source. Workspace path (`<workspace>/.ax/skills/<n>/SKILL.md`, via `workspace:pre-apply`) → strip-and-warn on `capabilities`. Installed path (via `skills:upsert` admin route) → honor `capabilities`.
- New: `workspace:pre-apply` veto on agent-authored writes that try to claim a `capabilities` block — captured by the strip-and-warn rule above; veto only if the rest of the file is malformed.
- HOME-side `$HOME/.ax/session/skills/` is defended by sandbox chmod 0555 + unreachability from `workspace:apply`. No validator hook needed on that side.

The security-checklist skill should run when extending the validator — it covers exactly this surface (prompt injection via skill body, supply chain via what gets installed). Plan an explicit security-checklist pass in the impl plan task list.

---

## Open questions

These should be resolved before the impl plan lands, but they don't block writing the design.

1. **Body-only system-prompt fold vs SDK-native discovery — do we need both, or is just the SDK's auto-index enough?**
   *Revised tentative answer:* SDK-only by default. The SDK already injects a one-line `description` index of each skill into the system prompt at startup, and the model invokes the built-in `Skill` tool to load full bodies on demand. That's the progressive-disclosure design Anthropic ships. We'd only add a `system-prompt:augment` fold if testing shows the SDK index is too sparse for our use cases (e.g. the model fails to invoke skills it would have used if the body was already in context). Cheaper to start without the fold and add it if needed than to ship duplicated content.

2. **What happens if a skill's `allowedHosts` declares `api.anthropic.com`?**
   *Tentative answer:* Allowed and harmless — set-union dedupes. The default allowlist already contains it. No special-casing.

3. **Should we allow skills with NO capability block (instruction-only installed skills)?**
   *Tentative answer:* Yes. An instruction-only skill is useful: a "respond in pirate English" skill, a domain-knowledge skill for a particular customer's product. The admin install path simply adds an instruction file to attached agents' workspaces + system prompt. v1 supports it; the `capabilities` block is optional throughout the manifest schema.

4. **MCP server bundling in skills — schema reservation now, or wait?**
   *Tentative answer:* Reserve `capabilities.mcpServers` as a forbidden field in v1 (validator rejects with a "deferred to follow-up" message). Cheaper than re-doing the manifest shape later when we want to add it.

5. **Half-wired window plan.**
   *Tentative answer:* Same as the Phase 5+ pattern in `feedback_half_wired_window_pattern.md`. PR adds `@ax/skills`, wires it in CLI + k8s preset same PR, includes a canary acceptance test that installs+attaches+chats. No "wire it later" sub-PR.

---

## Impact / change list

Approximate scope, for sizing the impl plan:

- **New package** `@ax/skills`: ~600-900 LOC (plugin, validator extensions, HTTP routes, hook impls, tests).
- **Modify** `packages/validator-skill/src/frontmatter.ts`: ~100 LOC additive (capability parsing + strip-vs-honor branching).
- **Modify** `packages/validator-skill/src/plugin.ts`: ~30 LOC (strip-and-warn on `capabilities` in agent-authored writes; existing `.ax/skills/<n>/SKILL.md` path match stays).
- **Modify** `packages/agent-claude-sdk-runner/src/main.ts`: ~10 LOC Phase 0 — add `settingSources: ['user', 'project']` + `'Skill'` to `allowedTools`.
- **Modify** `packages/sandbox-subprocess` + `packages/sandbox-k8s`: ~80 LOC each — accept `installedSkills` in `sandbox:open-session`; set `CLAUDE_CONFIG_DIR=$HOME/.ax/session` in the runner env; write installed-skill files under `$CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md` + chmod 0555; symlink `<workspace>/.claude/skills` → `<workspace>/.ax/skills` (relative).
- **Modify** `packages/chat-orchestrator/src/orchestrator.ts`: ~80 LOC (the union step in section above + new outcomes).
- **Modify** `packages/agents/src/...`: schema migration adding `skill_attachments` column + admin route to manage attachments.
- **Modify** `packages/channel-web/src/admin/...`: new Skills tab + agent-edit Skills section. Reuses existing components.
- **New DB migration** in storage-postgres for `skills` table + `agents.skill_attachments` column.
- **CLI + k8s preset** wires `@ax/skills` into the bootstrap plugin list (same-PR wiring per I3).
- **Canary acceptance test** in test-harness.

Rough order of magnitude: comparable to the credentials admin UI PR (#51) — 7-ish phases, ~25-30 commits.

---

## Follow-ups (out of this PR)

- **Uncredentialed in-session approval gate** for GETs to non-allowlisted hosts. Tier-split from the brainstorm.
- **MCP server bundling** inside skills. Schema is reserved; impl is a follow-up.
- **Skill versioning + upgrade** flow. When admin re-uploads a skill manifest that changes capabilities, attached agents need a "this changed; review?" prompt.
- **User-installable skills** via signed bundles. Out-of-band review story before this lands.
- **Workspace skill → installed skill** "promote" flow. An agent's well-tested workspace skill could be presented to the admin as a candidate for installation. Nice-to-have.

---

## Next step

Once this design is reviewed and the open questions are settled (or accepted as "tentative answers are fine"), produce a TDD-shaped impl plan via the writing-plans skill at `docs/plans/2026-05-17-skill-install-workflow-impl.md`.
