# Skill authoring redesign — Phase 3: bundle-native projection + re-spawn trigger

**Date:** 2026-05-29
**Status:** Design — approved (decisions resolved in brainstorm), pending implementation plan
**Author:** Vinay (with Claude)
**Parent design:** `docs/plans/2026-05-29-skill-authoring-lazy-redesign-design.md`
**Phase 1 (done):** rename `.ax/skills` → `.ax/draft-skills` (PR #215, merged)
**Phase 2 (done):** non-destructive commit scan + quarantine (PR #216, merged) —
`docs/plans/2026-05-29-skill-authoring-phase-2-scan-quarantine-design.md`

## Goal

Make the host read-only `user` projection (`$CLAUDE_CONFIG_DIR/skills/<id>/`, chmod
`0555`) the **single skill-discovery chokepoint**, fed from **cleared workspace
`.ax/draft-skills/` bundles** (+ the existing catalog/default/global registry reads)
instead of a runner-local symlink. Quarantined bundles are **omitted** from the
projection so the model can't see — let alone trigger — a flagged skill: *this is
where the real discovery gate lives* (Phase 2's commit scan is best-effort
defense-in-depth; the projection is the enforcement). Then **delete the
`install_authored_skill` transaction** and the workspace→DB promotion, **stop
retiring the draft**, and add the **session-dirty → re-spawn** activation trigger so a
newly authored / edited / cleared / quarantined draft takes effect on the next fresh
spawn.

## How discovery works today (verified by reading the pipeline)

A self-authored skill is discovered **runner-locally**, invisibly to the host:

1. The agent writes `.ax/draft-skills/<id>/SKILL.md` in its workspace.
2. The runner scaffolds `<workspace>/.claude/skills → ../.ax/draft-skills`
   (`agent-claude-sdk-runner/src/git-workspace.ts`, `scaffoldWorkspaceSkillSurface`,
   called per-spawn from `main.ts`).
3. The SDK is configured with `settingSources: ['user', 'project']`
   (`main.ts:924`). The `project` source reads `<workspace>/.claude/skills/` (the
   symlink), so the SDK discovers the draft **directly from the workspace** — the
   orchestrator never enumerates it.
4. `install_authored_skill` (the transaction) promotes the draft into
   `skills_v1_user_skills` (DB), **retires** the workspace draft (`git`-deletes
   `.ax/draft-skills/<id>/`), then the approval card →
   `applyCapabilityGrant` (`orchestrator.ts:1985-2079`) calls `skills:attach-for-user`
   + `session:terminate` (forcing a next-turn re-spawn). The promoted skill then
   resolves via `skills:resolve` (DB) and is materialized into the read-only `user`
   projection by the runner (`installed-skills.ts`, `materializeInstalledSkillsFromEnv`,
   files `0444`, dirs `0555`).

So **two** discovery paths coexist today: drafts via the runner-local `project`
symlink, and promoted/attached/global skills via the host `user` projection. Phase 3
collapses this to **one**.

## Decisions (resolved in brainstorm)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Legacy / migration | **Clean-slate — no migration.** The project is still in development; there is no production data to preserve. We do **not** backfill, dual-read, or special-case existing `skills_v1_user_skills` in-chat-authored rows. (The DB read path survives anyway, but for settings-UI/admin/global skills — not to carry legacy in-chat rows.) |
| D2 | Close the `project`-source backdoor | **Drop `'project'` from the runner `settingSources`** so the `0555` host `user` projection is the *sole* discovery path. Removing only the symlink is insufficient: `.claude/skills/` is **not** on the validator veto list (it is explicit pass-through), so a bare symlink-removal would leave an agent-writable, `project`-discoverable `.claude/skills/` dir — a projection + quarantine bypass. |
| D3 | Activation timing | **Next-turn via re-spawn.** Mark the session dirty on active-set change → the next turn cold-starts and re-projects. Matches today's behavior (settingSources are read at spawn, never mid-session) and reuses the existing terminate-warm-session mechanism. Same-turn (re-spawn + resume mid-turn) stays deferred. |
| D4 | Strangler order | **Fold symlink-removal into PR-A (with the projection), not a separate later step** (a deviation from the handoff's suggested order). Running the new host projection *and* the old `project` symlink in parallel would double-discover the same skill id under both the `user` and `project` sources — undefined precedence. The discovery path must **move atomically**, not run dual. PR-A swaps it; PR-B deletes the transaction + adds re-spawn. |
| D5 | Where the workspace-draft read lives | **Move the workspace-draft read + lazy-parse + quarantine-filter into `@ax/skills`** as the projection source (matches the parent design's "skills owns projection-building reads"). Delete only the promotion + draft-retire from `@ax/agents`. The orchestrator unions this new source in alongside `skills:resolve` / `skills:list-defaults`. |
| D6 | Caps for workspace drafts in Phase 3 | **Empty caps (instructions-only).** Lazy capability *approval* is Phase 4. Phase 3 carries the approved-caps shape through the projection (so DB-resolved skills keep their caps) but grants drafts none — see the inter-phase gap below. |

## Architecture (component by component)

### Component 1 — `@ax/skills`: a workspace-draft projection source (D5)

A new read that, given `(ownerUserId, agentId)`, enumerates the agent's committed
`.ax/draft-skills/` bundles and returns them in the same `ResolvedSkill` shape that
`skills:resolve` already returns (`{id, capabilities, bodyMd, manifestYaml, files}`):

- Reads the workspace via the existing `workspace:list` / `workspace:read` hooks
  (the same mechanism `readAuthoredBundle` uses today) — the committed mirror is on
  the host, so this is a host-side read, not a sandbox round-trip.
- **Lazy manifest parse:** parse `SKILL.md` frontmatter with the existing
  `parseSkillManifest`. A malformed manifest is **skipped** (logged, not projected) —
  never throws, never blocks; the file stays in the workspace for the agent to fix.
  (Structural validity is a use-time concern per the parent design; an unparseable
  draft simply isn't discoverable until fixed.)
- **Quarantine filter:** call `skills:quarantine-get` per skill; a quarantined draft
  is **omitted** from the result. This is the Phase-2 flag's real consumer — the
  enforcement gate. Soft-dep guarded (`hasService`): a preset without the store
  projects all drafts (no quarantine, no regression).
- **Caps:** Phase 3 returns **empty** `capabilities` for workspace drafts (D6).

This read is the single home for "what self-authored skills does this agent have,
and which are safe to surface." Exposed as a `@ax/skills` service so the orchestrator
(and a future admin UI) consume it through the bus, not a direct import.

### Component 2 — orchestrator: union the new source; drop nothing that still has writers

`installedSkillsForSandbox` (`orchestrator.ts:~1448`) is fed from the union of:

1. **Self-authored workspace drafts** (Component 1) — agent's own, most local.
2. **User attachments** (`skills:resolve`, DB) — TASK-33 self-serve.
3. **Agent-global attachments** (`skills:resolve`, DB).
4. **Defaults** (`skills:list-defaults`, DB — user + global).
5. **Builtins** (config).

De-dup by `id`, **first-wins** (most-local-wins). Rationale: the agent's current
authored draft should beat a stale catalog/default copy of the same id; this extends
today's existing user-wins precedence rather than inventing a new rule.

`skills:resolve` and `skills:list-defaults` (the DB reads) are **untouched** — they
remain load-bearing for settings-UI CRUD (`skills/settings-routes.ts`), admin-promote
(`agents/admin-routes.ts`), the global skill catalog, and defaults. Phase 3 only stops
*creating* new DB rows for in-chat authoring; it does not delete the DB read path.

### Component 3 — runner: the `user` projection becomes the sole discovery path (D2)

- **Drop `'project'` from `settingSources`** (`main.ts:924` → `['user']`). The SDK
  now discovers skills *only* from `$CLAUDE_CONFIG_DIR/skills/` (the `0555`
  host-materialized projection). A direct `.claude/skills/evil/SKILL.md` write by the
  agent is simply never discovered.
- **Remove the `.claude/skills → ../.ax/draft-skills` symlink scaffold**
  (`scaffoldWorkspaceSkillSurface`, `git-workspace.ts`) and its tests. Dead once the
  `project` source no longer discovers skills.
- Confirm during implementation that nothing host-legitimate relies on the `project`
  source for project-level `CLAUDE.md`/settings (current read: it only carried the
  skills symlink; the system prompt is delivered via `system-prompt:augment`, not a
  project `CLAUDE.md`). If a legitimate project-level need surfaces, narrow rather
  than re-open skill discovery.
- The materialization path (`materializeInstalledSkillsFromEnv`, `AX_INSTALLED_SKILLS_JSON`,
  `0444`/`0555`) is **unchanged** — Phase 3 only changes what feeds it (the union now
  includes workspace drafts), not how it writes.

### Component 4 — delete the transaction + the promotion + stop retiring (PR-B)

- **`@ax/skill-broker`:** delete `install_authored_skill.ts` (tool + descriptor +
  registration). Keep `search_catalog` and `request_capability` (catalog queries).
- **`@ax/agents`:** delete the workspace→DB promotion + the **draft-retire**
  (`authored-skills.ts` + the `workspace:apply` delete block in `plugin.ts`) and the
  `agents:install-authored-skill` service, **including** the Phase-2
  `skills:quarantine-get` promote-refusal consumer — the projection-omission gate now
  supersedes it. Decide the fate of the admin-promote read path
  (`agents:list-authored-skills`): repurpose it as / replace it with the Component-1
  read, or remove it if the projection source subsumes its only caller. The bundle-read
  logic (`readAuthoredBundle`) **moves to `@ax/skills`** (D5) rather than being deleted
  outright.

### Component 5 — session-dirty → re-spawn activation trigger (D3)

When a turn's commit changes the active set, the warm session must be retired so the
next turn cold-starts and re-projects:

- **Trigger condition:** the turn committed a change under `.ax/draft-skills/`
  (author / edit / delete a draft), or a quarantine flag flipped for this
  `(user, agent)`.
- **Mechanism:** reuse the existing terminate-warm-session path — the same primitive
  `applyCapabilityGrant` already uses (`session:terminate` on the conversation's alive
  `activeSessionId`, so the next turn's routing finds it dead and takes the fresh
  cold-start path). No new `session:mark-dirty` kernel concept is required if the
  terminate-on-change shape is sufficient; if a lighter "dirty bit honored at routing"
  is cleaner, define it as a scoped orchestrator concern with a boundary-reviewed hook.
- A **host-only** host grant stays **live** via `proxy:add-host` (TASK-37) — no
  re-spawn. A new **env-var** credential forces a re-spawn anyway (env reaches the
  runner only at spawn). This asymmetry ("does it need new env / skills / prompt?") is
  the re-spawn boundary and it *tightens* quarantine: a malicious mid-session edit to
  an already-active skill can't take effect until a re-spawn, which is exactly where
  the quarantine flag gates it out.

## The inter-phase capability gap (explicit, accepted)

Phase 3 projects workspace drafts with **empty caps**; lazy capability *approval* is
**Phase 4**. PR-B deletes the old cap-granting transaction. Therefore, **between Phase 3
and Phase 4, a self-authored skill that declares capabilities (hosts / credentials /
packages) is discoverable and readable but cannot *reach* anything** — its caps are
ungranted. **Pure-instruction self-authored skills work fully after Phase 3.**

This is consistent with the parent design's phasing ("Phase 3 = discovery + projection
+ re-spawn + delete the transaction; lazy cap approval = Phase 4") and with the
Phase-6 kind-walk (the end-to-end Linear skill, which needs caps) depending on Phase 4.
Legacy DB-resolved skills (global / catalog / settings-managed) keep their
already-approved caps, so non-self-authored capability skills are unaffected. The
projection carries the approved-caps shape through, so Phase 4 only needs to *populate*
caps for drafts on approval — not reshape the projection.

**Phase 3 "walk-ready" therefore means:** a pure-instruction self-authored skill is
discoverable + activatable through the projection, and a quarantined one is invisible.
Capability author-and-run is a Phase 4+ acceptance.

## Strangler order (the half-wired-window backbone)

Two stacked PRs (a third if the re-spawn trigger is large enough to isolate). Every
commit keeps discovery working; CLAUDE.md's no-half-wired-plugins invariant holds
within each PR.

**PR-A — Discovery-path swap (non-destructive to authoring).**
- Add the Component-1 `@ax/skills` workspace-draft projection source (lazy parse +
  quarantine-omit).
- Union it into the orchestrator (Component 2) with empty caps.
- Drop `'project'` from `settingSources` + remove the symlink scaffold (Component 3).
- Load every new path in **both** CLI and k8s presets, same PR.
- The `install_authored_skill` transaction is **still present** — so nothing
  regresses; in-chat *pure-instruction* authoring now works **without** it (auto-
  projected). A draft that is then installed is retired from the workspace and resolves
  via the DB instead — no double-count, no discovery gap.
- **Canary** (real executors): a quarantined draft is **omitted** from the projection
  (the model never sees its name+description); a cleared draft **projects**.
- PR body: explicit "half-wired window OPEN until PR-B" note; the discovery path moved
  cleanly (no dual-discovery), the transaction is the only remaining promotion path.

**PR-B — Delete the transaction + stop retiring + re-spawn (window CLOSED).**
- Stop retiring the draft (delete the `workspace:apply` delete block).
- Delete `install_authored_skill` + `agents:install-authored-skill` + the promotion +
  the Phase-2 promote-refusal consumer (Component 4).
- Add the session-dirty → re-spawn trigger (Component 5).
- **Canary** extended: an authored/edited draft **re-projects on re-spawn**.
- PR body: explicit "window CLOSED" note — the projection-omission gate fully
  supersedes the Phase-2 promote-refusal; the inter-phase cap gap (above) is named.

## Security analysis (full `security-checklist` pass during implementation)

This is the slice that makes the projection the actual discovery enforcement boundary.
Three threat models:

- **Prompt injection.** Discovery grants *instructions only* — being in the active set
  lets the model read a body, not reach anything. The residual risk (a malicious
  pure-instruction body) is exactly the class the Phase-2 commit scan flags and the
  Phase-3 projection **omits**. The scan is the net; the projection is the gate.
- **Sandbox escape.** The `0555` host projection is the sole discovery path; the agent
  cannot write to it, and (D2) cannot create an alternative discoverable surface
  (`project` is dropped). A direct `.claude/skills/` write is inert. The quarantine
  flag lives in host-side state, never a workspace marker — untrusted content cannot
  control its own gate. A mid-session edit to an active skill cannot take effect until
  a re-spawn (Component 5), where the flag re-gates it.
- **Supply chain.** No new dependency. The projection reads bundles already in the
  workspace mirror and the existing content-addressed bundle store.

**Must prove (canary):** a quarantined bundle is **genuinely unreachable** — not merely
unmaterialized-but-symlinked. The dropped `project` source + omitted projection +
inert direct `.claude/skills/` write together close the backdoor.

## Boundary review (new / changed hooks)

**`@ax/skills` workspace-draft projection source (new service):**
- **Alternate impl:** the same projection input could be assembled by the orchestrator
  reading `workspace:*` directly, or (later) by a catalog/registry read for shared
  bundles. The service surface — `(ownerUserId, agentId) → ResolvedSkill[]` — is
  identical regardless of where the bundles physically live, so it's a real
  abstraction, not premature.
- **Leaking field names:** none. `ownerUserId` / `agentId` / `id` / `capabilities` /
  `bodyMd` / `manifestYaml` / `files` are domain/routing identifiers — no
  git/sqlite/k8s vocabulary, no `bundle_tree_sha`/`sha`/path-as-token in the payload.
- **Subscriber risk:** none — request/response service, not a broadcast payload.
- **Wire surface:** in-process bus only (no IPC action).

**Re-spawn trigger (Component 5):** if implemented as a new orchestrator-internal
signal rather than reusing `session:terminate`, the hook must not leak storage
vocabulary; name the alternate impl (a routing-time dirty bit on the session row vs. a
terminate call) and keep the payload to routing identifiers.

No change to the `workspace:pre-apply` payload (still veto-only) and no change to the
`AX_INSTALLED_SKILLS_JSON` materialization shape — the union simply has more entries.

## Test strategy (TDD; canary stays real, no fire-spy)

- **`@ax/skills` projection source:** enumerates drafts; lazy-parse skips a malformed
  SKILL.md (no throw, not projected); quarantined draft omitted; cleared draft
  included; soft-dep absent → all drafts projected (no crash); caps empty in Phase 3.
- **Orchestrator union:** precedence + de-dup (self-authored beats a same-id default;
  user attachment beats agent-global; etc.); a draft with no DB row still reaches the
  projection.
- **Runner:** `settingSources` is `['user']` (project dropped); the symlink scaffold is
  gone; a direct `.claude/skills/` write is not discovered.
- **Re-spawn (PR-B):** a turn that commits a `.ax/draft-skills/` change retires the
  warm session → next turn cold-starts → the projection includes the new/edited draft.
- **Canary (k8s preset acceptance, extend the Phase-2 injection canary):** through real
  executors — a quarantined bundle is **omitted from the projection** (model never sees
  name+description) and a cleared/edited bundle **re-projects on re-spawn**.

## Half-wired window discipline

- PR-A: new projection source + union + dropped `project` source land together, in
  **both** CLI and k8s presets. Discovery moves atomically (no dual-discovery window).
  Explicit "window OPEN until PR-B" note.
- PR-B: the transaction + promotion + retire are deleted only once the projection is
  the proven sole discovery path; re-spawn lands same PR. Explicit "window CLOSED"
  note, naming the accepted inter-phase capability gap.

## Out of scope (deferred)

- **Lazy capability approval** (hybrid upfront-from-proposal + reactive top-up; the
  capability-proposal sidecar format; env-var-vs-proxy re-spawn boundary per credential
  kind) → **Phase 4**. Phase 3 must not retire the draft (so Phase 4 can edit +
  re-propose in place) and leaves the approved-caps plumbing shaped for Phase 4.
- **Catalog as a bundle registry** (share / install / admit over bundles) → **Phase 5**.
- **`ax-skill-creator` rewrite + the full Linear kind-walk** (capability author-and-run)
  → **Phase 6**.
- **Same-turn author+use** (re-spawn + resume mid-turn) → deferred (D3).
- **Migration / backfill of legacy DB-backed authored skills** → not done (D1,
  clean-slate).
