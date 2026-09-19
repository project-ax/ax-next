# TASK-399 — `--ink-ghost` is a fill, not ink

## What the card asked for, and why it can't be done that way

The card asks to "raise `text-ink-ghost` to at least AA (4.5:1) in both themes."
Measured against the real stylesheet, that instruction is unsatisfiable as written,
and the measurement says so cleanly.

`--ink-ghost` is `240 4% 78%` light / `240 4% 26%` dark. Confirmed, matching the four
prior probe runs exactly:

| pair | measured |
|---|---|
| `--ink-ghost` on `--background`, light | **1.72:1** |
| `--ink-ghost` on `--background`, dark | **2.04:1** |
| `--ink-ghost` on `--card`, dark | **1.67:1** |
| `--ink-ghost` on `--muted`, light | **1.57:1** |

The last two are worse than anything the card names, because the card only measured
the page background. The token also lands on cards and on filled chips.

To clear 4.5:1 on every surface it is painted on, `--ink-ghost` would have to become
**~46% light / ~53% dark**. `--muted-foreground` is already **44% light / 56% dark**.
The two would be 2–3 percentage points apart — the same colour. One concept, two
tokens: CLAUDE.md invariant 4.

Worse, it would break the token's other role. `--ink-ghost` is also a **fill**:

- `Composer.tsx:263` — the send circle's inactive state (`:has()` flips it to
  `bg-primary` once the field has content).
- `bits.tsx:86` — `StateDot`'s `resting` dot.
- `StatusDot.tsx:11,15` — the admin `empty` and `pending` dots.

A mid-grey send circle reads as *enabled*, and a mid-grey `resting` dot reads as
active next to `bg-primary` "working". Moving the value fixes the text and breaks
those three.

This is the exact tension `index.css` already documents for `--primary` and
`--destructive` — a token that is both an accent and a foreground, where moving it
satisfies one role by breaking the other. The resolution there was to **split the
roles**, not to average them. Same resolution here.

## The fix

`--ink-ghost` keeps its value and becomes **background-only**. Every site that paints
it as *text* moves to `text-muted-foreground`, which is the project's semantic token
for quiet-but-readable copy and which already clears AA on every surface it lands on
(light 5.20 background / 5.20 card / 5.20 popover / 4.73 muted; dark 6.14 / 5.03 /
5.03 / 5.28 — all measured by the existing `theme-contrast.test.ts`).

This is not a new idea in this codebase. `AgentMenu.tsx:99` already made exactly this
swap for one component, with a comment explaining why, and `AgentMenu.test.tsx:34`
already guards that one site. This card generalises a decision the project had
already made piecemeal.

### Scope — what actually moves

The card names two sites. There are **twelve**, in eleven files:

| file:line | what renders |
|---|---|
| `AgentStatus.tsx:108` | the cancel button beside the status line |
| `SidebarSectionLabel.tsx:32` | every sidebar section heading + popover footer |
| `NewSessionButton.tsx:66` | the ⌘N hint *(named by the card)* |
| `SessionHeader.tsx:143` | the conversation title in the header |
| `SessionRow.tsx:338` | the per-row "more" control |
| `ToolUse.tsx:55` | `STEP_LABEL_CLASS` — every tool-step label |
| `Toast.tsx:100` | the toast dismiss control |
| `Thread.tsx:255`, `:318` | message timestamps |
| `bits.tsx:335` | `row.source` — the `rule:*` ids in the permission rail |
| `bits.tsx:383` | `grantedDay` on a grant row |
| `Composer.tsx:301` | `⏎ send · ⇧⏎ newline` *(named by the card)* |

`bits.tsx:335` is the one the TASK-357 walk flagged: a consent surface, not chrome.

## Tasks

1. **The failing-first guard** — extend `theme-contrast.test.ts` with a per-theme case
   that (a) measures `--ink-ghost` against every quiet surface from the real
   stylesheet and (b) asserts no source file paints it as text. Fails on `main` in
   both themes, naming the measured number and every offending file. Includes an
   anti-vacuity assertion: the source scan must prove it can see the tree at all.
2. **The swap** — 12 sites → `text-muted-foreground`; update
   `SidebarSectionLabel.tsx`'s docstring, which names `ink-ghost` as the spec.
3. **Document the split** — a comment on `--ink-ghost` in `index.css` recording the
   numbers and the fill-only rule, so the next person does not re-derive this.

YAGNI pass: all three are load-bearing. No ESLint rule — the vitest guard is where the
measurement already lives, and a second enforcement point could disagree with it.

## Not in this PR

- **TASK-425** — verified a *different* pair: `--primary` on `--primary-soft`, which
  measures **4.35 light / 4.28 dark** (the walk said 4.36/4.28). Nothing to do with
  `--ink-ghost`. Correctly kept separate by the board.
- **The `resting` / `empty` dots.** They keep the faint fill, so `StateDot`'s
  `resting` stays at 1.72:1 light / 1.67:1 dark against its surface. `bits.tsx:70`
  says "colour is the state", which makes the dot an information-bearing non-text
  element owing 3:1 under WCAG 1.4.11 — a real defect, but a *different* one with a
  different fix, and one this PR's role-split is the precondition for. Follow-up card.
- **Boundary review:** not applicable. No hook surface, no IPC action, no payload
  field. This is CSS tokens and Tailwind classes inside one package.
