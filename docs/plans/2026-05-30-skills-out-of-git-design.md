# Skills out of git — DB + blob substrate, hybrid materialization gate

**Status:** Proposed (needs human sign-off before any code moves — reworks a subsystem merged days ago)
**Date:** 2026-05-30
**Author:** Vinay (with Claude)
**Related:**
- `2026-05-30-storage-out-of-git-design.md` (the `blob:*` store and `/ephemeral` model this depends on)
- `2026-05-29-skill-authoring-lazy-redesign-design.md` (the lazy redesign this adjusts — keeps most of it, swaps the substrate and tightens the gate)
- `2026-05-29-skill-authoring-phase-3-bundle-projection-design.md` (the workspace-draft projection this replaces)
- `2026-05-29-skill-authoring-phase-4-lazy-approval-design.md` (the reactive cap approval this re-times to before-materialize)
- `2026-05-27-agent-authored-skills-skill-creator-design.md` (authored-skills flow)
- `2026-05-26-just-in-time-capabilities-design.md` (JIT caps, approval-card SSE frame, reactive egress wall)
**Supersedes (in part):** the "skill drafts live in committed `.ax/draft-skills/`" decision (storage design §E, phase-3 projection) and the lazy *reactive-at-the-wall* capability approval timing (phase-4).

---

## TL;DR

Skills are the **last thing still in git** after the storage simplification. Drafts are authored into `/permanent/.ax/draft-skills/`, committed, bundled, and projected back into the sandbox via the workspace hooks — and the capability bundle is backed by an isomorphic-git tree (TASK-40). That keeps the per-turn git pipeline load-bearing for the one workload the lazy redesign was supposed to make cheap, and it splits the skill source-of-truth: DB rows for installed/catalog skills, a git workspace for drafts.

This proposal finishes the job the storage doc started:

1. **Skills leave git entirely.** Authoring goes to `/ephemeral` scratch; the agent proposes a bundle over IPC (`skill_propose`); the host stores it in the **DB + `blob:*` store** as the single source of truth for *all* skills (catalog, default, user-attached, authored).
2. **Deletes the bundle-in-git tree (TASK-40)** — sha256 in the blob store gives the same integrity/dedup with none of the git coupling.
3. **A hybrid materialization gate.** Self-authored, zero-capability skills materialize freely after the best-effort scan; anything that carries reach (hosts / credentials / MCP / packages) **or** is imported from outside is **approve-before-materialize**.
4. **Keeps the parts that work** — the read-only `0555` ephemeral skill-dir projection (`installed-skills.ts`), quarantine-as-host-state, the session-dirty → re-spawn trigger, the capability-proposal concept, the approval-card SSE frame (TASK-35), and the runtime reactive egress wall (TASK-37) as a safety net.

Net: one source of truth for skills (DB + blob), git fully off the chat path, and a human gate that's proportional to risk — silent for instruction scaffolding, explicit when the agent asks for network and secrets.

---

## The problem

The lazy redesign (2026-05-29) fixed the *transaction* problem — it split `install_authored_skill`'s six fused concerns so a failing sub-step no longer `git reset --hard`s the agent's work. But it left two structural issues, because at the time the storage substrate (`blob:*`, `/ephemeral`) didn't exist yet:

### 1. Skills are still in git — and split-brained

| Skill kind | Source of truth today |
|---|---|
| Catalog / default / user-attached | DB rows (`@ax/skills`, `@ax/agents` `authored-skills.ts`) |
| Agent-authored **drafts** | git workspace — `/permanent/.ax/draft-skills/<id>/`, committed + projected via `workspace:list`/`workspace:read` |
| Capability **bundle** bytes | isomorphic-git tree (TASK-40, "bundle git-tree backing byte store") |

Two stores for one concept (CLAUDE.md invariant I4). A draft becomes "real" by crossing from the git workspace into DB rows, and the bundle bytes live in a *third* place (a git tree) that exists only because we hadn't built a blob store. The storage doc explicitly left this as the one thing git keeps (§E) — but it's keeping it for want of an alternative, not because skills want versioning. They don't: a skill bundle is an opaque, content-addressed unit, last-write-wins per draft, exactly like an artifact.

