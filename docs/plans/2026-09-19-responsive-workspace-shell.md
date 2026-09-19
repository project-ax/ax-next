# TASK-404 — the workspace shell below 768px

## What the walk measured, and what the code says

The TASK-356 walk against `canopyworks.ai` reported, at phone width:

- Today's filter chips at **x = 385–541**, off the viewport.
- The agent tabs off-screen entirely.
- **No horizontal scroll**, so neither is reachable.

Reading the code corroborates all three, and names the mechanism. The surface is the
**workspace shell** (`src/components/workspace/*`), not the legacy `/chat` shell — the
"filter chips" and "agent tabs" the walk names exist only there.

Three facts produce the bug:

1. **`WorkspaceSidebar.tsx:61`** — `flex w-[236px] shrink-0 flex-col`. Unconditional.
   No `md:`, no collapse, no toggle. On a 390px phone it takes 61% of the viewport and
   leaves `main` 154px.
2. **`WorkspaceHeader.tsx:27/32`** — `flex h-14 shrink-0 items-center gap-3 px-6`, with
   the control block on `ml-auto`. Nothing wraps, nothing truncates, nothing has
   `min-w-0`. `"Today"` + `"Friday, August 21"` overrun the 106px content box and
   `ml-auto` pushes the chips past the right edge. 236 + 24 + title + subtitle lands the
   `ToggleGroup` right about where the walk measured it.
3. **`WorkspaceShell.tsx:689`** — `<main className="… overflow-hidden">`. That is the
   "no horizontal scroll". `overflow-hidden` clips both axes, and the root is
   `h-screen`, so the document never grows past the viewport and the overflow is
   genuinely unreachable rather than merely awkward.

`AgentView.tsx:857` is the same story: four triggers (`Conversation`, `What it did`,
`Files`, `Memory`) separated by `ml-6`, roughly 309px of intrinsic width in a 106px box.

### One thing the card understates

There is a **third** fixed column the card does not mention, and it is worse than either
of the two it does. `AgentRail.tsx:118` is `w-[296px] shrink-0`, rendered on the chat
tab. With the sidebar that is **532px of non-shrinking chrome on a 390px screen**: the
conversation column is `min-w-0 flex-1`, so it collapses to approximately zero and the
rail itself still overflows. The primary surface of the product — the thread — has no
width at all at phone width. Fixing the chips and the tabs while leaving that would be a
hollow fix, so it is in scope.

`AgentFiles.tsx:252` has a fourth (`w-[260px] shrink-0`, the file-list column on the
Files tab). That one is a master-detail pattern needing its own interaction design, it
is not what the walk measured, and it is **deferred to a follow-up card**.

## The decision: single column below `md`, side columns go off-canvas

