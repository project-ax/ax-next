# UX humanization track (`ux-first-run`) — handoff

**For:** the session that picks up TASK-334 … TASK-345.
**Status:** 12 cards on the board, 11 ready, 1 dep-gated. None started.
**Baseline:** `main` @ `2fe1b6ad` (TASK-347 merged). Every card is unblocked by
code that is already on main.
**Board:** the twelve cards carry `epic: ux-first-run`.

---

## Read this first: the design doc these cards cite is NOT in this repo

Every one of the twelve cards has this header line:

```
design: /home/vpulim/dev/workspaces/ax-next/docs/plans/2026-09-06-ux-first-run-audit.md
```

That file does not exist here. Not on disk, not in any branch, not in any commit
reachable from any ref, and nothing in the repo so much as mentions
`ux-first-run`. Note the path is `/home/vpulim/...` — a **Linux** path, so it was
written on the other machine and never made it across.

**This is not a blocker, and here is the evidence for that claim.** The cards
were measured for self-sufficiency before this handoff was written:

- ~25,000 characters of specification across the twelve.
- All twelve have a `## Acceptance` section.
- Each restates its findings with `file:line` and, in most cases, the exact
  replacement copy.
- **Finding coverage is complete with no gaps**: A1–A13, B1–B9, C1–C5, D1–D10,
  E1–E6 are each claimed by exactly one card. Nothing in the audit's
  numbering is unassigned, so the missing doc is not hiding work.

What the doc would still add: the audit's rationale, its `[S]/[M]/[L]` severity
tags (referenced in passing by TASK-345), and two "open questions" the cards
cite by number — **open question 1** (TASK-334: are slot labels humanized
client-side, or should manifests carry labels/URLs?) and **open question 4**
(TASK-337: does the rename endpoint get built, or is the feature parked?). Both
cards state an assumption inline and proceed, so neither stops work.

**Decision for a human, before dispatching anything:** copy the audit over from
the Linux machine and commit it to `main`, or accept that the cards are the
source of truth and delete the `design:` line so nobody chases a dead path. Do
not leave it as-is — a card citing an unreachable doc is exactly what sends
auto-ship's triage gate to **Needs Input**, and it will do that twelve times.

---

## Goal

The audit found the product speaks like a developer tool to a non-technical
first-time user, and in several places says something untrue. The track fixes
both, surface by surface, without changing behaviour.

Two sentences worth holding onto while working:

- **It is a copy-and-primitives track, not a redesign.** No grant semantics, no
  payload or IPC changes, no renamed identifiers, no new screens.
- **The honesty half is not cosmetic.** TASK-335's failed tool step that still
  reads "Ran a command", and TASK-337's empty state that claims "No
  conversations yet." on a *failed fetch*, are the product asserting things that
  are false. Those are defects with a copy-shaped fix, not polish.

---

## The twelve cards

| Card | Surface | Findings |
|---|---|---|
| TASK-334 | `PermissionCard` — the single trust moment | A1, A2, A5, A6, A11, A12 |
| TASK-335 | Chat core: step status, composer, errors | A3, A4, A7, A8, A9, A10 |
| TASK-336 | Vocabulary: New chat / File unavailable / Update key | C3, A13, E3 |
| TASK-337 | Workspace honesty: failed fetch, rename no-op | C1, C2 |
| TASK-338 | `UserMenu`: real popover primitive, labeled theme | C4, C5 |
| TASK-339 | Boot, sign-in, session-end | B1, B2, B3, B6 |
| TASK-340 | First-run dialog + setup wizard | B4, B5, B7, B8, B9 |
| TASK-341 | Admin config: `AgentForm`, `ModelConfigTab` | D1, D2, D3, D7 |
| TASK-342 | Provider setup + last-provider lockout | D4, D5 |
| TASK-343 | Admin copy sweep: Teams, Skills, bundles | D6, D8, D9, D10 |
| TASK-344 | Credentials + connectors (**deps: TASK-334**) | E1, E2, E4, E6 |
| TASK-345 | `RoutineEditor` cron preview | E5 |

---

## Sequencing — three couplings, and only one is on the board

