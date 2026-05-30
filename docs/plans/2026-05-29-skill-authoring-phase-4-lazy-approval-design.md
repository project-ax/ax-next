# Skill authoring Phase 4 — lazy capability approval

**Date:** 2026-05-29
**Status:** Design — approved direction, pending implementation plan
**Author:** Vinay (with Claude)
**Parent design:** `docs/plans/2026-05-29-skill-authoring-lazy-redesign-design.md`
**Handoff prompt:** `.claude/prompts/implement-phase-4-lazy-approval.md`

## Where this sits

Phase 4 of the skill-authoring lazy/bundle-native redesign. It turns the Phase-3
**empty-caps projection** into the real **lazy capability-approval wall** for
*self-authored* skills.

- **Phase 1 (PR #215):** rename `.ax/skills/` → `.ax/draft-skills/`.
- **Phase 2 (PR #216):** non-destructive commit scan + host quarantine store
  (`skills:quarantine-{set,clear,get,list}`).
- **Phase 3 (PRs #218 + #219):** the host read-only `user` projection
  (`$CLAUDE_CONFIG_DIR/skills/`, `0555`) is the sole discovery path, fed from
  cleared `.ax/draft-skills/` bundles. `agents:resolve-authored-skills` projects
  drafts **with EMPTY caps** — the exact placeholder Phase 4 fills. The
  `install_authored_skill` transaction + promotion + draft-retire are deleted; the
  workspace bundle is the source of truth. A `workspace:applied` subscriber marks a
  session dirty on a `.ax/draft-skills/` change → next-turn re-spawn (the
  `respawnSessions` Set). **Phase 4 reuses this for env-var credential grants.**

## Goal

A self-authored bundle carries a **capability proposal** (desired hosts /
credential slots / package registries / MCP servers). The human approves it at the
wall; only the **approved subset** is projected into the skill's caps. Two timings,
both reusing existing cards:

- **Upfront from proposal** — one approval card driven by the bundle's proposal
  (reuse the TASK-35 `kind:'skill'` card + SSE frame), so the user approves the
  declared set once.
- **Reactive top-up** — anything the skill reaches that was **not** in the approved
  set fires a top-up card (reuse the TASK-37 `kind:'host'` reactive egress wall).

## The four load-bearing decisions (resolved in brainstorming)

### D1 — The proposal lives in SKILL.md frontmatter (NOT a sidecar)

**This deliberately overrides the handoff prompt's prong 1**, which specified a
`.ax/draft-skills/<id>/capabilities.json` sidecar. Decision: the existing SKILL.md
frontmatter `capabilities:` block **is** the proposal.

Rationale:

- Reuses `parseSkillManifest` / `buildSkillManifestYaml` and the full validator
  surface (`HOSTNAME_RE`, `SLOT_RE`, `ACCOUNT_RE`, MCP command whitelist) as-is.
  `listAuthoredBundles` already parses the manifest for validity — it just discards
  the caps today.
- Keeps self-authored and catalog bundles **byte-identical** ("one primitive: the
  bundle"). A sidecar would diverge workspace bundles from catalog bundles, which
  carry caps in frontmatter via `skills:resolve`.
- The agent (Phase 6) already knows the frontmatter format; no second file to teach
  or keep consistent.

The parent design's "proposal lives as a sidecar, **not** in SKILL.md frontmatter
(kept inert/portable)" is honored *by a different mechanism* — see the security
model. The "inert" property is real; it is just enforced at the projection, not by
file layout.

### D2 — Skill-scoped per-capability approval store

New store in `@ax/skills`, beside quarantine (same db handle, same migration
pattern):

```
skills_v1_approved_caps
  owner_user_id  TEXT
  agent_id       TEXT
  skill_id       TEXT
  cap_kind       TEXT   -- 'host' | 'slot' | 'npm' | 'pypi' | 'mcp'
  cap_value      TEXT   -- host / slot name / package name / mcp server name
  cap_detail     JSONB  -- {kind, account} for slot; McpServerSpec for mcp; null otherwise
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  PRIMARY KEY (owner_user_id, agent_id, skill_id, cap_kind, cap_value)
```

Semantics: `approved` = the union of all rows for `(user, agent, skill)`.

- **projection** = `proposal ∩ approved`.
- **top-up delta** = `proposal − approved`.
- A proposal **edit** that adds a host/slot leaves prior approvals intact; only the
  delta is unapproved (the parent design's "only the delta is unapproved"). On
  approve, the delta's rows are written into the union.

Skill-scoped (not agent-wide) honors invariant #5 (minimize) and gives per-cap
revoke + audit. Note an existing limitation: the **proxy allowlist is
session-wide**, so the *effect* of a host approval is session-wide even though the
approval *record* is skill-scoped. The skill-scoped record still buys correct
re-projection, per-skill revoke, and clean audit.

Services (quarantine naming): `skills:approved-caps-set`, `skills:approved-caps-list`,
`skills:approved-caps-revoke`. Keyed `(ownerUserId, agentId, skillId, …)`.

### D3 — Upfront card fires at-spawn on a non-empty unapproved delta

When the orchestrator builds the projection and an **active** self-authored skill
has a non-empty `proposalDelta`, fire **one** upfront `kind:'skill'` card
(`authored: true`) for that delta. Deduped per `(conversation, skillId,
proposalHash)` so a re-spawn while still-unapproved does not re-fire.

The authoring/edit re-spawn (`onWorkspaceApplied`, already wired) is the natural
first fire — i.e. right after the agent writes the skill. Caps stay empty/partial
until approved. The reactive wall still catches **undeclared** reach.

Why not purely-reactive: a credential slot has no egress signal. An unapproved
`$LINEAR_API_KEY` is simply unset, so the `curl` sends an empty auth header and
fails — the human is never asked for the key. The at-spawn upfront card requests
credentials before they would silently fail. (Hosts and package registries *do*
surface reactively as allowlist misses; credentials do not.)

### D4 — Separate authored-grant path

The existing `agent:apply-capability-grant` is the **catalog** path
(`skills:resolve` + `skills:attach-for-user`) and stays untouched. A self-authored
draft is never in the catalog, so a new explicit path handles it:

```
authored grant (card.authored = true; skillId resolves to a draft, not catalog):
  skills:approved-caps-set rows for the approved proposal
  classify the newly-approved delta:
    host-only (incl. registry hosts) → proxy:add-host (LIVE, no re-spawn)
    contains credential slot or mcp   → session:terminate → fresh re-spawn

catalog grant (UNCHANGED):
  agent:apply-capability-grant → skills:resolve + skills:attach-for-user
```

Keeping the paths visibly distinct is the trust split the prompt flags as the
subtle risk: trusted catalog/admin frontmatter caps must never route through the
untrusted-draft approval path.

## Security model (the crux of the frontmatter choice)

Frontmatter caps are a **declaration, never a grant.**

- Enforcement (proxy allowlist + envMap) is sourced from `s.capabilities`, which the
  projection computes as `proposal ∩ approved`. It is **never** read from the
  frontmatter text. A draft declaring `allowedHosts: [evil.com]` projects to empty
  until a human approves it into the store; the proxy blocks it.
- **`agents:resolve-authored-skills` returns a caps-stripped `manifestYaml`**
  (name + description + version only). The materialized read-only `SKILL.md` the SDK
  sees has **no** caps block, so no current or future code path can mistake
  frontmatter for a grant, and the file is a clean Anthropic skill. The workspace
  draft keeps its full frontmatter (the proposal source of truth). This replaces the
  destructive validator `stripCapabilitiesFromFrontmatter` with a non-destructive
  projection-time normalization.
- Approval state is **host-side**, keyed `(user, agent, skill)`, outside the agent's
  reach — never a workspace marker (same rule as quarantine; untrusted content must
  not control its own gate).
- No smuggling via catalog: a draft is never admitted to the catalog, so
  `skills:resolve` never returns it and the orchestrator's catalog union never
  includes it. Only `agents:resolve-authored-skills` includes it, approval-filtered.

## Data flow

1. **`@ax/agents` owns the intersection.** `agents:resolve-authored-skills`:
   - parses the bundle frontmatter proposal (reuse `parseSkillManifest`),
   - calls the new soft-dep `skills:approved-caps-list`,
   - returns per skill: `capabilities = proposal ∩ approved`,
     `proposalDelta = proposal − approved`, and a **caps-stripped** `manifestYaml`.
   Soft-dep just like the existing `skills:quarantine-get` consult.
2. **Orchestrator** uses `capabilities` to build `installedSkillsForSandbox` /
   `unionedAllowlist` / `unionedCreds` exactly as today, and uses `proposalDelta`
   to decide whether to fire the upfront card (deduped). Card firing + dedup state
   live in the orchestrator (where the reactive `wallCardsByHost` dedup already
   lives).
3. **Approval store** in `@ax/skills`.
4. **Grant** via the authored-grant path (D4), then live `proxy:add-host` or
   `session:terminate` → re-spawn by delta kind.
5. **Reactive top-up** = the existing `kind:'host'` wall, enriched: if the missed
   host appears in an active draft's proposal with a cred slot, the grant also writes
   that slot's approval (→ re-spawn, since it is a credential).

## Re-spawn-vs-live asymmetry (verified against the code)

| Approved delta contains | Activation | Mechanism |
|---|---|---|
| Hosts only (incl. npm/pypi registry hosts) | **Live, no re-spawn** | `proxy:add-host` per host (allowlist Set read by reference) |
| Any credential slot (`api-key` → env var) | **Re-spawn** | envMap frozen at spawn → `session:terminate` → fresh spawn |
| Any MCP server | **Re-spawn** | `.mcp.json` materialized at spawn under `settingSources: ['user']` |

The only manifest credential kind today is `api-key`, delivered as an env var
(frozen at spawn). `proxy:rotate-session` / `sessionsNeedingRotation` are for
non-`api-key` kinds (none exist yet) and do **not** interact with Phase 4.

Package approval (`npm`/`pypi`): the package itself is gated by its **registry
host** (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`). The orchestrator
auto-allowlists those when a projected skill declares packages. Approving a package
adds the registry host live via `proxy:add-host` (host-class → live). The package
list in the projection only gates the registry host; it carries no separate
spawn-time materialization.

## Strangler order — 3 stacked PRs

Each green + walked, with an explicit window note. Self-authored caps stay
empty-by-default until approved at every intermediate commit.

- **PR-A — projection + store (window OPEN).**
  Add the approval store + `skills:approved-caps-{set,list,revoke}` services in
  `@ax/skills`. Extend `agents:resolve-authored-skills` to return
  `proposal ∩ approved` + `proposalDelta` + caps-stripped `manifestYaml`. With no
  approvals yet, every draft still projects empty (the safe default). Load the store
  in the CLI + k8s presets in the same PR.
  **Canary:** an unapproved draft projects with empty/partial caps and the proxy
  blocks its declared host (mirror the Phase-3 quarantine-omit canary, real
  executors, no fire-spy).

- **PR-B — hybrid approval timing (window CLOSED for approval).**
  Upfront card (at-spawn on delta, deduped) + reactive top-up enrichment + the
  authored-grant path (store-write → live/re-spawn by delta) + channel-web wiring
  (the `authored` banner already renders; route authored decisions to the new path)
  + a human **quarantine-clear** affordance (the `skills:quarantine-list` service
  from Phase 2 was provided to unblock this). Load every new card path/service in
  CLI + k8s presets.
  **Canary:** approve → projected → reachable; a credential grant flips re-spawn
  while a host-only grant goes live; a bundled MCP server loads once approved
  (carries the Phase-3 verification item: `.mcp.json` under
  `settingSources: ['user']`).

- **PR-C — remove the destructive caps-strip.**
  Delete `stripCapabilitiesFromFrontmatter` (validator) and its
  `skills:capabilities-stripped` warn (keep the observable warn only if still
  useful). Confirm frontmatter caps on a self-authored draft are genuinely inert
  (the host honors only `s.capabilities` from the approval store). Move structural
  frontmatter validity to lazy/at-use per the parent design. Safe only **after**
  PR-A/B make the projection source caps from the store, not frontmatter.

  (PR-C may fold into PR-B if review prefers; kept separate so CodeRabbit gets a
  main-based pass on the removal after PR-A/B land.)

## Boundary review (for the PR descriptions)

- **Alternate impl for `skills:approved-caps-*`:** a per-skill snapshot blob
  (`(user, agent, skill) → approved JSON + hash`) — rejected for coarse revoke and
  non-queryable deltas. So the hook is justified.
- **Leaking field names:** `cap_kind` / `cap_value` / `cap_detail` are
  backend-neutral; no `sha` / path-as-token / storage vocabulary. The new
  `proposalDelta` field on `agents:resolve-authored-skills` is a `SkillCapabilities`
  shape — no leak.
- **Subscriber risk:** none key off a backend-specific field.
- **Trust split:** sidecar/proposal/approval path is **self-authored-only**;
  admin/global/catalog frontmatter caps stay on `skills:resolve`, never routed
  through approval.

## Constraints / invariants

- **security-checklist** — all three threat models; this is the slice that makes
  capability *use* the real boundary. Prove an unapproved-proposal skill cannot
  reach its declared host (proxy still blocks), and that approval state lives
  host-side.
- **Half-wired-window discipline** — load every new store/service/card-path in CLI +
  k8s presets in the same PR; never remove the caps-strip in a PR that would leave a
  self-grant gap. Explicit "window CLOSED" note per PR.
- **One source of truth (#4)** — the bundle frontmatter is the proposal source; the
  approval store is thin metadata; the projection is a view. No second proposal
  source.
- **Bug-fix-needs-test + canary stays real** — extend
  `presets/k8s/src/__tests__/acceptance.test.ts` through real executors per the
  canary notes above.

## Relationship to remaining phases

**Phase 5** = catalog as a bundle registry (share/install/admit over bundles) —
where the catalog format also becomes bundle-native, completing "one primitive."
**Phase 6** = the `ax-skill-creator` rewrite + the end-to-end kind-walk (author and
run a Linear skill, both explicit-hosts and agent-decides-hosts prompts), where
Phase 4's proposal-authoring is taught to the agent. Phase 4 should leave the system
walk-ready: a self-authored skill that proposes a host + credential, gets approved
at the wall, and reaches the host on the next (re-spawned) turn.