### 2. The git path is back on the hot loop

The whole point of the lazy redesign was to make "author a Linear skill and run it" cheap and legible. But projecting a draft still rides the workspace-git pipeline (commit → bundle → host mirror → re-project), which the storage doc just removed from every *other* turn. Skills authoring becomes the **last reason** the deterministic-OID tri-party coupling and the per-turn commit have to exist.

### 3. The cap gate fires late

Phase 4 approves capabilities **reactively** — the skill materializes, runs, hits the egress wall, and *then* the human sees a card. That's a clever fit for *undeclared* reach (a skill that surprises us), but for a skill that declares `hosts: [api.linear.app]` + a credential up front, it means the risky bytes are already projected and running before anyone consented. The human gate wants to be *before* first run for the declared-capability case.

---

## What changes

Four moves. They sit directly on the storage doc's substrate, so most of the machinery already exists.

### A. Authoring goes to `/ephemeral`; the agent proposes over IPC

Drafting moves off git onto the same scratch tier artifacts use:

1. The agent writes the bundle into **`/ephemeral/skill-draft/<id>/`** (`SKILL.md`, extra files, a manifest declaring capability *proposals*). This is throwaway scratch — `git add -A` never sees it (storage doc §C), and a failed author leaves nothing to roll back.
2. The agent calls **`skill_propose(path)`**. The runner-side executor validates structurally (`parseSkillManifest`, `validateBundleFiles`, capability shape) — the same checks the broker does today — then streams the bundle bytes over IPC.

This replaces the "flush workspace → projection reads the committed draft" path (phase-3 Component 1) with a direct upload. The `validator-skill` `pre-apply` veto survives as a structural gate on `skill_propose` — it keyed off a *write chokepoint*, not git specifically (storage doc §E), and `skill_propose` is that chokepoint now.

### B. The host stores skills in DB + blob — the single source of truth

```
skill_propose(ctx, { manifest, files[], capabilityProposal, origin }) → { skillId, status }
```

The host:
- writes the bundle bytes to **`blob:put`** (content-addressed; storage doc §B) — kills the TASK-40 git-tree backing,
- inserts/updates **one** skill row `{ skillId, manifest, capabilityProposal, blobSha, origin, status, scanVerdict, approvedCapabilities }`,
- returns a `skillId` + the resulting `status` (see the gate, §C).

This is the **same table** that already holds catalog / default / user-attached skills. Authored skills stop being a separate git-backed species — they're rows with `origin = 'authored'`. One source of truth (I4), one store to query for "what skills exist," one GC story (reference-counted blobs, storage doc open-Q 3).

`origin` is known at the IPC boundary and drives the gate: `authored` (the agent composed this bundle), `imported` (a catalog/external pull), or `attached` (an admin/user action).

### C. The hybrid materialization gate

Classified by the host at propose time, from two facts it already has — the capability proposal and `origin`:

```
clean scan  AND  origin = authored  AND  capabilityProposal = ∅
    → status = active           (materialize freely, no human)

otherwise (any capability, OR origin ∈ {imported, attached})
    → status = pending          (approve-before-materialize; nothing projects)

scan hit (any class)
    → status = quarantined      (omit from projection; reason returned to agent)
```

- **Free path** — self-authored instruction scaffolding (a commit-message style guide, a "how we structure tests" skill). No reach to consent to; the best-effort scan is the only check. Materializes into the `0555` dir on the next spawn. The residual risk (the agent freely activating instruction text it wrote itself) is exactly the posture the lazy redesign already accepted for this case.
- **Gated path** — anything with `hosts`/`credentials`/`mcp`/`packages`, or anything pulled from outside. The whole skill waits in `pending`; **no bytes project, no caps inject** until a human approves via the existing approval-card SSE frame (TASK-35). On approve, the host records the approved capability subset (`proposal ∩ approved`, unchanged from JIT) and flips to `active`.
- **Quarantine** stays host state (phase-2): a flagged bundle is simply omitted from the projection with a reason, never silently dropped.

