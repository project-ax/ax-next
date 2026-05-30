# Skill authoring Phase 4 PR-B — hybrid approval timing (design addendum)

**Date:** 2026-05-29
**Status:** Design — approved, pending implementation plan
**Parent design:** `docs/plans/2026-05-29-skill-authoring-phase-4-lazy-approval-design.md`
**Phase-4 plan (PR-A in full + PR-B/PR-C outline):** `docs/plans/2026-05-29-skill-authoring-phase-4-lazy-approval-plan.md`
**Handoff prompt:** `.claude/prompts/implement-phase-4-pr-b-approval-timing.md`

PR-A (PR #220, merged) added the approval **store** + the `proposal ∩ approved`
**projection** (`agents:resolve-authored-skills` now returns the approved subset
as `capabilities`, the unapproved remainder as `proposalDelta`, and a
caps-stripped `manifestYaml`). It is behavior-preserving: no write path exists,
so `approved` is always empty and every draft projects empty caps.

PR-B turns the unapproved `proposalDelta` into live capabilities through a human
approval, and activates the grant per the re-spawn-vs-live asymmetry. This
addendum records the seven design decisions resolved in brainstorming (the
prompt's five open questions plus two sub-questions) and the concrete PR-B
architecture, grounded in the **merged** code (line numbers verified against
`main` @ `82db5aac`; they drift — locate by symbol).

---

## Decisions (brainstormed + approved)

### D-B1 — Upfront-card dedup hashes the *shown delta*, scoped per conversation

The dedup key is `${skillId}\u0000${hash}` where `hash` is a stable canonical
hash of the **shown** delta — `{ hosts, slots, npm, pypi }` derived from
`proposalDelta`, **excluding** `mcpServers` (MCP is deferred — D-B2). State lives
in a new `upfrontCardsByConv: Map<conversationId, Set<string>>` in the
orchestrator (mirroring the reactive wall's `wallCardsByHost`), but **keyed by
conversationId, not sessionId**, so it survives a re-spawn within the same
conversation. **Correction (found at plan time):** `chat:end` fires per-TURN (15
sites, one per outcome), so it is NOT a safe clear point — clearing there would
re-fire the card every turn. The dedup is instead cleared by the authored-grant
path on apply (so a post-approve spawn re-evaluates the now-smaller delta);
otherwise it persists for the orchestrator-instance lifetime. In-memory,
single-replica — same posture as `wallCardsByHost` / `respawnSessions`.

Consequences (these are the D3 requirements):
- A re-spawn while still-unapproved (same shown delta) → same hash → **no
  re-fire**.
- An edit that grows the proposal (new host/slot) → larger shown delta → new
  hash → **re-fires for just the current delta**.
- A partial/reactive approval that shrinks the shown delta → new hash →
  re-fires for the *remaining* unapproved delta (this is desirable: a credential
  slot has no egress signal, so it must be re-surfaced upfront).
- A shown delta that is empty (everything approved, or an mcp-only remainder) →
  **no card**.

Rejected: hashing the full proposal (wouldn't re-surface a still-unapproved
credential after a partial approval); mirroring `wallCardsByHost` session-scoped
(re-fires on every re-spawn — violates D3).

### D-B2 — MCP servers are deferred to a later PR

`PermissionCard.tsx` renders hosts/slots/packages but not MCP servers (which run
arbitrary commands like `npx -y linear-mcp` in the sandbox). Rather than add an
MCP card section now, PR-B **defers MCP approval**:

- The upfront card shows only the shown delta (hosts/slots/packages).
- The authored grant writes approval rows only for the shown delta — **never an
  `mcp` row**.
- An mcp-only delta therefore fires no card and grants nothing.
- This is **fail-closed**: an un-approvable MCP server is simply never projected
  into `capabilities`, so no `.mcp.json` materializes and the proxy/runner never
  sees it. The canary asserts this explicitly (so the deferral is a proven
  closed door, not a silent gap).

This supersedes the parent plan's PR-B canary item 7c ("a bundled MCP server's
`.mcp.json` loads once approved"); that item moves to the later MCP-card PR.

### D-B3 — Approve writes the *whole shown delta* (no per-cap selection)

One approve = grant every entry currently in the shown delta. Mirrors the
catalog card's all-or-nothing UX. Partial approval still happens organically via
the reactive host wall. Simplest state machine + revoke story (per-cap revoke is
a future admin affordance over `skills:approved-caps-revoke`). The grant is
**server-authoritative**: it re-resolves the draft's current `proposalDelta`
rather than trusting a client-supplied list.

### D-B4 — Reactive wall stays host-only; the upfront card owns credentials

The prompt (prong 4) and the parent design's data-flow point 5 call for the
reactive `kind:'host'` wall to *also* approve a credential slot when the missed
host maps to a proposal slot. **We do not do this**, because the reactive host
card (`routes-allow-host.ts`) does `proxy:add-host` + `host-grants:grant` only —
it **collects no credential value**, so "approving the slot" there would bind an
empty env var. Credentials have no egress signal anyway; they are requested
exclusively by the at-spawn upfront card (which has password inputs) and
re-surface there post-host-approval because the slot is still in the shown delta
(D-B1). The reactive path is therefore **unchanged** in PR-B.

Reactive host approvals remain durable via the existing `host-grants` store
(per-(user,agent), loaded at spawn ~`orchestrator.ts:1548`), independent of the
skill-scoped approved-caps store. A host the user allowed reactively may still
appear in a later upfront card's shown delta (approved-caps doesn't record it);
approving it there writes a harmless duplicate row. Documented, accepted.

### D-B5 — PC-2 helper is a pure, per-bundle function

`@ax/agents` exports `projectAuthoredBundle(manifestYaml: string, approved:
ApprovedCapEntry[]): { capabilities; delta; manifestYaml; description } | null`
(null = unparseable → caller skips). No I/O. The real
`agents:resolve-authored-skills` loop calls it (fetching `approved` from
`skills:approved-caps-list`); the CLI dev stub (`dev-agents-stub.ts`) calls it
with `approved=[]` (the CLI has no `@ax/skills`). This closes the PR-A drift
where the stub hand-rolled the projection — passing `manifestYaml` raw (no
caps-strip), returning no `proposalDelta` — so the CLI dev loop would silently
never surface the approval wall.

### D-B6 — `description` is added to the resolve output

The authored upfront card needs the skill's description (the catalog card shows
`detail.description`). `@ax/agents` already parses the manifest, so surface
`description` as a field on `AuthoredResolvedSkill` (+ its Zod schema) rather
than re-parsing the caps-stripped `manifestYaml` in the orchestrator. Small,
justified widening of a hook already changing this phase.

### D-B7 — The decision route re-derives authored-ness server-side

`postPermissionDecision` must route an authored draft to a new
`agent:apply-authored-capability-grant` and a catalog skill to the existing
`agent:apply-capability-grant`. The card payload carries `authored:true`, but
**the server must not trust the client to pick the grant path** (the trust split
is the headline risk). Implementation: the route calls the authored grant
**first**; the grant self-detects (re-resolves the agent's drafts) and returns
`{applied:false, reason:'not-authored'}` when `skillId` is not a draft, at which
point the route falls back to the catalog grant. One authored-resolve per
approval; the host-side grant service is the sole authority on which path runs.

---

## Architecture (one PR — half-wired window CLOSED)

Verified anchors (symbols, not line numbers — they drift):

- **Projection source:** `packages/agents/src/plugin.ts`
  `agents:resolve-authored-skills`; pure algebra
  `packages/agents/src/authored-caps.ts` (`intersectProposalWithApproved`,
  `EMPTY_CAPABILITIES`); bundle reader `packages/agents/src/authored-skills.ts`
  `listAuthoredBundles`; output types `packages/agents/src/types.ts`
  (`AuthoredResolvedSkill`, `AgentsResolveAuthoredSkillsOutputSchema`).
- **Approval store + services:** `packages/skills/src/approved-caps-store.ts`
  (`set`/`clear`/`list` exist); `skills:approved-caps-list` registered in
  `packages/skills/src/plugin.ts`; types in `packages/skills/src/types.ts`.
- **Orchestrator cold-start:** `packages/chat-orchestrator/src/orchestrator.ts` —
  catalog fold loop over `attachments` (~`:1407-1445`), authored resolve
  (~`:1461-1475`), registry auto-allow over `unionedSkills` (~`:1522-1538`,
  **already covers authored packages**), host-grants load (~`:1548`),
  `unionedAllowlist` freeze (~`:1561`), `installedSkillsForSandbox`
  (~`:1563-1595`), `proxy:open-session` (~`:1597`). Catalog grant
  `applyCapabilityGrant` (~`:2100`); reactive wall `onHttpEgress` +
  `wallCardsByHost` (~`:766-800`); `respawnSessions` + `onWorkspaceApplied`
  (~`:812-900`, consumed at routing ~`:1019-1037`). Service registrations in
  `packages/chat-orchestrator/src/plugin.ts`.
- **Cards:** union `packages/channel-web/src/server/types.ts` `PermissionRequest`
  (the `skill` variant already has `authored?` + `packages?`); catalog builder
  `packages/skill-broker/src/tools/request-capability.ts`; SSE match
  `packages/channel-web/src/server/sse.ts` (skill by `conversationId`, host by
  `reqId`); component `packages/channel-web/src/components/PermissionCard.tsx`
  (renders the authored banner, slots, packages; writes keys via
  `setDestinationCredential`, POSTs `{conversationId, skillId}`); decision route
  `packages/channel-web/src/server/routes-chat.ts` `postPermissionDecision`;
  reactive host route `packages/channel-web/src/server/routes-allow-host.ts`.

### 1. PC-2 — shared pure helper (`@ax/agents`)

Extract `projectAuthoredBundle(manifestYaml, approved)` (D-B5/D-B6). Rewire the
real handler loop to call it; sync `dev-agents-stub.ts` to call it with `[]`.
Add `description` to `AuthoredResolvedSkill` + schema + the PR-A projection test
+ the PR-A canary's projection assertions.

### 2. PC-1 — egress wiring (`chat-orchestrator`) — the correctness keystone

After `authoredDraftSkills` resolves, fold each authored skill's
`capabilities.allowedHosts` into `baseAllowSet` and `capabilities.credentials`
into `baseCreds`, deriving the ref the way the card wrote it:
`slot.account !== undefined ? account:<svc> : skill:<skillId>:<slot>` (must match
the catalog `applyCapabilityGrant` convention **and** the card's
`setDestinationCredential` `skill-slot` destination — verify the latter in the
plan). Reuse the existing `slotOwners` collision check: a slot name already owned
by a trusted source (agent default / catalog attachment) is a **fatal terminate
with a clear `reason`** — an untrusted draft must never hijack or be silently
mis-bound to a trusted credential. Registry hosts need no change (the
`unionedSkills` registry loop already folds approved authored packages).

Without PC-1 an approved authored host projects into `capabilities` yet the proxy
still blocks it ("approved but unreachable" — a silent failure). PC-1 is a no-op
while approvals are empty, so it is safe to land first.

### 3. Write services (`@ax/skills`)

Register `skills:approved-caps-set` + `skills:approved-caps-revoke` over the
existing store `set`/`clear`. Add `SkillsApprovedCapsSet{Input,Output}` /
`...Revoke{Input,Output}` + Zod schemas (mirror `-list`), index exports, manifest
`registers` entries, and a preset reachability assertion. Boundary-neutral
(`kind`/`value`/`detail`). `set` carries `detail` (slot kind/account) for audit;
the projection still matches on `(kind,value)` only.

### 4. Authored-grant path (`chat-orchestrator`) — `agent:apply-authored-capability-grant`

A **new** service, distinct from the catalog `agent:apply-capability-grant`.
Input `{conversationId, userId, agentId, skillId}`. Steps:

1. Re-resolve the agent's authored skills (`agents:resolve-authored-skills`);
   find `skillId`. Not found → return `{applied:false, reason:'not-authored'}`.
2. Take its `proposalDelta`; compute the **shown** delta (hosts/slots/npm/pypi,
   excluding mcp — D-B2).
3. For each shown entry → `skills:approved-caps-set` (host/slot/npm/pypi), with
   `detail` for slots.
4. Classify (the asymmetry table): **any credential slot in the shown delta →
   `session:terminate`** for the conversation's warm session (next-turn re-spawn
   folds caps + injects env via PC-1); **else (host/package-only) → live
   `proxy:add-host`** for each approved host (registry hosts ride the next
   spawn). Re-spawn supersedes live-add when both apply.
5. Return `{applied:true, respawned: boolean}`.

Registered host-side only (channel-web → orchestrator), not an IPC action —
same posture as the catalog grant. `@ax/skills` peers are `hasService`-gated.

### 5. Upfront card at-spawn (`chat-orchestrator`)

In the cold-start path, for each authored skill with a non-empty **shown** delta,
build a `kind:'skill'`, `authored:true` card payload from the delta +
`credentials:list` (for `haveExisting`/`account` per slot, mirroring
`request-capability.ts`) + the new `description`, and fire one
`chat:permission-request` deduped per `(conversationId, skillId, deltaHash)`
(D-B1). New `upfrontCardsByConv` Map cleared on `chat:end`. The SSE already
routes skill cards by `conversationId`; the card component already renders the
authored variant.

### 6. Decision routing (`channel-web`)

`postPermissionDecision`: try `agent:apply-authored-capability-grant` first; on
`{applied:false, reason:'not-authored'}` fall back to `agent:apply-capability-grant`
(D-B7). Guard both with `hasService`. `PermissionCard.tsx` is unchanged for the
happy path (it already collects keys + POSTs `{conversationId, skillId}`; the
authored credential write reuses the same `skill-slot` destination →
`skill:<skillId>:<slot>` ref that PC-1 reads).

### 7. Reactive top-up — documented no-change (D-B4).

### 8. Quarantine-clear affordance (`channel-web`, shadcn)

HTTP routes over the existing `skills:quarantine-list` / `skills:quarantine-clear`
+ a small settings UI to list and clear a quarantined draft (Phase-2 services,
no UI yet). Most separable task; may split to a follow-up if review prefers.

### 9. Canary (`presets/k8s`, real executors — no fire-spy)

Extend `presets/k8s/src/__tests__/acceptance.test.ts`:
- (a) **PC-1 proof / security keystone:** approve an authored host →
  projected → **reachable through the proxy** (and the credential reaches
  `envMap`); an *unapproved* host stays blocked.
- (b) a **credential** grant flips re-spawn while a **host-only** grant goes
  live (`proxy:add-host`, no re-spawn).
- (c) **MCP fail-closed:** a proposal with an mcp server, even approved at the
  card, does NOT project the mcp server / write `.mcp.json`.

---

## Boundary review

- **`skills:approved-caps-set` / `-revoke`:** alternate impl — a per-skill
  snapshot blob (rejected in PR-A: coarse revoke, non-queryable delta). Field
  names `kind`/`value`/`detail` are backend-neutral; no `sha`/path/row
  vocabulary. No subscriber keys off a backend-specific field.
- **`agent:apply-authored-capability-grant`:** alternate impl — extend the
  catalog grant (rejected — collapses the trust split) or write approved-caps +
  fire re-spawn from the route (rejected — session/proxy orchestration belongs in
  the orchestrator, which owns sessions). Fields `conversationId`/`userId`/
  `agentId`/`skillId` are domain ids, no leak. `{applied, reason, respawned}` is a
  neutral result. Not an IPC action (agent/runner can't reach it).
- **`AuthoredResolvedSkill.description`:** a plain string; no leak.
- **Trust split:** the authored path never routes through
  `skills:attach-for-user` / the catalog grant; the discriminator
  (`reason:'not-authored'` fall-through) keeps the two paths visibly distinct.

## Constraints / invariants

- **security-checklist** (proxy allowlist boundary + untrusted content + new
  services + plugin loading). Headline: only the approved subset is reachable;
  approval is host-side, outside the agent's reach (#5, no self-grant); the
  trusted catalog path is untouched; an *unapproved* host stays blocked AND an
  *approved* host is reachable (PC-1).
- **Half-wired-window discipline (#3):** every new service / card path / grant is
  loaded + reachable + tested in the CLI + k8s presets in this PR. Explicit
  "window CLOSED" note in the PR body.
- **One source of truth (#4):** the bundle frontmatter is the proposal source;
  the approved-caps store is thin approval metadata; the projection is the view.
  No second proposal source.
- **Bug-fix-needs-test + canary stays real** (real executors, never fire-spy).
- **Re-spawn boundary (verified):** api-key credentials are env vars frozen at
  spawn → a credential grant re-spawns; host-only widen goes live via
  `proxy:add-host`.

## Deviations from the handoff prompt (record in the PR body)

- **MCP card deferred** (D-B2). Prong-7c canary becomes a fail-closed assertion;
  the rich MCP card moves to a follow-up PR.
- **Prong-4 reactive→credential enrichment dropped** (D-B4) — the reactive host
  card collects no credential value, so the enrichment would bind an empty env
  var; credentials flow through the upfront card instead.
