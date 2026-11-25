# Agent-first UI: `@project-ax/ui` and `@canopy/ui` — design

2026-11-24 · Vinay Pulim (decisions) · Claude (write-up)

Source spec: *Agent-First Design System: Implementation Spec* (Nov 24, 2026). This document adapts that spec to
our two real consumers, records the decisions made while doing so, and scopes the work. Where this document and
the source spec disagree, this document wins.

**Scope of build right now:** workstreams **1** (`@project-ax/ui` foundation) and **2** (channel-web
consolidation). Workstreams 3–5 are designed here so 1 and 2 don't paint us into a corner, but they are not
being built yet.

---

## 1. Intent

Coding agents write most of our UI now, and they are bad at design in a very specific way: every screen
re-decides spacing, type size, where Save goes, what "loading" looks like. channel-web proves it — the same intent
("a list row", "an error", "waiting on you") has 3–6 hand-rolled versions (see §6.1).

So we take the design decisions once, put them in a package, and expose only safe choices. Good UI becomes the
path of least resistance; bad UI fails to compile or fails lint.

Two consumers, one system:

- **ax-next** (public, MIT) uses **`@project-ax/ui`** for its own web app.
- **canopy-apps** (internal) — small internal web apps that AX agents and Claude agents build and deploy —
  use **`@canopy/ui`**, which derives from `@project-ax/ui`.

Every agent that builds UI in either place loads a skill that ships with the package, so guidance and code
version together.

## 2. Decisions

| # | Decision | Chosen |
|---|---|---|
| D1 | Package split | `@project-ax/ui` (public, in ax-next) is the base. `@canopy/ui` (private, Canopy GitLab) depends on it. |
| D2 | What `@project-ax/ui` contains | Generic building blocks for internal tools (shell, sidebar, header, footer, table, card, forms, dialogs…) plus page archetypes. **No Canopy Protect domain** (no Severity / duress / Freshness). |
| D3 | Canopy's look | Defaults to `@project-ax/ui`'s look. `@canopy/ui` keeps a theme seam for later restyling. |
| D4 | How canopy-apps render React | **Server-rendered React** (Express + `renderToString`), plus an esbuild client bundle for interactive parts. |
| D5 | Growing composites from apps | **Harvest and promote through a `labs` tier** (§9). |
| D6 | Where `@canopy/ui` is published | **Private Artifact Registry npm repo**; each app's build service account gets read. Source of truth stays in GitLab. |
| D7 | How far channel-web moves | **Full rewrite** onto `@project-ax/ui` — and the rewrite's goal is **consolidation**: collapse duplicate components into a minimal set and unify UX patterns and information hierarchy (§6). |
| D8 | Visual self-review for app agents | **Yes** — a `render` tool on the deploy connector (§8). |
| D9 | Build order | 1 → 2 now; 3, 4, 5 later. |
| D10 | Tailwind in apps | **Only inside composites**, through a token-only preset. Pages use components only. `CustomSection` (with `reason`) wraps exactly one composite, so the harvester gets named, typed components. |

Dropped from the source spec: the Canopy Protect source screens and archetypes (`ResourceListPage` from asset
list, `DashboardPage` from alerts), the Protect domain patterns, Mantine as a fallback (shadcn/Radix is already in
production here), and the `ResourceListPage`/`DetailPage` names (renamed to fit our screens, §5.4).

## 3. Goals, non-goals, anti-goals

**Goals**

- One minimal component set that every ax-next screen and every canopy-app is built from.
- Spacing, color, type, radius, elevation, motion and status come only from tokens and enums.
- Loading, error and empty states are required by component contracts.
- Labels on inputs and icon buttons are required props.
- One page-level information hierarchy (§6.3): one title, one primary action, one place for back, Save,
  destructive confirms and status.
- Violations are caught by types, lint and CI — not by a reviewer.

**Non-goals**

- Marketing / expressive UI. Replacing shadcn or Radix (we wrap them).
- A Storybook-grade public docs site.
- Upgrading Tailwind 3 → 4 (separate task; §5.2).
- Changing what any screen *does*. Workstream 2 changes how screens are built and how they present the same
  functions; routes, permissions, conversation behavior and copy stay unless §6.3 names a change.

**Anti-goals** (failure even if it technically works)

- A component set that's a 1:1 port of today's 180 components. That's a move, not a consolidation.
- Components so generic they're useless (`<Box>` with 30 props). Variation is small enums, never style props.
- Agents patching `packages/ui` to make one page work.
- A "temporary" escape hatch that becomes the main road. In channel-web specifically, `src/composites/` is for
  AX-only pieces; a generic duplicate parked there to dodge consolidation is a failed migration, not a composite.

## 4. Architecture

