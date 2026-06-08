# Skill Crystallization — autonomous self-improvement for ax agents

**Status:** Design / not yet implemented
**Date:** 2026-06-08
**Related:**
- `docs/plans/2026-05-29-skill-authoring-phase-3-bundle-projection-design.md` (the authored-draft → active projection this builds on; shipped as PRs #218/#219)
- `@ax/memory-strata` (the per-turn capture loop this builds on; shipped & wired in CLI + k8s presets)
- `@ax/routines` (the scheduled-fire machinery this reuses)

---

## Why this doc exists

Nous Research's Hermes agent has a feature we want: agents that **automatically write new
skills and improve them over time** when they decide a skill is warranted. This doc
specifies how to get that behavior in ax — by *borrowing the idea, not the implementation*,
and fencing it inside ax's security-first, multi-tenant invariants.

The headline finding from studying both systems: **ax already has ~90% of the primitives.**
Hermes' "self-improvement" is, concretely, *an LLM reviewing its own recent work and editing
its own markdown skill files* — driven by conversational signal (user corrections, noticing a
loaded skill was wrong), gated only by structural validation and an optional security scan
(which Hermes ships **off** for self-written skills). There is no eval harness, no test of the
skill before trusting it, and no reward signal. The RL/GEPA "evolution" work lives in a
separate offline repo and is not in Hermes' live loop.

ax already has: agent-authored skill drafts that persist in the git workspace, a scanner +
quarantine, a capability-approval gate, a projection that makes a clean instruction-only draft
**active to the same agent on the next turn with no human click**, and a full per-turn memory
loop (`@ax/memory-strata`). What ax is *missing* is the **autonomous trigger** — nothing today
decides "this recurring procedure deserves to be a skill" and authors it on its own.

This design adds exactly that one missing stage, and nothing more.

---

## TL;DR

- A **system default-routine** (`skill-reflection`) fires per-agent on a cadence and runs the
  agent in a **reflection turn** inside its own sandbox.
- The reflection turn reviews the agent's **consolidated memory** plus its own past
  transcripts, confirms a procedure **recurred across ≥2 conversations**, and authors/patches
  an **instruction-only** draft skill via the existing authoring/propose path.
- The draft is scanned. Clean + instruction-only → it goes **active on the agent's next real
  turn**, with no human action (this is already the shipped projection behavior). Anything
  that declares a connector falls back to the existing capability-approval gate.
- Memory stays the per-turn substrate (episodic). Skills are the **graduated, proven**
  procedures. This two-stage shape, with a recurrence gate, is a deliberate improvement over
  Hermes — whose prompt has to *beg* the model not to harden one-off failures into permanent
  skills. We make recurrence structural, not a plea.

Almost no new code: the new surface is a reflection meta-prompt + a default-routine
definition, a cheap "last-reflected" marker, a per-agent enable toggle, one guard in the
memory observer, and a canary test. Everything else is reuse.

---

## Decisions locked in brainstorming

1. **Trust posture — auto-active, scanned not gated.** A self-authored, instruction-only draft
   that passes `skills:scan` goes active for the *same* agent on its next turn with no human
   click. Bounded three ways: **own-agent scope** (never global), **instruction-only** (zero
   new reach), **scanned** (a scan hit quarantines it). Anything declaring a connector still
   routes to the existing `approved_caps` approval gate. This is strictly more conservative
   than Hermes (scan off, no capability fence) while keeping the autonomy.

2. **Two-stage — memory feeds skills.** `@ax/memory-strata` remains the per-turn capture. A
   separate, slower crystallization stage promotes *recurring* procedures into durable skills.
   Memory is the substrate; skills are the graduated form.

3. **Trigger + locus — scheduled reflection turn (routine).** A system default-routine fires
   per-agent on a cadence and runs the agent in its own sandbox to author/patch via the normal
   draft path. Reuses `@ax/routines`, warm-runner reuse, and the existing authoring path.

4. **Recurrence signal — consolidated-memory + cited recurrence.** Feed the reflection the
   already-consolidated memory (which by design represents reinforced, surviving learnings) and
   let it crystallize only procedures it can cite recurring across **≥2 distinct conversations**.
   Soft, model-judged, but grounded in memory that already survived consolidation. No new
   plumbing.

---

## What's verified shipped (preconditions, checked against the code 2026-06-08)

Both load-bearing dependencies were verified live before writing this — not assumed.

**`@ax/memory-strata` — SHIPPED & WIRED.** Loaded in both the CLI preset
(`packages/cli/src/main.ts`) and the k8s preset (`presets/k8s/src/index.ts`), paired with its
index plugin. It registers:
- a `chat:end` **observer** (fire-and-forget LLM extraction → `permanent/memory/inbox/<ISO>.md`),
- a debounced `chat:end` **consolidator** that *deduplicates* (token-set Jaccard), *clusters by
  subject*, *promotes by confidence* into `permanent/memory/docs/{entity,preference,decision,episode,general}/<slug>.md`,
  *decays* observations older than ~14 days, and regenerates a cached
  `permanent/memory/system/recent.md`,
- a `system-prompt:augment` **injector** that prepends `system/user.md` + `system/recent.md`
  (capped ~1500 tokens) at chat start,
- three agent tools: `memory_search` (BM25 over the index), `memory_read_section`, `memory_note`.

> **Correction vs. early brainstorming notes:** the runtime memory layout is `permanent/memory/`
> (`system/`, `docs/`, `inbox/`), **not** `.ax/memory/{patterns,mistakes,decisions}.md`. The
> "consolidated, reinforced" tier the reflection reads is `system/recent.md` + `docs/`.

**Authored-draft projection — SHIPPED & WIRED (PRs #218/#219).** The relevant facts:
- The orchestrator's spawn-time skill union calls `agents:resolve-authored-skills` →
  `skills:list-authored`, and includes drafts with `status='active'` (highest precedence).
- The propose path (`skills:propose`) runs `classifyProposal(origin, scanClean)`. For
  `origin='authored'` **+** clean scan it returns `'active'` automatically — no capability
  check, because authored manifests carry zero inline caps (TASK-100 moved all reach to
  connectors). Scan hit → `'quarantined'` (omitted from the projection; the model never sees it).
- `skills:proposed` fires → the orchestrator marks the session dirty (`respawnSessions`) → the
  next turn terminates the stale sandbox and fresh-spawns, so the agent sees the new skill.

So "instruction-only self-authored skill → active to the same agent next turn, no human action"
is the **exact current behavior**. This feature supplies the *trigger* that exercises it.

---

## Architecture — the loop end to end

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │ STAGE 1 — per-turn capture  (UNCHANGED, @ax/memory-strata)           │
  │   chat:end → observer → permanent/memory/inbox/                       │
  │            → consolidator (dedup/cluster/promote/decay)               │
  │            → permanent/memory/{system/recent.md, docs/...}            │
  └─────────────────────────────────────────────────────────────────────┘
                                   │  (feeds)
                                   ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │ STAGE 2 — crystallization  (NEW, this design)                        │
  │   cron fire → skill-reflection default-routine (per agent)           │
  │     → agent:invoke, hidden per-fire conversation, agent's sandbox     │
  │     → reflection meta-prompt:                                         │
  │         read consolidated memory (recent.md + docs/, memory_search)   │
  │         confirm recurrence ≥2 conversations (grep .claude/projects/)  │
  │         author/patch .ax/draft-skills/<id>/SKILL.md (instruction-only)│
  │         propose via skill-propose tool  → skill.propose IPC           │
  └─────────────────────────────────────────────────────────────────────┘
                                   │  (existing projection)
                                   ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │ STAGE 3 — activate  (UNCHANGED, PRs #218/#219)                       │
  │   skills:propose → classifyProposal('authored', clean) → 'active'     │
  │     scan hit → quarantined (inert) ; connector declared → pending     │
  │   skills:proposed → session dirty → re-spawn → agent sees skill       │
  └─────────────────────────────────────────────────────────────────────┘
```

### Inputs the reflection turn has, for free

> All paths below are relative to the runner's workspace root, which is the runner's `HOME` =
> `/permanent`. So `.ax/draft-skills/` is `/permanent/.ax/draft-skills/`, `memory/` is
> `/permanent/memory/`, etc.

Because the runner's `HOME` is `/permanent`, the reflection turn's own workspace already
contains both inputs — no new cross-conversation capability is required:
- **Consolidated memory** at `permanent/memory/system/recent.md` + `permanent/memory/docs/…`
  (also auto-injected into the reflection turn's system prompt by the existing
  `system-prompt:augment`), and queryable via the `memory_search` tool.
- **Its own past transcripts** at `permanent/.claude/projects/*/*.jsonl` (transcripts are
  runner-owned and git-committed), which the agent may `grep` to cite the ≥2 distinct
  conversations that ground a recurrence claim.

### Authoring uses the existing path verbatim

The reflection turn writes `.ax/draft-skills/<id>/SKILL.md` (instruction-only, empty
`connectors[]`) and proposes it through the existing skill-propose tool → `skill.propose` IPC
→ host `skills:propose`. We add no new authoring surface.

---

## The reflection meta-prompt (the real new IP)

This is the substance. It borrows Hermes' genuinely good parts and deliberately inverts one.

**Borrow from Hermes:**
- **Prefer patch over create.** Order of preference: patch a relevant existing self-skill →
  add a supporting file under one → create a new skill only if nothing covers the procedure.
- **An explicit anti-pattern list.** Do NOT crystallize: environment-dependent failures,
  transient/one-off errors, negative claims about a tool, or specifics of a single session.
- **Patch the moment a loaded skill is found wrong.**

**Invert from Hermes:**
- Hermes' prompt says *"a pass that does nothing is a missed opportunity."* For ax we say the
  opposite: **a no-op is the correct default.** Only crystallize on **cited recurrence (≥2
  distinct conversations)**. The gate is structural intent, not a polite request.

**Fence (ax-specific):**
- **Instruction-only by default.** If a procedure genuinely needs a connector, author it *with*
  the connector declared and let it land in the approval queue — never silently drop the
  capability to force an auto-active landing.
- **Cap per run** (see open decisions): at most N author/patch operations per reflection.

---

## New surface (small) vs. reused (almost everything)

**Genuinely new:**
1. The **reflection meta-prompt** + the `skill-reflection` **default-routine definition** that
   carries it (trigger = cron; conversation = `per-fire`; hidden).
2. A **last-reflected marker** (e.g. `.ax/skill-reflection/last-run.json`) recording the memory
   commit/mtime last seen, so a reflection no-ops cheaply when memory is unchanged.
3. A **per-agent enable toggle** in admin (reusing the existing default-routine enable/disable).
4. One **guard in the memory observer** (below) + the **canary test**.

**Reused unchanged:** `@ax/routines` (default-routine materialization, scheduled fire →
`agent:invoke`, hidden conversations from Routines Phase A), the `.ax/draft-skills/` authoring
path, the skill-propose tool + `skill.propose` IPC + `skills:propose` host hook, `skills:scan`
+ quarantine, the authored-draft projection + `skills:proposed` re-spawn, `approved_caps` for
connector gating, `@ax/memory-strata`, and the skills admin UI (`skills:list-authored`,
`skills:adopt-authored`, `skills:delete-authored`).

---

## Guards against the predictable failure modes

- **Reflection-eats-itself.** The `skill-reflection` conversation must be **excluded from the
  memory observer** and from the recurrence corpus, or the loop reflects on its own reflections.
  Implementation: the observer skips conversations that originate from a routine fire (the
  routine machinery already tags/hides its fire conversations; the observer keys off that). This
  is the one small change to existing code outside the new routine.
- **Runaway authoring.** Hard cap of N author/patch ops per run (prompt + enforced).
- **One-off hardening.** The ≥2-conversation cited-recurrence gate, grounded in
  already-consolidated memory.
- **Bad active skill.** It's instruction-only and own-agent-scoped, so blast radius is one
  agent's prose. Recoverable by the next reflection (patch/delete) or by the user in the admin
  UI. A scan hit keeps it inert from the start.

---

## Mapping to the six invariants (boundary review)

1. **Transport/storage-agnostic hooks.** No new service hooks are anticipated; we compose
   existing ones. The new artifacts are a routine definition (data), a workspace marker file,
   and a prompt. If implementation finds a new hook is genuinely needed (e.g. to tag/skip
   reflection conversations more cleanly than reading existing conversation metadata), it gets
   a full boundary-review entry then.
2. **No cross-plugin imports.** The reflection is a routine body + prompt; it talks to skills
   only through the existing tool/IPC/hook path. The observer guard lives inside
   `@ax/memory-strata`.
3. **No half-wired plugins.** Ships enabled-and-testable behind the per-agent toggle, with a
   canary acceptance test (below). Nothing merges that isn't reachable.
4. **One source of truth.** Memory stays the episodic substrate; skills are the graduated
   procedural form. The reflection *reads* memory and *writes* skills — it does not create a
   second store of learnings. A learning legitimately existing in both memory (episodic) and a
   skill (procedural) is expected, not a duplication smell.
5. **Capabilities explicit and minimized.** Auto-active is fenced to instruction-only,
   own-agent scope; any connector reach routes to `approved_caps` approval. The reflection turn
   runs with the same capabilities a normal turn for that agent has — no elevation.
6. **One UI design language.** The only UI is the per-agent toggle, built from the existing
   shadcn admin surface (invoke the `shadcn` skill when building it).

---

## Error handling

The reflection runs as a routine fire, so failures are already first-class: `routines_v1_fires`
records `ok`/error per fire; the conversation is hidden, so there's no user-facing impact; the
next cadence retries. A scan-flagged draft quarantines and stays inert. A connector-declaring
draft lands pending approval rather than failing.

---

## Testing

- **Canary acceptance (invariant #3).** Seed an agent's memory with a procedure recurring
  across 2 conversations → fire the `skill-reflection` routine → assert a draft is authored,
  scanned clean, lands `status='active'`, and is materialized into the next turn's skill union
  for that same agent.
- **Recurrence-guard test.** Seed a single-conversation one-off → assert **no** skill is
  crystallized.
- **Capability-fence test.** A draft that declares a connector lands pending-approval (not
  active).
- **No-self-reflection test.** Assert the `skill-reflection` conversation produces no memory
  observation (observer skip guard).

---

## Deferred (YAGNI for v1)

- **Hermes' curator** — weekly stale@30d → archive@90d aging + "umbrella" consolidation of
  narrow skills. Memory-strata already decays/consolidates *memory*; skill-level aging is a
  follow-up once we see real self-skill volume.
- **Hard-counter candidate markers** — we chose soft cited-recurrence; a rigorous tally store
  can come later if model-judged recurrence proves unreliable.
- **Team/shared-agent self-skills** — personal agents first (matches the PR #108 precedent of
  deferring team agents).
- **Auto-promotion of self-skills to the global catalog** — the user can already do this
  manually via admit-to-catalog; no autonomous promotion in v1.
- **Cross-agent learning** — agents do not read each other's self-skills.

---

## Open sub-decisions (carried into the implementation plan)

1. **Cadence.** Default: nightly cron, no-op if memory is unchanged since the last run.
   Alternative: trigger off memory-note accrual (fire after K new consolidated docs) instead of
   wall-clock. *Leaning nightly cron + cheap no-op.*
2. **Rollout default.** Ship the routine **per-agent toggle, default OFF**; flip to default-on
   once trusted. *Safe-rollout bias.*
3. **Per-run cap.** ≤3 author/patch operations per reflection. *Tunable.*
4. **Routine visibility.** Whether the `skill-reflection` routine is shown in the user's
   routine list (transparency, clearly labeled) or kept as a system routine. *Leaning visible
   + clearly labeled, since ax favors transparency for non-technical users.*
