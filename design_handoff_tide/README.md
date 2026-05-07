# Handoff: Tide — multi-agent chat UI

## Overview

Tide is a desktop-first chat interface for working with multiple specialized "agents" (tide, mercy, etc.) inside a single app. The design is centered on a calm, paper-feel aesthetic — warm off-white background, muted teal accent, IBM Plex typography. The primary flow is: pick an agent from the sidebar header, send messages in the main pane, and manage past sessions in a left rail.

This bundle is the result of an iterative design conversation. The canonical reference file is **`Tide Sessions.html`** — a fully interactive HTML prototype with sessions, inline rename, delete confirmation, agent switching, search, replies, tool-call previews, and a tweaks panel.

## About the design files

The HTML files in this bundle are **design references, not production code**. They use a single inline `<script>` block, no build step, mock data, and a flat DOM. The implementation task is to **recreate this design in your codebase's existing environment** (React/Next, Vue, SwiftUI, native, etc.) using the patterns, component primitives, and state management that codebase already establishes.

If your codebase has no UI yet, pick whatever framework best fits the rest of the stack and implement there. Do not ship the HTML directly.

## Fidelity

**High-fidelity.** Final colors, typography, spacing, borders, shadows, motion, and copy are all settled. Recreate pixel-for-pixel using the codebase's component library — match the look, not the implementation strategy.

If your codebase has a design system that conflicts with these tokens (different gray ramps, different accent), surface that to the design owner before diverging. The palette is intentionally warm and muted; falling back to a generic neutral ramp will lose the feel.

## Files in this bundle

- **`Tide Sessions.html`** — primary reference. Full app: sidebar (agent selector + sessions list + new-session + user menu), main pane (header + timeline + composer), search mode, message actions (copy / edit / retry), agent switching with deferred-session semantics, inline delete confirmation, tweaks panel.
- **`Tide.html`** — earlier single-session iteration. Useful as a simpler reference for the message timeline and composer in isolation.
- **`Tide Minimal.html`** — stripped-down variant. Reference for the absolute minimum chat surface.
- **`ax-logo.svg`** — Anthropic logo asset used in the user-menu footer.

Read **`Tide Sessions.html`** first; the other two are supporting context.

## Layout

Desktop layout is a two-column flex:

```
┌────────────────┬─────────────────────────────────────────┐
│ Sidebar 240px  │ Main pane (flex: 1)                      │
│  ┌──────────┐  │  ┌────────────────────────────────────┐  │
│  │ Agent    │  │  │ Session header (sticky, 56px)      │  │
│  │ chip     │  │  ├────────────────────────────────────┤  │
│  ├──────────┤  │  │ Timeline (scroll, max-w 720px,     │  │
│  │ + new    │  │  │ centered, top-padded)              │  │
│  │ session  │  │  │                                    │  │
│  ├──────────┤  │  │                                    │  │
│  │ Sessions │  │  │                                    │  │
│  │ list     │  │  │                                    │  │
│  │ (scroll) │  │  ├────────────────────────────────────┤  │
│  ├──────────┤  │  │ Composer (fixed bottom, max-w      │  │
│  │ User     │  │  │ 640px)                             │  │
│  │ menu     │  │  └────────────────────────────────────┘  │
│  └──────────┘  │                                          │
└────────────────┴─────────────────────────────────────────┘
```

- **Sidebar:** `240px` fixed width, `border-right: 1px solid var(--rule)`, `background: var(--bg)`. Internally a column flex with: agent chip (top), new-session button, sessions scroll region (`flex: 1`), user menu (bottom).
- **Sidebar collapsed state:** body class `sidebar-collapsed` collapses to `56px`. Persisted in `localStorage` under `tide-sidebar-collapsed`. Toggle button is a panel-with-rail glyph in the session header, right-aligned with the `⌘N` and `⋯` actions.
- **Mobile (`max-width: 720px`):** sidebar slides over as an overlay; toggle via body class `sidebar-open`.
- **Composer:** `position: fixed; bottom: 0; left: 240px; right: 0;` with internal `max-width: 640px` and `margin: 0 auto`. Adjusts to `left: 56px` when sidebar is collapsed, `left: 0` on mobile.
- **Timeline:** `max-width: 720px`, centered, with bottom padding to clear the fixed composer.