**1. TASK-344 depends on TASK-334, and the board says so.** TASK-334 introduces
the slot-id humanization helper (`api_key` → "API key",
`ANTHROPIC_API_KEY` → "Anthropic API key"); TASK-344 reuses it and explicitly
forbids duplicating the logic. **Have TASK-334 put that helper in a shared
module from the start** rather than inline in `PermissionCard.tsx` — otherwise
TASK-344 opens with a refactor of someone else's just-merged file.

**2. TASK-339 and TASK-340 both edit `App.tsx`, and nothing records it.** This
is the only file two cards touch. Different regions — 339 is at `:223`, `:236`,
`:312` (boot limbo, session expiry), 340 is at `:339` (the non-dismissible
dialog) — so it is a merge-conflict risk, not a design conflict. Run them
sequentially, or accept one rebase.

**3. TASK-336 ends in a repo-wide sweep.** After its three named renames it
sweeps `packages/channel-web` for user-facing "session" meaning *conversation*.
That touches files other cards are editing. **Land it last**, when the other
copy is settled, or it will be re-sweeping its own track.

Everything else is genuinely parallel.

---

## Constraints that are not negotiable

**Invariant 6 — one UI design language.** Compose the installed shadcn
primitives with semantic tokens (`bg-background`, `text-muted-foreground`,
`border-border`); no raw colors, no hand-rolled `<div>` widgets. Several cards
exist *because* this was violated: TASK-338's hand-rolled popover, TASK-339's
hand-rolled sign-in `<button>` (the first button a user ever touches),
TASK-342's hand-rolled switch, TASK-341's hand-rolled destructive divs.

**Invoke the `shadcn` skill before writing UI**, and remember the workspace flag
`-c packages/channel-web` on any CLI call. In practice you should not need one:
**every primitive this track asks for is already installed** — `dropdown-menu`,
`popover`, `switch`, `select`, `alert`, `tooltip`, `dialog`. Checked against
`packages/channel-web/src/components/ui/` on 2026-09-11.

**Invoke the `ux-design` skill** for the project's UX framework, and
`CLAUDE.md`'s *Voice & Tone* section is the copy spec — warm, plain, blameless,
"we" not "you", and no jokes on a real failure. The `ux-designer` agent is
available and advisory-only if a surface needs a second opinion.

**TASK-336's hard boundary, which applies to the whole track:** display strings
only. Do not rename code identifiers, IPC action names, payload fields, routes,
or storage keys. Hook payloads keep their names — that is invariant 1.

**TASK-340 carries a Half-Wired trap.** It adds a `hideClose` API to
`DialogContent`. Wire it and test it in the same PR; a Dialog API with no caller
does not merge.

---

## File map

All paths under `packages/channel-web/src/`. **All 35 files the cards cite were
verified present on 2026-09-11** — but the cards were written on 2026-09-06 and
their line numbers have had a week to drift. Treat `file:line` as "look here",
never as a coordinate.

- **Chat/trust:** `components/PermissionCard.tsx`, `ChainOfThought.tsx`,
  `Thread.tsx`, `Composer.tsx`, `AgentStatus.tsx`, `lib/transport.ts`
- **Vocabulary:** `components/NewSessionButton.tsx`, `AgentMenu.tsx`,
  `ArtifactChip.tsx`, `components/settings/ConnectorsTab.tsx`
- **Workspace:** `components/SessionList.tsx`, `SessionHeader.tsx`
- **Chrome:** `components/UserMenu.tsx`
- **Entry:** `App.tsx`, `components/LoginPage.tsx`,
  `components/onboard/FirstRunAutoCreate.tsx`
- **Wizard:** `components/ui/dialog.tsx`, `components/onboard/NewAgentDialog.tsx`,
  `components/setup/{SetupShell,StepGate,StepAdmin,StepModel}.tsx`
- **Admin:** `components/admin/{AgentForm,ModelConfigTab,AddProviderForm,AuthProvidersTab,TeamList,SkillEditor,SkillAttachmentsSection,BundleReviewDialog}.tsx`
- **Credentials/connectors:** `components/credentials/CredentialSlotRow.tsx`,
  `components/settings/{ConnectorConnectDialog,SkillInstallConsentDialog,AllowedSitesPanel,SiteAgentsDialog}.tsx`
