# AX v2 — CLAUDE.md and Skills Strategy

**Status:** Proposal, ready for review
**Date:** 2026-04-23
**Companion to:** `2026-04-22-plugin-architecture-design.md`

---

## TL;DR

Three months of v1 work produced a journal/lessons/skills system that's only partially earning its keep. The lessons and memory layers are high-signal; the journal is noisy; the ax-* skills are sometimes stale and sometimes never invoked. v2 is a clean slate for both code AND meta-process — easier to fix the meta-process at the same time than to drag v1 conventions into the new repo.

The shape, in five bullets:

- **Journal protocol loosens** from "log every meaningful unit of work" to "log decisions and dead ends." Removes ~70% of journal noise without losing anything that matters in 6 weeks.
- **Lessons and memory keep their current shape** — both genuinely paid back. Memory in particular saved entire debug sessions ("k8s-pod sandbox doesn't work with all-in-one server" is the canonical example).
- **Skills go friction-driven** — no pre-written per-plugin skills in v2. One bootstrap skill (`ax-v2-conventions`) from day 1; everything else is added only after 3+ sessions hit the same friction.
- **CLAUDE.md gains three v2-specific rules:** boundary-review gate for new hooks, no-cross-plugin-imports lint, no half-wired plugins.
- **Acceptance test track from Week 3** — one canary chat through every plugin, in CI. New plugins must extend the canary path before merge. Prevents the "plugins drift in isolation, integration breaks at Week 12" failure mode.

---

## Section 1 — What we learned from 3 months of v1

Five patterns that cost the most time, listed so the v2 conventions are clearly motivated:

1. **Two-source-of-truth bugs.** Skills migration in April surfaced an 8-row bug inventory (reconciler drift, cred scope mismatches, delete+re-add no-ops) all stemming from "git holds skills, but tables also hold skills." Same disease appeared with `.ax/tools/`.
2. **Plans superseded before they were built.** Workspace went through ~5 designs (WASM → unified container → NATS workspace → PVC → git-ssh → git-http → host-mediated git). Doc count exceeded LOC for some iterations.
3. **Half-finished infrastructure.** NATS bridge exists but isn't wired into runners. K8s-pod sandbox doesn't work with all-in-one server. Sqlite3 CLI not in container. These traps compound.
4. **Observability as bolt-on.** Many journal entries are "added X log to figure out Y." Diagnostic collector + per-component log levels landed late, after a lot of pain.
5. **Concerns coupled that should be separate.** `server-completions.ts` at 2,400 lines is the obvious one. Credential scope strings tangling with skill identity is the same disease at smaller scale.

The v2 plugin architecture (Section 4.5 of the architecture doc) addresses these structurally. This doc addresses them culturally — the conventions and review gates that prevent the disease from regrowing in a clean codebase.

---

## Section 2 — CLAUDE.md changes

Two CLAUDE.md files matter: the **current** one (in this repo) gets a near-term cleanup so v1 maintenance stops generating noise; the **v2 monorepo** gets a fresh CLAUDE.md tailored to plugin discipline.

### 2.1 Current repo: loosen the journal protocol

Replace the existing "Journal" subsection with:

```markdown
### Journal (`.claude/journal/`)

Append an entry to the appropriate category file when you:
- Make a non-obvious design decision (chose A over B, with a reason)
- Hit a dead end (X looked promising, here's why it doesn't work)
- Discover something the next person would benefit from knowing

You do NOT need to log every fix, every test green, every routine task. The
test: "would I want to read this entry in 6 weeks?" If no, skip it. The
journal is for future-you-with-no-context, not a transcript of present-you.
```

Rationale: looking at 6 months of journal entries, the high-value ones are decisions and dead ends. Routine fix entries are mostly read-once-then-forgotten and create maintenance overhead (index updates) without payback.

### 2.2 v2 monorepo: fresh CLAUDE.md skeleton

