# Skill authoring redesign: lazy validation, bundle-native skills, capability-gated-at-use

**Date:** 2026-05-29
**Status:** Design — approved direction, pending implementation plan
**Author:** Vinay (with Claude)

## Motivation

For several days we have been unable to get an agent to author a Linear skill
and then run it from the chat UI, despite shipping ~30 JIT tasks (TASK-32→62)
plus skill-install Phases 0/1, distribution D/E/F, and capabilities lifecycle
B/C. The infrastructure is not the blocker — the prompt
`.claude/prompts/improve-error-surfacing-and-binary-egress.md` records that
*"the full pipeline WORKS end-to-end when the agent gets a clean run"*
(credential injection, egress, and a 50-issue listing all confirmed). What
fails, repeatedly, is the **feedback the system gives the agent at each failure
point**, and the **all-or-nothing transaction** that destroys the agent's work
when any sub-step fails.

### The root cause: one transaction fusing six concerns

`install_authored_skill` (`packages/skill-broker/src/tools/install-authored-skill.ts`)
is a single synchronous tool call that fuses:

1. **flush** the runner's live workspace to the host mirror
   (`flushWorkspaceBeforeCall: true`),
2. **validate** the bundle (`@ax/validator-skill` frontmatter veto),
3. **declare** capabilities (the `hosts`/`slots`/`packages` args),
4. **get human approval** (the `chat:permission-request` card),
5. **enter credentials** (vault write on approval),
6. **promote + materialize** (workspace draft → DB rows in `@ax/agents`
   `authored-skills.ts`, then reconstructed back into the sandbox by the
   orchestrator at `:1448`).

Because it is one transaction, any sub-step failing rolls back *all* of it. The
rollback is `git reset --hard`, which **deletes the agent's just-written
draft**. The agent then receives a generic *"could not sync, try again"* and
blind-retries the identical broken draft — observed looping 4× in one walk
(B1). This is the worst possible shape: the error is both **swallowed** and the
work is **destroyed**.

### The deeper pattern

Skill authoring is the first feature where the **agent is a closed-loop consumer
of the system's own error reporting** — it must read the error to make progress.
Every other feature tolerates a swallowed error because a human consumes it and
improvises; the agent can't, so it loops or falls back. The two recorded
failures are the same bug class:

- **B1** — validator veto → `git reset --hard` → generic "try again" → blind
  retry loop.
- **C** — npm's HTTPS agent swallows the proxy's CONNECT-403 body; the agent
  sees only `statusCode=403`, misdiagnoses "github blocked," and falls back to
  GraphQL instead of re-authoring with the right hosts.

"An error gets swallowed in the turn lifecycle and the consumer is left with a
generic message or a silent hang" is the signature defect of this codebase
(Fault A, transcript-loss-on-reload, TASK-22, TASK-24, the chat-qa-sweep B/D
residue). Skill authoring is simply where it hurts most.

### The round-trip

Underneath the transaction is an avoidable data round-trip. A self-authored
skill goes **workspace → DB → sandbox**: the agent writes `.ax/skills/<id>/`
into its workspace (which *is* the sandbox filesystem), the install flushes it
out, `@ax/agents` promotes it into DB manifest-columns + files rows, the draft
is retired, and the orchestrator then **reconstructs a SKILL.md file tree from
those DB rows** and materializes it back into the sandbox
(`orchestrator.ts:1448-1480`). The files the agent already wrote are copied out,
transformed, and copied back. The DB is treated as source of truth; the
workspace is throwaway staging.

## Core principle

**The security gate is capability-*use*, not authoring or discovery.**

- A pure-instruction skill (no hosts, no credentials, no packages) is just text
  the model reads. Letting it exist and activate freely is low-risk — this is
  exactly how Anthropic skills work.
- A skill *with* capabilities cannot reach anything until a human approves at the
  wall. Egress goes through the per-session proxy; credentials are injected only
  on approval.

The frontmatter-strip rule's *principle* (no self-grant — invariant #5) is
preserved. We only change *where* capabilities are declared (into the bundle, as
a **proposal**) and *where* they are approved (moved to first use). Declaration
was never the danger; declaration **without an approval gate attached** was.

## The model

### One primitive: the bundle

A skill is a directory: `SKILL.md` (YAML frontmatter `name` + `description`,
then a markdown body) plus optional helper files, plus a **capability proposal**
(desired hosts / credential slots / package registries). The proposal lives in
the bundle as a sidecar manifest — **not** in SKILL.md frontmatter (kept
inert/portable) and **not** auto-granted. It is what the human approves.