- **Routines:** `components/routines/RoutineEditor.tsx`

---

## Gotchas that will cost an hour each

- **Radix primitives activate on `mousedown`, not `click`.** A `fireEvent.click`
  on a `TabsTrigger` (or a dropdown item) leaves the component exactly where it
  was, silently and with no error. Use `fireEvent.mouseDown`. This bites this
  track specifically, because four cards swap hand-rolled widgets for Radix
  ones. `@testing-library/user-event` is **not** a dependency here.
- **jsdom keeps one `window.location` per test FILE.** Since TASK-327 the
  workspace shell reads its route from the URL, so any test that navigates
  leaves the next one mounting on that URL. `WorkspaceShell.test.tsx` resets it
  in `beforeEach`; do the same in any new file that mounts a routed surface.
- **`packages/channel-web` DOES type-check its tests** (`include: ["src","mock"]`
  with no `__tests__` exclusion), so `pnpm build` covers them. That is
  package-specific — do not generalise it.
- **`pnpm --filter` goes BEFORE the script name.** `pnpm test --filter X`
  silently runs the whole repo suite.
- **The gate is three suites, not one.** `pnpm -r run test` bails at the first
  failure; the recursive part alone skips two others.
- The Bash tool here runs **zsh**; brace `${i}` before a `:`.

---

## Verification

```bash
pnpm build
pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
pnpm lint
```

`@ax/channel-web` alone is ~1800 tests and is where this track's regressions
will show. Per-card acceptance criteria are on the cards; each also asks for
tests, and the Bug Fix Policy applies to the honesty fixes — TASK-335's failed
step and TASK-337's lying empty state are bugs, so each needs a test that would
have caught it.

What a green suite will **not** prove, and this track is unusually exposed to
it: that the copy reads well to a human, that a dark-mode swap did not go
muddy, and that a Radix replacement kept focus behaviour. Walk the changed
surfaces in a browser — the `k8s-acceptance-loop` skill drives Playwright
against the kind cluster, and `chat-qa-sweep` covers the chat surfaces.

---

## Out of scope

- **E3's admin-row button consolidation** into a `…` DropdownMenu — TASK-336
  excludes it explicitly as an `[M]` cleanup.
- **A friendly day/time picker or natural-language cron input** — TASK-345
  excludes both; the `[L]` natural-language option was rejected in the audit.
- **Building the conversation-rename endpoint** — TASK-337 only stops the silent
  no-op. Whether the endpoint gets built is open question 4, a human decision.
- **Manifest-carried credential labels/URLs** — TASK-334 consumes them if
  present and invents nothing; making producers emit them is open question 1.
- **Renaming anything that is not a display string.** See the hard boundary
  above.

---

## Kickoff prompt

After `/clear`:

```
Work the ux-first-run track: TASK-334 through TASK-345 on the "TO DO" board.

Read docs/plans/2026-09-11-ux-humanization-track-handoff.md first. Its opening
section matters most — the design doc all twelve cards cite does NOT exist in
this repo, and the handoff explains why that is survivable and what to decide
about it before starting.

The cards are the specification: ~25k chars, each with file:line, intended copy,
and acceptance criteria, covering audit findings A1-A13, B1-B9, C1-C5, D1-D10,
E1-E6 with no gaps. Read the card you are building in full before touching code.

This is a copy-and-primitives track, not a redesign: display strings and shadcn
primitives only, no behaviour, payload, IPC or identifier changes. But the
honesty fixes (TASK-335's failed step reading "Ran a command", TASK-337's
"No conversations yet." on a FAILED fetch) are real defects — they get tests.

Invoke the shadcn and ux-design skills before writing UI. Every primitive this
track needs is already installed. CLAUDE.md's Voice & Tone section is the copy
spec.

Sequencing: TASK-334 before TASK-344 (shared slot-id humanization helper — put
it in a shared module from the start). TASK-339 and TASK-340 both edit App.tsx,
so don't run them in parallel. Land TASK-336 last; it ends in a repo-wide sweep.

TDD, and watch each test fail first. Full gate before each PR:
  pnpm build
  pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
  pnpm lint
```