The v2 CLAUDE.md should be ~1/3 the size of the current one (current is 200+ lines). Recommended sections:

```markdown
# CLAUDE.md (v2)

## Repository
- Monorepo: pnpm + changesets + tsconfig refs
- Each package is a plugin; @ax/core is the kernel; see ARCHITECTURE.md

## Build / Test
pnpm build / pnpm test / pnpm test --filter @ax/<plugin>

## The four invariants (read before touching code)

1. **Hook surface is transport-agnostic and storage-agnostic.** No git/sqlite/
   k8s vocabulary in hook payloads. If a payload field name only makes sense
   for one backend, it leaks. (See workspace abstraction, arch doc Section 4.5.)

2. **No cross-plugin imports.** Plugins talk through the hook bus only.
   Enforced by lint (see eslint.config.mjs `no-restricted-imports`).
   The hook bus IS the inter-plugin API.

3. **No half-wired plugins.** A plugin is either fully registered + tested +
   reachable from the canary acceptance test, or it doesn't merge. No "wire
   this up later" PRs.

4. **One source of truth per concept.** If two plugins both store state
   about the same thing (skills, tools, sessions), one of them is wrong.
   Coordinate through service hooks, not shared rows.

## Boundary review (required for new hooks)

When adding or changing a service-hook signature, fill in:
- What is the alternate impl this could have? (e.g., "git, but also gcs")
- Does any payload field name only make sense for the current impl?
- Could a subscriber depend on backend-specific fields and be wrong later?

If you can't name an alternate impl, the abstraction may be premature —
just write a function. If field names leak, rename now (cheap) before
subscribers depend on them (expensive).

## Journal & lessons
[same loosened protocol as Section 2.1]

## Voice & tone
[same as v1 — these don't depend on architecture]
```

Drop from v1 CLAUDE.md:
- The detailed `ax/*` sub-skill list (replaced by `ax-v2-conventions` skill discovery)
- The detailed reference document list (move into ARCHITECTURE.md)
- The provider-pattern paragraph (moves into the v2 architecture doc)

### 2.3 Add to both: "no half-wired plugins" rule

Even in v1, this prevents new traps from accumulating. Add under existing "Bug Fix Policy":

```markdown
### Half-Wired Code Policy

If you write infrastructure (NATS bridge, IPC transport, sandbox provider)
that's not actually called by the running system, either wire it in within
the same PR or don't merge it. "We'll wire it later" code becomes a trap —
it confuses readers, drifts from the rest of the system, and represents
work that looks done but isn't.
```

---

## Section 3 — Skills strategy for v2

The current ~25 `ax-*` skills work because v1 has a year of accumulated convention. v2 won't have that for months. Pre-writing skills against a not-yet-built architecture means **the skills will be wrong, get committed anyway, then mislead future-Claude into bad assumptions** — exactly the failure mode the current CLAUDE.md warns about.

### 3.1 The friction-driven skill rule