```text
ax-next (GitHub, public)                         Canopy GitLab (private)
  packages/ui  ──────────►  @project-ax/ui  ◄────  @canopy/ui
    foundation/   tokens → CSS vars + compiled CSS      re-exports the public API
    layout/       Stack, Inline, Grid, Divider          + theme.css (token values; = ax default today)
    components/   semantic components                   + labs/ (harvested composites, §9)
    patterns/     ListRow, PageHeader, ConfirmAction…   + skill/canopy-ui (extends ax-ui)
    archetypes/   ListPage, DetailPage, …               published to Artifact Registry (private)
    internal/     shadcn source + Radix (never exported)
    index.ts      the only public entry
  packages/ui/eslint-plugin → @project-ax/eslint-plugin-ui
  packages/ui/skill/ax-ui
  packages/channel-web  — imports only @project-ax/ui
```

**Layers** (app code imports from the top four; `internal/` never):

1. Archetypes — whole-page shapes.
2. Patterns — composed UX units (`ListRow`, `PageHeader`, `ConfirmAction`, `AsyncState`…).
3. Semantic components — `Button`, `TextField`, `StatusBadge`, `Text`…
4. Layout primitives — `Stack`, `Inline`, `Grid`, `Divider`.
5. Foundation — tokens.

**Theme contract.** Every visual value is a CSS custom property named by a token (§5.1). `@project-ax/ui` ships
`theme.css` (the ax default, light + dark) and `ui.css` (component styles that read only the variables). A
derived package changes look by shipping its own `theme.css` — same names, different values. Nothing else is
themeable. That's deliberate: if Canopy later needs a different *shape* (not just values), we add a named theme
slot to the base package on purpose, not a `className` escape.

**Tailwind in two places, nowhere else.** The package is authored in Tailwind and publishes **precompiled
CSS** (`ui.css`) for everything it exports. Apps may also use Tailwind, but **only inside their composites
folder** (§5.4 "Escape hatch"), and only through the package's **restricted preset**
(`@project-ax/ui/tailwind-preset`): token scales only (`gap-md`, `text-meta`, `bg-surface`), no default scales, no
arbitrary values. An app's Tailwind build scans only `src/composites/**` and emits a small `composites.css`.
Pages and screens have no `className` at all. *(Decided 2026-11-24: Tailwind where agents need freedom, components
where we need uniformity.)*

**SSR- and CSP-safe from day one** (needed by workstream 3, constrains workstream 1):

- No `window`/`document` access at import time; every component renders under `renderToString`.
- Our own components never emit inline `style=""` (canopy-apps CSP is `default-src 'self'`, which blocks inline
  style attributes in served HTML). Where Radix sets inline styles during SSR (e.g. popper positioning), CI
  renders those components server-side and checks the output; the fix belongs in the package.
- No CDN assets; fonts and icons ship in the package.

## 5. Workstream 1 — `@project-ax/ui` foundation

### 5.1 Tokens

Defined once in `foundation/tokens.ts` as `as const` objects; union types exported; CSS variables and the
internal Tailwind preset generated from the same source. Tailwind's default scales are removed inside the
package so an off-scale value fails the package build.

Starting values are **today's channel-web values** (DESIGN.md / `index.css`) — we are consolidating a look, not
inventing one. Names follow the source spec; the mapping from today's tokens:

| Group | Names | From today |
|---|---|---|
| Surface | `canvas`, `surface`, `surface-raised`, `overlay` | `--canvas`; `--background`=`--panel`=`--sidebar` → `surface`; `--card` → `surface-raised`; `--popover` → `overlay` |
| Content | `default`, `muted`, `subtle`, `inverse`, `link` | `--foreground`, `--muted-foreground`, `--state-quiet`, `--action-foreground`, `--primary` |
| Accent | `accent`, `accent-soft` | `--primary`, `--primary-soft` (=`--accent`=`--bubble`, three names for one value today) |
| Action | `action`, `action-hover` | `--action*` (monochrome primary button) |
| Status | `neutral`, `info`, `success`, `warning`, `danger` | `--destructive*`, `--warning*`; `info`/`success` added and contrast-tested |
| Space | `none`, `xs`, `sm`, `md`, `lg`, `xl`, `section` | 4px base; `section` = today's 16px panel gap / 18px inset resolved to one value (builder picks, shows it in the foundation PR) |
| Text roles | `display`, `title`, `heading`, `subheading`, `body`, `body-strong`, `meta`, `caption`, `code` | Collapses today's **15 font sizes** (10.5–30px). `meta` = the muted secondary line, today in six sizes (11.5/12/12.5/13/`xs`/`sm`). `display` = welcome 30px; `body` = 15px. |
| Radius | `none`, `sm`, `md`, `lg`, `full` | `sm`/`md` = control 9px family; `lg` = panel 16px; composer well 22px becomes internal to the Composer pattern |
| Elevation | `flat`, `raised`, `overlay` | `--shadow-key`, `--shadow-panel`, `--shadow-popover` (unused by primitives today; fixed) |
| Motion | `instant`, `fast`, `base` | honors `prefers-reduced-motion` |
| Width | `narrow`, `form`, `content`, `wide` | Collapses today's 10+ ad hoc `max-w-[…]` (420–900px) and 7 dialog widths |