Everything is this one primitive:

- **Self-authored** bundles live in the workspace authoring tree.
- **Catalog** is a registry of bundles. *Install-from-catalog* copies a bundle
  into the user's workspace (then it is workspace-native too). *Share-to-catalog*
  copies a workspace bundle into the registry; *admin admit* reviews the bundle
  + its proposal.

`install_authored_skill` (the transaction) is **deleted**.
`search_catalog` / `request_capability` survive as catalog *queries*.

### Three gates, none destructive

1. **Author — write files.** The agent writes `.ax/draft-skills/<id>/` with the
   normal Write tool. Always succeeds. No validation, no approval, no veto, no
   rollback.

2. **Commit — best-effort text safety scan (existing `workspace:pre-apply`
   hook).** `@ax/validator-skill` evolves from a destructive structural veto into
   a lightweight content scan on an **accept-but-annotate** path — *never the
   veto path*. The commit always lands (work is never destroyed); the scan's
   verdict rides alongside it. The scan is deliberately simple (heuristics /
   patterns for prompt-injection, social-engineering, exfiltration cues — not an
   LLM classifier, which is itself an injection surface). It is **defense in
   depth and observability, not the security boundary.**

   On a hit → **quarantine** (see below). On a clean pass → the skill is
   eligible for the active set.

3. **Use — lazy validation + capability approval (the real boundary).**
   - **Structural validity** is parsed lazily at use. A malformed SKILL.md
     surfaces its specific reason **in-context, with the file still present** to
     edit. Never blocks the commit; never triggers a rollback.
   - **Capability approval** is reactive. Hybrid timing: the bundle's proposal
     drives **one upfront approval card on first use** (read from the bundle,
     reusing the TASK-35 card + SSE frame); anything the skill reaches that was
     **not** declared triggers a **reactive top-up** card (reusing TASK-37's
     `proxy:add-host` reactive wall).

### Discovery via a host projection, not a raw workspace scan

The runtime already has the two-location model with the exact read-only property
we want (verified in `agent-claude-sdk-runner`: `main.ts:931`,
`installed-skills.ts:8`, `git-workspace.ts:185-214`). The SDK discovers from two
`settingSources: ['user', 'project']`:

| | Authoring / draft (source of truth) | Approved / active projection |
|---|---|---|
| **Path** | `<workspace>/.ax/skills/<id>/` — *the redesign renames this `.ax/draft-skills/`; see below* (today the `project` source reaches it via the `.claude/skills` → `../.ax/skills` symlink) | `$CLAUDE_CONFIG_DIR/skills/<id>/` = `<sandbox-HOME>/.ax/session/skills/<id>/` (the `user` source) |
| **Writable** | Yes — the agent authors and edits here | **No — host chmods `0555`** so the agent's tools can't touch it |
| **In git** | Yes — committed in the workspace | No — host-materialized fresh each spawn from `AX_INSTALLED_SKILLS_JSON` |
| **Capabilities** | None — instructions only | Approved `allowedHosts` / credentials / `.mcp.json` |

So the runtime already embodies "discovery grants instructions; capabilities come
only from the host's read-only projection." `install_authored_skill` exists only
to move a bundle from the left column to the right (with caps attached) — and in
doing so it *retires* the draft.

The redesign keeps the read-only `user` projection as the **single discovery
chokepoint** and changes only what feeds it:

- **Rename the authoring dir `.ax/skills/` → `.ax/draft-skills/`, and remove the
  `.claude/skills` → `.ax/skills` symlink.** `.ax/skills/` reads as "live
  skills" — it isn't; the live copy is the read-only projection. `draft-skills`
  makes the editable-source role obvious, and with the `project` source no longer
  used for discovery, the symlink that made it masquerade as a live skills dir is
  dead weight.
- The host reads **cleared** `.ax/draft-skills/` bundles (+ catalog/default
  bundles) and materializes them into `$CLAUDE_CONFIG_DIR/skills/<id>/` —
  pure-instruction skills with empty caps, capability skills with their
  *approved* caps.
- **The raw `project` source stops being a discovery path.** Today it discovers
  `.ax/skills/` directly, which would be a quarantine backdoor (the instructions
  are right there). Routing all discovery through the host projection closes it.
