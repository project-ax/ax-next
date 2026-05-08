# Admin Settings — Tailwind + shadcn migration — Design

**Date:** 2026-05-08
**Status:** Approved (brainstorm); pending implementation plan
**Branch:** `feat/admin-settings-redesign` (continuation)
**Source design:** `chat-ui.zip` → `chat-ui/project/Tide Admin Settings.html` (7 scenes; companion files `Tide.html`, `Tide Sessions.html`, `Tide Sessions Tailwind.html`, `Tide Minimal.html`)

---

## 1. Goal

Replace `@ax/channel-web`'s admin surface — currently rendered with ~2,700 lines of bespoke custom CSS — with a Tailwind + shadcn implementation that matches the Tide Admin Settings design pixel-for-pixel and establishes the design-system foundation for a follow-up phase that migrates the chat surface.

The current admin tree (`AdminSettings`, `ProviderKeysTab`, `ModelConfigTab`, `AgentForm`, `McpServerForm`, `TeamList`, plus `SettingsPanel` and the credentials components) ships its functionality cleanly but is visually inconsistent with the Tide direction the rest of the UI is heading toward. Recent commits on `feat/admin-settings-redesign` landed editorial polish on the legacy CSS; this design supersedes that polish with the production direction.

### Out of MVP scope (deferred to phase 2)