Redundant tokens are merged (`brand`/`sans` font both Inter; `send` folds into `accent` with its own foreground
for dark mode). Dark theme is written once (today it's duplicated for the media query and `[data-theme]`).
A contrast test checks every content token on every surface (WCAG AA), plus status tones on their soft fills.

### 5.2 Package mechanics

- Location `packages/ui`, name `@project-ax/ui`, published to public npm with the repo's existing changesets
  flow. The `@project-ax` npm scope must be registered first (action item).
- Tailwind stays on **3.4** for now. `field.tsx` already contains v4-only syntax (`has-data-[state=checked]`)
  that is dead under 3.4 — fix it on the way in.
- React 19, Radix (versions already in channel-web), lucide icons, Inter + IBM Plex Mono self-hosted in the package.
- Stories: **Storybook**, one story per state of every public export; axe on every story (serious/critical
  block); Playwright screenshot tests of every story (block on `packages/ui` changes). New dev dependencies go
  through the `security-checklist` supply-chain walk and are pinned.
- Type tests (`expect-type`) prove forbidden props (`className`, `style`, raw colors, `as`) fail to compile.

### 5.3 Component API rules

From the source spec, unchanged: no styling props; small enums (`intent`, `size`, `density`, ≤4 members);
required a11y props (`IconButton.label`, every input's `label`, `hideLabel` to hide visually); required state
contracts on anything rendering remote data; compound components over prop explosion; destructive actions only
through `ConfirmAction`; status as enums, never colors; one `primaryAction` per page.

Added from the inventory:

- **Busy is a prop, not a pattern.** `Button busy` always shows spinner + label; label-swapping ("Saving…") goes away.
- **One retry vocabulary.** Error states' retry button is always "Try again" (today: Try again / Retry / Reload /
  Refresh / Retry change).
- **Cards don't nest.** `Card` children can't include `Card`, `List`, or another bordered pattern (type-level where
  possible, lint otherwise). Quoted/preview content uses `InsetBlock`, one level only.

### 5.4 The minimal set

Derived from the inventory (§6.1). The count matters: **~45 public exports (including chat and media) replace ~180 app
components and 30 primitives.** Anything not on this list needs a design-system task to add it.

**Layout primitives (4):** `Stack`, `Inline`, `Grid`, `Divider`.

**Semantic components (13)**

| Component | Notes |
|---|---|
| `Button` | `intent: primary \| secondary \| quiet`, `size: sm \| md`, `busy`. Drops today's `navigation`, `settings-nav`, `settings-row`, `send` variants (those were layout jobs). No `danger`. |
| `IconButton` | `label` required; tooltip built in (merges `IconTooltip` and `Tip`). |
| `Text`, `Heading` | `role` from the text-role tokens. `Heading` level is derived from context (`PageHeader` = h1, `Section` = h2…), not chosen per call site. |
| `TextField`, `TextArea`, `Select`, `Combobox`, `Checkbox`, `Switch`, `RadioGroup` | Field wrapper built in: label, description, error. Replaces bare `Label`+`Input`, hand-rolled `FieldHint`, ad hoc error text. |
| `StatusBadge` | `tone: neutral \| info \| success \| warning \| danger`, optional `dot`, `size`. One emphasis ladder: success is never louder than warning. Replaces SourceBadge, TaskStatusPill, StatusChip, StatusDot, StateDot pills, dead AgentStateLabel. |
| `StatusMark` | The bare dot/diamond. `waiting` is always the diamond (today: diamond, circle, pill). |
| `Avatar` | token sizes, replaces AvatarTile's pixel prop. |
| `Timestamp` | One formatter, relative recent / absolute on hover. Replaces 7 helpers (`ago`, `timeAgo`, `RowTime`, `shortDay`, `checkInWhen`, `updateStamp`, `Elapsed`). |
| `Tabs`, `Menu`, `Tooltip` | One selected style each (today tabs come in three). |

**Patterns (16)**

| Pattern | Replaces (examples) |
|---|---|
| `AppShell` + `Sidebar`, `NavSection`, `NavItem`, `Header`, `Footer` | Workspace frame and AdminShell; four "active row" styles (SidebarRow, Button `navigation`/`settings-nav`, SidebarChats `ROW`, RailRow) → one. |
| `PageHeader` | `title`, `description?`, `back?`, `status?`, `primaryAction?`, `help?`. Replaces WorkspaceHeader, AdminPaneHeader, SettingsActions portal, Tasks/Task/Agent/Settings headers, three back-nav styles. |
| `Section` | `title`, `description?`, `action?`, `collapsible?`, `scope?` (§6.3 rule 9). Replaces hand-rolled h2 blocks, settings CardHeaders, SettingsDisclosure, SectionLabel/SectionHeader variants. |
| `List` + `ListRow` | `leading`, `title`, `meta`, `trailing`, `description`, `onOpen`, `menu`, `expandable`, `density`. List owns dividers. Replaces ~20 row implementations (DecisionRow header, TaskItem, LinkRow, ApprovalRow, ToolRow, SettingsRow, SettingsDetailRow, SkillRow, Sites rows, AuthProviders li, AgentToggleRow, RoleCard, AwaitingReview…) and three divider methods. |
| `KeyValueList` | StorageTab/SlackTab `dl`s, DetailItem. |
| `DataTable` | `columns`, `rows`, `loading`, `error`, `empty` required. FireRowsTable, UsagePrices, DefaultRoutines, SlackBots tables. |
| `Timeline` + `TimelineEntry` | UpdateEntry, RunRow, ReplyEntry (near byte-identical today). |
| `AsyncState` | `status`, `skeleton: rows \| lines \| block`, `empty`, `error {onRetry}`. Replaces PaneStatus, ReadFailure, ReadError×2, LoadingRows/Loading×2, Note×2, SectionNote, three identical LoadFailures, ~15 loose "Loading…" `<p>`s. |
| `EmptyState` | one look (today four), can reuse the page's primary action. |
| `Notice` | `tone: info \| warning \| danger \| success`, `title?`, `action?`, `onDismiss?`. Replaces Alert-with-overrides (90 uses, no warning tone today), tinted Card banners, RunWarning, RequestLeftOutNotice, SigningSecretHelp. |
| `Toast` | built on Notice tokens. |
| `ConfirmAction` | Generalized from SlackTab's DisconnectDialog (the only complete one): async `onConfirm`, busy, in-dialog error, dismiss locked while busy. Replaces ~22 hand-rolled confirm dialogs. |
| `FormDialog` | `size: sm \| md \| lg`. Replaces 7 ad hoc dialog widths and the Sheet-vs-Dialog split for key entry. |
| `Form` + `FormActions` | One Save model (§6.3 rule 6). Replaces 7 Save placements. |
| `Card`, `InsetBlock` | One card look (today ~8 overrides + a `settings` variant). |
| `FileTile` | `variant: card \| row \| chip`. ArtifactCard, ArtifactRow, GeneratedFileChip, AttachmentChip×2, WorkspaceAttachmentChip, MemoryUsedChip. |

**Generic chat and media patterns** also live in the package: `Thread` (scroll + message layout), `Message`
(bubble/turn anatomy), `Composer` (the well, attachments, Send/Stop), `Markdown` (today's
`components/Markdown.tsx` renderer and its sanitization), plus `Frame` (sandboxed iframe with auto-height; takes
an already-prepared `srcdoc`), `Chart` (chart.js with token colors), `Image` (token-sized, for operator logos and
art) and `Progress`. They are **not** built on assistant-ui — the team rejected it (2026-09-12, TASK-405); they
wrap channel-web's own frame parser and renderer. *(My call: these are generic, and canopy-apps that want chat,
charts or embedded frames should get them for free rather than each writing a composite.)*