## Design tokens

All tokens are CSS custom properties at `:root`. Light is the default; dark is via `prefers-color-scheme: dark` and an explicit `:root[data-theme="dark"]` override.

### Color — light

| Token              | Hex        | Usage                                         |
|--------------------|------------|-----------------------------------------------|
| `--bg`             | `#f6f6f3`  | App background, sidebar, main pane            |
| `--surface-raised` | `#fcfbf8`  | Near-white lifted surface — composer field    |
| `--bg-deep`        | `#eeede8`  | Hover/active states, subtle surfaces          |
| `--ink`            | `#17181a`  | Primary text                                  |
| `--ink-soft`       | `#44464b`  | Secondary text                                |
| `--ink-mute`       | `#8a857a`  | Tertiary text, placeholders, icons            |
| `--ink-ghost`      | `#b8b3a6`  | Quaternary text, disabled state, scrollbars   |
| `--rule`           | `#dad8cf`  | Borders, dividers                             |
| `--accent`         | `#1e6b6b`  | Muted teal — links, active indicators, send button when ready |
| `--accent-soft`    | `#dce9e7`  | Accent backgrounds, badges                    |
| `--you-wash`       | `#ecede6`  | "You" message bubble background               |
| `--you-ink`        | `#17181a`  | "You" message text                            |
| `--danger`         | `#c25450`  | Destructive actions (delete confirm, etc.)    |

### Color — dark

| Token              | Hex        |
|--------------------|------------|
| `--bg`             | `#15171a`  |
| `--surface-raised` | `#1f2125`  |
| `--bg-deep`        | `#1c1e22`  |
| `--ink`            | `#e8e4da`  |
| `--ink-soft`       | `#b0ab9f`  |
| `--ink-mute`       | `#7e7a72`  |
| `--ink-ghost`      | `#4a4842`  |
| `--rule`           | `#2b2d32`  |
| `--accent`         | `#4ba39e`  |
| `--accent-soft`    | `#1f2f34`  |
| `--you-wash`       | `#22242a`  |
| `--you-ink`        | `#e8e4da`  |

### Typography

```css
--sans:  'IBM Plex Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
--mono:  'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace;
--serif: 'IBM Plex Serif', Georgia, serif;
```

Loaded from Google Fonts. Body base: `font-family: var(--sans); font-size: 15px; line-height: 1.55; color: var(--ink);`.

Common type roles:

| Role                    | Family / size / weight / leading        |
|-------------------------|-----------------------------------------|
| Body / message text     | sans 15 / 400 / 1.55                    |
| Session title (sidebar) | sans 13 / 400 / 1.35                    |
| Agent chip name         | serif 15 / 400 / 1                      |
| Agent menu row title    | serif 14 / 400 / 1.1                    |
| Session header title    | serif 17 / 500 / 1.2                    |
| Group label (sidebar)   | sans 10 / 500 / 1, uppercase, tracking 0.12em, color `--ink-ghost` |
| Composer textarea       | sans 15 / 400 / 1.55                    |
| Inline confirm text     | sans 12 / 400 / 1.35, tracking -0.005em |
| Keyboard shortcut chip  | mono 10.5 / 400, color `--ink-ghost`    |

Letter-spacing is generally `-0.01em` on serif headings, `-0.005em` to `0` on body, `0.04em–0.14em` (uppercase) on labels.

### Shadows

```css
--shadow-sm: 0 1px 2px rgba(23, 24, 26, 0.04), 0 1px 1px rgba(23, 24, 26, 0.03);
--shadow-md: 0 8px 24px rgba(23, 24, 26, 0.06), 0 1px 2px rgba(23, 24, 26, 0.04);
```

Floating menus (agent menu, attach menu, row menu) use a heavier, custom shadow:
`0 12px 40px -8px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.04)`.

### Radii