**Breakpoint: `md` (768px)** — Tailwind's default, and the threshold the card states.
Note the legacy `/chat` shell uses `720px` via `max-[720px]:` body-class variants. We do
not adopt that number: it is the retiring surface (memory: "Workspace as sole
interface — /chat one release"), and 768 is both the card's number and the framework
default. Two breakpoints in one app is a cost, but inheriting a dying surface's
arbitrary number into the surviving one is a worse one.

**The rule, stated once:** *below `md` the shell is a single column. Both side columns
become off-canvas `Sheet` panels; the header wraps instead of pushing; the tab strip
becomes a horizontal scroll rail.*

### Why not the alternatives

- **`overflow-x: auto` on the shell.** Explicitly rejected by the card, and correctly:
  it converts a dead end into a 550px-wide sideways-scrolling desktop layout on a phone.
  The content is not too big — the chrome is.
- **Stack the rail under the conversation.** Tried on paper and rejected. The
  conversation column owns its own scroller and a bottom-anchored composer, inside a
  parent that is `min-h-0 flex-1` under an `overflow-hidden` `main`. Stacking a second
  unbounded-height scroller beneath it needs the outer split to scroll, which the
  `overflow-hidden` clips — so it would need its own height budget and would fight
  `use-stick-to-bottom`. A `Sheet` keeps the thread full-width and costs one tap.
- **Hide the rail below `md`.** That is the bug class this card exists to fix: content
  that exists and cannot be reached.
- **Collapse the sidebar to a 56px icon rail** (what the legacy shell's
  `sidebar-collapsed` does). Still spends 14% of a phone viewport permanently, and the
  agent roster is a list of names — unreadable as icons.

### Why a `matchMedia` hook and not pure CSS

A `Sheet` and an inline `<aside>` are different component trees, not one tree with
different CSS: the sidebar is stateful (`rosterOpen`), carries a `UserMenu`, and
rendering both would duplicate every interactive target and focus stop. So the branch
has to be in JS regardless. This is also the canonical shadcn Sidebar pattern
(`useIsMobile()` → `Sheet` on mobile, fixed aside on desktop).

It has a second, deliberate benefit: **it is the only part of this fix that jsdom can
test.** jsdom applies no CSS and does no layout, so a `md:` class is invisible to it and
any assertion about one would be a class-name spelling check wearing the costume of a
behaviour test. The repo already knows this — `src/__tests__/mobile-sidebar.test.tsx`
says so in its own header and tests the *state machine* instead. We follow that
precedent.

## Tasks

### T1 — `useIsCompact()` hook
`src/lib/use-compact.ts`. **Returns `false` when `window.matchMedia` is absent** — jsdom
ships none (`theme.ts:64` already guards for exactly this), so every one of the ~40
existing workspace tests keeps rendering the desktop tree unchanged. Load-bearing: yes —
T2 and T5 both branch on it.

Two things landed differently from the first draft of this plan, both deliberately:

- **The query is `not all and (min-width: 768px)`, not a `max-width`.** A `max-width`
  spelling cannot express the complement of `md`: `767px` leaves a pixel unclaimed and
  even `767.98px` leaves the open band `(767.98, 768)` matching neither query, which
  would put a viewport there on the desktop JS tree with the compact header CSS.
  Negating the real breakpoint — what Tailwind's own `max-md` compiles to — is gap-free
  by construction.
- **It uses `useSyncExternalStore`, not `useState` + effect.** The draft said
  "`useSyncExternalStore`-free"; that was wrong. A `useState` initialised to `false` plus
  an effect renders the DESKTOP tree on the first paint of every phone load and corrects
  it a frame later — a 236px sidebar that flashes in and out. `useSyncExternalStore`
  reads the right value before the first paint, and it is what `theme.ts` already uses
  for the same class of problem.

### T2 — `WorkspaceSidebar` → inline aside (desktop) / `Sheet` (compact)
Extract the existing body into a `SidebarNav` used by both. Desktop keeps
`w-[236px] shrink-0` verbatim. Compact renders no inline aside; `WorkspaceShell` owns
the `Sheet` open state and a hamburger trigger passed into `WorkspaceHeader`'s new
`leading` slot. Selecting anything closes the sheet. `SheetTitle` is `sr-only`.
Load-bearing: yes — this is the 236px that puts the chips back on screen.

### T3 — `WorkspaceHeader` wraps
`h-14` → `min-h-14 h-auto py-2 md:h-14 md:py-0`; add `flex-wrap`; control block
`ml-auto` → `w-full md:ml-auto md:w-auto`. New optional `leading` slot for T2's trigger.
**No truncation introduced** (TASK-436 asks that clamped text keep a `title`; the cheaper
answer here is to wrap rather than clamp, so nothing gains a clamp). Load-bearing: yes —
reclaiming the sidebar alone still leaves ~408px of header content in a 342px box.

### T4 — agent tab strip becomes a scroll rail
Wrap `TabsList` in `-mx-6 overflow-x-auto px-6`, `TabsList` gets `w-max`. Belt and
braces after T2: at 390px the strip now fits, at 320px it does not, and neither will a
fifth tab. **Touches no trigger, no `aria-controls`, no panel** — TASK-437's scope is
left exactly as it found it.

### T5 — `AgentRail` → inline aside (desktop) / `Sheet` (compact)
Same treatment and same reason as T2. Trigger sits in the agent header next to the tab
strip, chat tab only (which is the only tab that renders the rail today).
Load-bearing: yes — see "one thing the card understates".

### T6 — tests
`src/components/workspace/__tests__/responsive-shell.test.tsx`. Stubs `window.matchMedia`
compact, asserts the state machine: no inline nav, a trigger present, trigger reveals the
nav, selection closes it; and the same three for the rail. Desktop control case asserts
the inline aside is back and no trigger is rendered. Must be verified failing-first by
reverting T2/T5.

## Boundary review

Not applicable — no hook-bus surface, no IPC action, no payload. This is
`packages/channel-web` presentation only: one new React hook, two components gaining a
responsive branch, two gaining layout classes. No plugin boundary is crossed, no
capability is added, nothing reads untrusted content that did not already.

`security-checklist` not invoked: no sandbox boundary, no IPC, no plugin loading, no new
dependency (`Sheet` and `@radix-ui/react-dialog` are both already installed and already
used by `CredentialSlotRow`).

## Did a stale line generate this card?

No. The card was generated by a **measurement** (the TASK-356 walk), and reading the code
confirms the measurement rather than contradicting it. There is no stale doc or memory
row to correct. The one correction this branch does make is to the card's own scope — it
omits `AgentRail`, which is the worst of the three columns — and that is recorded here
and in the PR rather than in a doc that did not exist.

## Verification

- **CI layer:** T6 in jsdom, failing-first verified by reverting the fix.
- **Measurement layer:** jsdom cannot produce an x-position, so the numbers the card asks
  for come from a real browser — a throwaway Vite harness in the scratch dir that mounts
  the real `WorkspaceShell` with `fetch` stubbed, driven by Playwright at 390×844, before
  and after. The harness is **not committed** (it would be half-wired code); its measured
  numbers go in the PR body.