**AX-specific composites stay in channel-web**, in `packages/channel-web/src/composites/` — `ApprovalCard`,
`GrantRow`, decision blocks, `ArtifactCard`, `MemoryUsedChip`, the visual-frame wiring. Same folder, same rules
as any app's composites (below), and the first candidates for promotion if something turns out to be generic.
The frame-guard transform stays server-side in `@ax/frame-guard`; the package's `Frame` only renders the
sandboxed result.

**Escape hatch: `CustomSection` + composites** (changes the source spec, which banned Tailwind inside
`CustomSection`):

```tsx
// a page: no className, ever
<CustomSection reason="No pattern for a week-by-staff coverage grid">
  <CoverageGrid weeks={weeks} staff={staff} />
</CustomSection>

// src/composites/CoverageGrid.tsx: restricted Tailwind allowed here
export const CoverageGrid = defineComposite({
  name: 'CoverageGrid',
  purpose: 'Week × staff shift coverage',
  render: ({ weeks, staff }: CoverageGridProps) => (
    <Grid columns={{ base: 1, md: 7 }} gap="sm">…</Grid>
  ),
})
```

- **`CustomSection`** is the only escape hatch. `reason` (one sentence) is required. Its child must be exactly
  one element whose component is a composite imported from `src/composites/` — no inline markup.
- **Composites** (`src/composites/*.tsx`) are defined with `defineComposite({ name, purpose, render })`, take typed
  props, and may use layout primitives, every public export, raw elements, and the restricted Tailwind preset.
  Still banned there: `style`, arbitrary values, non-token colors, `@radix-ui/*` and package internals.
