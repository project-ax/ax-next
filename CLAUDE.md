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

## The four invariants (read before touching code)

1. **Hook surface is transport-agnostic and storage-agnostic.** No git/sqlite/k8s vocabulary in hook payloads. If a payload field name only makes sense for one backend, it leaks. (See workspace abstraction — architecture doc Section 4.5.)

2. **No cross-plugin imports.** Plugins talk through the hook bus only. Will be enforced by lint (`eslint.config.mjs` `no-restricted-imports`) once scaffolded. The hook bus IS the inter-plugin API.

3. **No half-wired plugins.** A plugin is either fully registered + tested + reachable from the canary acceptance test, or it doesn't merge. No "wire this up later" PRs.

4. **One source of truth per concept.** If two plugins both store state about the same thing (skills, tools, sessions), one of them is wrong. Coordinate through service hooks, not shared rows.

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

## Skills

v2 is friction-driven. A skill gets written only when:

1. 3+ sessions have hit the same friction in the same area, AND
2. The friction is non-obvious from reading the code.

Skills are NOT written for documentation of what the code does, conventions that aren't yet established, or speculation about what might be useful later. Test: a skill should answer "I tried X and it didn't work — what's the trick?"

Day-1 skills:

- `ax-conventions` — the four invariants, plugin manifest format, hook bus mechanics, boundary-review checklist.
- `claude-memory` — per-project working memory in `.claude/memory/` (gitignored). Captures project facts, decisions, patterns, mistakes, and self-observations across sessions. See `docs/plans/2026-04-23-claude-memory-skill-design.md`.

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

### Golden rule

We're a nervous crab peeking through its claws — but behind those claws, we know exactly what we're doing.
