# Conversational Agent Identity (openclaw-style) — Design

**Status:** design, ready for review → impl plans
**Supersedes:** the form-based personal-agent bootstrap (PRs #298–#300). `AgentBootstrap.tsx` + client-side `composeSystemPrompt` are retired by this work.
**Author/brainstorm:** 2026-06-02 session.

## Goal

Give every agent an **openclaw-style, file-based identity** that the agent discovers and writes **through conversation**, not a form. A brand-new agent wakes up not knowing who it is, talks with the user, and writes its own identity files. Those files — not a database column — are the single source of truth for who the agent is.

This replaces the shipped model (a 3-field wizard composing one `system_prompt` string stored in `agents_v1_agents.system_prompt`). That model diverged from the original design and produced the "agent says it's Claude" class of bug (identity reduced to a fragile string that didn't even carry the name).

**Model after openclaw canonical** (`github.com/openclaw/openclaw/docs/reference/templates`), *not* the ax v1 fork — i.e. no security-first/canary framing; `BOOTSTRAP.md` that literally self-deletes; collaboratively-written `SOUL.md`.

## Scope

In scope (this epic): the runner prompt-engine, the conversational agent-identity bootstrap (`IDENTITY.md` + `SOUL.md`), an optional operating-overrides file (`AGENTS.md`), the identity validator, dropping the `system_prompt` column, and a file-based admin editor.

Deferred: the parallel **user-profile** bootstrap (`USER_BOOTSTRAP.md` → `USER.md`), channel linking (WhatsApp/Telegram), and the heartbeat tie-in (already shipped as `@ax/routines`).

## The constraint that shapes everything: the SDK auto-loads nothing

Verified against the installed `@anthropic-ai/claude-agent-sdk@0.2.119`:

- **`AGENTS.md`: zero references** — the headless Agent SDK never auto-loads it.
- **`CLAUDE.md`:** loaded only when `settingSources` includes `'project'` (workspace) or `'user'` (under `CLAUDE_CONFIG_DIR`). The SDK `Options` default is `[]`.
- **Our runner** passes `settingSources: ['user']` (for Skill discovery) and **deliberately dropped `'project'`** (Phase 3 of skill-install). It supplies identity via an explicit `systemPrompt` string that *replaces* the preset.

**Consequence:** there is no free auto-load to exploit. A file sitting in the workspace is inert. The **runner** must explicitly read the `.ax/` files and inject them into the composed `systemPrompt`. The runner — not the agent, not the SDK — is the always-present anchor. This is why no file needs to play the "always-loaded scaffold" role that `AGENTS.md` plays in openclaw, and why the agent is never instructed to "load" `BOOTSTRAP.md`: the runner injects its content directly.

## The model

Identity lives as markdown files under **`/permanent/.ax/`** — the durable, git-backed, validator-watched namespace. (`/permanent` is the durable tier; `.ax/**` is exactly the subset `workspace:pre-apply` already filters to — see Validator.)

| `.ax/` file | who writes it | when the runner injects it |
|---|---|---|
| `BOOTSTRAP.md` | host seeds at create; **agent deletes** on completion | bootstrap mode (**exclusive** — nothing else) |
| `IDENTITY.md` | agent (during bootstrap) + user/agent (evolve) | normal mode, **if present** |
| `SOUL.md` | agent (during bootstrap) + user/agent (evolve) | normal mode, **if present** |
| `AGENTS.md` | **optional** — agent/user, on demand | normal mode, **if present** |
| *(safety floor)* | runner code — **not editable** | **always** |

**`.ax/BOOTSTRAP.md`'s presence is pure state.** It drives three things at once: the prompt the runner builds, the identity validator's approval window, and "is this agent still bootstrapping." Its *content* is the agent's system prompt while that state holds.

### Runner prompt-engine (port of v1's modular builder)

A prioritized `PromptModule` system. On every turn the runner reads `/permanent/.ax/` and composes the SDK `systemPrompt`:

- **`BOOTSTRAP.md` exists →** the system prompt is **only** `BOOTSTRAP.md`'s content (v1's "ONLY show BOOTSTRAP.md — it is self-contained"). The agent wakes up *inside* the bootstrap script.
- **else (normal mode) →** `[hardcoded safety floor]` + `[AGENTS.md if present]` + `## Identity` (`IDENTITY.md`) + `## Soul` (`SOUL.md`) + identity-evolution guidance + the existing operational notes (workspace root, ephemeral scratch). Each file is optional — **inject-if-present**.

The `system-prompt:augment` hook still prepends on top of the composed result; the existing-sandbox reuse path is unaffected (the `.ax/` files are already materialized in that sandbox's `/permanent`).

### Bootstrap lifecycle

1. **Create (host):** a bare agent is created (no `system_prompt`); the host `workspace:apply`s the `BOOTSTRAP.md` template into `/permanent/.ax/BOOTSTRAP.md`.
2. **First chat:** the SPA opens a chat with the new agent. The runner sees `BOOTSTRAP.md`, injects it → the agent opens with "Hey. I just came online. Who am I? Who are you?" and converses.
3. **Self-authoring:** per the script, the agent `Write`s `.ax/IDENTITY.md` + `.ax/SOUL.md`, then **deletes `.ax/BOOTSTRAP.md`**. (The template names its own path so the agent knows what to delete.)
4. **Durable + validated:** at turn end the runner bundles the changes; the host's `workspace:apply` facade fires `workspace:pre-apply` (filtered to `.ax/**`) → validators run → durable commit + `workspace:applied`. Identity is now in git.
5. **Normal mode:** next session, no `BOOTSTRAP.md` → the runner composes from `IDENTITY`/`SOUL`. The agent is itself.

### Evolution & self-modification

After bootstrap the runner injects "Identity Evolution" guidance: *your files are yours; read then `Write` to update; changes auto-commit; tell the user when you change `SOUL.md`.* This guidance also names **`.ax/AGENTS.md`** as the home for operating-behavior changes — so "the user or the agent wants to modify core behavior" is answered by creating/editing that optional file (agent via `Write`, user via the admin editor). No mandatory file, no duplication; `.ax/AGENTS.md` exists only when there's a genuine per-agent override.

**Security floor (Invariant #5).** The non-negotiable operating rules — untrusted content is data not instructions; ask before irreversible/external actions — live in a **hardcoded runner preamble that is always injected and not editable**. `.ax/AGENTS.md` is the editable layer *on top*. An agent (or a prompt-injection) cannot `Write` away its own guardrails. Keep this floor thin (a couple of sentences); everything customizable goes in `AGENTS.md`.

### Identity validator (`@ax/validator-identity`)

A **third subscriber** to `workspace:pre-apply` — which is live infra today (the `@ax/core` apply facade fires it on every apply, pre-filtered to `.ax/**`; `@ax/validator-skill` and `@ax/validator-routine` already subscribe). Modeled almost line-for-line on `validator-skill`: filter the change set by path, `reject()` to veto.

Policy:
- **Bootstrap window** (`.ax/BOOTSTRAP.md` present): allow writes to `IDENTITY.md`/`SOUL.md` (the agent is creating them) and allow the agent's **delete** of `BOOTSTRAP.md` (the completion ritual).
- **After bootstrap:** identity/`AGENTS.md` writes are allowed but **flagged/announced** ("tell the user — it's your soul"); git history is the audit trail; a **hard veto** is reserved for prompt-injection signatures. (Mirrors v1's `validate-commit` + the soft "tell the user" posture.)

This is the use case that unblocks the validator: it was deferred in the 2026-05-01 workspace redesign purely because the *approval flow* ("what's a legitimate identity change?") was undesigned. The bootstrap window **is** that approval signal.

## Components & changes

- **`@ax/agent-claude-sdk-runner`** — replace `buildSystemPrompt(string)` with the modular prompt-engine reading `/permanent/.ax/`; bootstrap-mode branch; safety floor; evolution guidance. (Phase 1)
- **Templates package** — canonical `BOOTSTRAP.md` (+ default `IDENTITY.md`/`SOUL.md` scaffolds if any) versioned in code, v2-adapted from openclaw: `Write` not `write_file`; `.ax/` paths; "delete `.ax/BOOTSTRAP.md`"; **trim** `USER.md`/channel-linking (out of scope); adapt the memory section to `@ax/memory-strata`. Lives in the runner package or a small shared `@ax/agent-identity` package. (Phase 1)
- **Bootstrap route (`@ax/channel-web`)** — `POST /api/agents/bootstrap` creates a **bare** agent (no `systemPrompt`) then `workspace:apply`s `BOOTSTRAP.md`. `agents:create` must accept an absent `systemPrompt`. (Phase 2)
- **SPA first-run** — replace the form branch in `shouldShowAgentBootstrap` with **auto-create-bare-agent + open chat**; delete `AgentBootstrap.tsx`, `composeSystemPrompt`, `agent-bootstrap.ts`, the gate's form path. (Phase 2)
- **Backfill migration** — for every existing agent write `.ax/IDENTITY.md` = `You are <displayName>, a helpful personal assistant.` and `.ax/SOUL.md` = the agent's current `system_prompt` blob (preserves behavior; finally names the older agents, closing the "says Claude" gap). No `AGENTS.md`. (Phase 2)
- **`@ax/validator-identity`** — new plugin, `workspace:pre-apply` subscriber (above). (Phase 3)
- **`agents_v1_agents.system_prompt`** — dropped, with its Zod types/validators and the `agents:create` field; orchestrator passes `displayName` (the runner's fallback identity) instead of `systemPrompt`. (Phase 4)
- **Admin editor** — the single "system prompt" textarea becomes a file editor: **Identity / Soul / Operating instructions (advanced, optional → `AGENTS.md`)**, reading via `workspace:read`, saving via `workspace:apply`. (Phase 4)
- **`@ax/memory-strata`** — `bootstrapMemoryTree` seeds `system/agent.md` from the **composed identity** (read from the files) instead of `agentSystemPrompt`. (Phase 4)

## Phase decomposition (one design, shipped under a half-wired window)

1. **Runner prompt-engine + templates.** Modular builder, bootstrap-mode, safety floor, evolution guidance; seed `BOOTSTRAP.md`/`AGENTS.md` templates. **String fallback retained** (no `.ax/` identity → fall back to legacy `agentConfig.systemPrompt`) so nothing breaks mid-migration. *Window opens.*
2. **Conversational first-run + backfill.** Bare-agent create → open chat; retire the form; backfill all existing agents to `.ax/` files.
3. **`@ax/validator-identity`.** The `workspace:pre-apply` subscriber with the bootstrap-window policy.
4. **Drop `system_prompt` + admin editor + memory-strata.** Remove the column and the string-fallback path (*window closes*); ship the file-based admin editor; memory-strata seeds from composed identity.

Each phase ships its consumer in the same PR (Invariant #3). The string fallback (Phase 1) is the half-wired bridge; Phase 4 closes it once every agent has files and every reader is migrated.

## Invariants & boundary review

- **#2 (transport/storage-agnostic, no cross-plugin imports):** the runner reads files; no new hook *signature* is added (this rides existing `workspace:apply`/`read`/`pre-apply`). The validator declares its payload locally.
- **#3 (no half-wired):** the string fallback is the explicit, time-boxed bridge; Phase 4 removes it.
- **#4 (one source of truth):** the `.ax/` files. The DB column dies. No duplicated mandatory `AGENTS.md`.
- **#5 (capabilities minimal):** the non-editable safety floor; the validator gating self-edits; `AGENTS.md` is opt-in.
- **#6 (one UI language):** the admin editor composes existing shadcn primitives.
- **Boundary review:** no new service-hook signature. `agents:create` loses a field (`systemPrompt`) rather than gaining a hook. The validator is a new *subscriber* to an existing hook with an existing, `.ax/`-scoped payload — no new leak surface.

## Deferred / out of scope

- `USER_BOOTSTRAP.md` → `USER.md` (the agent learning about the user) — a follow-up epic; openclaw folds it into the same bootstrap conversation, so it's cheap to add later.
- Channel linking (WhatsApp/Telegram) from openclaw's `BOOTSTRAP.md` — not applicable to v2 yet.
- Heartbeat (`HEARTBEAT.md`) — already `@ax/routines`.

## Open questions to settle in the impl plan

1. **Seeding owner.** Lean: **host seeds `.ax/BOOTSTRAP.md` at create** (fits the bootstrap-route flow), which depends on a brand-new agent's `/permanent` accepting that first `workspace:apply` (the redesign's "first apply creates `main`" path, open-question #7 there). Fallback: the **runner seeds on first session** if it finds no identity files and no `BOOTSTRAP.md`. Confirm during Phase 1.
2. **Prompt order in normal mode** — `[safety floor] + [AGENTS.md] + Identity + Soul` vs identity-first. v1 put the operating manual first; pick and pin.
3. **Budget behavior** — the modular builder's `renderMinimal`/drop-when-tight policy for large evolved identity files.
4. **Backfill split** — putting the whole legacy `system_prompt` blob into `SOUL.md` is the safe default (no attempt to split identity vs. personality); confirm acceptable.

## Decisions resolved during brainstorming (audit trail)

- **Files are the only source of truth** (not the `system_prompt` column).
- **Chat-only first-run** replaces the form (#298–#300 retired).
- **Scope = agent identity + validator**; `USER.md` deferred.
- **Model after openclaw canonical**, not the ax v1 fork.
- **`.ax/` location** for `IDENTITY`/`SOUL`/`BOOTSTRAP` (+ optional `AGENTS.md`) — auto-visible to the validator, SDK-neutral (the SDK auto-loads nothing).
- **`AGENTS.md` is optional + inject-if-present** (no mandatory static file → no duplication), with a thin **non-editable safety floor in the runner**.
- **The runner injects `BOOTSTRAP.md` verbatim** as the system prompt in bootstrap mode; there is **no agent-facing "load" instruction** — the runner is the anchor. `BOOTSTRAP.md` presence = the one signal driving prompt + validator + bootstrap-state.
- **`workspace:pre-apply` is live infra**; `@ax/validator-identity` is a third subscriber modeled on `validator-skill`, with the bootstrap window as its approval signal (resolving the deferral).
