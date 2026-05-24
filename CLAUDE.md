# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Repository

- **Name:** ax-next — AX v2, greenfield rewrite
- **Shape:** Monorepo (pnpm + changesets + tsconfig refs). Each package is a plugin; `@ax/core` is the kernel. Scaffolding is Week 1 of build — not yet wired up.
- **Architecture spec:** `docs/plans/2026-04-22-plugin-architecture-design.md`
- **Conventions spec:** `docs/plans/2026-04-23-v2-claude-md-and-skills.md`

## Legacy reference

The v1 AX codebase lives at `~/dev/ai/ax/`. It is a **read-only reference** — consult it for edge cases and port specific helpers (e.g., `safePath`, canary scanner, k8s pod lifecycle bits from the correlation-ID work), but:

- Do NOT mutate it from this repo.
- Do NOT carry over its orchestration shape. The expensive parts of v1 (`server-completions.ts`, the IPC handler dispatcher, the multi-mode sandbox manager) are exactly what v2 removes. Porting them is wasted work.
- Do NOT port v1's `.claude/skills/ax/*` sub-skills. They encode v1 architecture that's being replaced. v2 skills are friction-driven (see Skills, below).

## Build / Test

```bash
pnpm build
pnpm test
pnpm test --filter @ax/<plugin>
```

(Tooling lands in Week 1–2 per architecture doc Section 10.)

## Codex Memory Bootstrap

Project-local memory lives in `.claude/memory/`. For any substantial Codex task,
inspect that directory first and load only the memory needed for the task.

Default approach:

- Read small repo-local memory files directly when they are relevant:
  `context.md`, `patterns.md`, `mistakes.md`, and `meta.md`.
- Search `decisions.md` for task-relevant terms before reading large sections.
- Treat `/Users/vpulim/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/MEMORY.md`
  as an index. Follow linked notes selectively instead of loading the whole
  directory.
- Update `.claude/memory/` as you work and **commit those changes** — these files are tracked in the repo, not gitignored. Fold a memory update into the same commit as the work that produced it (or a small follow-up commit on the branch).

If the task touches architecture, hooks, plugins, security boundaries, CI/PR
workflow, UI conventions, manual acceptance, or prior regressions, bias toward
reading more memory before editing.

## The invariants (read before touching code)

1. **Hook surface is transport-agnostic and storage-agnostic.** No git/sqlite/k8s vocabulary in hook payloads. If a payload field name only makes sense for one backend, it leaks. (See workspace abstraction — architecture doc Section 4.5.)

2. **No cross-plugin imports.** Plugins talk through the hook bus only. Will be enforced by lint (`eslint.config.mjs` `no-restricted-imports`) once scaffolded. The hook bus IS the inter-plugin API.

3. **No half-wired plugins.** A plugin is either fully registered + tested + reachable from the canary acceptance test, or it doesn't merge. No "wire this up later" PRs.

4. **One source of truth per concept.** If two plugins both store state about the same thing (skills, tools, sessions), one of them is wrong. Coordinate through service hooks, not shared rows.

5. **Capabilities are explicit and minimized.** Every plugin, tool, IPC handler, and sandbox boundary grants the smallest set of capabilities it needs — no more. The list to think about: filesystem paths, network reach, process spawn, env access, untrusted-input handling.

   Untrusted content (model output, tool output, user input crossing a trust boundary, third-party plugin code) is treated as untrusted at every hop. The whole point of v2 over openclaw is that we're the secure one — if a hook surface, IPC action, or plugin grants more reach than it strictly requires, that's the bug.

   When touching sandbox boundaries, IPC transport, plugin loading, or any code path that handles untrusted content, invoke the `security-checklist` skill.

6. **One UI design language: shadcn primitives + semantic tokens.** Every user-facing surface (chat, admin, settings, onboarding wizard, error pages) shares the shadcn install in `packages/channel-web` — that's the source of truth. New components compose existing shadcn primitives (`Button`, `Input`, `FieldGroup`/`Field`, `Card`, `Alert`, etc.) with the project's semantic color tokens (`bg-background`, `text-muted-foreground`, `border-border`, …); they don't reinvent styled `<div>`s, hand-roll forms, or use raw color values like `bg-blue-500` or `#000`.

   If a needed primitive isn't installed yet, add it via the shadcn CLI (`pnpm dlx shadcn@latest add <name> -c packages/channel-web`) — don't hand-write a one-off. If a new SPA surface needs UI, host it inside `channel-web` rather than spinning up a separate Vite build with its own design system. The whole point of standardizing on shadcn was that we stop having three different versions of "what does a button look like."

   When building or modifying any UI, invoke the `shadcn` skill — it loads the installed-component list, the rule files, and the monorepo workspace flag (`-c packages/channel-web`).

## Boundary review (required for new hooks)

When adding or changing a service-hook signature, or adding a subscriber hook with a non-trivial payload, answer in the PR description:

- **Alternate impl this hook could have:** name one. (If you can't, consider whether this needs to be a hook at all vs. just a function inside one plugin.)
- **Payload field names that might leak:** list any, or "none". (e.g., `sha`, `bucket`, `pod_name`, `socket_path`. If present, justify or rename.)
- **Subscriber risk:** could a subscriber key off a backend-specific field and break when the alternate impl ships?
- **Wire surface (if this is also an IPC action):** schema lives in this plugin's directory, not a central file.

If you can't name an alternate impl, the abstraction may be premature — just write a function. If field names leak, rename now (cheap) before subscribers depend on them (expensive).

Patches that only change a plugin's **internal** implementation (no hook-surface change) don't need boundary review.

## Half-Wired Code Policy

If you write infrastructure (IPC transport, sandbox provider, bridge, etc.) that's not actually called by the running system, either wire it in within the same PR or don't merge it. "We'll wire it later" code becomes a trap — it confuses readers, drifts from the rest of the system, and represents work that looks done but isn't.

## Bug Fix Policy

Whenever you fix a bug that wasn't caught by an existing test, you MUST add a test that would have caught it the first time. No exception. The test goes in before the fix is considered done.

## Task Board Policy

Tracked work lives on the GitHub **"TO DO"** Projects v2 board (org `project-ax`,
project **#1**, linked to this repo's Projects tab) — **not** in a `TODO.md` file.
The board is the single source of truth. **Both humans and Claude Code agents edit
it.** There is no committed task list and no mermaid DAG to keep in sync.

**Lanes (the `Status` field):**

- **Backlog** — gated / not-yet-actionable / wait-until-earned work. The orchestrator never pulls from here. New work the team isn't ready to start lands here. `(walk)`-tagged manual-acceptance walks live here too (they aren't `yolo-ship`-able — see below).
- **To Do** — the actionable inbox. Anyone drops a card here; the `auto-ship` orchestrator drains it.
- **In Progress** — a `yolo-ship` agent is building it.
- **In Review** — its PR is open, queued for the serialized merge.
- **Done** — merged.
- **Parked** — quarantined by the failure breaker (see the `auto-ship` skill).

**Card shape:**

- **Title** is prefixed with a stable `[TASK-ID]` (`ARCH-n`, `CLI-n`, `SYNC-n`, `FAULTA-n`, or a fresh `TASK-n`). Walk cards also carry `(walk)` in the title.
- **Dependencies** live in the **"Depends on"** text field as space/comma-separated Task IDs. Empty = *not yet analyzed*; `none` = *analyzed, no deps*. Don't conflate the two.

**Readiness is derived, not a lane.** A To Do card is *ready* iff every Task ID in
its "Depends on" points at a **Done** card. Dangling references (the dep card no
longer exists) are pruned during review, not treated as a block.

**Dependency hygiene.** Anyone may add a card or hand-set its deps. When the To Do
lane changes, the orchestrator reviews the whole lane: it analyzes + writes deps for
any card whose "Depends on" is still empty (writing `none` when there are none), and
prunes any referenced Task ID whose card has vanished. Keep the field honest — a
stale dep silently blocks a ready task.

The `auto-ship` skill owns draining the board (monitor To Do → review deps → ship up
to 3 ready cards at a time via `yolo-ship`). See `.claude/skills/auto-ship/`.

## Skills

v2 is friction-driven. A skill gets written only when:

1. 3+ sessions have hit the same friction in the same area, AND
2. The friction is non-obvious from reading the code.

Skills are NOT written for documentation of what the code does, conventions that aren't yet established, or speculation about what might be useful later. Test: a skill should answer "I tried X and it didn't work — what's the trick?"

Day-1 skills:

- `ax-conventions` — the six invariants, plugin manifest format, hook bus mechanics, boundary-review checklist.
- `claude-memory` — per-project working memory in `.claude/memory/` (committed to the repo). Captures project facts, decisions, patterns, mistakes, and self-observations across sessions. See `docs/plans/2026-04-23-claude-memory-skill-design.md`.
- `security-checklist` — three-threat-model walk (sandbox escape, prompt injection, supply chain) producing a structured PR security note. Fires on sandbox / IPC / plugin loading / untrusted content / new-dependency changes. See `docs/plans/2026-04-23-security-checklist-skill-design.md`.

Everything else is deferred until earned.

## Voice & Tone for User-Facing Content

When generating or editing any user-facing content (README, SECURITY.md, docs, error messages, CLI output, comments visible to users), use the following voice:

### Personality

- **Self-deprecating but competent.** We joke about our paranoia, not about security itself. We're the friend who triple-checks the door is locked and laughs about it — but the door IS locked.
- **Warm and approachable.** Assume the reader is smart but not necessarily technical. Never gatekeep. Never make someone feel dumb for not knowing what a CVE is.
- **Honest about complexity.** Security is hard. We say so. We don't pretend things are simple when they aren't, but we do our best to make them understandable.
- **Sarcastic toward bad practices, never toward people.** We roast hardcoded API keys, not the person who committed them. We've all been there.

### Writing guidelines

- Plain language first, jargon second. If you use a technical term, briefly explain it or link to an explanation.
- Short sentences. Short paragraphs. Walls of text are a security vulnerability for attention spans.
- Funny is fine. Funny instead of clear is not.
- When discussing real vulnerabilities, threats, or security configurations, drop the jokes and be direct. Lives and livelihoods depend on this stuff.
- Default to "we" not "you" — we're on the same team as the reader.
- Admit what we don't know. Uncertainty stated clearly is more trustworthy than false confidence.

### Examples

**Good:** "We pin our dependencies because we have trust issues. But also because unpinned dependencies are how supply chain attacks happen, and we'd rather be paranoid than compromised."

**Good:** "This step is optional but recommended. Kind of like locking your car in a safe neighborhood — probably fine if you skip it, but you'll feel better if you don't."

**Bad:** "If you don't understand why this matters, you probably shouldn't be deploying to production."

**Bad:** "Simply configure your TLS mutual authentication with certificate pinning." (nothing about this is "simply")
