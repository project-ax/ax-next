# UX humanization track (`ux-first-run`) — handoff

**For:** the session that picks up TASK-334 … TASK-345.
**Status:** 12 cards on the board, 11 ready, 1 dep-gated. None started.
**Baseline:** `main` @ `2fe1b6ad` (TASK-347 merged). Every card is unblocked by
code that is already on main.
**Design:** `docs/plans/2026-09-06-ux-first-run-audit.md` (committed with this handoff).
**Board:** the twelve cards carry `epic: ux-first-run`.

---

## The audit these cards come from

Every card carries `design:` pointing at the UX audit, now committed alongside
this handoff at **`docs/plans/2026-09-06-ux-first-run-audit.md`**. Read it for
any card you build — the cards restate their findings, but the audit carries the
rationale, the severity, and the "already right" list below that the cards do
not.

**One piece of hygiene first:** the `design:` line on all twelve cards still
reads `/home/vpulim/dev/workspaces/ax-next/docs/plans/...`, an absolute path
from the other machine that resolves nowhere here. Repoint it at the
repo-relative path, or every reader re-runs the hunt that produced this handoff.

### Severity, for ordering inside the track

The audit tags every finding by user-impact and code-cost (`[S]` hours, `[M]`
~a day, `[L]` structural — it biases hard to S/M and rejects the one [L]).

| | count |
|---|---|
| Critical, S | 2 |
| Important, S | 16 |
| Important, M | 5 |
| Minor, S | 12 |
| Nit, S | 4 |

**Both Criticals are A1 and A2, and both are in TASK-334** — the credential slot
input with a raw `api_key` label and no help, and the skill-approval card titled
`Approve {request.skillId}?` with no statement of what approving does. The audit
calls `PermissionCard` "the single trust moment of the product" and "where
first-time users freeze". If the track ships in one order only, it starts there.

### The four open questions are already neutralized

The audit ends with four questions marked "need a human decision — **NOT for
autonomous cards**". Worth knowing that the decomposition handled all four:
each affected card names its question number and states an assumption that
does not foreclose the answer.

| Q | affects | card | the card's assumption |
|---|---|---|---|
| 1 | A1 | TASK-334 | slot labels humanized client-side; manifest-carried labels/URLs stay producer-side, consumed only if present |
| 2 | B8 | TASK-340 | the new copy is mechanism-agnostic and stays correct under either resolution of the auth-model question |
| 3 | A7 | TASK-335 | implement the height-cap mitigation ONLY; whether the two cards may ever co-render stays human |
| 4 | C2 | TASK-337 | stop the silent no-op; whether the rename endpoint gets built is separate, and ungating later is one line |

So the audit's warning does not block the track. It does mean **no card should
quietly answer its open question** — if building one tempts you to decide it,
that is the escalation, not a judgement call.

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

## Already right — do not regress

The audit names the surfaces that are exemplary and are the house standard. This
matters more than it sounds for a copy track, because **several of them live in
files these cards edit**: `ChainOfThought`'s collapsed detail (TASK-335 edits
its header labels), `AgentForm`'s collapsed Advanced for new agents (TASK-341),
`StepModel`'s Advanced collapsible (TASK-340), and the whole
`ApprovalCard` / `DecisionRow` / `AgentRail` / `decision-copy` honesty system,
which is the voice the rest of the track is being brought up to.

Also on the list: `SkillEditor` form-first with its raw escape hatch,
`TodayView`'s empty state, `HomeComposer`'s routing proposal,
`KeyForm`/`CredentialSlotForm`'s "A key is saved" cue, and
`SkillInstallConsentDialog`'s consent framing — which TASK-344 is explicitly
told not to touch while humanizing the title around it.

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
- **All four open questions themselves** — see the table above. The cards work
  around them; none of them answers one.
- **E3's second half**, the five-button admin row collapsing into a `⋯`
  DropdownMenu — an `[M]` the audit raises and TASK-336 excludes.
- **Renaming anything that is not a display string.** See the hard boundary
  above.

---

## Kickoff prompt

After `/clear`:

```
Work the ux-first-run track: TASK-334 through TASK-345 on the "TO DO" board.

Read docs/plans/2026-09-11-ux-humanization-track-handoff.md first, then the
audit it points at (docs/plans/2026-09-06-ux-first-run-audit.md) for whichever
card you are building.

The cards are the specification: ~25k chars, each with file:line, intended copy,
and acceptance criteria, covering audit findings A1-A13, B1-B9, C1-C5, D1-D10,
E1-E6 with no gaps. Read the card in full before touching code, and read the
audit's "Already right - do not regress" list before editing any file it names.

The audit has four open questions marked NOT for autonomous cards. All four are
already neutralized by an explicit assumption on the affected card. If building
one tempts you to actually decide one, escalate instead.

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