- A composite may be used without `CustomSection` from another composite or from a page when it's an
  established piece of the app (e.g. channel-web's `ApprovalCard`); `CustomSection` marks the places where a
  *page* needed something the system doesn't cover. Both are reported on the PR.
- Why a separate component rather than Tailwind inline in the page: inline JSX is tangled with the page's state
  and handlers, so it can't be lifted cleanly. A composite has a name, a purpose and typed props — exactly what
  the harvester (§9) needs, and the `reason`s pointing at it say why the system fell short.

**Archetypes (5)** — extracted from the page shapes the inventory found recurring:

| Archetype | Used by today |
|---|---|
| `ListPage` | Tasks, Agents (admin), Connectors, Auth providers, Teams, Allowed sites, Routines, Skills |
| `DetailPage` | Task, Connector details, Agent settings, Task check-in |
| `SettingsPage` | Models, Branding, Storage, Usage, Slack, Helper model (sections of forms/values) |
| `FocusPage` | Login, setup wizard (`step`), onboarding, Apps approve, Boot, error pages (today five framings: 360/448/460px, canvas vs background, brand vs none) |
| `WorkspacePage` | Agent conversation + rail, Today |

Plus `BasePage` (shell + title + one primary action) for pages no archetype fits, filled with `Section`s and
`CustomSection`s. Catalog/browse (Skills store, Connector directory) is a second-pass candidate: build
it as `ListPage` first and promote only if it doesn't fit.

### 5.5 Enforcement in ax-next

| Rule | Mechanism | Blocks |
|---|---|---|
| Tokens only | union types; restricted Tailwind preset (no default scales) for the package and for composites | yes |
| No `className`/raw elements in pages | `@project-ax/eslint-plugin-ui`; message names the component to use | yes |
| No `style`/arbitrary values anywhere in app code (composites included) | same plugin + preset | yes |
| `CustomSection` has a `reason` and exactly one composite child | same plugin | yes |
| Composites use `defineComposite` and live in `src/composites/` | same plugin | yes |
| Public API only | `ax-ui/no-internal-imports` for `@radix-ui/*`, `@/components/ui`, `@project-ax/ui/internal` | yes |
| Required labels / state contracts / one primary action | TypeScript | yes |
| a11y | axe on every story and on the channel-web Playwright pages | yes (serious, critical) |
| Visual regressions | Playwright screenshots of every story | yes, for `packages/ui` |
| New `CustomSection`s and composites | lint report posted on the PR (name, purpose, reason) | no (human review) |

**Agent hooks** (`.claude/settings.json`): PreToolUse blocks writes to `packages/ui/**` unless the worktree has a `.ax-ds-task` marker file;
PostToolUse runs the UI eslint rules on an edited `*.tsx`; Stop runs `tsc --noEmit` + lint on touched packages.
Board cards that are design-system work carry a `(ds)` tag in the title, and `yolo-ship` creates the `.ax-ds-task`
marker in the worktree for them. Workstreams 1 and 2 are mostly `(ds)` work.

**CODEOWNERS:** `packages/ui/**` and `packages/ui/skill/**` → the design owner (open item O1).

**Repo docs that change:** CLAUDE.md invariant #6 points at `@project-ax/ui` instead of channel-web's shadcn
install, and gains the one-line "UI work uses the `ax-ui` skill". The `shadcn` project skill re-targets
`packages/ui` (`-c packages/ui`) and is scoped to design-system tasks. DESIGN.md moves to `packages/ui`.

### 5.6 The `ax-ui` skill

Per the source spec's "Feature-agent skill", renamed: `packages/ui/skill/ax-ui/` (SKILL.md, generated
`references/archetypes.md`, `patterns.md`, `tokens.md`; `scripts/render.ts`, `scripts/check.sh`), symlinked into
`.claude/skills/ax-ui/`. `scripts/build-skill.ts` generates the references from types and stories; CI fails on
drift. SKILL.md states it overrides general design skills (including `impeccable` and `frontend-design`) for app
UI work. The `ux-design` advisory skill stays and should reference the §6.3 rules.

## 6. Workstream 2 — channel-web consolidation

**Goal:** collapse channel-web's duplicate components into the minimal set in §5.4, and along the way unify UX
patterns and information hierarchy. This is a rewrite *with a point of view*, not a port: when two screens do the
same thing differently, they end up doing it the same way.

### 6.1 Baseline (inventory, 2026-11-24)

Three read-only sweeps over `packages/channel-web/src` (excluding tests). Headline numbers:

- 212 `.tsx` files; `className` in 202 of them; 608 raw `<div>`; 554 arbitrary `[Npx]` values in 104 files.
- **15 distinct font sizes**; `text-[13px]` ×122, `text-[12px]` ×72, `text-[12.5px]` ×62, `text-[11.5px]` ×56.
  ~350 arbitrary font sizes vs 51 tokenized ones.