- Pills / chips: `999px` or `50%` for circles
- Buttons (filled icon, e.g. send): `50%` (30px circle)
- Cards / panels / menus: `10px`
- Composer field: `8px`
- Session row: `4px`
- Inline buttons / micro chrome: `3px–6px`

### Spacing

No formal scale; use multiples of 2 (2, 4, 6, 8, 10, 12, 14, 16, 20, 24). Sidebar interior padding is `12px`. Session header padding is `0 24px`. Timeline horizontal padding is `24px`. Composer horizontal padding is `24px` (outer) + `10px 12px 10px 14px` (inner field).

### Transitions

Default easing `ease`, durations `100–140ms` for hover/focus, `200–300ms` for content swaps.

```css
transition: background 120ms ease, color 120ms ease;
transition: border-color 140ms ease, box-shadow 140ms ease;
```

## Components

### 1. Agent chip (sidebar header)

A button at the top of the sidebar that opens the agent menu.

- Layout: horizontal flex, `gap: 8px`, `padding: 10px 12px`, full sidebar width minus its own margin, `border-radius: 8px`.
- Contents (left to right): 22px square avatar tile (gradient bg from accent to `--bg-deep`, 1px `--rule` border, 5px accent dot centered), agent name (serif 15px), caret icon (10px, `--ink-mute`, right-aligned via `margin-left: auto`).
- Hover/open: background `--bg-deep`. `aria-expanded="true"` matches hover style.

### 2. Agent menu (popover)

Opens below the chip. Width matches the sidebar minus side padding.

- Container: `--bg`, 1px `--rule`, `border-radius: 10px`, custom heavy shadow (see Shadows).
- Header label: "switch agent" — uppercase 10.5px tracking 0.14em, `--ink-ghost`, padding `8px 10px 4px`.
- Rows: 22px avatar + name (serif 14) + description (sans 11, `--ink-mute`) stacked + checkmark (14px accent) on right when selected.
- Footer note: "a new session starts on your next message" — 10.5px `--ink-ghost`, centered, top border `--rule`.
- Behavior is critical — see **Agent switching semantics** below.

### 3. New-session button

Sits below the agent chip in the sidebar.

- Layout: same width as agent chip, `padding: 8px 10px`, `border-radius: 6px`. Horizontal flex with `gap: 8px`.
- Contents: 13px plus icon (`--ink-mute`) + label "new session" (sans 12.5, `--ink-soft`) + `⌘N` keyboard hint (mono 10.5, `--ink-ghost`, `opacity: 0` until hover).
- Hover: bg `--bg-deep`, color `--ink`, kbd opacity 1.

### 4. Sessions list

Scroll region. Day-grouped — group labels ("today", "yesterday", "earlier") in the uppercase 10px style.

- Each row: horizontal flex, `align-items: flex-start`, `gap: 8px`, `padding: 8px 12px`, `border-radius: 4px`, `height: 34px` (fixed, important — see below).
- Contents: 6px agent-color dot (margin-top 7px to optical-center against first text line), session title (sans 13, single line, `text-overflow: ellipsis`), `⋯` more button (right side, `opacity: 0` until row hover/active).
- Active row: bg `--bg-deep`, color `--ink`, plus a 2px accent bar pseudo-element at left edge.
- **Fixed height:** rows are `height: 34px`, not auto. This is required so the inline delete confirm state (which has different content) doesn't shift surrounding rows.

### 5. Inline delete confirmation

When the user picks "delete" from a session's `⋯` menu, the row's contents are replaced **in place** with a confirmation UI. The 5-second auto-revert and the fixed `34px` row height ensure the sidebar doesn't reflow.

- Container picks up class `confirming-delete`. Background: `color-mix(in oklch, var(--danger) 10%, transparent)`. Same padding as a normal row (`8px 12px`).
- Children: text "delete this session?" (sans 12, `--ink`, `flex: 1`), "cancel" button (`--ink-soft`, hover `--ink`), "delete" button (`--danger`, weight 500, hover swaps to white text on `--danger` bg).
- Buttons are `font-size: 11.5px`, `line-height: 1`, `padding: 3px 7px`, `border-radius: 3px`.

