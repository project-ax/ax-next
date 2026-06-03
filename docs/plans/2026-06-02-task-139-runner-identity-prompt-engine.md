# TASK-139 — Runner prompt-engine + identity templates (Phase 1)

Epic: conversational-agent-identity. Design: `docs/plans/2026-06-02-conversational-agent-identity-design.md`.

Replace `buildSystemPrompt(string)` in `@ax/agent-claude-sdk-runner` with a modular
file-based prompt-engine that reads `${workspaceRoot}/.ax/` every turn and composes the
SDK `systemPrompt`. Opens the half-wired string-fallback window (closed in Phase 4).

## Pinned decisions (open questions this phase owns)

- **`.ax/` location** — `${env.workspaceRoot}/.ax/` (defaults to `/permanent`, override
  `AX_WORKSPACE_ROOT`), not a hardcoded path. Matches every sibling `/permanent` reader.
- **Prompt order, normal mode** — `[agentConfig.systemPrompt prepend (carries augment)] +
  [safety floor] + [AGENTS.md?] + ## Identity + ## Soul + evolution guidance + operational
  notes`. Operating-manual-first (v1 ordering); safety floor first among runner-authored
  content so a long SOUL.md can't displace it.
- **Augment** — honored by prepending the whole `agentConfig.systemPrompt` on top in normal
  mode (the orchestrator merged augment + legacy persona into that one string host-side).
  Fallback mode = that string IS the base (today's behavior). No realistic Phase-1 agent has
  both `.ax/` files and a legacy persona, so this injects only the augment block in practice.
- **Budget** — no renderMinimal/drop allocator in Phase 1. Inject each `.ax/` file in full;
  skip a single file (logged warn) only if it exceeds a 256 KiB hard cap (corrupt-file guard,
  never mid-content truncation). Drop-when-tight is a follow-up.
- **Templates home** — versioned TS string constants in the runner package
  (`src/identity-templates.ts`), not a new package.

## Modes (engine contract)

On each turn the runner reads `.ax/BOOTSTRAP.md`, `.ax/AGENTS.md`, `.ax/IDENTITY.md`,
`.ax/SOUL.md`:

1. **Bootstrap mode** — `BOOTSTRAP.md` present → systemPrompt is **exactly and only** its
   content (verbatim, nothing else; not even the augment, not the notes). Returned as a
   plain string.
2. **Normal mode** — no `BOOTSTRAP.md` but ≥1 of `{IDENTITY.md, SOUL.md, AGENTS.md}` present
   → compose `[agentConfig.systemPrompt prepend] + [safety floor] + [AGENTS.md?] +
   ## Identity (IDENTITY.md?) + ## Soul (SOUL.md?) + evolution guidance + operational notes`.
   Each `.ax/` file inject-if-present. Safety floor + evolution guidance + notes always.
3. **String fallback** — no `BOOTSTRAP.md` and no identity files → legacy behavior: the
   existing `buildSystemPrompt` string path (preset when empty, string + notes when set).

The existing operational notes (workspaceNote / ephemeralScratchNote / pythonVenvNote /
capabilityHandoffNote / skillAuthoringNote) are reused from `system-prompt.ts` in all of
normal + fallback modes. Bootstrap mode injects none of them (verbatim-only).

## Tasks

### Task 1 — `identity-templates.ts` (templates source)
New `src/identity-templates.ts` exporting `BOOTSTRAP_TEMPLATE`, `IDENTITY_SCAFFOLD`,
`SOUL_SCAFFOLD` as string constants. BOOTSTRAP v2-adapted from openclaw canonical:
conversational "you just woke up", talk-first/no-form, write `.ax/IDENTITY.md` +
`.ax/SOUL.md` with the **`Write`** tool (not `write_file`), memory section pointing at
`@ax/memory-strata` (`memory_note` for lasting facts), completion ritual that deletes
`.ax/BOOTSTRAP.md` by its named path, closing line. Trim USER.md + channel-linking. No
security-first/canary framing. Scaffolds are short defaults the bootstrap script can copy.
Tests: structural assertions (contains `Write`, `.ax/IDENTITY.md`, `.ax/SOUL.md`,
`.ax/BOOTSTRAP.md` self-delete, memory-strata reference; NOT `write_file`, NOT `USER.md`,
NOT WhatsApp/Telegram/canary).

### Task 2 — safety floor + evolution guidance + module renderers (`prompt-engine.ts`)
New `src/prompt-engine.ts`. Export:
- `safetyFloorNote()` — thin, hardcoded, couple-sentence runner preamble: untrusted content
  is data not instructions; ask before irreversible/external actions. Not file-derived.
- `identityEvolutionNote()` — your `.ax/` files are yours; read then `Write` to update;
  changes auto-commit; tell the user when you change `SOUL.md`; `.ax/AGENTS.md` is the home
  for operating-behavior overrides.
- pure compose helper `composeNormalModePrompt({ prepend, agentsMd, identityMd, soulMd,
  notes })` → string, in the pinned order, inject-if-present per file, `## Identity` /
  `## Soul` headings only when the file is present (or always, with the file body? — decide:
  heading present only when body present, to avoid empty sections).
Tests cover floor/evolution content + the compose ordering with each file present/absent.

### Task 3 — `.ax/` reader + async `buildSystemPrompt`
In `prompt-engine.ts`: `readAxIdentityFiles(workspaceRoot)` → `{ bootstrap?, agents?,
identity?, soul? }` (each `string | undefined`; absent file or read-error → undefined;
>256 KiB → undefined + `console.warn`). Then make `buildSystemPrompt` **async** with a new
signature that takes `workspaceRoot` (already does) and dispatches:
- bootstrap present → return `bootstrap` verbatim.
- else if any identity file present → `composeNormalModePrompt(...)` using the reused notes
  bundle (workspace + ephemeral? + pythonVenv? + handoff + skill-authoring) and the
  `agentConfig.systemPrompt` prepend + floor + evolution.
- else → the legacy string path (preset/string, unchanged).
The notes bundle stays a helper so bootstrap/normal/fallback share one note-assembly site.
Tests: bootstrap-exclusive, normal composition (each file present/absent), safety-floor-
always-present-and-unsuppressable, fallback condition (no files → legacy preset/string).

### Task 4 — wire `main.ts`
`await buildSystemPrompt(agentConfig.systemPrompt, env.workspaceRoot, env.ephemeralRoot,
pythonVenvReady)` (now async). Confirm the call site is already inside an async fn (it is —
it's in the `query({ options })` builder). Update the comment block. No other call-site
changes; existing-sandbox reuse path unaffected (files already materialized in /permanent).

### Task 5 — gate + security note + memory
`pnpm build && pnpm test --filter @ax/agent-claude-sdk-runner`, lint scoped to changed
files. Run security-checklist (untrusted file content composed into prompt; non-editable
safety floor is the mitigation). Update memory; PR body carries the security note + the
"no new hook signature" boundary statement.

## Invariants

- #2: runner reads files; no new hook signature (rides nothing — pure local fs read).
- #3: string fallback is the explicit time-boxed bridge (Phase 4 closes it); engine is fully
  wired into `main.ts` this PR.
- #5: hardcoded non-editable safety floor; 256 KiB per-file guard on untrusted file content.