- Most repeated class strings: `text-sm text-muted-foreground` ×87, `text-xs text-muted-foreground` ×60,
  `flex flex-col gap-2` ×52, `flex flex-col gap-3/4` ×68, `flex justify-end gap-2` ×18.
- ~20 list-row implementations, 4 navigation "active" styles, ~22 hand-rolled confirm dialogs (a reusable one
  exists but is private), 5 loading languages, 4 error surfaces, 7 Save placements, 7 time formatters,
  ~8 `Card` overrides, 5 centered-page framings, 7 dialog widths.
- Dead code: `ProviderRow`, `KeyForm`, `StatusDot` (only used by ProviderRow), `AgentStateLabel` (0 callers),
  `AdminPaneHeader`'s `eyebrow`/`badge`, `AdminNavItem`'s `icon`.
- Test coupling: 399 test files; 84 use `querySelector`/`toHaveClass` (200 + 92 occurrences) and must move to
  role/label queries as their screens migrate.

This baseline is also the "phase 0" measurement from the source spec for ax-next: the counts above, plus an axe
run and a screenshot set of every surface (light/dark, 1440/390) captured before the first migration PR and kept
in `packages/ui/eval/results/2026-11-baseline/`.

### 6.2 What a user notices today (top inconsistencies)

1. Page titles run 15–24px; Today renders two `h1`s; AgentForm's `h2` is larger than its page's `h1`.
2. The primary action moves: page header on most pages, page body on Routines, Sites, Default routines; Today
   shows several default-variant buttons at once (every open grant).
3. Editing an object works four ways: whole-page swap (Agents), dialog (Routines, Connectors, Skills), a Sheet
   that holds only two buttons (Auth, Agents), inline expand (Routines list).
4. The same decision looks different in the Today queue and in chat (dot vs pill, red Alert vs red text, button
   heights).
5. "Waiting on you" is a diamond, a circle, or a pill; "Saved" gets the loudest badge; the `secondary` badge is
   white on a white card (invisible).
6. Routines' three tabs use three looks (flat rows, shadowed cards, shadowed table).
7. Destructive actions are inconsistent: some confirm with busy + in-dialog error, some show errors behind the
   dialog, Revoke and site Remove don't confirm at all.
8. Admin-only content is marked as a tab, a section, or not at all.

### 6.3 Unified rules (the hierarchy every migrated screen follows)

These are encoded in archetype/pattern APIs wherever possible; the rest go in the `ax-ui` skill and the
`ux-design` skill.

1. **One title.** Exactly one `h1` per page, rendered by `PageHeader`. Heading levels below it come from
   `Section` nesting, never chosen at the call site.
2. **One primary action, always in `PageHeader`.** Section-level actions sit at the right of the `Section`
   header and are `secondary` or `quiet`. Row actions go in the row's `menu` (or one `quiet` trailing button).
   Today's "every grant has a primary button" becomes one primary per page.
3. **One back.** `PageHeader back` ("‹ Parent"). No breadcrumbs-plus-back, no "Back to chat" buttons.
4. **One way to edit an object.** Small objects (≤ ~6 fields, no sub-lists): `FormDialog`. Anything larger:
   `DetailPage` (its own route, so it links and survives reload). No sheets that only hold buttons; no
   whole-page view swaps without a route. Inline expand is for *reading* more, not editing.
5. **Destructive = `ConfirmAction`, always.** Revoke and site Remove gain a confirm. Cancel label is "Cancel";
   the confirm label is the verb ("Remove site", "Revoke").