### 6. Session header

Sticky top bar in the main pane.

- Layout: horizontal flex, `align-items: center`, `padding: 0 24px`, `height: 56px`, `border-bottom: 1px solid var(--rule)`, `background: var(--bg)`.
- Contents: session title (serif 17, weight 500, double-click to inline-rename), then `⌘N`, `⋯` (more menu), and sidebar-toggle icon — all right-aligned with consistent column width.
- Sidebar toggle uses a panel-with-rail glyph (rectangle with a vertical rail near the left edge). Does **not** rotate on collapse — meaning is "sidebar," same in either state.

### 7. Composer

Fixed-bottom input area.

- Outer: padding `12px 24px 16px`, max-width 640px, centered.
- Field (`.composer-field`): `display: flex; align-items: flex-end; gap: 10px;` with `padding: 10px 12px 10px 14px`, `background: var(--surface-raised)` (near-white, lifts the field off the page), `border: 1px solid var(--rule)`, `border-radius: 8px`, `box-shadow: var(--shadow-sm)`.
- Focus-within: `border-color: color-mix(in srgb, var(--accent) 40%, var(--rule))` and a 4px accent halo via box-shadow.
- Children: 28px attach (`+`) button, textarea, 30px send button.
- **Critical alignment detail:** the textarea has `min-height: 28px` (not the natural ~22px). With `align-items: flex-end` on the field, matching heights mean the `+` button and the textarea's first line of text bottom-align AND visually center-align — without this fix, the `+` floats above the placeholder's optical center.
- Send button: 30px circle, default bg `--ink-ghost`, when there's text `bg = --accent` (toggled via `.ready` class). Hover scales 1.05.

### 8. Message actions

Each message footer carries a timestamp plus inline icon-buttons:

- **Agent messages** — `copy` (writes the message text to clipboard, briefly swaps icon to a checkmark on success) and `retry` (regenerates the response).
- **User messages** — `copy` and `edit` (turns the message body into a `contenteditable="plaintext-only"` field; Enter commits, Escape cancels, blur commits).

Buttons are 22px square ghost icon-buttons; the action row is right-aligned for user messages and left-aligned for agent. Each icon is 13px, stroked at `currentColor` with `stroke-width: 1.4`. Hover bumps `color` from `--ink-mute` to `--ink` and adds a subtle `--ink-ghost` background.

**Branching semantics:** committing an edit or hitting retry **truncates the conversation** — every message after the edited user message (or after the prompt that produced the retried agent reply) is removed from both the in-memory `messages` array and the DOM, and a fresh agent turn runs from that point. This mirrors the way ChatGPT / Claude.ai handle edit and regenerate. The truncation is unconditional; there is no branch-tree UI.

### 9. Tweaks panel

A floating panel toggled from the toolbar (host-driven). Use it for design knobs (font size, accent, etc.). The starter component provides `<TweaksPanel>` and the matching controls; do **not** ship the tweaks UI to production — strip it.

### 10. User menu

Bottom of sidebar. Avatar + name + caret. Opens a popover with profile / preferences / sign-out items, plus an Anthropic logo footer (use `ax-logo.svg`).

Note: the section numbering above skips one because an earlier "Reply preview" section was removed; renumber freely when you adopt this in your own component library.

## Interactions & behavior

### Agent switching semantics (subtle — read carefully)

The user can pick a different agent from the agent menu. The intended behavior:

1. **Empty current session** (no messages yet) → retag the current session with the new agent. **No new session is created.** The chat view stays on the same session, now under the new agent.

2. **Current session has messages** → enter a **pending** state:
   - The chat view goes blank (renders the empty intro: "One conversation. Say anything.").
   - The agent chip and dropdown checkmark immediately reflect the newly selected agent.
   - **No new session is created yet.** The previous session still exists in the sidebar.
   - When the user sends their first message, **then** a new session is created under the pending agent and the message lands in it.
   - Clicking another session in the sidebar, or `+ new session`, cancels the pending state.