This **moves the capability gate before first run** for the declared case, which is stricter *and* simpler than phase-4's reactive timing. The phase-4 reactive cap top-up is no longer needed for *declared* skill caps. The **runtime reactive egress wall (TASK-37) stays** — it now guards only *undeclared* reach (a skill that tries to hit a host it never proposed), which is its proper job as a runtime safety net, independent of skill approval.

### D. Materialize via the existing projection — unchanged

`active` skills project into the read-only **`0555` `$CLAUDE_CONFIG_DIR/skills/`** dir at spawn, exactly as `materializeInstalledSkillsFromEnv` (`agent-claude-sdk-runner/src/installed-skills.ts`) does today — the host just feeds it from `blob:get` instead of a git projection. Capabilities (credentials, egress allowlist) inject at spawn from the approved set in the DB. Nothing about the projection, the immutability, or the credential injection changes; only the *source* of the bytes does.

---

## The user-facing UX

The substrate is invisible to the user; the **gate** is what they feel, and it's proportional to risk. Two cases.

### Gated: "make me a Linear skill"

A Linear skill needs `api.linear.app` + `LINEAR_API_KEY` → gated → approve-before-materialize.

**Turn 1 — user:** "Make me a skill for working with Linear issues."

**Turn 1 — agent (visible, brief):** drafts into `/ephemeral/skill-draft/…`, calls `skill_propose`. The transcript shows light activity (*"Drafting `linear` skill…"*), then an **approval card** appears inline:

> **🧩 New skill: `linear`** — proposed by the agent
> Lets me create, read, and update Linear issues.
> **Wants:** network access to `api.linear.app` · a credential `LINEAR_API_KEY` (not set)
> **Instructions preview:** [expandable — the SKILL.md body]
> `[Approve]` `[Approve & add key…]` `[Deny]`

The agent's turn **ends here**, with a forward-pointing line:
> "I've proposed a **`linear`** skill — approve it above and it'll be ready on your next message."

**The card — user approves & pastes the key.** The credential goes to the vault (never the bundle, blob, or git); the host flips the row to `active` and records the approved caps.

**Turn 2 — user:** "Great, list my open issues." → fresh spawn projects the dir *with* `linear` in it, injects the credential, the agent invokes the skill and lists the issues.

From the user's seat this is a normal *ask → approve → use* exchange. The re-spawn is invisible — it's just "the thing I approved now works."

### Free: "make me a commit-message style skill"

Zero capability, self-authored → free. The user sees *"Added a `commit-style` skill"* and it's live next turn. **No card, no interruption.** The gate only appears when there's actual reach to consent to.

### Why the seam disappears

- **The card *is* the pause.** A capability skill already stops for human approval; the re-spawn boundary hides entirely behind a stop the user was making anyway. By the time they've read the card and pasted a key, the re-spawn cost is already spent.
- **Wording points forward** ("ready on your next message"), framing the boundary as anticipation, not latency. The anti-pattern — *"Skill installed. (You may need to start a new session.)"* — leaks the mechanism and reads like a bug.
- **A persistent "Skills" affordance** (a chip / list outside the transcript) shows the just-approved skill as installed, so next-turn activation isn't on faith.

---

## The spawn-time-discovery constraint (state it loudly)

**Skills are discovered at spawn, not live.** Materializing a skill into the dir while the agent process is already running is invisible to the model, for two independent reasons:

1. **Awareness.** The model only knows a skill exists because its **name + description were injected into context at spawn**. Writing a new skill to disk mid-turn doesn't retroactively edit context the model already received — it can't see the skill to invoke it.
2. **Readability.** The skill dir is a **`0555` ephemeral projection set up at spawn**. Files the host writes after spawn may not even appear inside the running sandbox's view until the next spawn re-projects.

Both point the same way: skill visibility is a **spawn-time property**. We adopt **version (a): re-spawn on the next turn** — the host flips the row to `active`, and the user's next message runs in a fresh sandbox that projects *and* enumerates the new skill. No new machinery; it reuses the spawn path.

> **Build requirement.** The agent must *know* it's on the (a) boundary, so it words turn 1 correctly and doesn't try to invoke a skill it proposed this turn. A line of harness/system-prompt guidance: *"A skill you propose this turn becomes available next turn — propose it, tell the user it's ready on their next message, don't attempt to invoke it now."* Without this the agent may call the just-proposed skill, fail to find it, and get confused. (This is the pending-turn re-spawn orchestration from `2026-05-26-jit-pending-turn-re-spawn-resume-orchestration-impl.md`.)