6. **One Save model.** Forms in dialogs: `FormActions` in the dialog footer, Cancel (quiet) then Save (primary),
   right-aligned. Settings pages: Save appears only when dirty, in a sticky bar with "Unsaved changes",
   Discard, Save (today's ModelsTab pattern, the most complete one). Busy = `Button busy`; success = a `Toast`,
   not a "✓ Saved" text node.
7. **One state language.** Loading = a skeleton shaped like the content (`rows`/`lines`/`block`); spinners only
   inside buttons and for whole-page boot. Error = `AsyncState` error (danger `Notice` + "Try again"). Empty =
   `EmptyState`, reusing the page's primary action when there is one.
8. **One status vocabulary.** `StatusBadge` tones with a fixed emphasis ladder (danger > warning > info >
   neutral ≥ success). Waiting-on-you is the warning diamond everywhere (sidebar, switcher, queue, chat).
   The same decision renders through the same pattern in Today and in chat.
9. **Admin scope is marked one way.** A `Section`/`PageHeader` `scope="workspace"` renders one consistent
   marker ("Workspace setting — applies to everyone"). Admin-only content is never a bare tab.
10. **No nested cards.** Lists sit directly on the surface; `InsetBlock` for quoted/preview content, one level.
11. **One time format.** `Timestamp` everywhere.

**Sign-off (decided):** approving this document approves these 11 rules. Where a rule changes behavior a user
can see (2, 3, 4, 5, 9), the migrating PR attaches before/after screenshots as a record, and the surface gets a
walk (§6.5). A behavior change that goes *beyond* these rules goes to Needs Input instead of merging.

### 6.4 How the work is sliced

**No half-wired components.** Every `@project-ax/ui` component lands in the same PR as its first channel-web
callers (CLAUDE.md "Half-Wired Code Policy"). So workstreams 1 and 2 interleave; there is no "build the whole
library first" phase. The only exception is the foundation slice, whose consumer is channel-web's theme.

Order (each step = one or a few PRs; each is a `(ds)` card). The numbering is the logical order; the roadmap
(`docs/superpowers/plans/2026-11-24-project-ax-ui-roadmap.md`) splits these into cards, and its dependency
column, not this numbering, decides what runs in parallel:

1. **Foundation:** scaffold `packages/ui`, tokens → `theme.css`/`ui.css`, contrast test, Storybook + axe +
   screenshot CI, lint plugin (rules are errors, existing violations frozen — see below), import boundary,
   hooks, CODEOWNERS. channel-web
   imports `theme.css` instead of its `index.css` token block — first real consumer, no visual change.
2. **Text + layout:** `Text`, `Heading`, `Stack`, `Inline`, `Grid`, `Divider`. Migrate the 15 most-repeated
   class strings across the app (mechanical, big count reduction).
3. **States + feedback:** `AsyncState`, `EmptyState`, `Notice`, `Toast`, `Button busy`, `ConfirmAction`.
   Migrate every loading/error/empty/confirm site (rules 5, 7).
4. **Rows + status:** `List`, `ListRow`, `KeyValueList`, `StatusBadge`, `StatusMark`, `Timestamp`, `Avatar`,
   `FileTile`, `Timeline`. Migrate all row implementations (rules 8, 10, 11).
5. **Shell + headers:** `AppShell`, `Sidebar`, `NavItem`, `PageHeader`, `Section`, archetypes. Migrate every
   page frame (rules 1, 2, 3, 9). Delete dead code.
6. **Forms + editing:** field components, `Form`, `FormActions`, `FormDialog`, `DataTable`. Migrate every editor
   and table (rules 4, 6).
7. **Chat + media:** `Thread`, `Message`, `Composer`, `Markdown`, `Frame`, `Chart`, `Image`; move AX chat
   composites into `src/composites/`. `Frame` and `Markdown` render untrusted content — `security-checklist`.
8. **Finish:** delete `src/components/ui/`; channel-web's Tailwind config shrinks to the restricted preset
   scanning only `src/composites/**`; lint rules flip to *error*;
   CLAUDE.md, shadcn skill, DESIGN.md updated; `ax-ui` skill + `build-skill.ts` + drift check land.
   Exit = zero violations in channel-web, every story axe-clean, every surface walked.

**Other UI work during the rewrite (decided): no freeze; new code complies now.** From step 1, the UI lint rules
are *errors* in channel-web. Existing violations are frozen in `eslint-suppressions.json` (ESLint bulk
suppressions), and the CI ratchet (`scripts/ui-suppressions-ratchet.mjs`) only lets them go down; a rule's frozen
total may rise only in the PR that switches the rule on. Feature cards that touch an
unmigrated file may leave its existing violations alone but must not add new ones. Rules switch on as their
replacements ship (S1: arbitrary values and style; S2a: className on intrinsic elements only, and raw
`div`/`span`/`p`/`h2`–`h6`; S3–S6: internal shadcn imports per area, and each area widens the raw-element list and
extends the className ban to the components it replaces; S8 ends with the full lists) — there is nothing to
comply with before then (rulings 2026-11-24, R12).

Steps 3–7 can split by surface (admin/settings/routines vs workspace/today/tasks) to run in parallel through
auto-ship; the component lands with whichever surface PR gets there first, and the other rebases onto it.

### 6.5 Acceptance

- Every PR: build + test + lint, `tsc` alongside vitest, story axe/screenshot checks for new components, and
  tests that touched screens rewritten to role/label queries.
- Every PR that changes a visible behavior under §6.3: before/after screenshots in the PR body.
- After steps 5, 6 and 7: a `(walk)` card that drives the migrated surfaces on kind with Playwright
  (`k8s-acceptance-loop`), light + dark, 1440 + 390, including approval, streaming, error and focus-restore flows
  (DESIGN.md's "preserve behavior" list).
- Final: re-run the §6.1 counts and the baseline axe/screenshot set; record results next to the baseline.

## 7. Workstream 3 — `@canopy/ui` and canopy-apps *(designed, not built now)*

- **Package:** GitLab repo; depends on `@project-ax/ui` (pinned, exact); re-exports the public API; ships
  `theme.css` (identical to ax's today), `labs/`, and `skill/canopy-ui` (extends `ax-ui` with canopy-apps
  rules: IAP viewer, `escapeHtml` no longer needed in TSX paths, CSP, deploy loop). CI publishes to a private
  Artifact Registry npm repo.
- **Install without secrets:** `create_app` grants the app's build service account `artifactregistry.reader` on
  that repo; the template seeds a scoped `.npmrc` (`@canopy:registry=…`) and the build uses the service
  account token it already holds. No new secret in the build or the app.
- **Template:** `express-starter` gains server-rendered React: routes return `renderToString(<Page/>)` inside the
  existing `page()` shell; `gcp-build` runs `tsc`, `@project-ax/eslint-plugin-ui`, the Tailwind CLI with the
  restricted preset over `src/composites/**`, and an esbuild bundle of the client islands (dialogs, menus). JS,
  the package's `ui.css`/`theme.css` and the app's `composites.css` are served from `/static/` under the existing
  CSP.
- **Enforcement moves into the build:** app agents work through the deploy connector (`read_files`, `deploy`,
  `get_logs`), not a local checkout, so Claude Code hooks don't apply. A lint or type error fails the deploy as
  `build_failed`; the agent reads the errors with `get_logs`.
- **Skill delivery:** the deploy connector serves the `canopy-ui` skill (MCP resource or `get_guide` tool) from
  the `@canopy/ui` version the app pins. CANOPY.md points at it.
- **Eval:** the source spec's before/after eval, with an internal-tools prompt set (expense approver, deal
  dashboard, booking sheet, team directory, request queue, settings page, report with date range, admin list
  with bulk actions). Results in the `@canopy/ui` repo under `eval/results/<date>/`.

## 8. Workstream 4 — `render` tool *(designed, not built now)*

The deploy connector gains `render(app, paths[], states?)`: a platform-run headless browser loads the app at
1440/390 × light/dark and returns screenshots plus axe results. It reaches the app as a platform identity through
the normal IAP path (or against a preview revision), never via `run.app`. It can only render the calling agent's
own apps. Axe serious/critical findings become a blocking check in the deploy flow once the eval shows the false
positive rate is low. Needs its own boundary + `security-checklist` review (a browser that can fetch is an SSRF
surface; it must be confined to the app's own origin).

## 9. Workstream 5 — harvester and labs *(designed, not built now)*

- **In apps:** composites live only in `src/composites/`, defined with `defineComposite` (§5.4 "Escape hatch").
  They use only public exports, tokens and the restricted preset, so they're portable by construction: the same
  preset ships with `@canopy/ui`.
- **Harvester:** a scheduled platform job reads only `src/composites/**` plus every `CustomSection reason` across
  app repos, groups composites by name, purpose and structure, and files a design-system card when ≥3 apps share
  a shape. The card quotes the reasons, which say what the system was missing. App code
  is agent-written and untrusted: the harvester never executes it, and nothing it finds is merged automatically.
- **Promotion:** a maintainer agent generalizes the shape into `@canopy/ui/labs` with stories, type tests and
  axe; the design owner approves. Labs exports may change between minors. A labs component that several apps use
  unchanged for a release cycle graduates to the stable API — in `@canopy/ui`, or upstream into
  `@project-ax/ui` if it isn't Canopy-specific (public repo: scrub internal names first).
- **Skill:** agents search stable, then labs, before writing a composite.

## 10. Security notes

- **Supply chain:** Storybook, Playwright, axe, esbuild are new dev dependencies — pinned, reviewed with
  `security-checklist`. The package publishes to public npm: publishing uses changesets from CI only, with npm
  provenance.
- **Untrusted content:** `Markdown`/`Message` render model output — the package owns sanitization once instead
  of per call site; it must not regress today's Markdown guarantees.
- **CSP:** components emit no inline styles or scripts (§4), so canopy-apps keep `default-src 'self'`.
- Workstreams 3–5 each need their own boundary review when built (registry grant, render tool, harvester).

## 11. Open items

- **O1 — Design owner.** Who approves `packages/ui` changes and labs promotions (CODEOWNERS)? Default if
  unanswered: Vinay.
- **O2 — npm scope.** Register `@project-ax` on npm before the first publish. (Workstream 2 doesn't need a
  publish — channel-web uses the workspace link — so this only gates canopy-apps.)
- ~~O3 — Behavior changes in §6.3~~ — decided: approving this doc approves the rules (§6.3).
- ~~O4 — Other UI work during the rewrite~~ — decided: new code complies now (§6.4).

## 12. Left to the builder

Exact token values where today's values conflict (e.g. 16 vs 18px `section` space; pick one and show it),
Storybook version, component internals, PR boundaries inside each §6.4 step, and the test-query rewrites.