This deferred behavior matters because it avoids cluttering the sidebar with empty sessions every time someone hovers over the agent picker.

State variable: `pendingAgentId`. Cleared on `submit()`, `switchSession()`, `newSession()`. `getActiveAgent()` honors `pendingAgentId` ahead of the session's `agentId`.

### Session lifecycle

- A new session is born `{ id, title: 'new session', messages: [], agentId }`.
- Title auto-derives from the first user message after a save (substring + truncation).
- Sessions are stored in `localStorage`. The active session's id is persisted alongside.
- Delete is a two-step inline confirm with 5s auto-revert. Confirm replaces the row contents in place; no modal.
- Rename is double-click on the session row title (or session-header title). Plaintext-only `contenteditable`. Enter to commit, Esc to cancel.

### Search mode

Toolbar action transitions the composer to a search field; timeline filters by substring, with hit highlights and an offer to escalate to "semantic" search. Body class `searching` hides the attach button, etc.

### Edit & retry (conversation branching)

See §8 above. Both actions are destructive: they re-run the model on the prior prompt and drop everything that came after, in-memory and on disk. There is no undo — the prior agent reply is gone.

### Tool calls

Some prompts trigger a planned tool-call sequence. The agent message renders with a tools block in `running` state (animated dots), then transitions tools to `done` before streaming the reply text. See `planTools()` and the tools schema embedded in agent messages.

## State management

Top-level state lives on a single `store` object persisted to `localStorage`:

```ts
type Store = {
  sessions: Session[];
  activeId: string;
};

type Session = {
  id: string;          // 'sess-' + base36 timestamp
  title: string;       // derived from first user message
  messages: Message[];
  agentId: string;     // 'tide' | 'mercy' | ...
};

type Message = {
  id: string;          // 'u'|'a' + timestamp
  role: 'you' | 'agent';
  text: string;
  ts: number;
  tools?: ToolGroup[]; // optional planned-tools block on agent messages
};
```

In-memory globals layered on top:

- `messages` — live reference to the active session's `messages` array (for fast append).
- `pendingAgentId` — see agent switching semantics.

Other persisted keys:

- `tide-sidebar-collapsed` — `'1'` when collapsed.
- `tide-active-agent` (`AGENT_KEY`) — global default agent for new sessions.

## Agents (mock data)

```js
const AGENTS = [
  { id: 'tide',  name: 'tide',  tag: 'work',  desc: 'your default work agent',        color: '#7aa6c9' },
  { id: 'mercy', name: 'mercy', tag: 'legal', desc: 'contracts, vendors, compliance', color: '#b08968' },
  // ...see full list in Tide Sessions.html
];
```

The colored dot in the sidebar session row uses `agent.color`. The agent avatar tile in the chip and menu uses a gradient that mixes the accent with `--bg-deep` (color-agnostic — same look for all agents at present, by intent).

## Assets

- **`ax-logo.svg`** — Anthropic logo. Used in the user menu footer at small size. Replace with whatever brand asset is appropriate for your build.
- All icons are inline SVG, hand-drawn at 12–16px viewport sizes with `stroke="currentColor"`. No icon library — match this hand-drawn look or substitute equivalent simple line icons from your kit (Lucide, Heroicons outline). Stroke widths are 1.2–1.6px depending on icon size.

## What to ignore

- The interaction "tweaks" panel — design-only.
- Inline `<script>` mock data, fake response generation, fake tool planning. Replace with real APIs.
- Any text labels prefixed with copy like "your default work agent" — placeholder.
- Search "semantic" escalation — a UI hint for a feature that's not built; gate behind a real flag in your codebase.

## Questions for the design owner before shipping

1. Are agent identities and copy final? (`tide`, `mercy`, etc., and their descriptions)
2. Real tool-call protocol — what's the actual shape and animation timing?
3. Is the sidebar collapsed state a first-class feature or just for desktop power users?
4. Mobile: is the slide-over sidebar the intended pattern, or should mobile be a separate design?
5. Does the user menu need a real settings/profile screen, or is the popover the whole feature?