- **The draft is no longer retired on approval** (see "Updating an approved
  skill"). The bundle stays in `.ax/draft-skills/<id>/` as the editable source of
  truth; the read-only projection is just a view of it.

**Quarantine = omission from the projection.** A quarantined bundle stays in
`.ax/draft-skills/<id>/` (preserved, editable) but is not materialized into the
read-only path, so the SDK never loads its name+description — the model cannot
trigger what it cannot see. There is no separate "quarantine directory": it is
the authoring bundle minus a projection.

### Updating an approved skill

The agent has exactly one place it reads and writes for create, fix-after-
quarantine, and update alike: `<workspace>/.ax/draft-skills/<id>/`. It **cannot**
edit the approved copy (`$CLAUDE_CONFIG_DIR/skills/` is `0555`), and it never
needs to — that path is the host's projection of the workspace source.

To update an approved skill, the agent edits `.ax/draft-skills/<id>/`, re-commits,
and the next fresh spawn re-projects:

- **Instructions-only edit** → re-scan + re-project, **no re-approval** (caps
  unchanged). Blast radius is bounded by the already-approved caps, the edit is
  run through the commit scan, and it only goes live at re-spawn — where the
  quarantine flag can gate it.
- **Capability addition** (new host/slot in the proposal) → only the *delta* is
  unapproved, so a reactive top-up card fires for just that on next use; existing
  approvals persist.

This depends on the redesign **not retiring the workspace draft on approval** (a
change from today, where the draft is deleted, forcing a from-scratch re-author
to make any edit).

### Activation trigger: re-spawn on active-set change

Materialization is **per fresh-spawn, not per-turn.** Verified in
`orchestrator.ts`: the warm/routed path (`:980-1100`) explicitly *"does NOT call
sandbox:open-session"*; `installedSkillsForSandbox` (`:1448`), `proxy:open-session`
(`:1139`, "Fresh-spawn path only"), and system-prompt augment (`:1102`, "the
runner doesn't reload it anyway") are all built **only** on the cold-start path.
Under keepalive a warm session reuses a frozen projection for every turn until
the idle reaper kills it.

So the activation trigger is **not** "project every turn." It is:

> When the active set (or the env it needs) changes, mark the session **dirty**;
> the next turn **re-spawns fresh** instead of reusing the warm sandbox, and the
> fresh spawn recomputes the projection — including only cleared bundles.

This reuses TASK-36 (pending-turn → re-spawn → resume). A bundle authored,
edited, cleared, quarantined, or a credential approved all flip the dirty bit.

A useful asymmetry falls out naturally:

- A **host-only** grant (no new env) can be applied **live** to the warm proxy
  session via `proxy:add-host` (TASK-37) — no re-spawn.
- A credential delivered as an **env var** (e.g. `$LINEAR_API_KEY`) can only
  reach the runner at spawn, so granting it forces a re-spawn anyway. The
  re-spawn boundary falls cleanly on "does this need new env / skills / prompt."

This also tightens quarantine: a malicious mid-session *edit* to an
already-active skill cannot take effect until a re-spawn (the runner won't reload
it live), and that re-spawn is exactly where the quarantine flag gates it out.
The keepalive freeze works *for* the security model here.

### Quarantine mechanics

- **Flag location:** host-side state keyed by `(user/agent, skillId)` — **not** a
  marker file in the workspace. A workspace marker would be agent-writable, and
  untrusted content must not control its own gate. The commit scan sets it; the
  fresh-spawn projection reads it.
- **Non-destructive + reason-driven clearing:** the scan reason is handed to the
  agent (so it revises the body and re-commits — a clean re-scan clears the flag)
  and flagged to the human (who can clear a true positive). No `git reset`, no
  blind loop — the agent always knows *why* and the file is always there to fix.
- **Metadata, not promotion:** this is thin per-skill *status*, not the heavy
  manifest-columns + files promotion we delete. Approach is "bundle is source of
  truth, metadata is thin" — not "zero DB."

## Security analysis

- **Invariant #5 (capabilities explicit + minimized, no self-grant):** preserved.
  Capabilities are a *proposal* in the bundle; the human grants them at the wall.
  An agent still cannot silently widen its reach.
- **Untrusted content treated as adversarial at every hop:** the commit scan is a
  best-effort first layer; the capability-use wall (proxy + credential injection)
  is the actual boundary. Defense in depth.
- **Discovery grants nothing:** being in the active set lets the model *read*
  instructions, not *reach* anything. The only residual risk of free discovery is
  a malicious pure-instruction body — precisely the class the commit scan flags
  and the projection omits.
- **Gate state is outside the agent's reach:** quarantine status is host-side.
- A full three-threat-model `security-checklist` pass (sandbox escape, prompt
  injection, supply chain) is required during implementation — this design
  touches sandbox boundaries, untrusted-content handling, and plugin/skill
  loading.

## What changes (component by component)

- **`packages/skill-broker`** — delete `install_authored_skill` and its
  transaction. Keep `search_catalog` / `request_capability` as catalog queries.
- **`packages/validator-skill`** — flip from destructive `workspace:pre-apply`
  veto + `git reset --hard` rollback to a non-destructive **accept-but-annotate**
  content scan that sets quarantine status. Structural frontmatter parsing moves
  to lazy/at-use.
- **`packages/agents` (`authored-skills.ts`)** — drop the workspace→DB promotion
  for self-authored skills; the bundle stays in the workspace. **Stop retiring
  the draft** so the workspace bundle remains the editable source of truth.
- **`packages/agent-claude-sdk-runner`** — route SDK discovery solely through the
  host read-only `user` projection (`$CLAUDE_CONFIG_DIR/skills/`, `0555`); rename
  the authoring dir `.ax/skills/` → `.ax/draft-skills/` and remove the
  `.claude/skills` → `.ax/skills` symlink so the raw `project` source is no longer
  a discovery path (`git-workspace.ts:185-214`). `.ax/draft-skills/` remains the
  authoring source the host projects *from*.
- **`packages/skills`** — `skills:resolve` / `skills:list-defaults` /
  projection-building reads bundles (workspace + catalog/default registry)
  instead of treating DB manifest-columns as the sole source of truth. Capability
  proposal sidecar format defined here.
- **`packages/chat-orchestrator`** — projection sourced from cleared bundles;
  add the **session-dirty → re-spawn** activation trigger (reuse TASK-36);
  host-only widening stays live (TASK-37). The `installedSkillsForSandbox`
  mapping (`:1448`) is fed from bundles + quarantine status.
- **Catalog / broker** — collapses from "promote DB skill rows" to "registry of
  bundles."
- **`packages/channel-web`** — approval cards already exist (skill + reactive
  host variants); wire the hybrid upfront + top-up timing and a human
  quarantine-clear affordance.
- **`ax-skill-creator` built-in skill** — rewrite the authoring guide for the new
  model: author by writing files; no install call; capabilities are a proposal
  the human approves at use; quarantine reasons are surfaced and fixable in place.

## Phasing sketch (to be detailed by the implementation plan)

1. **Bundle + proposal contract** — define the bundle shape (files + capability
   proposal sidecar) and the projection's bundle source.
2. **Non-destructive commit scan + quarantine** — evolve `validator-skill` off
   the veto path; add host-side quarantine status; surface reasons.
3. **Bundle-native projection + re-spawn trigger** — orchestrator reads cleared
   bundles; session-dirty → re-spawn; delete the install transaction and the
   workspace→DB promotion.
4. **Lazy capability approval** — hybrid upfront-from-proposal + reactive top-up.
5. **Catalog as bundle registry** — share/install/admit over bundles.
6. **`ax-skill-creator` rewrite + kind-walk** — author-and-run a Linear skill
   end-to-end (both the explicit-hosts and the agent-decides-hosts prompts).

Each phase observes the half-wired-window discipline (load it in CLI + k8s
preset in the same PR; explicit "window CLOSED" note) and keeps the canary using
real executors, never fire-spies.

## Open questions for the plan

- **Scan heuristics** — the concrete pattern set, and how to keep it simple
  without becoming a meaningful evasion target (we accept that it is best-effort,
  not the boundary).
- **Multi-tenant composition** — how default-attached and catalog bundles compose
  with workspace bundles in a single projection, and precedence on id collision.
- **Same-turn author+use** — default is next-turn-via-re-spawn (matches today's
  "usable next turn"). Decide whether same-turn activation (re-spawn + resume
  mid-turn) is worth the extra complexity for the MVP.
- **Migration** — what happens to existing DB-backed authored skills when the
  source of truth moves to bundles.
- **Credential delivery** — confirm the env-var-vs-proxy-substitution boundary
  that determines re-spawn-vs-live for each credential kind.