A skill gets written when:
- 3+ sessions have hit the same friction in the same area, AND
- The friction is non-obvious from reading the code (i.e., a real "skill" — knowing what to do that the code doesn't tell you)

A skill does NOT get written for:
- "Documentation of what the code does" (the code does that; if it doesn't, fix the code)
- "Conventions that aren't yet established"
- "What I think might be useful later"

Test: a skill should answer a question of the form "I tried X and it didn't work — what's the trick?" If it can't, it's documentation, not a skill.

### 3.2 Day-1 skill: `ax-v2-conventions`

One skill from day 1, capturing the cross-cutting rules that won't change:

```markdown
---
name: ax-v2-conventions
description: Use when writing or modifying any v2 plugin or hook — covers the four invariants (transport/storage-agnostic hooks, no cross-plugin imports, no half-wired plugins, one source of truth), the boundary review checklist, and the plugin manifest format
---

## The four invariants
[same as CLAUDE.md, expanded with concrete examples]

## Plugin manifest format
[the `ax` field in package.json — registers, calls, configSchema]

## Hook bus mechanics
[hooks.fire vs hooks.call, subscriber rejection shape, error handling]

## Boundary review checklist
[expanded form of CLAUDE.md's review gate, with worked examples]

## Common patterns
[lazy content fetchers in deltas, opaque tokens, optimistic concurrency]
```

This is the one skill that's safe to write upfront because it captures architectural decisions that *won't* change as the code grows — they're defined by the plugin contract, not by any specific plugin.

### 3.3 Per-plugin skills are deferred until friction earns them

Don't write `ax-v2-workspace-git`, `ax-v2-sandbox-k8s`, etc. on day 1. Wait until:
- 3+ different sessions touched the plugin
- A non-obvious gotcha emerged that bit someone

Then write a skill that captures *just that gotcha*, not a full sub-system overview. Keep it short.

Expected steady state: ~5-8 skills total in v2, vs. ~25 in v1. Smaller, sharper, all earning their keep.

### 3.4 Don't port v1 ax-* skills to v2

Tempting, because they encode real knowledge. But:
- v2 architecture is different — most file paths and patterns won't apply
- Stale skills are worse than no skills (CLAUDE.md already warns this)
- Re-deriving the convention from real friction in v2 produces a more accurate skill than translating a v1 one

Keep v1 skills in the v1 repo for v1 maintenance. v2 monorepo starts with one skill (`ax-v2-conventions`) and grows from there.

---

## Section 4 — Boundary review process

The single highest-leverage process change. Today, hook signatures get reviewed informally (or not at all) and leaks survive into committed code. The workspace abstraction we just fixed (Section 4.5 of the architecture doc) is exactly the kind of leak that should have been caught at signature design.

### 4.1 The trigger

Boundary review is required when:
- A new service hook is added
- An existing service hook's signature changes (any field add/remove/rename)
- A new subscriber hook is added with a non-trivial payload

Patches that only change a plugin's *internal* implementation (no hook surface change) don't need boundary review.

### 4.2 The checklist

Reviewer (or PR author, if no reviewer available) answers in the PR description:

```markdown
## Boundary review

- **Alternate impl this hook could have:** <name one>
  (If you can't name one, consider whether this needs to be a hook at all
  vs. just a function inside one plugin.)

- **Payload field names that might leak:** <list any, or "none">
  (e.g., `sha`, `bucket`, `pod_name`, `socket_path`. If present, justify
  or rename.)

- **Subscriber risk:** Could a subscriber key off a backend-specific field
  and break when the alternate impl ships? <yes/no/explain>

- **Wire surface (if this is also an IPC action):** Schema is in this
  plugin's directory, not a central file. <confirm>
```

Four bullets. Five minutes per review. The cost is trivial relative to the cost of a leak that ships and grows subscribers.

### 4.3 Where the checklist lives

In the v2 monorepo, add `.github/PULL_REQUEST_TEMPLATE.md` with the checklist auto-included. Reviewers see it filled in before approving. Empty boundary-review section = ask the author to fill it in.

---

## Section 5 — Acceptance test track from Week 3

Memory shows v1 acceptance test setup was painful and incomplete (k8s-pod sandbox can't run with all-in-one server, sqlite3 CLI not in container, kind-values config gaps). Plugins drifted in isolation; integration broke at Week 12+ when someone tried to deploy.

### 5.1 The canary chat

One canonical end-to-end chat that exercises every loaded plugin:

```
1. CLI sends message via channel-chat-ui
2. Channel calls chat:run
3. Core fires chat:start (audit + diagnostic plugins observe)
4. llm:pre-call (memory plugin injects recall)
5. llm:call (llm-router → llm-anthropic OR llm-mock)
6. tool:execute (workspace:apply with a small change)
7. workspace:pre-apply (scanner observes)
8. workspace:applied (skill validator + audit observe)
9. chat:end (chat_complete logger fires)
10. Response streams back via SSE
```

If any plugin in the loaded preset isn't reached by the canary, that's a half-wired plugin — fail the build.

### 5.2 When it lands

Per the architecture doc Section 10 build order:
- **Week 3** — canary lands alongside the smallest viable end-to-end (mock LLM, subprocess sandbox, sqlite storage). It's tiny because the system is tiny.
- **Week 4-6** — canary extends to use real LLM + bash tool.
- **Week 7-9** — canary forks into two profiles (local + k8s); both must pass.
- **Week 10+** — every new plugin merge extends the canary's reachable plugin set.

### 5.3 Cost vs. benefit

Cost: ~1 day to set up the canary infrastructure in Week 3, ~30 min per plugin to extend it.

Benefit: the entire class of "works in unit tests, breaks in integration" bugs gets caught at PR time, not at deploy time. v1 spent multiple weeks on integration debt that this would have prevented.

---

## Section 6 — Migration order

Apply in this order. Earlier items are independent; later items depend on earlier.

```
Now (this week, in v1 repo)
  • Update CLAUDE.md journal protocol (Section 2.1)
  • Add half-wired-code policy to CLAUDE.md (Section 2.3)
  • Stop writing journal entries for routine fixes
  • Don't add new ax-* skills unless 3+ sessions hit the friction

When v2 monorepo is created (Week 1 of v2 build)
  • Create new CLAUDE.md per Section 2.2 skeleton
  • Create ax-v2-conventions skill per Section 3.2
  • Add .github/PULL_REQUEST_TEMPLATE.md with boundary-review checklist
  • Configure eslint no-restricted-imports for cross-plugin imports

Week 3 of v2 build
  • Land canary acceptance test alongside smallest viable end-to-end
  • Add CI gate: PR fails if loaded plugin not reached by canary

Week 4+ of v2 build
  • Per-plugin skills only when friction earns them
  • Per-plugin READMEs (NOT skills) for setup/config docs
  • Lessons + memory continue as-is — they're working
```

---

## What's NOT in scope

Listed so future readers don't expect coverage:

- **Per-plugin documentation standards.** Each plugin's README is the plugin's call. Don't centralize.
- **Lessons format changes.** Current lessons format works.
- **Memory format changes.** Current memory format works.
- **Auto-generation of skills from journal entries.** Tempting; deferred. Would risk producing low-signal skills automatically.
- **Skill triggering metrics.** Would help identify never-invoked skills, but instrumenting it is more work than it's worth at our scale.

---

## Design decisions log

- **Journal protocol:** keep current vs. loosen vs. delete. **Chose loosen** — the per-category structure is good, the "log every meaningful unit" rule produces noise.
- **Skills strategy:** port v1 → v2 vs. friction-driven from scratch. **Chose friction-driven** — porting risks stale skills against changed architecture; v2 pace of change makes a fresh start cheaper than maintenance.
- **Day-1 skill:** zero skills vs. one bootstrap skill vs. multiple skeleton skills. **Chose one bootstrap skill** — `ax-v2-conventions` captures invariants that won't change, and gives Claude an anchor point to discover other skills as they're written.
- **Boundary review:** informal vs. checklist vs. dedicated reviewer. **Chose checklist** — 5 minutes per review, embedded in PR template, no new role required.
- **Canary acceptance test:** Week 3 vs. Week 7 vs. "when we get to it." **Chose Week 3** — earliest point a canary is meaningful, and earlier the canary catches half-wired plugins the cheaper the fix.
- **CLAUDE.md split:** one file with v1+v2 vs. separate files per repo. **Chose separate** — v2 is a separate monorepo per the architecture doc; mixing rules confuses both.
- **Half-wired-code policy:** apply to v1 immediately or only v2. **Chose both immediately** — costs nothing in v1, prevents new debt while v2 is being built.
