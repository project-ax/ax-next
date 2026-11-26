# S4 — Rows + status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `StatusMark`, `StatusBadge`, `Timestamp`, `Avatar`, `KeyValueList`, `Card`, `InsetBlock`, `List`/`ListRow`, `Timeline`/`TimelineEntry` and `FileTile` in `@project-ax/ui`. Move channel-web onto them so that §6.3 rule 8 (one status vocabulary), rule 10 (no nested cards) and rule 11 (one time format) hold. Rows use one divider method. Delete the components they replace.

**Architecture:**
- **Packaging:** the components follow the S2a/S3 pattern. Class lookups are literal maps run through `cx`, with no `className`, `style` or `as` props. Each component has a story per state, plus axe and Docker screenshots.
- **One source per rule:** a single status-tone map drives both the mark and the badge. One time formatter backs both `Timestamp` and plain-text uses through a pure function. One file-icon picker and one size formatter back `FileTile`.
- **Migration:** channel-web moves over surface by surface. Each replaced component is deleted in the task that removes its last caller.
- **Lint:** rules widen in the last task through the ratchet's new widening path.

**Tech Stack:** React 19, TypeScript, Tailwind 3.4.19 (restricted `ax-` preset), lucide-react, Radix (`@radix-ui/react-collapsible` for expandable rows, pinned to channel-web's resolved version), and `Intl` (no date library). Tests use Vitest + jsdom. Stories use Storybook 10.6.7 with Playwright and axe in the pinned Docker image.

**Spec:** `docs/superpowers/specs/2026-11-24-agent-first-ui-design.md` §5.3, §5.4 (rows for `StatusBadge`, `StatusMark`, `Avatar`, `Timestamp`, `List`+`ListRow`, `KeyValueList`, `Timeline`, `Card`/`InsetBlock`, `FileTile`), §6.3 rules 8, 10, 11. Roadmap card **S4 Rows + status**. S3 lessons: `docs/superpowers/plans/2026-11-25-project-ax-ui-s3-followups.md`.

## PR split

One branch (`design/project-ax-ui-s4`), shipped as two stacked PRs by commit range:

| PR | Tasks | What lands |
|---|---|---|
| **S4a** status, time, identity, surfaces | 1–6 | StatusMark/StatusBadge (rule 8), Timestamp (rule 11), Avatar, KeyValueList, Card, InsetBlock (rule 10). Dead code deleted |
| **S4b** rows, timelines, files | 7–12 | List/ListRow, Timeline, FileTile; ~45 row sites, 3 timeline rows and 5 file components migrated; lint locked |

## Global Constraints

- **USER DIRECTIVE (binding on every task and review):** before/after does NOT have to look the same. What must be preserved is FUNCTIONALITY: the same actions, data, states, flows, focus and screen-reader behaviour. Look-and-feel differences that come from adopting a shared component are not findings above Minor. The goal is to reuse as many components (basic and composed) as possible and to delete code that re-implements them. Don't add wrappers or one-off styling to keep an old look.
- **Component API (§5.3):**
  - no styling props (`className`, `style`, `as`, raw colors);
  - small enums (≤ 4 members, except where the spec fixes a set: `StatusBadge`/`StatusMark` `tone` has the spec's 5);
  - required a11y props;
  - status as enums, never colors.
- **Rule 8 (verbatim):** "`StatusBadge` tones with a fixed emphasis ladder (danger > warning > info > neutral ≥ success). Waiting-on-you is the warning diamond everywhere (sidebar, switcher, queue, chat). The same decision renders through the same pattern in Today and in chat."
- **Rule 10 (verbatim):** "Lists sit directly on the surface; `InsetBlock` for quoted/preview content, one level."
- **Rule 11 (verbatim):** "`Timestamp` everywhere."
- **Divider rule:** the roadmap's done-when says "one divider method": `List` owns row dividers. No row draws its own `border-b`, `divide-y` or `<Separator>`.
- **Restricted preset:**
  - `ax-` token classes only, no arbitrary values;
  - class strings are literal maps through `cx`, never built from strings, never passed through non-className props (an S3 lesson: a helper that took `width="max-w-[720px]"` hid violations from lint);
  - SSR-safe: no `window` or `document` at module scope or during render.
- **Fixed-height controls:** the `Button`, `IconButton` and `ButtonBase` controls are fixed-height, one-line controls. Never put multi-line content in them (S3 lesson: GeneratedFileChip overflowed).
- **Text that can be long** (titles, names, filenames) must not overflow its box at 390 px. Filenames truncate the stem and keep the extension visible.
- **Lint and suppressions:**
  - Every migrated channel-web file adds no new `ax-ui/*` violations.
  - Run `pnpm lint:ui:prune` afterwards (never `lint:ui:suppress`, except in Task 12).
  - Each frozen per-file count may only fall.
  - Ratchet: `node scripts/ui-suppressions-ratchet.mjs origin/main` → ok.
- **Tests:**
  - Tests on a migrated screen move to role, label or text queries in the same task.
  - Never loosen an assertion without an equivalent: no deleted assertion, no exact→regex, no visible→inDocument.
  - Bug Fix Policy: a fixed bug gets a test that would have caught it.
- **Carry-overs from S3, still binding:**
  - Every failed read offers a working "Try again".
  - Only danger is `role=alert`.
  - A status message that changes uses one persistent `role=status` element.
  - No nested live regions.
  - Notice actions take `busy`.
  - Two different actions never share a label.
- **New dependencies:** exact pin at channel-web's resolved version, with the supply-chain walk recorded in the task report.
- **Docker-backed tests:** need `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`. Locally they may time out waiting for a container start slot that other processes hold. Re-run such a file alone and report both runs; CI is the final signal.

## Review Focus

1. **Bad or edge-case dates.** These include an unparseable or missing date, a future time (a scheduled check-in), a date across midnight or a DST change, and a user in another timezone.
   - `Timestamp` must render nothing (not "Invalid Date") for a bad value.
   - Future times read as "in 5 min" or "Tomorrow 9:00 AM".
   - Day boundaries follow the user's local calendar.
   - Tests in Task 2 use a fixed `now` and an explicit `timeZone`.
2. **A long title, filename or agent name at 390 px.**
   - `ListRow`, `FileTile` (all three variants) and `StatusBadge` must not overflow their box.
   - Filenames keep their extension.
   - Stories with 80-character names in Tasks 1, 7 and 9 pin this, with a bounding-box assertion in a unit test where jsdom can't measure (assert the truncation classes and the stem/extension split).
3. **A row that opens on click AND has its own controls** (a switch, menu, Revoke button).
   - Clicking or keyboard-activating a trailing control must not open the row.
   - Tab order is primary action, then trailing controls.
   - There is exactly one accessible primary action per row.
   - Tests go in Task 7.
4. **"Waiting on you" shown in several places for one item** (sidebar dot, switcher roster, Today queue, chat card).
   - Every place uses the warning diamond with the same accessible wording.
   - A source-scan convention test in Task 12 fails on hand-rolled warning dots (`rounded-full bg-warning`).
5. **A card inside a card.** It must be impossible by type where it can be, and reported otherwise. `Card` and `InsetBlock` render a dev-mode console error when nested in their own kind, and a test pins it (Task 3). The migration flattens every List-inside-Card to a flush `Card` containing a `List`, which is allowed.

---

### Task 1: `StatusMark` + `StatusBadge`

**Model:** standard.

**Files:**
- Create:
  - `packages/ui/src/internal/status.ts` (the one tone map)
  - `packages/ui/src/components/StatusMark.tsx`, `StatusBadge.tsx`, and their `.stories.tsx`
- Modify: `index.ts`, `props.test-d.ts`, `ui.css` (via `gen`)
- Test: `packages/ui/src/__tests__/status.test.tsx`

**Interfaces (produces):**
```ts
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export interface StatusMarkProps { tone: StatusTone; label?: string }   // label → role="img" aria-label; else aria-hidden
export interface StatusBadgeProps { tone: StatusTone; dot?: boolean; size?: 'sm' | 'md'; children: React.ReactNode }
```

**Shape and colour:**
- Shape is the second channel; colour is never the only signal:

  | tone | shape |
  |---|---|
  | `warning` | diamond (waiting on you) |
  | `danger` | square |
  | `info` | filled circle |
  | `success` | check |
  | `neutral` | ring |

  These carry over StateDot's shapes. Its separate "paused dash" folds into the `neutral` ring, by ruling. Cost: paused and resting share a mark, and their labels differ.
- **Emphasis ladder (rule 8):**
  - `danger` uses its soft fill and danger text;
  - `warning` uses its soft fill and warning text;
  - `info` uses accent-soft;
  - `neutral` and `success` both use the plain `surface-raised` fill with muted text and a coloured mark.

  So `success` is never louder than `warning`.
- `StatusBadge` text uses the `caption` role and must not wrap. Long text truncates with a `title` attribute.

- [ ] **Step 1: Write the failing tests.**
  - `StatusMark renders a distinct shape per tone (5 different data-shape values)`.
  - `StatusMark is aria-hidden without label, role=img with label`.
  - `StatusBadge tone classes follow the ladder: success fill === neutral fill, warning fill !== success fill`.
  - `StatusBadge dot renders a StatusMark of the same tone`.
  - `long badge text truncates (has truncation class + title)`.
  - SSR render.
  - Type tests: no `className`, and a bad tone fails.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement and export (`StatusMark`, `StatusMarkProps`, `StatusBadge`, `StatusBadgeProps`, `StatusTone`), then run `gen`. The diamond and square may use a rotated or square box with token sizes, or an inline SVG. No arbitrary values.
- [ ] **Step 4: Stories.** `StatusMark/AllTones`, `StatusBadge/AllTones`, `WithDot`, `Sizes`, and `LongText` at 390 px. Run `stories:update` and the verify run. Run the unit tests.
- [ ] **Step 5:** Commit `feat(ui): StatusMark and StatusBadge`.

### Task 2: `Timestamp` and `formatTimestamp`

**Model:** standard (dates are fiddly).

**Files:**
- Create: `packages/ui/src/internal/time.ts`, `packages/ui/src/components/Timestamp.tsx` and its `.stories.tsx`
- Modify: `index.ts`
- Test: `packages/ui/src/__tests__/time.test.ts`, `timestamp.test.tsx`

**Interfaces (produces):**
```ts
export type TimestampStyle = 'relative' | 'clock';
export function formatTimestamp(value: Date | string | number, opts?: { style?: TimestampStyle; now?: Date; timeZone?: string; locale?: string }): string | null; // null when unparseable
export function formatFullTimestamp(value: Date | string | number, opts?: { timeZone?: string; locale?: string }): string | null; // "Fri, Oct 23, 2026, 7:13 PM"
export interface TimestampProps { value: Date | string | number; style?: TimestampStyle; now?: Date }  // default 'relative'
```

**Formats:** these are the union of today's helpers, collapsed into two styles.
- **`relative`** (default; for "when did this happen" and "when will it happen"):
  - Past:
    - < 1 min: "just now"
    - < 60 min: "5 min ago"
    - same local day: "3 hr ago"
    - yesterday: "Yesterday 4:58 PM"
    - < 7 days: "Mon 10:02 AM"
    - same year: "Oct 23"
    - otherwise "Oct 23, 2025"
  - Future, mirrored:
    - < 60 min: "in 5 min"
    - same day: "Today 9:00 AM"
    - tomorrow: "Tomorrow 9:00 AM"
    - < 7 days: "Mon 10:02 AM"
    - then the same date forms as the past.
- **`clock`** (for dense timelines; replaces `compactStamp`):
  - today: "7:13 PM"
  - < 7 days: "Fri 7:13 PM"
  - otherwise "Oct 23", with the year when it isn't the current year.
- **`Timestamp` renders:**
  - `<time dateTime={ISO} title={formatFullTimestamp(value)}>{formatTimestamp(value)}</time>`;
  - plus a visually hidden full timestamp when the visible text is relative, so screen readers get the absolute time (this replaces RowTime's sr-only full stamp);
  - nothing at all for an unparseable value.
- **Locale and time zone:** the user's (`Intl` defaults). `now` defaults to `new Date()` at render. The component doesn't tick, same as today.

- [ ] **Step 1: Write the failing tests** in `time.test.ts`, with a fixed `now` and an explicit `timeZone: 'America/Los_Angeles'`, locale `en-US`:
  - Each past and future bucket above, with exact strings.
  - The midnight boundary: 23:59 yesterday reads "Yesterday 11:59 PM", not "1 min ago".
  - A DST-change day (Nov 1, 2026 in that zone): the day bucket is still correct.
  - `null` for `'not a date'` and `NaN`.
  - The `clock` style buckets.
  - `formatFullTimestamp` exact string.

  In `timestamp.test.tsx`:
  - It renders a `<time>` with an ISO `dateTime` and a `title`.
  - The relative style includes the hidden absolute text.
  - Nothing is rendered for an unparseable value.
  - SSR doesn't throw.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement and export (`Timestamp`, `TimestampProps`, `TimestampStyle`, `formatTimestamp`, `formatFullTimestamp`).
- [ ] **Step 4:** Add stories `Relative/AllBuckets` and `Clock` using a fixed `now` (deterministic screenshots). Run `stories:update` and the verify run.
- [ ] **Step 5:** Commit `feat(ui): Timestamp and one time formatter`.

### Task 3: `Avatar`, `KeyValueList`, `Card`, `InsetBlock`

**Model:** standard.

**Files:**
- Create: `packages/ui/src/components/{Avatar,KeyValueList,Card,InsetBlock}.tsx` and their `.stories.tsx`, plus `packages/ui/src/internal/nesting.ts` (context guards)
- Modify: `index.ts`, `props.test-d.ts`, `ui.css`
- Test: `packages/ui/src/__tests__/surfaces.test.tsx`

**Interfaces (produces):**
```ts
export interface AvatarProps { name: string; size?: 'xs' | 'sm' | 'md' | 'lg'; shape?: 'square' | 'round'; tone?: 'brand' | 'neutral'; label?: boolean }
// sizes xs 16, sm 20, md 26 (default), lg 36 px. Initials = first letters of the first two words (1 for a single word), uppercase.
// Decorative (aria-hidden) unless label=true → role="img" aria-label={name}.
// brand = today's AgentTile primary-soft fill; neutral = today's muted UserMenu tile.
export interface KeyValueListProps { items: ReadonlyArray<{ label: string; value: React.ReactNode }>; layout?: 'rows' | 'stacked' }  // renders <dl>; rows = label left / value right with List-style dividers; stacked = label above value
export interface CardProps { children: React.ReactNode; flush?: boolean; label?: string }  // flush = no padding (hosts a List edge to edge); label → <section aria-label>
export interface InsetBlockProps { children: React.ReactNode; label?: string }  // muted, rounded, one level
```

**Nesting rules:**
- `Card` and `InsetBlock` each provide a context.
- A `Card` rendered inside a `Card`, or an `InsetBlock` inside an `InsetBlock`, does two things in development (`process.env.NODE_ENV !== 'production'`):
  - calls `console.error('Card: cards do not nest — use InsetBlock for quoted or preview content (§6.3 rule 10).')`;
  - still renders.
- An `InsetBlock` inside a `Card` is allowed.
- `Card` has one look: today's default Card (`surface-raised` fill, panel radius, panel elevation). The `settings` variant folds into it.

- [ ] **Step 1: Write the failing tests:**
  - Avatar: initials `'Quill Bot' → 'QB'`, `'juniper' → 'J'`; aria-hidden by default; `label` → img with name; the size tokens map to 4 distinct classes.
  - KeyValueList: renders `dl`, with `dt`/`dd` pairs in order.
  - Card inside Card → `console.error` called once with the message. Card + InsetBlock → no error. InsetBlock inside InsetBlock → error.
  - Card `label` → region named.
  - SSR for all four.
  - Type tests: no `className`.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement and export. Run `gen`.
- [ ] **Step 4:** Stories:
  - Avatar sizes and shapes and tones, LongName.
  - KeyValueList rows and stacked, LongValue at 390.
  - Card default, flush with a list-like child, with InsetBlock.
  - InsetBlock with a quote.

  Run `stories:update` and verify.
- [ ] **Step 5:** Commit `feat(ui): Avatar, KeyValueList, Card, InsetBlock`.

### Task 4: Status migration (rule 8) and dead code

**Model:** standard.

**Files (channel-web `src/components/…` unless a path is given):**

| Today | Becomes |
|---|---|
| `StateDot` / `StateDotSlot` (`workspace/bits.tsx:168`), 16 uses in 12 files | `StatusMark` |
| `TaskStatusPill` (`workspace/task-bits.tsx:225`) | `StatusBadge dot` |
| `StatusChip` (`routines/StatusChip.tsx`) | `StatusBadge` |
| shadcn `Badge`, 47 uses in 27 files | `StatusBadge` |
| `badgeVariants()` used as classes on non-Badge elements (`DirectoryListingRow` ×3, `workspace/bits.tsx:352`) | `StatusBadge` |
| bare waiting dots (`AgentSwitcher:112,133`, `WorkspaceSidebar:105`) | `StatusMark tone="warning"` |
| `WorkspaceSidebar:191` warning count Badge | `StatusBadge tone="warning"` |
| `ApprovalCard:245` "Waiting on you" badge | `StatusBadge tone="warning" dot` |

`StateDot` state → tone:

| state | tone |
|---|---|
| working, on-track | info |
| waiting, held, needs-you | warning |
| stopped, off-track, error, bad | danger |
| resting, no-update, no-recent-update, paused | neutral |
| done | success |

Badge variant → tone:

| Badge variant | tone |
|---|---|
| `destructive` | danger |
| `warning` | warning |
| `accent`, `default` | info |
| `secondary`, `outline` | neutral |

A Badge that is a **label, not a status** (for example "Suggested", "You", "Catalog", a count) becomes `StatusBadge tone="neutral"`. Count badges keep their number as text.

Delete, along with their tests:
- `admin/ProviderRow.tsx`, `admin/KeyForm.tsx`, `admin/StatusDot.tsx`
- `AgentStateLabel` (in `workspace/bits.tsx`)
- `components/SourceBadge.tsx` and `skillSource`
- `StateDot`/`StateDotSlot`, `TaskStatusPill`, `StatusChip` once their callers are gone

`__tests__/theme-contrast.test.ts` reads `StatusDot.tsx` and `bits.tsx`'s StateDot fill arms from source. Drop those cases. Status-tone contrast is now covered by the package's contrast test (status tones on soft fills), so confirm that it covers every fill `StatusMark`/`StatusBadge` use and add any that are missing.

- [ ] **Step 1: Update the tests to the new roles and text, and confirm the changed assertions fail.**
  - Tests that query `.bg-warning` or `span[aria-hidden]` dots (AgentSwitcher, StateDotSlot, TodayTaskGroup, DecisionRow, WorkspaceSidebarState) move to text queries, or to the mark's `data-shape="diamond"`. `data-shape` is a public, documented attribute of StatusMark for tests and scripts.
  - A test for Review Focus 4: the sidebar, switcher and Today queue each render a diamond for a waiting agent.
- [ ] **Step 2:** Migrate and delete. `grep -rnE "components/ui/badge|StateDot|StatusChip|TaskStatusPill|AgentStateLabel|SourceBadge|ProviderRow|StatusDot|KeyForm" packages/channel-web/src` returns nothing outside `components/ui/`.
- [ ] **Step 3:** channel-web `tsc`, the full channel-web suite, `pnpm lint`, `pnpm lint:ui:prune`, ratchet ok.
- [ ] **Step 4:** Commit `refactor(channel-web): one status vocabulary — StatusMark and StatusBadge (rule 8)`.

### Task 5: Time migration (rule 11)

**Model:** standard.

**Files:**
- `lib/workspace-time.ts`, `lib/models-copy.ts` (its own `timeAgo`), `lib/task-row-line.ts`, `lib/artifact-labels.ts`, `lib/task-meta.ts`, `lib/task-finish-by.ts`, `lib/agent-slack.ts`
- `workspace/task-bits.tsx` (`RowTime`), `workspace/bits.tsx` (`Elapsed`), `workspace/DecisionRow.tsx` (`ago`), `routines/FireRowsTable.tsx` (`formatTimestamp`)
- The `toLocaleString`/`toLocaleDateString` sites:
  - `RememberedSitesPanel:115`, `AwaitingReviewSection:93`, `WorkspaceShell:81`, `AppLinkCodeDialog:30`, `FactsMemory:291`
  - `TaskAppConnection:17`, `TeamList:30`, `SlackBotsCard:76`, `SlackTab:116`, `DefaultRoutinesSection:181`
- The `Intl.DateTimeFormat` sites: `MemoryUsedChip:47`, `task-row-line`
- Their tests

**Mapping:**
- A moment shown on screen → `<Timestamp value>` (relative), or `style="clock"` in timelines and dense lists. That covers RowTime's sites, `ago`, both `timeAgo` helpers, `Elapsed` ("started 5 min ago" → `started <Timestamp/>`), `shortDay`, `updateStamp`, and every `toLocale*` display.
- A moment inside a sentence or other built string → the package's `formatTimestamp(value)`:
  - `checkInWhen` in "Next check-in …";
  - sr-only labels;
  - copy constants;
  - `artifact-labels`, `task-row-line`, `task-meta`.

  Example: "Next check-in Tomorrow 9:00 AM". The phrasing may change ("at 10:02 AM" → "Today 10:02 AM"); the information may not. List every phrasing change in the report.
- Date-only values that are not moments stay as they are, and the report lists each one:
  - a finish-by **date** ("Finish by Oct 23") → `formatTimestamp(value, { style: 'clock' })` only if the result is a plain date; otherwise keep a date-only `Intl` call in `lib/task-finish-by.ts`;
  - a calendar day header (`localDayLabel`).
- `lib/workspace-time.ts` keeps only what's still used. The rest is deleted with its tests.

- [ ] **Step 1:** Update the tests to the new output strings and `<time>` elements, and confirm they fail. Add one test per former helper asserting the replacement's exact output for a fixed `now`.
- [ ] **Step 2:** Migrate. `grep -rnE "\b(ago|timeAgo|RowTime|shortDay|checkInWhen|updateStamp|Elapsed|compactStamp|fullStamp)\b|toLocale(Date|Time)?String\(" packages/channel-web/src` lists only the documented keepers, each named in the report.
- [ ] **Step 3:** Gate as in Task 4.
- [ ] **Step 4:** Commit `refactor(channel-web): Timestamp everywhere (rule 11)`.

### Task 6: Avatar, KeyValueList, Card, InsetBlock migration (rule 10)

**Model:** standard.

**Files:**
- **Avatar:**
  - `AvatarTile` (`components/AvatarTile.tsx`) and `AgentTile` (`workspace/bits.tsx:53`): 17 callers → `Avatar`.
  - Sizes: 16, 18 → `xs`; 20, 22 → `sm`; 24, 26, 28 → `md`; 36 → `lg`.
  - AgentTile is `brand`; the UserMenu tiles are `neutral`.
  - Delete both components.
- **KeyValueList:**
  - `admin/StorageTab.tsx:182` and `admin/SlackTab.tsx:765` → `layout="rows"`.
  - `settings/DirectoryListingRow.tsx` `DetailItem` and `workspace/DecisionTaskBlock.tsx` (2 `dl`) → `layout="stacked"`.
  - TaskPage `MetaRow`: migrate only if it's a label/value list; otherwise note why not.
- **Card**, 52 sites:
  - Every `Card` → ui `Card`. `variant="settings"` and every className override go.
  - A Card that hosts a list (`overflow-hidden p-0`, `divide-y`) → `Card flush` (its rows become a `List` in Task 10/11; until then the children stay).
  - Width-capped page cards (AppsApprovePage, LoginPage, ErrorBoundary, SetupShell, VisualFrame, ApprovalCard) → `Card` inside the page's existing width container. If the container cap was on the Card itself, keep a `Stack` wrapper; per the directive, a different width is fine.
  - Tinted status cards in TaskPage (`bg-warning-soft`, `bg-primary-soft`) → `Notice` with the matching tone when they say something about state, or `InsetBlock` when they quote content.
  - Layout cards with `lg:col-*` (TaskPage) → `Card` in a `Grid`.
- **InsetBlock**, about 15 sites:
  - `DecisionRow:335`, `TaskNotes:119`, `ArtifactViewer:200`, `AgentAppsRows:79` (nested grant `li` → InsetBlock inside the row)
  - `SkillForm:499,770`, `LegacyConnectorEditDialog` ×4, `AddProviderForm:71`, `BundleFileView:47`, `DecisionRequestBlock:46`
  - the two `blockquote`s (`ConnectorToolPermissions:91`, `bits.tsx:292`)
  - the AwaitingReview rows and their 3 near-twins, if they are quoted content (otherwise they're rows: Task 10)
- Delete shadcn `components/ui/card.tsx` only if no importer remains (Task 12 bans it either way). Their tests come too.

- [ ] **Step 1:** Update the tests (role and text queries; Card `label` → region) and confirm the changed ones fail. Add a test for Review Focus 5: render the screen with the most cards (TaskPage), spy on `console.error`, and assert no nesting error.
- [ ] **Step 2:** Migrate. Then:
  - `grep -rn "AvatarTile\|AgentTile" packages/channel-web/src` is empty;
  - `grep -rn "components/ui/card" packages/channel-web/src` lists only `components/ui/` itself (or nothing).
- [ ] **Step 3:** Gate as in Task 4.
- [ ] **Step 4:** Commit `refactor(channel-web): Avatar, KeyValueList, one Card, InsetBlock (rule 10)`.

**End of S4a.**

### Task 7: `List` + `ListRow`

**Model:** most capable (interaction and a11y design).

**Files:**
- Create: `packages/ui/src/components/List.tsx` (List and ListRow), `List.stories.tsx`
- Modify: `index.ts`, `package.json` (`@radix-ui/react-collapsible`, exact pin from the lockfile), `ui.css`
- Test: `packages/ui/src/__tests__/list.test.tsx`

**Interfaces (produces):**
```ts
export interface ListProps { label: string; density?: 'comfortable' | 'compact'; children: React.ReactNode }  // <ul aria-label>, owns dividers between rows
export interface ListRowProps {
  title: string;
  meta?: React.ReactNode;          // one line under the title, muted (e.g. Timestamp, "3 tools")
  description?: string;            // up to 2 lines, clamped
  leading?: React.ReactNode;       // Avatar, StatusMark, file icon
  trailing?: React.ReactNode;      // buttons, Switch, toggle group, an existing shadcn DropdownMenu until S6a
  onOpen?: () => void;             // the row's primary action
  href?: string;                   // primary action as a link (mutually exclusive with onOpen)
  expandable?: { content: React.ReactNode; defaultOpen?: boolean; label: string }; // Collapsible; label names the toggle
}
```

**Behaviour:**
- `List` renders `ul` with `aria-label`, and rows as `li`. Dividers sit between rows, never after the last one.
- `comfortable` is today's settings density (min height `touch`+), and `compact` is today's dense rail density.
- **Primary action:** with `onOpen` or `href`, the **title** renders as the row's only primary control (a `button` or `a`). A pseudo-element stretches it over the whole row, so clicking anywhere on the row opens it. `trailing` sits above that layer and stays independently clickable and focusable. Clicking a trailing control never fires `onOpen` (Review Focus 3).
- **Without `onOpen` or `href`:** the title is plain text.
- **`expandable`:** a chevron toggle named `label` (for example "Show details for {title}"). `aria-expanded` is set, and the content renders below the row inside the same `li`.
- **`menu` is not in this task.** It waits for S6a's `Menu` (ruling). Until then a row menu is passed in `trailing`.
- **Long text:** the title truncates to one line with a `title` attribute. `meta` truncates. `description` clamps to 2 lines. Nothing overflows at 390 px.

- [ ] **Step 1: Failing tests (jsdom, `fireEvent`):**
  - `renders ul with aria-label and li per row`.
  - `no divider after the last row` (assert the divider class sits on rows 1..n-1 only, or uses the CSS sibling selector, whichever the implementation uses, pinned).
  - `onOpen: title is the only button named by the title; clicking the row body calls onOpen once`.
  - `clicking a trailing button calls its handler and NOT onOpen`.
  - `keyboard: Tab order is title button then trailing controls; Enter on the title opens`.
  - `href renders a link named by the title`.
  - `expandable toggles aria-expanded and shows content`.
  - `long title has truncation class and title attribute`.
  - SSR.
  - Type test: `onOpen` and `href` together is an error, and `className` is rejected.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement and export (`List`, `ListProps`, `ListRow`, `ListRowProps`). Record the supply-chain note for the collapsible package.
- [ ] **Step 4:** Stories:
  - Basic (title, meta)
  - WithLeadingAvatar
  - WithStatusMark
  - Openable
  - OpenableWithTrailingSwitch
  - Expandable
  - Compact
  - LongTitle at 390

  Run `stories:update` and verify.
- [ ] **Step 5:** Commit `feat(ui): List and ListRow`.

### Task 8: `Timeline` + `TimelineEntry`, and the three timeline rows

**Model:** standard.

**Files:**
- Create: `packages/ui/src/components/Timeline.tsx` and its stories
- Modify: `index.ts`
- Test: `packages/ui/src/__tests__/timeline.test.tsx`
- channel-web: `workspace/TaskUpdates.tsx` (`UpdateEntry`, `ReplyEntry`), `workspace/RepeatTaskBody.tsx` (`RunRow`), and their tests

**Interfaces (produces):**
```ts
export interface TimelineProps { label: string; children: React.ReactNode }   // <ol aria-label>
export interface TimelineEntryProps {
  mark: React.ReactNode;           // StatusMark, or StatusBadge for "You"/"Someone else"
  children: React.ReactNode;       // the entry text (clamped to 2 lines)
  time: Date | string | number;    // rendered as <Timestamp style="clock">
  action?: React.ReactNode;        // e.g. an IconButton link to the conversation
}
```

UpdateEntry, RunRow and ReplyEntry become `TimelineEntry`. Each entry keeps its extra content (reading suffix, error line, sr-only group label) inside its `children`. The copied `IconLink` + sr-only stamp goes away, because `Timestamp` carries the absolute time.

- [ ] **Step 1:** Write the failing package tests (an `ol` with `li` entries in order; the time renders a `<time>`; the action is focusable; long text clamps; SSR). Update the channel-web TaskUpdates and RepeatTaskBody tests to role/text queries. Confirm they fail.
- [ ] **Step 2:** Implement and export, add stories, then migrate the three entries and delete them.
- [ ] **Step 3:** Gate as in Task 4, plus package tests and the stories verify run.
- [ ] **Step 4:** Commit `feat(ui): Timeline; task updates and runs use it`.

### Task 9: `FileTile` and the file components

**Model:** most capable (it replaces five components with different behaviour).

**Files:**
- Create:
  - `packages/ui/src/components/FileTile.tsx` and its stories
  - `packages/ui/src/internal/file.ts` (`fileIcon`, `splitFileName`, `formatFileSize`)
- Modify: `index.ts`
- Test: `packages/ui/src/__tests__/file-tile.test.tsx`, `file.test.ts`
- channel-web:
  - `workspace/ArtifactCard.tsx`, `workspace/AgentArtifacts.tsx` (`ArtifactRow`), `workspace/GeneratedFileChip.tsx`
  - `components/AttachmentChip.tsx`, `workspace/WorkspaceAttachmentChip.tsx`
  - `lib/storage-copy` (size formatting)
  - their tests

**Interfaces (produces):**
```ts
export function formatFileSize(bytes: number): string;   // "812 B", "1.2 KB", "3.4 MB", "1.1 GB"
export interface FileTileProps {
  name: string;
  variant: 'card' | 'row' | 'chip';
  size?: number;                      // bytes
  kind?: string;                      // mime type or extension → icon
  detail?: string;                    // e.g. artifact type line, "Ready to send"
  status?: 'ready' | 'working' | 'failed';   // working → busy (spinner on the primary control, aria-busy); failed → danger text in detail
  progress?: number;                  // 0–100, shown while working
  onOpen?: () => void;                // primary action (open / download); the whole tile is one control
  actionLabel?: string;               // accessible name prefix, e.g. "Download" → "Download report.csv"; default "Open"
  trailing?: React.ReactNode;         // e.g. remove button for a pending attachment
  previewUrl?: string;                // image thumbnail (image attachments)
}
```

**Behaviour:**
- **Primary control:** the tile is a real `button` (or a non-interactive `div` without `onOpen`). It is never the fixed-height ui `Button`.
- **Layout:**
  - `card` is a full-width bordered tile with a 40 px icon;
  - `row` is borderless, for use inside a `List`;
  - `chip` is inline and two-line (name, then "size · detail") with a minimum height of `touch`. Its width is capped by a token width, and the name truncates.
- **Name:** split into stem and extension. The stem truncates with an ellipsis; the extension always stays visible (`report-q3-final-really-final….csv`). A `title` attribute shows the full name.
- **Accessible name:** `${actionLabel} ${name}`.
- **Busy:** keeps the label, shows a spinner and `aria-busy`, and stays focusable (S3 busy semantics).

**Migration:**
- **GeneratedFileChip:** becomes `FileTile variant="chip"`. Its download/gone/error logic stays in channel-web; the error `Notice` stays below. This also finishes the S3 follow-up, since busy no longer drops focus.
- **ArtifactCard:** becomes `card`.
- **ArtifactRow:** becomes `row`, inside a `List` in Task 11.
- **AttachmentChip** (image, downloadable, pending) and **WorkspaceAttachmentChip** (with progress, ready, failed and retry, and remove in `trailing`): both become `chip`, or the image `previewUrl`.
- **Duplicates:** the two `pickIcon` copies and the three size formatters are deleted.
- **MemoryUsedChip** is not a file tile. It moves to a `List` in Task 11.

- [ ] **Step 1: Failing tests:**
  - `formatFileSize` buckets.
  - `splitFileName('report.final.csv') → ['report.final', '.csv']`, `('README') → ['README', '']`, `('.env') → ['.env', '']`.
  - `fileIcon` for image, pdf, csv, unknown.
  - Each variant renders its parts.
  - A long name keeps the extension node separate and the stem truncates (assert the structure and classes).
  - The accessible name is "Download report.csv".
  - Working: aria-busy, focus kept, click swallowed.
  - Failed shows the detail as danger text.
  - A trailing button click doesn't trigger `onOpen`.
  - No `div` inside a `button` (the primary control's descendants are phrasing elements only: assert no `div`/`p` inside the button).
  - SSR.

  Then update the channel-web tests for the five components to role/text, and confirm they fail.
- [ ] **Step 2:** Implement and export (`FileTile`, `FileTileProps`, `formatFileSize`), then add stories: each variant × short and 80-character name × 390/1440, Working, Failed, WithProgress, ImagePreview. Run `stories:update` and verify.
- [ ] **Step 3:** Migrate and delete the replaced code. Run `grep -rn "pickIcon\|formatSize\|function formatBytes" packages/channel-web/src` and confirm only `formatFileSize` imports remain.
- [ ] **Step 4:** Gate as in Task 4, plus the package tests.
- [ ] **Step 5:** Commit `feat(ui): FileTile; artifacts, attachments and generated files use it`.

### Row migration guide (Tasks 10–11)

| Today | Becomes |
|---|---|
| any repeated row (an `li`, or a `div` in a `.map`) with a title and optional meta, leading or trailing | `ListRow` inside one `List` (label = the section's heading text) |
| a row that opens a sheet, page or dialog on click | `ListRow onOpen` (or `href`) |
| a row with a Switch or ToggleGroup | `ListRow trailing={<Switch …/>}` with the Switch's existing accessible name |
| a row with a DropdownMenu | `ListRow trailing={<existing DropdownMenu/>}`. It keeps its trigger name (scripts pin "Actions for X") until S6a |
| `SettingsRow`/`SettingsDetailRow`/`SettingsDisclosure` | `ListRow` (+ `onOpen` that opens the existing Sheet; disclosure → `expandable`) |
| row dividers (`divide-y`, `border-b … last:border-b-0`, row `<Separator>`) | removed. `List` owns them |
| `Card` holding rows | `Card flush` + `List` |
| a quoted or preview block inside a row | `InsetBlock` inside `ListRow description`, or inside `expandable` content |
| a real table (`FactsMemory`, `SlackBotsCard`, `UsagePricesCard`, `DefaultRoutinesSection`, `StorageTab` OwnerRow) | stays; it's S6a `DataTable` |
| `FireRowsTable` (div rows, not a table) | `List compact` |

**Checks:**
- **Pinned selectors** must keep working; update a script only when unavoidable, and say so:
  - `check-agent-connector-layout.mjs:36-39` (the "Edit GitHub" button, `[data-testid="connector-name-github"]` and its next-sibling status line);
  - `check-agent-skills-routines.mjs` ("Actions for meeting-notes", "Edit skill" menuitem, switches);
  - `check-routines-layout.mjs:305-317` (switch names).
- **Before deleting a row component,** confirm with grep that no caller is left.

### Task 10: Rows — admin, settings, routines, credentials

**Model:** standard.

**Files:**
- `settings/SettingsLayout.tsx` (`SettingsRow`, `SettingsDetailRow`, `SettingsDisclosure`, which are deleted when their last caller goes)
- `settings/`: `SkillsAppStore` (`SkillRow`, the per-agent branch), `RememberedSitesPanel`, `AllowedSitesPanel`, `AwaitingReviewSection` (+ twins `admin/AuthoredSkillsSection:307`, `admin/SlackBotRequests`, `admin/SkillAttachmentsSection:156`), `ConnectorToolPermissions` (`ToolRow` A), `DirectoryListingRow`, `ConnectorsTab`
- `admin/`: `AuthProvidersTab`, `TeamList`, `UsageTab` (`UsageRow`), `SlackTab` (6 `li`), `AgentToolPicker`, `AgentForm`, `SelectedModelsPane`, `RoleCard` (→ `Card` with a `StatusBadge`; not a row)
- `routines/`: `AgentSelfImprovementSection` (`AgentToggleRow`), `RoutinesList`, `FireRowsTable`
- `credentials/CredentialSlotRow` (3 callers)
- their tests

- [ ] **Step 1:** List every row site per file in the report. Update the tests to role/text (`getByRole('list', {name})`, `within(listitem)`). Confirm the changed assertions fail.
- [ ] **Step 2:** Migrate per the guide, and delete the replaced row components. Then run `grep -rnE "divide-y|last:border-b-0|<Separator" packages/channel-web/src/components/{admin,settings,routines,credentials}`. It must list only real tables or non-row uses, each named in the report.
- [ ] **Step 3:** Gate as in Task 4.
- [ ] **Step 4:** Commit `refactor(channel-web): admin, settings, routines and credentials rows use List (one divider method)`.

### Task 11: Rows — workspace

**Model:** standard.

**Files (`workspace/`):**
- `DecisionRow` (header row + resolved receipt; one decision renders through the same pattern in Today and chat, rule 8: confirm with `GrantRow`/`ApprovalCard` and note what differs)
- `TasksPage` (`TaskItem` → `ListRow href`), `TodayTaskGroup`, `TodayView` (working-agent rows)
- `TaskPage` (`AboutRow` → `expandable`)
- `AgentApps`/`AgentAppsRows` (`LinkRow`, `ApprovalRow`), `ConnectorDetails` (`ToolRow` B), `AgentConnectors` (keep the script's pins)
- `AgentSettings` (icon rows), `AgentSelfChanges`, `AgentArtifacts` (`ArtifactRow` via FileTile `row`), `AddConnector` (`AvailableRow`), `GrantRow`, `MemoryUsedChip` (statement list), `LearnedInChat`, `SidebarChats`, `AgentSlackBotChannels`, `ConnectorsTab`
- their tests

Steps 1–4 are as in Task 10, with these differences:
- The grep scope is `components/workspace`.
- Run `node --check` on any touched `scripts/check-*.mjs`.
- Commit message: `refactor(channel-web): workspace rows use List (one divider method)`.

### Task 12: Lock it

**Model:** standard.

**Files:**
- Modify: `eslint.config.mjs` (channel-web block), root `package.json` (only if a rule is new to `lint:ui:suppress`), `eslint-suppressions.json`
- Create: `packages/channel-web/src/__tests__/rows-status-convention.test.ts`
- Delete: shadcn `components/ui/{badge,card}.tsx` if no importer remains
- Modify: the roadmap's S4 row and the S3 follow-ups doc (tick what S4 closed)

- [ ] **Step 1: Widen lint.** This is the ratchet's widening path; frozen totals may rise.
  - `ax-ui/no-internal-imports` `uiModules`: add `'badge'` and `'card'`, plus `'avatar'` if a shadcn avatar module exists.
  - `ax-ui/no-raw-elements` `elements`: add `'ul'`, `'ol'`, `'li'`, `'dl'`, `'dt'`, `'dd'`, `'time'`.
  - Run `pnpm lint:ui:suppress`, then `pnpm lint:ui:prune` (separate commands).
  - `node scripts/ui-suppressions-ratchet.mjs origin/main` must print the "widened" lines and `ok`.
  - Report the frozen totals per rule, before and after. Remaining `li`/`ul` sites are expected in chat (S7) and markdown.
- [ ] **Step 2: The convention test.** It is a source scan like `state-language-convention.test.ts`. Prove it bites with scratch files, then delete them. It fails on any of these in `packages/channel-web/src` (excluding `components/ui/` and `__tests__`):
  - `rounded-full bg-warning` (a hand-rolled waiting dot);
  - `toLocaleString(`, `toLocaleDateString(` or `toLocaleTimeString(` outside the documented keepers allow-list;
  - `divide-y`, or `last:border-b-0` on a row (allow-list the real tables).
- [ ] **Step 3: Full gate.**
  - `pnpm build`.
  - `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts` (Docker note in Global Constraints).
  - `pnpm lint`.
  - Ratchet against `origin/main`.
  - `pnpm --filter @project-ax/ui typecheck`.
  - channel-web `tsc`.
- [ ] **Step 4:** Commit `feat(lint): rows and status locked — badge/card modules and list/time elements banned in pages; convention test`.

**End of S4b.**