### The one visible seam: "create *and* use" in one breath

"Make a Linear skill **and** list my issues" can't complete in one turn — the skill isn't in context until re-spawn. The agent should **recognize the pattern and tee up the continuation** rather than silently dropping the second half:

> "Here's the **`linear`** skill — once you approve it, say *go* and I'll pull your open issues right away."

Worst case degrades to **one extra message**, never to a broken request.

> **Deferred alternative — version (b), live injection.** Write into a *writable* live dir and push a `system-reminder` context frame into the running turn announcing the skill. Makes same-turn use work, but forks skill discovery into a second (live) path and gives up some of the `0555` immutability. Not worth it now. If we ever want true same-turn continuation, the cleaner form is "host triggers an immediate transparent re-spawn and replays the pending instruction" — which keeps a single discovery path. Start with (a).

---

## How this lands the invariants

- **I1 (transport/storage-agnostic hooks).** Improved. `skill_propose` carries `manifest`/`files`/`capabilityProposal`/`origin` — no `sha`, `ref`, `tree`, `commit`, `bundle`. Bundle bytes ride `blob:put`. Named alternate impls: DB-row + blob skill store vs (today) git-workspace drafts.
- **I2 (no cross-plugin imports).** Unchanged — `skill_propose` and the gate run over IPC / the hook bus.
- **I3 (no half-wired plugins).** Improved — *removes* the TASK-40 git-tree backing and the workspace-draft surface. Each move ships producer + consumer + canary in one PR.
- **I4 (one source of truth).** The headline win. One skill store (DB + blob) for catalog, default, attached, **and** authored. Kills the draft-in-git / rows-in-DB split-brain and the third-place bundle tree.
- **I5 (capabilities minimized).** Improved. The gate moves to **before first run** for declared caps — bytes don't project and credentials don't inject until a human consents. The runtime egress wall remains for undeclared reach. Credentials never enter the bundle, blob, or git.
- **I6 (one UI language).** Unchanged — the approval card and Skills affordance compose existing shadcn primitives (TASK-35 already does).

---

## Boundary review (new hook)

**`skill_propose(ctx, { manifest, files[], capabilityProposal, origin }) → { skillId, status }`**
- *Alternate impl:* yes — DB-row + `blob:*` store (this proposal) vs the git-workspace draft store (today) vs a future remote skill registry. Real seam.
- *Field names that might leak:* none. `manifest`/`files`/`capabilityProposal` are skill-domain; `origin` is an enum of trust-provenance, not a backend id. Bundle bytes go to `blob:put` (whose `sha256` is a content hash, not a git oid).
- *Subscriber risk:* the bundle is **untrusted, adversarial** model output — see security walk. No subscriber executes it; the host structurally validates and scans before any projection.
- *Wire surface:* bytes ride `callBinary`; the JSON envelope is small and schema-validated in this plugin's directory (not a central file).

---

## Security walk (security-checklist)

Touches IPC actions, plugin/skill loading, and storage of untrusted content — the skill fires.