- Chat surface migration (`Sidebar`, `Thread`, `Composer`, `MarkdownText`, `ToolUse`, `AgentChip`, `AgentMenu`, `Toast`, `NewSessionButton`, `SearchBar`, `SessionList`, `SessionRow`, `LoginPage`).
- Deletion of the now-partially-unused legacy `index.css` blocks.
- Theme toggle UI (Tide's light/dark switcher is part of the design *page*, not the production product). Dark mode continues to track `data-theme` + system preference.
- Snapshot tests of admin views.
- Backend or API changes — same wire surface throughout.

---

## 2. The five invariants — how this design respects them

This is a frontend-only change inside one package. Most invariants are not exercised, but for completeness:

1. **Hook surface is transport-agnostic and storage-agnostic.** No hooks added or modified.
2. **No cross-plugin imports.** No new package boundaries crossed. `@ax/channel-web` keeps its existing imports.
3. **No half-wired plugins.** Tailwind + shadcn are wired to a real consumer (the admin tree) in the same PR they're introduced. The chat surface staying on legacy CSS is not "half-wired infrastructure" — it's a working alternate consumer that hasn't been migrated yet. A `Half-wired window` declaration in the PR description names the close condition explicitly (see §8).
4. **One source of truth per concept.** Design tokens (HSL CSS variables) live in one place: shadcn's generated `index.css` block. The legacy `index.css` token stanza at the top is replaced; legacy custom CSS below the token block is left untouched until phase 2.
5. **Capabilities explicit and minimized.** No new capabilities requested. Tailwind preflight is enabled globally — see §3.4 for the audit-vs-scope trade-off.

**Boundary review:** N/A. No service hooks, subscriber hooks, or IPC actions added. Phase 2 also adds none — the chat surface is rendered into the same routes the SPA already owns.

**Security note:** No new untrusted-content surface. shadcn primitives are React components compiled into the bundle — no runtime template eval, no use of unsafe HTML-injection escape hatches. The IBM Plex font load adds two requests to `fonts.googleapis.com` / `fonts.gstatic.com`; if the deployment posture forbids that, fonts move to self-hosted (§3.3 fallback). No `security-checklist` is invoked here.

---

## 3. Foundation

### 3.1 Tailwind setup

- Add dev deps in `packages/channel-web/package.json`: `tailwindcss`, `postcss`, `autoprefixer`.
- New `tailwind.config.ts` at the package root.
  - `content`: `['./index.html', './src/**/*.{ts,tsx}']` — Tailwind only generates utilities for files this package owns. No leakage into other packages.
  - `darkMode: ['selector', '[data-theme="dark"]']` — utilities respect the existing `data-theme` mechanism without us having to flip to the `.dark` class.
  - `theme.extend.colors`: HSL token mapping copied verbatim from `Tide Admin Settings.html`.
  - `theme.extend.fontFamily`: `sans` → IBM Plex Sans → fallback stack; `mono` → IBM Plex Mono → fallback stack.
  - `theme.extend.borderRadius`, `boxShadow`, `keyframes`, `animation`: copied from Tide.
- New `postcss.config.js` registering `tailwindcss` + `autoprefixer`.
- `vite.config.ts`: no change. Vite already runs PostCSS.

### 3.2 shadcn setup

- `pnpm dlx shadcn@latest init` inside `packages/channel-web/`. Interactive prompts answered:
  - Style: `default`
  - Base color: `zinc` (overridden anyway by Tide tokens)
  - CSS variables: yes
  - Tailwind config path: `tailwind.config.ts`
  - Components alias: `@/components`
  - Utils alias: `@/lib/utils`
  - React Server Components: no
- `components.json` checked in. `src/lib/utils.ts` (with `cn()`) checked in.
- shadcn writes a token stanza into `src/index.css`. We **replace** Tide's token values into that stanza so shadcn primitives pick up Tide's palette automatically.
- Primitives added now (one `pnpm dlx shadcn@latest add` invocation):
  `button input label select badge alert card dialog separator command tooltip dropdown-menu`.
- Runtime deps the install pulls in: `class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-*` (for Select, Dialog, DropdownMenu, Tooltip, Separator, Label), `cmdk` (for Command). `lucide-react` already present.

### 3.3 Fonts

- IBM Plex Sans (400, 500, 600) + IBM Plex Mono (400, 500) loaded via `<link>` in `packages/channel-web/index.html` `<head>`, with `font-display: swap` honored by Google Fonts' default response.
- Fallback stack on both families: `ui-sans-serif, system-ui, -apple-system, …` (sans); `ui-monospace, SFMono-Regular, …` (mono).
- Body font is **not** changed at the `<body>` level. The admin shell root applies `className="font-sans antialiased"` — chat surface keeps its current font cascade until phase 2.
- Self-hosted fallback path documented: if `fonts.googleapis.com` is restricted, copy the woff2 files into `public/fonts/` and swap the `<link>` for an `@font-face` block in shadcn's `index.css`.

### 3.4 Tailwind preflight strategy

**Decision: enable preflight globally.**

Considered:
- (A) **Global preflight, audit chat surface as we go.** Light upfront audit cost. Phase 2 has zero infrastructure churn — pure recomposition. *(chosen)*
- (B) Disable preflight, scope via `.admin-tw` wrapper. Zero risk to chat now, but creates a quirky scoped-Tailwind world phase 2 has to undo.
- (C) Custom scoped `:where()` reset. Too clever for the payoff.

The chat surface's `index.css` already does its own reset (margin, padding, box-sizing) at the top. Tailwind's preflight overlap is mostly orthogonal: `margin: 0` on headings (we don't render headings outside admin in chat), `list-style: none` on `ul`/`ol` (chat has no public bullet lists), `box-sizing: border-box` (already set). Risk surface is small and easy to spot in the dev server.

**Audit step:** before opening the PR, run `pnpm --filter @ax/channel-web dev` and walk the chat surface end-to-end (sidebar, session list, thread, composer, tool-use renderings, agent menu, toast). Any visual regression is fixed by adding back the affected legacy CSS rule with higher specificity, *not* by disabling preflight.

**Fallback:** if more than ~3 chat-side regressions surface, switch to (B) — wrap `<AdminShell/>` in a `tailwind` class and configure Tailwind's `important: '.tailwind'` selector. This trade-off is documented in the PR description either way.

### 3.5 Dark mode

- The current code uses `data-theme="light|dark"` on `<html>` plus a `prefers-color-scheme` fallback in `index.css`.
- shadcn's CSS variables are scoped to `:root` and `.dark` by default. We rewrite shadcn's stanza to scope dark tokens to `[data-theme="dark"], :root:not([data-theme="light"]) @media (prefers-color-scheme: dark)` — matching the existing convention.
- Tailwind `darkMode: ['selector', '[data-theme="dark"]']` (per §3.1) lets utilities like `dark:bg-card` resolve correctly.
- No theme-toggle UI is added in this PR. The dark-mode toggle in Tide's design page is for designers, not the product.

---

## 4. Architecture

### 4.1 Shell topology

When `adminSettingsOpen === true`, the entire left rail and main pane are owned by `<AdminShell/>` — a sibling of `<Sidebar/>` + `<Thread/>` + `<Composer/>`, not a child. The chat sidebar is unmounted while admin is open.

```
App.tsx
  adminSettingsOpen ─┬─ false → <Sidebar/> (chat) + <Thread/> + <Composer/>     [unchanged]
                    └─ true  → <AdminShell onClose={…}/>
                                  ├─ <AdminSidebar/>           (240px, fixed-width left rail)
                                  │     ├─ tide brand mark + ‘← chat’ button (calls onClose)
                                  │     ├─ "Admin" eyebrow
                                  │     ├─ <AdminNavItem/> × 5 (provider-keys / model-config / agents / mcp / teams)
                                  │     └─ user chip            (reuses UserMenu identity, restyled)
                                  └─ <AdminPane/>              (flex-1, scrollable)
                                        ├─ <AdminPaneHeader/> (eyebrow + title + optional badge slot)
                                        └─ active tab content
```

`<AdminShell/>` owns the active-tab state (replaces the existing `useState<TabId>` in `AdminSettings.tsx`). Default tab `'provider-keys'`. No URL routing — it's a state toggle like today.

### 4.2 File migration map

| Existing path | Outcome in this PR |
|---|---|
| `components/admin/AdminSettings.tsx` | **Replaced.** Becomes `components/admin/AdminShell.tsx` (sidebar + pane composition). Same `onClose` prop so the App.tsx integration is one-line unchanged. |
| `components/admin/ProviderKeysTab.tsx` | Rewritten with shadcn primitives + Tide's `provider` row composition. |
| `components/admin/ProviderKeyForm.tsx` | **Folded** into `ProviderKeysTab` as the inline `<KeyForm/>` block. Standalone file removed. |
| `components/admin/ModelConfigTab.tsx` | Rewritten using `<RoleCard/>` pattern. The provider-grouped model picker uses shadcn `Command` (cmdk) for search-on-open, matching Tide Scene 07. Plain `<Select/>` would not match Scene 07's combobox-with-search behavior. |
| `components/admin/AgentForm.tsx` | Rewritten with shadcn `Card` / `Input` / `Label` / `Button`. Same form fields, same handlers, same submit shape. |
| `components/admin/McpServerForm.tsx` | Same treatment as `AgentForm`. |
| `components/admin/TeamList.tsx` | Rewritten as a list of `<RoleCard/>`-style rows; member edit opens a shadcn `<Dialog/>`. |
| `components/credentials/*` (4 files) | Rewritten. Becomes the "My credentials" view inside `<SettingsPanel/>`. Uses the same `provider`-row vocabulary as Provider keys. |
| `components/settings/SettingsPanel.tsx` | Rewritten. Lives outside `AdminShell` — opens from the user chip dropdown like today. |
| `components/UserMenu.tsx` | **Mild restyle only.** Used by both chat and admin; full migration deferred to phase 2 to keep this PR's blast radius scoped. The dropdown body is restyled with shadcn `DropdownMenu` primitives; behavior unchanged. |
| `components/Sidebar.tsx`, `SessionList.tsx`, `SessionRow.tsx`, `Thread.tsx`, `Composer.tsx`, `MarkdownText.tsx`, `ToolUse.tsx`, `AgentChip.tsx`, `AgentMenu.tsx`, `Toast.tsx`, `NewSessionButton.tsx`, `SearchBar.tsx`, `SidebarCollapseToggle.tsx`, `SidebarMobileToggle.tsx`, `SessionHeader.tsx`, `AgentStatus.tsx`, `LoginPage.tsx` | **Untouched.** Phase 2. |

### 4.3 Local components introduced

These live in `src/components/admin/`, not in `src/components/ui/` (shadcn-managed dir). They are bespoke compositions of shadcn primitives + Tailwind utilities:

- `<AdminShell/>` — sidebar + pane layout shell.
- `<AdminSidebar/>` — left-rail nav with brand, back-to-chat button, nav list, user chip.
- `<AdminNavItem/>` — single nav row with active state + icon slot.
- `<AdminPane/>` — main content area with scroll handling.
- `<AdminPaneHeader/>` — eyebrow + title + badge slot (used by every tab).
- `<ProviderRow/>` — provider list row with status dot, masked stub, expand state.
- `<KeyForm/>` — inline key entry form (input + actions + optional error alert).
- `<RoleCard/>` — generic card with role pill + title + caption + body slot. Reused by Model config (one card per role) and the Agents/MCP/Teams views (one card per row).
- `<StatusDot/>` — accessible status indicator (`empty` / `ok` / `bad` / `pending` variants).

Icons via `lucide-react`. Mapping:

| Tide SVG | lucide-react |
|---|---|
| Provider keys nav icon | `KeyRound` |
| Model config nav icon | `Cpu` |
| Agents nav icon | `User` |
| MCP servers nav icon | `Server` |
| Teams nav icon | `UsersRound` |
| Back-to-chat chevron | `ChevronLeft` |
| Status dot OK check | `Check` |
| Validation error mark | `AlertCircle` |
| Hint info mark | `Info` |
| User-chip caret | `ChevronDown` |
| Combobox clear | `X` |

### 4.4 Visual extrapolation (views Tide does not render)

The Tide handoff renders Provider keys (4 scenes) and Model config (3 scenes) in detail. The other admin views — and the user-mode views — get extrapolated from Tide's design vocabulary. Each call below is documented so the reviewer can flag mismatches.

- **Agents.** Same shell as Provider keys. Body is a list of `<RoleCard/>` rows, one per agent. Each row: agent name (15px medium), short caption (13px muted), edit button on the right. Inline form expands underneath the active row using the same `key-form` muted-bg + animate-form-in treatment from Provider keys. New-agent button styled `btn-primary` in the pane header (right side).
- **MCP servers.** Identical pattern to Agents. Status dot variants: `empty` (not configured) / `ok` (configured + reachable) / `bad` (configured but health check failing) / `pending` (configured, probing).
- **Teams.** List of `<RoleCard/>` rows showing team name + member count + role pill. `Edit members` button opens shadcn `<Dialog/>` with the member list + add/remove controls.
- **Settings panel** (user-scoped, opens from user-chip dropdown, not from admin sidebar). Same overall shell minus the admin sidebar — opens as a centered max-w-[640px] column inside the chat shell using the chat sidebar still on the left. Body is a vertical stack of `<Card/>` blocks, one per settings section (currently: profile, my credentials).
- **Credentials list** (lives inside Settings panel). `<ProviderRow/>`-style list with status dots, masked key stubs, and the `<KeyForm/>` inline-add pattern. Reuses Provider keys' visual vocabulary verbatim.
- **OAuth web-paste flow** (existing `OAuthFlowForm`). Lives inside `<KeyForm/>` slot when the credential kind is `anthropic-oauth`. Shadcn `<Alert variant="default"/>` explains the paste step; the paste field uses the mono-input treatment.

---

## 5. Testing

### 5.1 Existing tests

The current `__tests__/admin-*.test.tsx` files assert *behavior* (form submission, API calls, validation messages, canary banner text). Behavior is preserved — only visuals change. Strategy:

- Keep all existing tests.
- Update only the selectors that break. Examples:
  - `.admin-settings-tabs li[data-active]` → `[role="tablist"] [aria-selected="true"]` (or whatever the migrated structure exposes via accessible roles).
  - `.admin-canary-banner` → role-based query if structure changes; otherwise keep.
- No deletions. Per `CLAUDE.md` Bug Fix Policy: any selector change must keep the underlying assertion intact (or strengthen it).

### 5.2 New tests

- `AdminShell.test.tsx`
  - Renders all 5 nav items.
  - Active state follows `activeTab` prop / state.
  - `← chat` button calls `onClose`.
  - User-chip identity is sourced from the same place `UserMenu` reads from.
- `provider-row.test.tsx`
  - Status dot renders correct variant for empty / configured / error / pending.
  - Masked key stub renders in mono with the correct `••••<last4>` shape.
- `model-config-select.test.tsx`
  - Command palette opens on trigger click.
  - Options grouped by provider heading.
  - Disabled state when no providers configured shows the hint Alert + disabled trigger.
  - Filter input updates the rendered option list.

### 5.3 Snapshot tests

**None.** Visual fidelity is checked by eye in the dev server + Playwright acceptance. Snapshots would lock arbitrary class strings and create maintenance churn.

### 5.4 Verification loop

1. `pnpm --filter @ax/channel-web dev` against the existing mock backend (`mock/server.ts`). Walk Tide's 7 scenes by hand and confirm visual match.
2. **Audit chat surface for preflight regressions** (per §3.4) before opening the PR.
3. Acceptance against the local kind cluster `ax-next-dev` via the `k8s-acceptance-loop` skill — Playwright drives admin from the chat-side menu, hits the real API, confirms each Tide scene's state can be reached and looks right.
4. `pnpm --filter @ax/channel-web test` green.
5. `pnpm build` green at the root.

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Tailwind preflight breaks chat-surface visuals | Medium | Audit step in §3.4; fallback to scoped preflight if regressions exceed ~3 fixes. |
| shadcn `Command` palette does not match Tide Scene 07 keyboard hints exactly | Low | Tide's "↵ select" + "4 hidden by filter" footer is rendered via `cmdk`'s footer slot; matchable. |
| IBM Plex font load is blocked by deployment CSP / network policy | Low | Self-hosted fallback documented (§3.3). |
| The chat-side `UserMenu` mild restyle drifts from the rest of the chat surface | Medium | Restyle is minimal (dropdown body only); the trigger button keeps its current chrome until phase 2. Documented in PR description. |
| Phase 2 slips and the half-wired window stays open | Medium | Window has a 2-week soft target; declared in PR description per §8. |
| shadcn primitives add bundle size that materially affects channel-web load | Low | shadcn's primitives are tree-shakeable; only what we import ships. Radix primitives are small. Bundle delta will be reported in the PR description. |

---

## 7. PR shape

- **Branch:** `feat/admin-settings-redesign` (already checked out).
- **Commits:** roughly 6–10 conventional commits, e.g.:
  1. `chore(channel-web): set up tailwind + postcss + autoprefixer`
  2. `chore(channel-web): init shadcn primitives + tokens + cn helper`
  3. `feat(channel-web): add IBM Plex font loading`
  4. `feat(channel-web): add admin shell with sidebar nav`
  5. `refactor(admin-settings): migrate provider keys to shadcn primitives`
  6. `refactor(admin-settings): migrate model config with cmdk combobox`
  7. `refactor(admin-settings): migrate agents/mcp/teams forms`
  8. `refactor(channel-web): migrate settings panel + credentials list`
  9. `chore(channel-web): mild UserMenu restyle for admin parity`
  10. `test(admin-settings): update selectors + add admin shell tests`
- **PR title:** `feat(channel-web): migrate admin settings to Tailwind + shadcn`.
- **PR body** must include:
  - "Summary" — one-line outcome.
  - "Half-wired window" — text per §8.
  - "Boundary review" — N/A with reason (no hooks added).
  - "Visual extrapolation" — list of the §4.4 calls so the reviewer can flag any view they want different.
  - "Test plan" — checklist matching §5.4.
  - "Bundle delta" — before/after kB for `dist-web/`.

---

## 8. Half-wired window (text for the PR description)

> **Window OPEN.** Tailwind + shadcn primitives now live in `@ax/channel-web` but only the admin tree consumes them. The chat surface (`Sidebar`, `SessionList`, `SessionRow`, `Thread`, `Composer`, `MarkdownText`, `ToolUse`, `AgentChip`, `AgentMenu`, `Toast`, `NewSessionButton`, `SearchBar`, `SidebarCollapseToggle`, `SidebarMobileToggle`, `SessionHeader`, `AgentStatus`, `LoginPage`) still uses the legacy `index.css` custom CSS below the shadcn token block.
>
> **Window CLOSED in:** follow-up PR `feat/chat-surface-shadcn-migration`, which migrates the chat surface using `Tide.html` / `Tide Sessions Tailwind.html` as references and deletes the now-unused blocks of legacy `index.css`. Window expected to close within 2 weeks.

---

## 9. References

- `chat-ui.zip` design handoff (extracted to `/tmp/chat-ui-extract/` during brainstorm).
- `chat-ui/project/Tide Admin Settings.html` — primary design (7 scenes + component palette).
- `chat-ui/project/Tide.html` — chat surface reference for phase 2.
- `chat-ui/project/Tide Sessions Tailwind.html` — sessions list Tailwind reference for phase 2.
- `docs/plans/2026-04-25-chat-ui-pulled-forward.md` — original chat-UI plan (predates Tailwind direction).
- `docs/plans/2026-05-06-credentials-admin-ui-design.md` — credentials feature design (this migration restyles the views shipped by that work).
- `CLAUDE.md` — five invariants, voice & tone for user-facing strings.