- **Sandbox escape / path traversal.** Skill bytes are content-addressed (`blob:*`, `sha256` keys, no caller paths). Authoring is confined to `/ephemeral/skill-draft/**`; `skill_propose` validates the manifest + file set structurally (`validateBundleFiles`) and the `pre-apply` veto still runs at this chokepoint. Projection stays **read-only `0555`** — the agent cannot mutate a live skill. Removing the git-tree backing shrinks the surface.
- **Prompt injection.** The bundle is untrusted model output. The **best-effort scan** runs before materialization; a hit → quarantine (omitted, not run). The **hybrid gate** is the core control: nothing with reach projects without a human approving the *specific* hosts/credentials shown on the card. The free path is restricted to `origin = authored ∧ capabilityProposal = ∅` — instruction text with no reach. `SKILL.md` is never shell-interpolated; `displayName`/`mediaType` are untrusted text to any renderer.
- **Supply chain.** `origin ∈ {imported, attached}` is **always gated**, even when zero-capability — an externally-authored bundle gets a human provenance check before it can run, on the same card. No new dependency (rides the storage doc's `blob:*` + `callBinary`). Credentials live in the vault, injected at spawn, never in the bundle/blob/git.

---

## Migration / phasing

Clean-slate — still in development, no authored-skill rows to migrate (the git drafts are throwaway). Each phase leaves the tree green. Depends on storage-doc Phase 1 (the `blob:*` store) landing first.

1. **Phase 1 — `skill_propose` + DB/blob store (additive).** Add the IPC action, runner-side executor, and the host store (skill row + `blob:put`). Land it behind the existing authored-skills flow as the new write path; canary reachability in the same PR.
2. **Phase 2 — hybrid gate.** Classify at propose time (scan + `origin` + caps); wire `pending` → approval-card → `active`. Re-time the cap approval from reactive to before-materialize. Keep the TASK-37 egress wall for undeclared reach.
3. **Phase 3 — switch projection to the blob store.** Feed `materializeInstalledSkillsFromEnv` from `blob:get`; retire the workspace-draft projection (phase-3 Component 1) and the `.ax/draft-skills/` authoring dir.
4. **Phase 4 — delete the git backing.** Remove the TASK-40 isomorphic-git bundle tree; remove skills from storage-doc §E's "what git keeps" list. With skills gone, `/permanent` git holds only identity (`IDENTITY.md`/`SOUL.md`) + the rare Pattern A project — the per-turn commit can finally be gated on a non-empty diff (storage-doc Phase 4).

After Phase 4, git is off the skills path entirely, matching the storage doc's end state for transcripts and blobs.

---

## What gets deleted / simplified (concrete, vs the just-merged Phase 3/4)

- **Deleted:** the TASK-40 isomorphic-git bundle-tree backing (`2026-05-26-jit-bundle-git-tree-backing-byte-store-swap-impl.md`); the `/permanent/.ax/draft-skills/` authoring dir + the workspace-draft projection source (phase-3 Component 1, `workspace:list`/`workspace:read` for drafts).
- **Re-timed:** phase-4 reactive capability approval → approve-before-materialize for declared caps. The approval-card SSE frame (TASK-35) and the `proposal ∩ approved` store **survive**; only the trigger/timing changes.
- **Kept as-is:** the `0555` ephemeral projection + `materializeInstalledSkillsFromEnv`, quarantine-as-host-state (phase-2), the session-dirty → re-spawn trigger, the capability-proposal concept, the runtime reactive egress wall (TASK-37) as a safety net for *undeclared* reach.
- **Unified:** authored skills become rows in the *same* DB/blob store as catalog/default/attached skills — one source of truth, one GC story.

The recurring shape (same as the storage doc): the right primitives already exist — the `0555` projection, the scan/quarantine, the approval card, the `blob:*` store, the `/ephemeral` mount. This proposal connects them and disconnects git from the one data class still riding it.

---

## Open questions

1. **Should imported *zero-capability* skills really be gated?** This proposal gates on `origin` even when caps are empty (provenance). Alternative: gate only on capabilities, and trust any clean-scanned instruction text regardless of origin. Leaning gated-on-provenance (an externally-authored body the human hasn't seen is a supply-chain hop), but it's a one-line policy knob.
2. **Same-turn create-and-use.** Ship (a) + the "say go" tee-up, or invest in (b)/transparent-re-spawn-replay now? Recommend (a); revisit only if users hit the seam often.
3. **Editing a quarantined or denied draft.** The agent re-materializes the draft into `/ephemeral` from the stored bytes and re-proposes. Confirm the UX: does a denied skill linger as `pending`/`denied` in the Skills affordance, or vanish?
4. **Per-user vs per-agent authored skills.** The union/attachment model (`2026-05-26-jit-per-user-skill-attachment-orchestrator-union-impl.md`) is unchanged, but confirm an authored skill's default scope (this agent only, until shared-to-catalog).
5. **Does any skill workload still need git in the sandbox?** After Phase 4, only identity + Pattern A do — fold into the storage doc's open-Q 5 (gate the `git` binary on the Pattern A profile).
