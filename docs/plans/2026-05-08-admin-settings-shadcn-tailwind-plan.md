# Admin Settings — Tailwind + shadcn migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `@ax/channel-web`'s admin tree (Provider keys, Model config, Agents, MCP servers, Teams, Settings panel, Credentials) from ~2,700 lines of bespoke custom CSS to a Tailwind + shadcn implementation that matches `Tide Admin Settings.html` visually and establishes the design-system foundation for a phase-2 chat-surface migration.

**Architecture:** Tailwind CSS + shadcn primitives installed via the standard CLI inside `packages/channel-web/`. shadcn token stanza in `src/index.css` is replaced with Tide's HSL palette so primitives render with Tide's look. A new `<AdminShell/>` (sidebar + main pane composition) replaces the existing two-pane `<AdminSettings/>` and is mounted as a sibling of the chat sidebar in `App.tsx` — when admin is open, the chat sidebar unmounts. Local admin components (`AdminSidebar`, `AdminNavItem`, `AdminPane`, `AdminPaneHeader`, `ProviderRow`, `KeyForm`, `RoleCard`, `StatusDot`) compose shadcn primitives + Tailwind utilities. Chat surface stays on legacy `index.css` until a follow-up phase-2 PR.

**Tech Stack:** Tailwind CSS 3.x + PostCSS + autoprefixer; shadcn/ui primitives (Button, Input, Label, Select, Badge, Alert, Card, Dialog, Separator, Command (cmdk), Tooltip, DropdownMenu); Radix primitives (transitive); IBM Plex Sans + Plex Mono via Google Fonts; existing React 19 + Vite 6 + TypeScript 6 + Vitest + Testing Library; lucide-react (already a dep) for icons.

**Design doc:** `docs/plans/2026-05-08-admin-settings-shadcn-tailwind-design.md` — referenced throughout as `[design §N]`.

---

## File Structure

### Created files

```
packages/channel-web/
├── tailwind.config.ts                                    [Phase 0]
├── postcss.config.js                                     [Phase 0]
├── components.json                                       [Phase 0, shadcn-managed]
├── src/
│   ├── lib/
│   │   └── utils.ts                                      [Phase 0, shadcn-generated cn()]
│   ├── components/
│   │   ├── ui/                                           [Phase 0, shadcn-managed dir]
│   │   │   ├── button.tsx
│   │   │   ├── input.tsx
│   │   │   ├── label.tsx
│   │   │   ├── select.tsx
│   │   │   ├── badge.tsx
│   │   │   ├── alert.tsx
│   │   │   ├── card.tsx
│   │   │   ├── dialog.tsx
│   │   │   ├── separator.tsx
│   │   │   ├── command.tsx
│   │   │   ├── tooltip.tsx
│   │   │   └── dropdown-menu.tsx
│   │   └── admin/
│   │       ├── AdminShell.tsx                            [Phase 1]
│   │       ├── AdminSidebar.tsx                          [Phase 1]
│   │       ├── AdminNavItem.tsx                          [Phase 1]
│   │       ├── AdminPane.tsx                             [Phase 1]
│   │       ├── AdminPaneHeader.tsx                       [Phase 1]
│   │       ├── StatusDot.tsx                             [Phase 1]
│   │       ├── ProviderRow.tsx                           [Phase 2]
│   │       ├── KeyForm.tsx                               [Phase 2]
│   │       ├── RoleCard.tsx                              [Phase 3]
│   │       ├── ModelCombobox.tsx                         [Phase 3]
│   │       └── __tests__/
│   │           ├── AdminShell.test.tsx                   [Phase 1]
│   │           ├── ProviderRow.test.tsx                  [Phase 2]
│   │           └── ModelCombobox.test.tsx                [Phase 3]
```

### Modified files

```
packages/channel-web/
├── package.json                                          [Phase 0, deps + scripts]
├── index.html                                            [Phase 0, font links]
├── src/
│   ├── index.css                                         [Phase 0, prepend shadcn tokens]
│   ├── App.tsx                                           [Phase 1, swap AdminSettings → AdminShell]
│   └── components/
│       ├── UserMenu.tsx                                  [Phase 6, mild dropdown restyle]
│       ├── admin/
│       │   ├── ProviderKeysTab.tsx                       [Phase 2]
│       │   ├── ModelConfigTab.tsx                        [Phase 3]
│       │   ├── AgentForm.tsx                             [Phase 4]
│       │   ├── McpServerForm.tsx                         [Phase 4]
│       │   ├── TeamList.tsx                              [Phase 4]
│       │   └── __tests__/
│       │       ├── admin-canary-banner.test.tsx          [Phase 1, selector update]
│       │       ├── admin-agents.test.tsx                 [Phase 4, selector update]
│       │       ├── admin-mcp.test.tsx                    [Phase 4, selector update]
│       │       └── admin-teams.test.tsx                  [Phase 4, selector update]
│       ├── credentials/
│       │   ├── CredentialsList.tsx                       [Phase 5]
│       │   ├── ApiKeyForm.tsx                            [Phase 5]
│       │   ├── OAuthFlowForm.tsx                         [Phase 5]
│       │   └── CredentialAddMenu.tsx                     [Phase 5]
│       └── settings/
│           └── SettingsPanel.tsx                         [Phase 5]
```

### Deleted files

```
packages/channel-web/src/components/admin/
└── ProviderKeyForm.tsx                                   [Phase 2 — folded into KeyForm.tsx]
```

### Untouched (Phase 2 follow-up PR)

`Sidebar.tsx`, `SidebarCollapseToggle.tsx`, `SidebarMobileToggle.tsx`, `SessionList.tsx`, `SessionRow.tsx`, `SessionHeader.tsx`, `Thread.tsx`, `Composer.tsx`, `MarkdownText.tsx`, `ToolUse.tsx`, `AgentChip.tsx`, `AgentMenu.tsx`, `AgentStatus.tsx`, `Toast.tsx`, `NewSessionButton.tsx`, `SearchBar.tsx`, `LoginPage.tsx`, plus the chat-side blocks of `index.css`.

---

## PHASE 0 — Foundation: Tailwind, shadcn, tokens, fonts

### Task 0.1: Add Tailwind + PostCSS dev dependencies

**Files:**
- Modify: `packages/channel-web/package.json`
- Create: `packages/channel-web/tailwind.config.ts`
- Create: `packages/channel-web/postcss.config.js`

- [ ] **Step 1: Install dev dependencies**

Run from repo root:

```bash
pnpm --filter @ax/channel-web add -D tailwindcss@^3.4 postcss@^8.4 autoprefixer@^10.4
```

Expected: lockfile updates, `node_modules/tailwindcss` etc. present.

- [ ] **Step 2: Create `postcss.config.js`**

```js
// packages/channel-web/postcss.config.js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 3: Create `tailwind.config.ts` with Tide tokens + dark-mode selector**

```ts
// packages/channel-web/tailwind.config.ts
import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"IBM Plex Sans"',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        mono: [
          '"IBM Plex Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          soft: 'hsl(var(--primary-soft))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
          soft: 'hsl(var(--destructive-soft))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        'rule-soft': 'hsl(var(--rule-soft))',
        'ink-ghost': 'hsl(var(--ink-ghost))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        sm: '0 1px 2px hsl(0 0% 0% / 0.04), 0 1px 1px hsl(0 0% 0% / 0.03)',
        md: '0 8px 24px hsl(0 0% 0% / 0.06), 0 1px 2px hsl(0 0% 0% / 0.04)',
      },
      keyframes: {
        'form-in': {
          from: { opacity: '0', transform: 'translateY(-2px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'form-in': 'form-in 180ms cubic-bezier(0.2,0.8,0.2,1) both',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
```

- [ ] **Step 4: Install `tailwindcss-animate` (used by shadcn components)**

```bash
pnpm --filter @ax/channel-web add -D tailwindcss-animate@^1.0
```

- [ ] **Step 5: Verify build works**

```bash
pnpm --filter @ax/channel-web build
```

Expected: build succeeds (Tailwind compiles even though no utilities are used yet — empty stylesheet emit is fine).

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/package.json packages/channel-web/tailwind.config.ts packages/channel-web/postcss.config.js pnpm-lock.yaml
git commit -m "chore(channel-web): set up tailwind + postcss + autoprefixer"
```

---

### Task 0.2: Initialize shadcn + utilities

**Files:**
- Create: `packages/channel-web/components.json`
- Create: `packages/channel-web/src/lib/utils.ts`
- Modify: `packages/channel-web/tsconfig.json` (add `@/*` path alias)
- Modify: `packages/channel-web/vite.config.ts` (add `@/*` resolve alias)

- [ ] **Step 1: Add path alias to `tsconfig.json`**

Open `packages/channel-web/tsconfig.json`. Inside `compilerOptions`, add (or extend if `paths` already exists):

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

- [ ] **Step 2: Add resolve alias to `vite.config.ts`**

Open `packages/channel-web/vite.config.ts`. Inside the Vite config, ensure `resolve.alias` includes:

```ts
import path from 'node:path';

// inside defineConfig({...})
resolve: {
  alias: {
    '@': path.resolve(__dirname, './src'),
  },
},
```

If `resolve.alias` already exists, merge `'@': path.resolve(__dirname, './src')` into it.

- [ ] **Step 3: Create `src/lib/utils.ts` with `cn()` helper**

```ts
// packages/channel-web/src/lib/utils.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 4: Install runtime deps (clsx + tailwind-merge + class-variance-authority)**

```bash
pnpm --filter @ax/channel-web add clsx@^2.1 tailwind-merge@^2.5 class-variance-authority@^0.7
```

- [ ] **Step 5: Create `components.json`**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/index.css",
    "baseColor": "zinc",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

- [ ] **Step 6: Verify TypeScript still type-checks**

```bash
pnpm --filter @ax/channel-web exec tsc --noEmit
```

Expected: no errors. (If errors mention missing module declarations for `clsx` or `tailwind-merge`, re-run `pnpm install` from repo root.)

- [ ] **Step 7: Commit**

```bash
git add packages/channel-web/package.json packages/channel-web/components.json packages/channel-web/tsconfig.json packages/channel-web/vite.config.ts packages/channel-web/src/lib/utils.ts pnpm-lock.yaml
git commit -m "chore(channel-web): init shadcn + cn helper + path alias"
```

---

### Task 0.3: Add shadcn primitives via CLI

**Files (all created by the CLI):**
- Create: `packages/channel-web/src/components/ui/button.tsx`
- Create: `packages/channel-web/src/components/ui/input.tsx`
- Create: `packages/channel-web/src/components/ui/label.tsx`
- Create: `packages/channel-web/src/components/ui/select.tsx`
- Create: `packages/channel-web/src/components/ui/badge.tsx`
- Create: `packages/channel-web/src/components/ui/alert.tsx`
- Create: `packages/channel-web/src/components/ui/card.tsx`
- Create: `packages/channel-web/src/components/ui/dialog.tsx`
- Create: `packages/channel-web/src/components/ui/separator.tsx`
- Create: `packages/channel-web/src/components/ui/command.tsx`
- Create: `packages/channel-web/src/components/ui/tooltip.tsx`
- Create: `packages/channel-web/src/components/ui/dropdown-menu.tsx`

- [ ] **Step 1: Run shadcn `add` for all primitives at once**

From `packages/channel-web/`:

```bash
cd packages/channel-web && pnpm dlx shadcn@latest add -y button input label select badge alert card dialog separator command tooltip dropdown-menu
```

Expected: 12 files created under `src/components/ui/`. CLI also installs Radix dependencies + cmdk into `package.json`.

- [ ] **Step 2: Verify each generated file is present**

```bash
ls packages/channel-web/src/components/ui/
```

Expected output (alphabetical):

```
alert.tsx
badge.tsx
button.tsx
card.tsx
command.tsx
dialog.tsx
dropdown-menu.tsx
input.tsx
label.tsx
select.tsx
separator.tsx
tooltip.tsx
```

- [ ] **Step 3: Verify generated files compile**

```bash
pnpm --filter @ax/channel-web exec tsc --noEmit
```

Expected: no errors. (If shadcn generates an import that doesn't resolve, install the missing package — most commonly `@radix-ui/react-icons`.)

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/src/components/ui packages/channel-web/package.json pnpm-lock.yaml
git commit -m "chore(channel-web): add shadcn primitives (button, input, select, command, dialog, dropdown-menu, alert, badge, card, separator, label, tooltip)"
```

---

### Task 0.4: Replace shadcn token stanza with Tide tokens

**Files:**
- Modify: `packages/channel-web/src/index.css` (top of file — token block + base layer)

The shadcn CLI prepends a token stanza to `src/index.css` during `init`. We rewrite that stanza to use Tide's HSL values and to scope dark tokens to the existing `data-theme` mechanism. The legacy CSS *below* the shadcn block stays untouched until phase 2.

- [ ] **Step 1: Inspect what shadcn wrote**

```bash
head -80 packages/channel-web/src/index.css
```

Expect a `@tailwind base; @tailwind components; @tailwind utilities;` block followed by `@layer base { :root { --background: …; } .dark { … } }`.

- [ ] **Step 2: Replace the `:root` and `.dark` stanzas with Tide values**

Open `src/index.css`. Replace the shadcn-generated `@layer base { :root { … } .dark { … } * { @apply border-border; } }` block with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 240 6% 10%;
    --card: 0 0% 100%;
    --card-foreground: 240 6% 10%;
    --popover: 0 0% 100%;
    --popover-foreground: 240 6% 10%;
    --primary: 211 100% 44%;
    --primary-foreground: 0 0% 100%;
    --primary-soft: 214 100% 95%;
    --secondary: 240 5% 96%;
    --secondary-foreground: 240 6% 10%;
    --muted: 240 5% 96%;
    --muted-foreground: 240 4% 46%;
    --accent: 240 5% 96%;
    --accent-foreground: 240 6% 10%;
    --destructive: 0 60% 55%;
    --destructive-foreground: 0 0% 100%;
    --destructive-soft: 0 60% 96%;
    --border: 240 6% 91%;
    --input: 240 6% 91%;
    --ring: 211 100% 44%;
    --radius: 0.5rem;
    --rule-soft: 240 6% 95%;
    --ink-ghost: 240 4% 78%;
  }

  /* Dark tokens scoped to existing data-theme mechanism + system fallback. */
  :root[data-theme='dark'],
  :root:not([data-theme='light']) {
    @media (prefers-color-scheme: dark) {
      --background: 0 0% 0%;
      --foreground: 240 5% 96%;
      --card: 240 3% 11%;
      --card-foreground: 240 5% 96%;
      --popover: 240 3% 11%;
      --popover-foreground: 240 5% 96%;
      --primary: 211 100% 52%;
      --primary-foreground: 0 0% 100%;
      --primary-soft: 212 100% 14%;
      --secondary: 240 3% 9%;
      --secondary-foreground: 240 5% 96%;
      --muted: 240 3% 9%;
      --muted-foreground: 240 4% 56%;
      --accent: 240 3% 9%;
      --accent-foreground: 240 5% 96%;
      --destructive: 4 86% 62%;
      --destructive-foreground: 0 0% 100%;
      --destructive-soft: 4 60% 16%;
      --border: 240 4% 17%;
      --input: 240 4% 17%;
      --ring: 211 100% 52%;
      --rule-soft: 240 4% 13%;
      --ink-ghost: 240 4% 26%;
      color-scheme: dark;
    }
  }
  :root[data-theme='dark'] {
    --background: 0 0% 0%;
    --foreground: 240 5% 96%;
    --card: 240 3% 11%;
    --card-foreground: 240 5% 96%;
    --popover: 240 3% 11%;
    --popover-foreground: 240 5% 96%;
    --primary: 211 100% 52%;
    --primary-foreground: 0 0% 100%;
    --primary-soft: 212 100% 14%;
    --secondary: 240 3% 9%;
    --secondary-foreground: 240 5% 96%;
    --muted: 240 3% 9%;
    --muted-foreground: 240 4% 56%;
    --accent: 240 3% 9%;
    --accent-foreground: 240 5% 96%;
    --destructive: 4 86% 62%;
    --destructive-foreground: 0 0% 100%;
    --destructive-soft: 4 60% 16%;
    --border: 240 4% 17%;
    --input: 240 4% 17%;
    --ring: 211 100% 52%;
    --rule-soft: 240 4% 13%;
    --ink-ghost: 240 4% 26%;
    color-scheme: dark;
  }
}
```

The legacy `index.css` content below this block (the existing custom-CSS world) stays exactly as it is. Do not touch any line below the closing `}` of the `@layer base { … }` shadcn block.

- [ ] **Step 3: Run dev server and visually confirm chat surface still renders**

```bash
pnpm --filter @ax/channel-web dev
```

Open the URL in a browser. Confirm the login page (and after auth, the chat surface) still looks like it did before. Tailwind's preflight (margin-zero on headings, list-style-none on `ul`/`ol`, border-box on `*`) is now active globally — note any obvious regression.

If something regresses on the chat side, capture it in a scratch note for Task 0.6 (the formal audit).

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ax/channel-web test
```

Expected: all tests still green. (Tests don't render full styles; behavior tests should be unaffected.)

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/index.css
git commit -m "chore(channel-web): apply Tide token palette to shadcn css variables"
```

---

### Task 0.5: Wire IBM Plex font loading

**Files:**
- Modify: `packages/channel-web/index.html`

- [ ] **Step 1: Add Google Fonts links to `<head>`**

Open `packages/channel-web/index.html`. Inside `<head>`, before the existing `<link rel="stylesheet">` or `<script type="module">`, add:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
  rel="stylesheet"
/>
```

- [ ] **Step 2: Confirm fonts load in dev server**

```bash
pnpm --filter @ax/channel-web dev
```

Open the page, open DevTools → Network → filter for "font". Confirm two woff2 requests succeed (one Plex Sans, one Plex Mono).

> Note: The `font-sans antialiased` class is **not** applied at the `<body>` level. Admin-tree components apply it themselves once they're built (Phase 1+). Chat surface inherits its current font cascade until phase 2.

- [ ] **Step 3: Commit**

```bash
git add packages/channel-web/index.html
git commit -m "feat(channel-web): preload IBM Plex Sans + Mono for admin shell"
```

---

### Task 0.6: Audit chat surface for preflight regressions

**Files:**
- Possibly modify: `packages/channel-web/src/index.css` (the legacy section below the shadcn block, only if a regression needs it)

> This task is a checkpoint, not a feature. Tailwind's preflight is now active globally. The chat surface is the consumer most at risk of subtle visual drift. We walk it end-to-end before locking in the foundation.

- [ ] **Step 1: Start dev server**

```bash
pnpm --filter @ax/channel-web dev
```

- [ ] **Step 2: Walk the full chat surface and note any regression**

Compare each surface to git `main` visually:

- Login page: form layout, button alignment, headings.
- After auth — `Sidebar`: agent menu, `NewSessionButton`, `SearchBar`, `SessionList` (with at least 3 sessions seeded), `UserMenu` chip.
- `SessionHeader`: title, agent chip, agent status.
- `Thread`: empty state ("ask anything"), then with messages — markdown rendering (`MarkdownText`), tool use blocks (`ToolUse`), agent chip in user-meta.
- `Composer`: input field, send button, agent picker.
- `Toast`: trigger one via the `agent-status-test-triggers` debug helpers.
- Mobile: resize the window to <640px — confirm `SidebarMobileToggle` works and the scrim renders.

- [ ] **Step 3: Fix any regression by adding higher-specificity legacy rules**

For each regression: open `src/index.css`, find the relevant legacy selector below the shadcn block, and add a more specific rule that re-asserts the lost browser-default behavior.

Example fix for "session list bullets are missing" (which would only matter if the legacy CSS expected default `list-style: disc`):

```css
.session-list {
  list-style: disc inside;
}
```

Do **not** disable Tailwind preflight. Do **not** modify the shadcn block at the top of `index.css`. Only add legacy rules below it.

If more than ~3 fixes are needed, **stop and reconsider** — switch to scoped preflight per design §3.4 fallback (wrap `<AdminShell/>` in a `tailwind` class and set `important: '.tailwind'` in `tailwind.config.ts`). Document the switch in this task's commit message.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ax/channel-web test
```

Expected: all tests green.

- [ ] **Step 5: Commit (only if Step 3 changed anything)**

```bash
git add packages/channel-web/src/index.css
git commit -m "fix(channel-web): restore N chat-surface defaults after tailwind preflight"
```

(If Step 3 was a no-op, skip this commit. The audit checkpoint is then implicit.)

---

## PHASE 1 — Admin shell scaffold

### Task 1.1: Create `StatusDot` and `AdminNavItem`

**Files:**
- Create: `packages/channel-web/src/components/admin/StatusDot.tsx`
- Create: `packages/channel-web/src/components/admin/AdminNavItem.tsx`

- [ ] **Step 1: Implement `StatusDot`**

```tsx
// packages/channel-web/src/components/admin/StatusDot.tsx
import { cn } from '@/lib/utils';

export type StatusDotVariant = 'empty' | 'ok' | 'bad' | 'pending';

export interface StatusDotProps {
  variant: StatusDotVariant;
  className?: string;
}

const VARIANT_CLASS: Record<StatusDotVariant, string> = {
  empty: 'bg-ink-ghost',
  ok: 'bg-primary shadow-[0_0_0_3px_color-mix(in_srgb,hsl(var(--primary))_18%,transparent)]',
  bad: 'bg-destructive',
  pending:
    'bg-ink-ghost animate-pulse',
};

export function StatusDot({ variant, className }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block w-1.5 h-1.5 rounded-full shrink-0',
        VARIANT_CLASS[variant],
        className,
      )}
    />
  );
}
```

- [ ] **Step 2: Implement `AdminNavItem`**

```tsx
// packages/channel-web/src/components/admin/AdminNavItem.tsx
import type { ComponentType, SVGProps } from 'react';
import { cn } from '@/lib/utils';

export interface AdminNavItemProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  active?: boolean;
  onClick: () => void;
}

export function AdminNavItem({ icon: Icon, label, active, onClick }: AdminNavItemProps) {
  return (
    <button
      type="button"
      data-active={active || undefined}
      onClick={onClick}
      className={cn(
        'group relative flex items-center gap-2.5 w-full px-2.5 py-2 rounded-sm text-[13px] cursor-pointer transition-colors',
        active
          ? 'bg-muted text-foreground before:content-[""] before:absolute before:left-0 before:top-2.5 before:bottom-2.5 before:w-0.5 before:bg-primary before:rounded-full'
          : 'text-foreground/75 hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon
        className={cn(
          'w-3.5 h-3.5 shrink-0 transition-colors',
          active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground/75',
        )}
      />
      <span>{label}</span>
    </button>
  );
}
```

- [ ] **Step 3: Run type-check**

```bash
pnpm --filter @ax/channel-web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/src/components/admin/StatusDot.tsx packages/channel-web/src/components/admin/AdminNavItem.tsx
git commit -m "feat(channel-web): add StatusDot + AdminNavItem primitives"
```

---

### Task 1.2: Create `AdminSidebar`

**Files:**
- Create: `packages/channel-web/src/components/admin/AdminSidebar.tsx`

- [ ] **Step 1: Implement `AdminSidebar`**

```tsx
// packages/channel-web/src/components/admin/AdminSidebar.tsx
import { ChevronLeft, ChevronDown, KeyRound, Cpu, User, Server, UsersRound } from 'lucide-react';
import { useUser } from '@/lib/user-context';
import { AdminNavItem } from './AdminNavItem';
import { cn } from '@/lib/utils';

export type AdminTabId =
  | 'provider-keys'
  | 'model-config'
  | 'agents'
  | 'mcp-servers'
  | 'teams';

const NAV: Array<{ id: AdminTabId; label: string; icon: typeof KeyRound }> = [
  { id: 'provider-keys', label: 'Provider keys', icon: KeyRound },
  { id: 'model-config', label: 'Model config', icon: Cpu },
  { id: 'agents', label: 'Agents', icon: User },
  { id: 'mcp-servers', label: 'MCP servers', icon: Server },
  { id: 'teams', label: 'Teams', icon: UsersRound },
];

export interface AdminSidebarProps {
  activeTab: AdminTabId;
  onTabChange: (tab: AdminTabId) => void;
  onBackToChat: () => void;
}

export function AdminSidebar({ activeTab, onTabChange, onBackToChat }: AdminSidebarProps) {
  const user = useUser();
  const initials = (user.displayName ?? user.email).slice(0, 1).toUpperCase();

  return (
    <aside className="w-[240px] shrink-0 border-r border-border bg-background flex flex-col font-sans">
      <div className="px-3 pt-3.5 pb-2 flex items-center justify-between gap-2">
        <span className="flex items-center">
          <span className="inline-block w-[5px] h-[5px] rounded-full bg-primary mr-2 -translate-y-[3px]" />
          <span className="text-[19px] font-medium tracking-[-0.015em] leading-none">tide</span>
        </span>
        <button
          type="button"
          onClick={onBackToChat}
          className={cn(
            'cursor-pointer inline-flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-xl text-[11.5px]',
            'text-muted-foreground bg-muted border border-transparent',
            'hover:text-foreground hover:bg-background hover:border-border transition-colors',
          )}
        >
          <ChevronLeft className="w-[11px] h-[11px]" strokeWidth={1.4} />
          chat
        </button>
      </div>
      <div className="flex-1 overflow-hidden pt-2.5 pb-2 flex flex-col">
        <div className="text-[10.5px] tracking-[0.12em] uppercase text-ink-ghost px-4 py-2 font-medium">
          Admin
        </div>
        <ul className="flex flex-col gap-px px-1 list-none m-0 p-0">
          {NAV.map((item) => (
            <li key={item.id}>
              <AdminNavItem
                icon={item.icon}
                label={item.label}
                active={activeTab === item.id}
                onClick={() => onTabChange(item.id)}
              />
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-border p-2">
        <div className="flex items-center gap-2.5 px-2 py-[7px] rounded-md">
          <span
            className="w-[26px] h-[26px] rounded-full border border-border inline-flex items-center justify-center text-[11px] shrink-0"
            style={{
              background:
                'linear-gradient(135deg, color-mix(in srgb, hsl(var(--primary)) 26%, hsl(var(--muted))), hsl(var(--muted)))',
            }}
          >
            {initials}
          </span>
          <span className="flex flex-col gap-px min-w-0 flex-1">
            <span className="text-[12.5px] leading-[1.15] truncate">
              {user.displayName ?? user.email}
            </span>
            <span className="text-[10.5px] leading-[1.15] text-muted-foreground truncate">
              {user.email}
            </span>
          </span>
          <ChevronDown className="w-2.5 h-2.5 text-muted-foreground shrink-0" strokeWidth={1.4} />
        </div>
      </div>
    </aside>
  );
}
```

> Note: the user chip is intentionally a static visual element here — full dropdown behavior lives on the chat-side `UserMenu`. The admin shell currently has only one exit affordance (the `← chat` button at the top); extending the chip to a dropdown is a phase-2 follow-up.

- [ ] **Step 2: Run type-check**

```bash
pnpm --filter @ax/channel-web exec tsc --noEmit
```

Expected: no errors. If `useUser` returns a different shape than `{ displayName?, email }`, adjust based on the actual `user-context.tsx` export.

- [ ] **Step 3: Commit**

```bash
git add packages/channel-web/src/components/admin/AdminSidebar.tsx
git commit -m "feat(channel-web): add AdminSidebar with tide brand, nav, user chip"
```

---

### Task 1.3: Create `AdminPane` and `AdminPaneHeader`

**Files:**
- Create: `packages/channel-web/src/components/admin/AdminPane.tsx`
- Create: `packages/channel-web/src/components/admin/AdminPaneHeader.tsx`

- [ ] **Step 1: Implement `AdminPaneHeader`**

```tsx
// packages/channel-web/src/components/admin/AdminPaneHeader.tsx
import type { ReactNode } from 'react';

export interface AdminPaneHeaderProps {
  eyebrow: string;
  title: string;
  /** Optional right-aligned slot — typically a status badge or count. */
  badge?: ReactNode;
}

export function AdminPaneHeader({ eyebrow, title, badge }: AdminPaneHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4 px-8 pt-[18px] pb-4 border-b border-rule-soft">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[11px] tracking-[0.06em] uppercase text-muted-foreground font-medium">
          {eyebrow}
        </span>
        <span className="text-[19px] font-medium tracking-[-0.012em]">{title}</span>
      </div>
      {badge && <div className="flex items-center gap-3.5">{badge}</div>}
    </header>
  );
}
```

- [ ] **Step 2: Implement `AdminPane`**

```tsx
// packages/channel-web/src/components/admin/AdminPane.tsx
import type { ReactNode } from 'react';

export interface AdminPaneProps {
  header: ReactNode;
  children: ReactNode;
}

export function AdminPane({ header, children }: AdminPaneProps) {
  return (
    <main className="flex-1 flex flex-col min-w-0 font-sans antialiased">
      {header}
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-24">{children}</div>
    </main>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm --filter @ax/channel-web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/src/components/admin/AdminPane.tsx packages/channel-web/src/components/admin/AdminPaneHeader.tsx
git commit -m "feat(channel-web): add AdminPane + AdminPaneHeader composition"
```

---

### Task 1.4: Create `AdminShell` and wire into `App.tsx`

**Files:**
- Create: `packages/channel-web/src/components/admin/AdminShell.tsx`
- Create: `packages/channel-web/src/components/admin/__tests__/AdminShell.test.tsx`
- Modify: `packages/channel-web/src/App.tsx`
- Delete: `packages/channel-web/src/components/admin/AdminSettings.tsx`

The new `<AdminShell/>` replaces `<AdminSettings/>`. It owns the active-tab state internally (default `provider-keys`). When admin is open, the chat sidebar and main pane are unmounted; when closed, they re-mount with their existing state preserved by the assistant-ui runtime.

- [ ] **Step 1: Write failing test**

```tsx
// packages/channel-web/src/components/admin/__tests__/AdminShell.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminShell } from '../AdminShell';
import { UserProvider } from '@/lib/user-context';
import type { AuthUser } from '@/lib/auth';

const fakeUser: AuthUser = {
  id: 'u1',
  email: 'ana@example.co',
  displayName: 'Ana K.',
  isAdmin: true,
};

function renderShell(onClose = vi.fn()) {
  return render(
    <UserProvider value={fakeUser}>
      <AdminShell onClose={onClose} />
    </UserProvider>,
  );
}

describe('AdminShell', () => {
  it('renders all 5 nav items with provider-keys active by default', () => {
    renderShell();
    const nav = screen.getByRole('list');
    expect(within(nav).getByText('Provider keys')).toBeInTheDocument();
    expect(within(nav).getByText('Model config')).toBeInTheDocument();
    expect(within(nav).getByText('Agents')).toBeInTheDocument();
    expect(within(nav).getByText('MCP servers')).toBeInTheDocument();
    expect(within(nav).getByText('Teams')).toBeInTheDocument();
    const active = within(nav).getByRole('button', { name: 'Provider keys' });
    expect(active).toHaveAttribute('data-active');
  });

  it('clicking Model config makes it the active tab', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Model config' }));
    const nav = screen.getByRole('list');
    expect(within(nav).getByRole('button', { name: 'Model config' })).toHaveAttribute(
      'data-active',
    );
    expect(
      within(nav).getByRole('button', { name: 'Provider keys' }),
    ).not.toHaveAttribute('data-active');
  });

  it('clicking ← chat calls onClose', async () => {
    const onClose = vi.fn();
    renderShell(onClose);
    await userEvent.click(screen.getByRole('button', { name: /chat/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the user chip with the current user identity', () => {
    renderShell();
    expect(screen.getByText('Ana K.')).toBeInTheDocument();
    expect(screen.getByText('ana@example.co')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm --filter @ax/channel-web test AdminShell
```

Expected: FAIL — `AdminShell` doesn't exist yet.

- [ ] **Step 3: Implement `AdminShell`**

```tsx
// packages/channel-web/src/components/admin/AdminShell.tsx
import { useState } from 'react';
import { AdminSidebar, type AdminTabId } from './AdminSidebar';
import { AdminPane } from './AdminPane';
import { AdminPaneHeader } from './AdminPaneHeader';
import { ProviderKeysTab } from './ProviderKeysTab';
import { ModelConfigTab } from './ModelConfigTab';
import { AgentForm } from './AgentForm';
import { McpServerForm } from './McpServerForm';
import { TeamList } from './TeamList';

export interface AdminShellProps {
  onClose: () => void;
}

interface TabMeta {
  eyebrow: string;
  title: string;
}

const TAB_META: Record<AdminTabId, TabMeta> = {
  'provider-keys': { eyebrow: 'Admin', title: 'Provider keys' },
  'model-config': { eyebrow: 'Admin', title: 'Model config' },
  agents: { eyebrow: 'Admin', title: 'Agents' },
  'mcp-servers': { eyebrow: 'Admin', title: 'MCP servers' },
  teams: { eyebrow: 'Admin', title: 'Teams' },
};

export function AdminShell({ onClose }: AdminShellProps) {
  const [activeTab, setActiveTab] = useState<AdminTabId>('provider-keys');
  const meta = TAB_META[activeTab];

  return (
    <div className="flex h-full bg-background">
      <AdminSidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onBackToChat={onClose}
      />
      <AdminPane
        header={<AdminPaneHeader eyebrow={meta.eyebrow} title={meta.title} />}
      >
        {activeTab === 'provider-keys' && <ProviderKeysTab />}
        {activeTab === 'model-config' && <ModelConfigTab />}
        {activeTab === 'agents' && <AgentForm />}
        {activeTab === 'mcp-servers' && <McpServerForm />}
        {activeTab === 'teams' && <TeamList />}
      </AdminPane>
    </div>
  );
}
```

> The Tab content components (`ProviderKeysTab` etc.) are still on legacy CSS at this point — they'll be migrated in subsequent phases. The shell renders fine with mixed content.

- [ ] **Step 4: Update `App.tsx` to render `<AdminShell/>` instead of `<AdminSettings/>`**

Open `packages/channel-web/src/App.tsx`. Replace line 36:

```ts
import { AdminSettings } from './components/admin/AdminSettings';
```

with:

```ts
import { AdminShell } from './components/admin/AdminShell';
```

Replace the JSX block in `AppContent` (currently lines ~139–159):

```tsx
<div className="app-layout">
  <Sidebar
    onOpenAdminSettings={() => setAdminSettingsOpen(true)}
    onOpenSettings={() => setSettingsOpen(true)}
  />
  {sidebarOpen && (
    <div
      className="sidebar-scrim"
      onClick={() => setSidebarOpen(false)}
      aria-hidden="true"
    />
  )}
  <main className="pane">
    {adminSettingsOpen
      ? <AdminSettings onClose={() => setAdminSettingsOpen(false)} />
      : <>
          <SessionHeader />
          <Thread />
        </>
    }
  </main>
  <SettingsPanel
    open={settingsOpen}
    onClose={() => setSettingsOpen(false)}
  />
  <ToastStack />
</div>
```

with:

```tsx
<div className="app-layout">
  {adminSettingsOpen ? (
    <AdminShell onClose={() => setAdminSettingsOpen(false)} />
  ) : (
    <>
      <Sidebar
        onOpenAdminSettings={() => setAdminSettingsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {sidebarOpen && (
        <div
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <main className="pane">
        <SessionHeader />
        <Thread />
      </main>
    </>
  )}
  <SettingsPanel
    open={settingsOpen}
    onClose={() => setSettingsOpen(false)}
  />
  <ToastStack />
</div>
```

> Behavioral change: opening admin now unmounts the chat sidebar (per design §4.1). `SettingsPanel` still renders unconditionally because it's a modal-style overlay opened from the user-chip dropdown — preserved as today.

- [ ] **Step 5: Delete `AdminSettings.tsx`**

```bash
git rm packages/channel-web/src/components/admin/AdminSettings.tsx
```

- [ ] **Step 6: Run AdminShell test, verify PASS**

```bash
pnpm --filter @ax/channel-web test AdminShell
```

Expected: PASS.

- [ ] **Step 7: Run full test suite — note any failures from removed AdminSettings**

```bash
pnpm --filter @ax/channel-web test
```

Expected: any test that imports `AdminSettings` directly or queries by `.admin-settings-*` class will fail. Note them; they're fixed in Task 1.5.

- [ ] **Step 8: Commit**

```bash
git add packages/channel-web/src/App.tsx packages/channel-web/src/components/admin/AdminShell.tsx packages/channel-web/src/components/admin/__tests__/AdminShell.test.tsx
git rm packages/channel-web/src/components/admin/AdminSettings.tsx
git commit -m "feat(channel-web): replace AdminSettings with AdminShell (sidebar + pane)"
```

---

### Task 1.5: Update existing admin tests for new shell selectors

**Files (one or more, based on Task 1.4 Step 7 failures):**
- Modify: `packages/channel-web/src/components/admin/__tests__/admin-canary-banner.test.tsx`
- Possibly modify: any other test that imports `AdminSettings` or queries `.admin-settings-*`

The migration replaced legacy class names with utility classes + accessible roles. Tests that asserted on `.admin-settings-tabs li[data-active]` need to switch to role-based queries.

- [ ] **Step 1: Inspect each failing test from Task 1.4 Step 7**

For each failure:

- If it's a test of *behavior* on a tab content component (`ProviderKeysTab`, etc.), the test still works — the component is unchanged in Phase 1. The failure is likely an import path or selector to the AdminSettings shell. Update the import to render the relevant tab component directly (most tests already do).
- If it's the canary-banner test (`admin-canary-banner.test.tsx`), update its selector. The canary banner moves into `ProviderKeysTab` (or wherever its eventual home is in Phase 2). Until then, it's not rendered by `AdminShell`. **Defer to Phase 2 Task 2.3** — at that point, the banner relocates and the test selector updates with it.

For the immediate Phase 1 fix: any test that imports the deleted `AdminSettings` becomes a render-on-the-tab-directly test.

- [ ] **Step 2: Update each failing test**

Example pattern: if a test rendered `<AdminSettings onClose={…} />` and queried `[role="tab"][aria-selected="true"]`, switch to rendering `<AdminShell onClose={…} />` wrapped in `<UserProvider/>` and query the nav `<button data-active>` instead.

For tests that exercise tab-content behavior only, render the tab component directly with no shell wrapper:

```tsx
import { render } from '@testing-library/react';
import { ProviderKeysTab } from '../ProviderKeysTab';

render(<ProviderKeysTab />);
// then assert on whatever this test originally asserted on
```

- [ ] **Step 3: Run full test suite**

```bash
pnpm --filter @ax/channel-web test
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/src/components/admin/__tests__
git commit -m "test(admin): update test selectors for AdminShell"
```

---

## PHASE 2 — Provider keys migration

### Task 2.1: Create `ProviderRow`

**Files:**
- Create: `packages/channel-web/src/components/admin/ProviderRow.tsx`
- Create: `packages/channel-web/src/components/admin/__tests__/ProviderRow.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// packages/channel-web/src/components/admin/__tests__/ProviderRow.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderRow } from '../ProviderRow';

describe('ProviderRow', () => {
  it('renders empty state with Add key button', async () => {
    const onEdit = vi.fn();
    render(
      <ProviderRow
        mark="An"
        name="Anthropic"
        status="empty"
        onEdit={onEdit}
      />,
    );
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /add key/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('renders configured state with masked stub and Edit button', () => {
    render(
      <ProviderRow
        mark="An"
        name="Anthropic"
        status="ok"
        keyStub="sk-ant-•••••••••3c2f"
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('sk-ant-•••••••••3c2f')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit key/i })).toBeInTheDocument();
  });

  it('renders error state', () => {
    render(
      <ProviderRow
        mark="An"
        name="Anthropic"
        status="bad"
        statusLabel="Key rejected by provider"
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByText('Key rejected by provider')).toBeInTheDocument();
  });

  it('renders an editing form in the body slot', () => {
    render(
      <ProviderRow
        mark="An"
        name="Anthropic"
        status="empty"
        statusLabel="Adding key…"
        editing
        body={<div data-testid="key-form-slot">form here</div>}
      />,
    );
    expect(screen.getByTestId('key-form-slot')).toBeInTheDocument();
    // While editing, the Edit/Add button is hidden.
    expect(screen.queryByRole('button', { name: /add key/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm --filter @ax/channel-web test ProviderRow
```

Expected: FAIL — `ProviderRow` doesn't exist.

- [ ] **Step 3: Implement `ProviderRow`**

```tsx
// packages/channel-web/src/components/admin/ProviderRow.tsx
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { StatusDot, type StatusDotVariant } from './StatusDot';
import { cn } from '@/lib/utils';

export interface ProviderRowProps {
  /** Two-letter mark (e.g., 'An', 'OA'). */
  mark: string;
  name: string;
  status: StatusDotVariant;
  /** Override the default label for the status (e.g., 'Adding key…'). */
  statusLabel?: string;
  /** Configured masked key stub. */
  keyStub?: string;
  /** When true, the action button is hidden and `body` is rendered below the head. */
  editing?: boolean;
  /** Inline form (typically `<KeyForm/>`) rendered when editing. */
  body?: ReactNode;
  onEdit?: () => void;
}

const DEFAULT_LABEL: Record<StatusDotVariant, string> = {
  empty: 'Not configured',
  ok: 'Configured',
  bad: 'Error',
  pending: 'Validating…',
};

export function ProviderRow({
  mark,
  name,
  status,
  statusLabel,
  keyStub,
  editing,
  body,
  onEdit,
}: ProviderRowProps) {
  const label = statusLabel ?? DEFAULT_LABEL[status];
  const buttonVariant = status === 'ok' ? 'outline' : 'default';
  const buttonLabel = status === 'ok' ? 'Edit key' : 'Add key';

  return (
    <div className="border-b border-rule-soft last:border-b-0 py-[1.125rem]">
      <div className="flex items-center gap-3.5">
        <span className="w-8 h-8 rounded-md bg-muted inline-flex items-center justify-center text-[13px] font-medium text-foreground/75 shrink-0 tracking-[-0.01em]">
          {mark}
        </span>
        <span className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[15px] font-medium tracking-[-0.01em] leading-tight">
            {name}
          </span>
          <span className="inline-flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <StatusDot variant={status} />
            <span className={cn(status === 'bad' && 'text-destructive')}>{label}</span>
            {keyStub && (
              <>
                <span aria-hidden="true" className="opacity-40">·</span>
                <span className="font-mono text-[11.5px] tracking-[0.05em]">
                  {keyStub}
                </span>
              </>
            )}
          </span>
        </span>
        {!editing && onEdit && (
          <Button
            type="button"
            variant={buttonVariant}
            size="default"
            onClick={onEdit}
          >
            {buttonLabel}
          </Button>
        )}
      </div>
      {editing && body}
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm --filter @ax/channel-web test ProviderRow
```

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/admin/ProviderRow.tsx packages/channel-web/src/components/admin/__tests__/ProviderRow.test.tsx
git commit -m "feat(channel-web): add ProviderRow with status variants"
```

---

### Task 2.2: Create `KeyForm`

**Files:**
- Create: `packages/channel-web/src/components/admin/KeyForm.tsx`

`KeyForm` is the inline edit/add form that lives inside an editing `<ProviderRow/>`. It's the merged successor to the deleted `ProviderKeyForm.tsx`.

- [ ] **Step 1: Implement `KeyForm`**

```tsx
// packages/channel-web/src/components/admin/KeyForm.tsx
import { useState, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface KeyFormProps {
  /** Placeholder for the key input. */
  placeholder?: string;
  /** Aria label for the key input. */
  inputLabel?: string;
  /** Validation error returned by the backend. */
  error?: string;
  /** True while the parent is awaiting a save round-trip. */
  saving?: boolean;
  /** Optional helper line shown to the right of the actions (e.g., "Get a key at console.anthropic.com"). */
  helperRight?: ReactNode;
  onSave: (key: string) => void | Promise<void>;
  onCancel: () => void;
}

export function KeyForm({
  placeholder = 'Paste your API key',
  inputLabel = 'API key',
  error,
  saving,
  helperRight,
  onSave,
  onCancel,
}: KeyFormProps) {
  const [key, setKey] = useState('');
  const trimmed = key.trim();

  return (
    <div className="mt-3.5 p-3.5 bg-muted border border-rule-soft rounded-lg flex flex-col gap-2.5 animate-form-in">
      <Input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={placeholder}
        aria-label={inputLabel}
        disabled={saving}
        className="font-mono text-[13px] tracking-[0.02em]"
      />
      {error && (
        <div
          role="alert"
          className={cn(
            'inline-flex items-center gap-2 px-2.5 py-2 self-start',
            'bg-destructive-soft border border-destructive/25 rounded-md',
            'text-[12.5px] text-destructive',
          )}
        >
          <AlertCircle className="w-3 h-3 shrink-0" strokeWidth={2.5} />
          <span>{error}</span>
        </div>
      )}
      <div className="flex gap-2 items-center">
        <Button
          type="button"
          onClick={() => void onSave(trimmed)}
          disabled={saving || trimmed.length === 0}
        >
          {saving ? 'Validating…' : error ? 'Retry' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        {helperRight && (
          <span className="ml-auto text-[11.5px] text-muted-foreground">
            {helperRight}
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter @ax/channel-web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/channel-web/src/components/admin/KeyForm.tsx
git commit -m "feat(channel-web): add KeyForm (inline key entry with error alert)"
```

---

### Task 2.3: Migrate `ProviderKeysTab` to use `ProviderRow` + `KeyForm`

**Files:**
- Modify: `packages/channel-web/src/components/admin/ProviderKeysTab.tsx`
- Delete: `packages/channel-web/src/components/admin/ProviderKeyForm.tsx`
- Modify: `packages/channel-web/src/components/admin/__tests__/admin-canary-banner.test.tsx` (selector update — banner now lives in this tab)
- Modify: `packages/channel-web/src/components/admin/AdminShell.tsx` (canary banner moves out of the shell-level chrome — see Task 1.4; if the banner was rendered above tab content in the shell, move it into ProviderKeysTab)

The behavior contract is unchanged: fetch providers on mount, click Add → expand inline form, paste key → POST validates, on success refetch + collapse, on failure show error alert + retry. We're swapping the visual layer.

- [ ] **Step 1: Rewrite `ProviderKeysTab.tsx`**

```tsx
// packages/channel-web/src/components/admin/ProviderKeysTab.tsx
/**
 * ProviderKeysTab — provider list with validation states.
 *
 * Behavior contract preserved from the legacy implementation:
 *   - GET /admin/credentials/providers on mount.
 *   - One row open at a time; opening a row collapses any other.
 *   - Save validates against the provider; success refetches + collapses,
 *     failure shows an inline destructive Alert + flips the action button to "Retry".
 */
import { useEffect, useRef, useState } from 'react';
import { listProviders, validateProviderKey, type ProviderEntry } from '@/lib/providers';
import { ProviderRow } from './ProviderRow';
import { KeyForm } from './KeyForm';
import type { StatusDotVariant } from './StatusDot';

const PROVIDER_HELPER: Record<string, string> = {
  anthropic: 'console.anthropic.com',
  openai: 'platform.openai.com/api-keys',
};

function providerMark(name: string): string {
  // Two-letter mark from the provider name (e.g., 'Anthropic' → 'An').
  return name.slice(0, 2);
}

export function ProviderKeysTab() {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const editingIdRef = useRef<string | null>(null);

  const fetchProviders = async () => {
    try {
      const list = await listProviders();
      setProviders(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchProviders();
  }, []);

  const handleEdit = (providerId: string) => {
    setRowError({});
    setEditingId(providerId);
    editingIdRef.current = providerId;
  };

  const handleCancel = (providerId: string) => {
    setEditingId(null);
    editingIdRef.current = null;
    setRowError((prev) => ({ ...prev, [providerId]: '' }));
  };

  const handleSave = async (provider: ProviderEntry, key: string) => {
    setValidating(true);
    try {
      await validateProviderKey(provider.id, key);
      if (editingIdRef.current !== provider.id) {
        setValidating(false);
        return;
      }
      const list = await listProviders();
      setProviders(list);
      setEditingId(null);
      editingIdRef.current = null;
      setRowError((prev) => ({ ...prev, [provider.id]: '' }));
    } catch (err) {
      setValidating(false);
      if (editingIdRef.current !== provider.id) return;
      setRowError((prev) => ({
        ...prev,
        [provider.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <CanaryAdvisory />

      <div className="mb-5">
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">
          Provider keys
        </h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Manage shared API keys for the model providers wired into this deployment.
          Keys are encrypted at rest and never returned in plaintext.
        </p>
      </div>

      {loading && <div className="text-sm text-muted-foreground">Loading providers…</div>}

      {loadError && (
        <div
          role="alert"
          className="px-3 py-2 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive"
        >
          Couldn't load providers: {loadError}
        </div>
      )}

      {!loading && !loadError && providers.length === 0 && (
        <div className="text-sm text-muted-foreground">
          No providers registered. Wire one in via{' '}
          <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            credentials:list-providers
          </code>
          .
        </div>
      )}

      <div className="flex flex-col">
        {providers.map((provider) => {
          const isEditing = editingId === provider.id;
          const error = rowError[provider.id];
          const status: StatusDotVariant = error
            ? 'bad'
            : provider.configured
              ? 'ok'
              : 'empty';

          const statusLabel = error
            ? 'Key rejected by provider'
            : isEditing
              ? 'Adding key…'
              : provider.configured
                ? 'Configured'
                : 'Not configured';

          return (
            <ProviderRow
              key={provider.id}
              mark={providerMark(provider.name)}
              name={provider.name}
              status={status}
              statusLabel={statusLabel}
              keyStub={provider.configured && !isEditing ? 'key ••••••••' : undefined}
              editing={isEditing}
              {...(!isEditing && { onEdit: () => handleEdit(provider.id) })}
              body={
                isEditing && (
                  <KeyForm
                    placeholder={`Paste your ${provider.name} API key`}
                    inputLabel={`${provider.name} API key`}
                    error={error || undefined}
                    saving={validating}
                    helperRight={
                      PROVIDER_HELPER[provider.id] ? (
                        <>
                          Get a key at{' '}
                          <a
                            href={`https://${PROVIDER_HELPER[provider.id]}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            {PROVIDER_HELPER[provider.id]}
                          </a>
                        </>
                      ) : undefined
                    }
                    onSave={(key) => handleSave(provider, key)}
                    onCancel={() => handleCancel(provider.id)}
                  />
                )
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function CanaryAdvisory() {
  return (
    <div
      role="status"
      data-testid="canary-advisory"
      className="mb-6 flex gap-2.5 items-start p-3.5 bg-muted border border-border rounded-lg text-[13px] leading-[1.5] text-muted-foreground"
    >
      <span className="shrink-0 font-mono text-[10px] tracking-[0.12em] uppercase text-muted-foreground bg-background border border-border px-1.5 py-0.5 rounded mt-px">
        Advisory
      </span>
      <span className="flex-1">
        Canary scanner isn't wired in yet — this deployment has no automated
        secret-leak veto and no LLM-output redaction. Internal use only.{' '}
        Tracked for Week&nbsp;13+.
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Delete the standalone `ProviderKeyForm.tsx`**

```bash
git rm packages/channel-web/src/components/admin/ProviderKeyForm.tsx
```

- [ ] **Step 3: Update `admin-canary-banner.test.tsx` to find the advisory by its testid**

The banner moved from the shell into `ProviderKeysTab`. Update the test to render `<ProviderKeysTab />` (or `<AdminShell />` with the default `provider-keys` tab) and query `getByTestId('canary-advisory')` or `getByText(/canary scanner isn't wired in yet/i)`.

Example revised test (only the relevant change):

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProviderKeysTab } from '../ProviderKeysTab';
import { vi } from 'vitest';
import * as providers from '@/lib/providers';

describe('canary advisory banner', () => {
  it('renders advisory copy on the provider-keys tab', async () => {
    vi.spyOn(providers, 'listProviders').mockResolvedValue([]);
    render(<ProviderKeysTab />);
    expect(await screen.findByTestId('canary-advisory')).toBeInTheDocument();
    expect(
      screen.getByText(/canary scanner isn't wired in yet/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/internal use only/i)).toBeInTheDocument();
  });
});
```

(If the original test had a more specific assertion — e.g., on the "Tracked for Week 13+" string — preserve it.)

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ax/channel-web test
```

Expected: green. Investigate any other failure that uses a legacy class selector against the migrated tab and update it to a role-based or text-based query.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/admin/ProviderKeysTab.tsx packages/channel-web/src/components/admin/__tests__/admin-canary-banner.test.tsx
git rm packages/channel-web/src/components/admin/ProviderKeyForm.tsx
git commit -m "refactor(admin-settings): migrate provider keys to shadcn (ProviderRow + KeyForm)"
```

---

## PHASE 3 — Model config migration

### Task 3.1: Create `RoleCard`

**Files:**
- Create: `packages/channel-web/src/components/admin/RoleCard.tsx`

- [ ] **Step 1: Implement `RoleCard`**

```tsx
// packages/channel-web/src/components/admin/RoleCard.tsx
import type { ReactNode } from 'react';

export interface RoleCardProps {
  /** Short uppercase role tag (e.g., 'fast', 'runner'). Mono. */
  pill: string;
  title: string;
  caption: string;
  /** The interactive content — typically a select/combobox. */
  children: ReactNode;
}

export function RoleCard({ pill, title, caption, children }: RoleCardProps) {
  return (
    <div className="p-5 border border-rule-soft rounded-xl bg-card flex flex-col gap-3 transition-colors hover:border-border">
      <div className="flex items-start gap-3.5">
        <span className="shrink-0 font-mono text-[10.5px] tracking-[0.1em] uppercase text-muted-foreground bg-muted border border-rule-soft px-2 py-1 rounded leading-tight">
          {pill}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-medium tracking-[-0.01em] mb-0.5">
            {title}
          </div>
          <div className="text-[13px] leading-[1.5] text-muted-foreground">
            {caption}
          </div>
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter @ax/channel-web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/channel-web/src/components/admin/RoleCard.tsx
git commit -m "feat(channel-web): add RoleCard (Tide role-card composition)"
```

---

### Task 3.2: Create `ModelCombobox`

**Files:**
- Create: `packages/channel-web/src/components/admin/ModelCombobox.tsx`
- Create: `packages/channel-web/src/components/admin/__tests__/ModelCombobox.test.tsx`

`ModelCombobox` is a cmdk-backed combobox that matches Tide Scene 07: provider-grouped options, search-on-open, keyboard hint footer, and selected-state checkmark. Built on the shadcn `Command` primitive plus `Popover`/`Dialog` for the open state.

> Note: shadcn doesn't ship a "Combobox" by name — it's a documented composition of `Popover` + `Command`. We open it as a popover for inline use inside `RoleCard`.

- [ ] **Step 1: Add shadcn `popover` primitive (if not already added in Phase 0)**

```bash
cd packages/channel-web && pnpm dlx shadcn@latest add -y popover
```

If the file already exists, skip.

- [ ] **Step 2: Write failing test**

```tsx
// packages/channel-web/src/components/admin/__tests__/ModelCombobox.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelCombobox } from '../ModelCombobox';

const groups = [
  {
    providerName: 'Anthropic',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
];

describe('ModelCombobox', () => {
  it('renders the disabled trigger when no providers are configured', () => {
    render(
      <ModelCombobox
        ariaLabel="Fast model"
        groups={[]}
        value=""
        onChange={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByRole('button', { name: /fast model/i })).toBeDisabled();
  });

  it('clicking the trigger opens the popover with grouped options', async () => {
    render(
      <ModelCombobox
        ariaLabel="Fast model"
        groups={groups}
        value=""
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /fast model/i }));
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-4-7')).toBeInTheDocument();
  });

  it('selecting an option calls onChange with the model id and closes', async () => {
    const onChange = vi.fn();
    render(
      <ModelCombobox
        ariaLabel="Runner model"
        groups={groups}
        value=""
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /runner model/i }));
    await userEvent.click(screen.getByText('claude-sonnet-4-6'));
    expect(onChange).toHaveBeenCalledWith('claude-sonnet-4-6');
  });

  it('typing into the search input filters options', async () => {
    render(
      <ModelCombobox
        ariaLabel="Fast model"
        groups={groups}
        value=""
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /fast model/i }));
    await userEvent.type(screen.getByPlaceholderText(/search/i), 'haiku');
    expect(screen.getByText(/claude-haiku-4-5-20251001/)).toBeInTheDocument();
    expect(screen.queryByText('claude-opus-4-7')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test, verify FAIL**

```bash
pnpm --filter @ax/channel-web test ModelCombobox
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `ModelCombobox`**

```tsx
// packages/channel-web/src/components/admin/ModelCombobox.tsx
import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ModelComboboxGroup {
  providerName: string;
  models: string[];
}

export interface ModelComboboxProps {
  ariaLabel: string;
  groups: ModelComboboxGroup[];
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ModelCombobox({
  ariaLabel,
  groups,
  value,
  onChange,
  disabled,
  placeholder = '— Select a model —',
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            'w-full justify-between font-mono text-[13px] tracking-[0.02em]',
            !value && 'text-muted-foreground',
          )}
        >
          {value || placeholder}
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
        <Command>
          <CommandInput placeholder="Search or pick a model…" />
          <CommandList>
            <CommandEmpty>No model matches.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.providerName} heading={group.providerName}>
                {group.models.map((model) => (
                  <CommandItem
                    key={model}
                    value={model}
                    onSelect={(selected) => {
                      onChange(selected);
                      setOpen(false);
                    }}
                    className="font-mono text-[12.5px]"
                  >
                    <span className="flex-1">{model}</span>
                    {value === model && (
                      <Check className="h-3.5 w-3.5 text-primary" strokeWidth={2.5} />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 5: Run test, verify PASS**

```bash
pnpm --filter @ax/channel-web test ModelCombobox
```

Expected: PASS (4/4). If a test fails because Radix's `Popover` requires `pointer-events` in JSDOM, add `import '@testing-library/jest-dom';` to the test file's imports (already a global setup if `test-setup.ts` is configured) and ensure `userEvent.setup()` is used.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/admin/ModelCombobox.tsx packages/channel-web/src/components/admin/__tests__/ModelCombobox.test.tsx packages/channel-web/src/components/ui/popover.tsx
git commit -m "feat(channel-web): add ModelCombobox (cmdk + popover)"
```

---

### Task 3.3: Migrate `ModelConfigTab` to use `RoleCard` + `ModelCombobox`

**Files:**
- Modify: `packages/channel-web/src/components/admin/ModelConfigTab.tsx`

- [ ] **Step 1: Rewrite `ModelConfigTab.tsx`**

```tsx
// packages/channel-web/src/components/admin/ModelConfigTab.tsx
/**
 * ModelConfigTab — searchable model pickers per role.
 *
 * Behavior contract preserved from the legacy implementation:
 *   - Fetch listProviders() on mount.
 *   - Show only configured providers.
 *   - On Save, write each non-empty selection as a credential
 *     (scope='global', ownerId=null, ref=role.ref, kind='setting',
 *     payload=selectedModel).
 *   - Empty selections are silently skipped.
 */
import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { listProviders, type ProviderEntry } from '@/lib/providers';
import { adminCredentials } from '@/lib/credentials';
import { Button } from '@/components/ui/button';
import { RoleCard } from './RoleCard';
import { ModelCombobox, type ModelComboboxGroup } from './ModelCombobox';

const ROLES = [
  {
    id: 'fast-model',
    pill: 'fast',
    label: 'Fast / cheap model',
    ref: 'setting.fast-model',
    description:
      'Used for conversation titles, quick classification, low-latency tasks.',
  },
  {
    id: 'runner-model',
    pill: 'runner',
    label: 'Agent runner model',
    ref: 'setting.runner-model',
    description: 'Used for all agent sessions via the Claude SDK runner.',
  },
] as const;

export function ModelConfigTab() {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listProviders();
        if (cancelled) return;
        setProviders(list);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (savedTimeoutRef.current !== null) {
        clearTimeout(savedTimeoutRef.current);
        savedTimeoutRef.current = null;
      }
    };
  }, []);

  const configured = providers.filter((p) => p.configured);
  const noProviders = configured.length === 0;
  const groups: ModelComboboxGroup[] = configured.map((p) => ({
    providerName: p.name,
    models: p.models,
  }));

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    if (savedTimeoutRef.current !== null) {
      clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = null;
    }
    try {
      for (const role of ROLES) {
        const selectedModel = selectedModels[role.ref];
        if (!selectedModel) continue;
        await adminCredentials.create({
          scope: 'global',
          ownerId: null,
          ref: role.ref,
          kind: 'setting',
          payload: selectedModel,
        });
      }
      setSavedOk(true);
      savedTimeoutRef.current = setTimeout(() => {
        setSavedOk(false);
        savedTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const hasAnySelection = ROLES.some((r) => selectedModels[r.ref]);

  if (loadError !== null) {
    return (
      <div
        role="alert"
        className="px-3 py-2 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive max-w-[640px] mx-auto"
      >
        Couldn't load providers: {loadError}
      </div>
    );
  }

  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <div className="mb-5">
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">
          Model configuration
        </h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Pick which model handles each role. Only providers with a configured key
          appear here.
        </p>
      </div>

      {noProviders && (
        <div className="flex items-start gap-2.5 p-3.5 bg-primary-soft border border-primary/20 rounded-lg text-[13px] leading-[1.5] text-foreground/80 mb-4">
          <Info
            className="w-4 h-4 rounded-full bg-primary text-primary-foreground p-px shrink-0 mt-px"
            strokeWidth={3}
          />
          <span>
            Configure a provider key first, then come back here to choose models.
          </span>
        </div>
      )}

      <div className="flex flex-col gap-3.5">
        {ROLES.map((role) => (
          <RoleCard
            key={role.id}
            pill={role.pill}
            title={role.label}
            caption={role.description}
          >
            <ModelCombobox
              ariaLabel={role.label}
              groups={groups}
              value={selectedModels[role.ref] ?? ''}
              onChange={(model) =>
                setSelectedModels((prev) => ({ ...prev, [role.ref]: model }))
              }
              disabled={noProviders}
              placeholder={
                noProviders ? '— Configure a provider first —' : '— Select a model —'
              }
            />
            {selectedModels[role.ref] && (
              <span className="flex items-center gap-1.5 mt-2 text-[11.5px] text-muted-foreground">
                Currently ·{' '}
                <code className="font-mono text-[11.5px] text-primary tracking-[0.02em]">
                  {selectedModels[role.ref]}
                </code>
              </span>
            )}
          </RoleCard>
        ))}
      </div>

      <div className="mt-6 pt-4 border-t border-rule-soft flex items-center gap-3">
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !hasAnySelection}
        >
          {saving ? 'Saving…' : savedOk ? '✓ Saved' : 'Save changes'}
        </Button>
        {!hasAnySelection && !saving && !savedOk && !saveError && (
          <span className="text-[12.5px] text-muted-foreground">
            Pick a model above to enable save.
          </span>
        )}
        {savedOk && (
          <span className="text-[12.5px] text-muted-foreground">
            Changes apply on the next session start.
          </span>
        )}
        {saveError && (
          <div
            role="alert"
            className="px-2.5 py-1.5 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive"
          >
            {saveError}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run all tests**

```bash
pnpm --filter @ax/channel-web test
```

Expected: green. If any prior model-config test queries by `select` element directly, update it to query the combobox button by its aria-label.

- [ ] **Step 3: Commit**

```bash
git add packages/channel-web/src/components/admin/ModelConfigTab.tsx
git commit -m "refactor(admin-settings): migrate model config to RoleCard + ModelCombobox"
```

---

## PHASE 4 — Other admin views (Agents, MCP, Teams)

> The three remaining admin tabs all follow the same visual recipe: **list of `<RoleCard/>`-style rows; click a row to expand an inline form (or open a `<Dialog/>` for Teams)**. Tide doesn't render these — see design §4.4 for the extrapolation calls. The behavior contract of each form is preserved exactly.

### Task 4.1: Migrate `AgentForm`

**Files:**
- Modify: `packages/channel-web/src/components/admin/AgentForm.tsx` (415 lines today — full rewrite of the visual layer; preserve all handlers, state machine, and API wiring)
- Possibly modify: `packages/channel-web/src/components/admin/__tests__/admin-agents.test.tsx` (selector update only)

- [ ] **Step 1: Read the existing `AgentForm.tsx` end to end**

```bash
cat packages/channel-web/src/components/admin/AgentForm.tsx
```

Identify:
- The state machine (loading / list view / create form / edit form / saving / error states).
- All handler functions and the API calls they make.
- The set of form fields per agent.

These all carry forward unchanged into the migrated version.

- [ ] **Step 2: Rewrite the visual layer with shadcn primitives**

Replace each rendered surface with the following pattern. Skeleton for the list view:

```tsx
// inside AgentForm.tsx, list-view return
return (
  <div className="max-w-[640px] mx-auto font-sans">
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">Agents</h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Define the agents available across this deployment.
        </p>
      </div>
      <Button onClick={() => setMode('create')}>New agent</Button>
    </div>

    {loading && <div className="text-sm text-muted-foreground">Loading agents…</div>}
    {loadError && (
      <div role="alert" className="px-3 py-2 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive">
        {loadError}
      </div>
    )}

    <div className="flex flex-col gap-3.5">
      {agents.map((agent) => (
        <RoleCard
          key={agent.id}
          pill="agent"
          title={agent.name}
          caption={agent.description ?? '—'}
        >
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => handleEdit(agent.id)}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleDelete(agent.id)}>
              Delete
            </Button>
          </div>
        </RoleCard>
      ))}
    </div>
  </div>
);
```

Skeleton for the create / edit form view (same shape, different submit handler):

```tsx
return (
  <div className="max-w-[640px] mx-auto font-sans">
    <div className="mb-5 flex items-center gap-3">
      <Button variant="ghost" size="sm" onClick={() => setMode('list')}>← Back</Button>
      <h2 className="text-2xl font-medium tracking-[-0.018em]">
        {mode === 'create' ? 'New agent' : `Edit ${draft.name}`}
      </h2>
    </div>

    <Card className="p-5">
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="agent-name">Name</Label>
          <Input
            id="agent-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="agent-desc">Description</Label>
          <Input
            id="agent-desc"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </div>
        {/* …repeat for each field the existing form has — system prompt, model, etc. */}

        {saveError && (
          <div role="alert" className="px-2.5 py-2 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive">
            {saveError}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save agent'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode('list')}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  </div>
);
```

Required imports at the top of the file:

```tsx
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { RoleCard } from './RoleCard';
```

Remove all `className="agent-form-*"` legacy class strings. Remove any remaining JSX from the legacy version that's no longer reachable.

> The existing form has more fields than the skeleton shows (system prompt, default model, capabilities). Carry every field forward — wrap each in the same `<div class="flex flex-col gap-2"><Label/><Input/></div>` (or `<Textarea/>`, which we add via `pnpm dlx shadcn@latest add -y textarea` if any field is multi-line) idiom.

- [ ] **Step 3: If a `<Textarea/>` is needed, add the primitive**

```bash
cd packages/channel-web && pnpm dlx shadcn@latest add -y textarea
```

- [ ] **Step 4: Run admin-agents tests**

```bash
pnpm --filter @ax/channel-web test admin-agents
```

If failures are pure-selector (e.g., `.agent-form-name`), update them to use `getByLabelText('Name')` etc.

- [ ] **Step 5: Run full test suite**

```bash
pnpm --filter @ax/channel-web test
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/admin/AgentForm.tsx packages/channel-web/src/components/admin/__tests__/admin-agents.test.tsx packages/channel-web/src/components/ui
git commit -m "refactor(admin-settings): migrate agent form to shadcn"
```

---

### Task 4.2: Migrate `McpServerForm`

**Files:**
- Modify: `packages/channel-web/src/components/admin/McpServerForm.tsx`
- Possibly modify: `packages/channel-web/src/components/admin/__tests__/admin-mcp.test.tsx`

- [ ] **Step 1: Apply the same recipe as Task 4.1**

Use the list-view + form-view skeleton from Task 4.1. The MCP form has its own field set (server URL, auth scheme, allowed tools list, status probe state) — carry every field forward, swap the wrapper to shadcn `<Card/>`, fields to `<Label/>` + `<Input/>` (or `<Select/>` for enum fields), action buttons to `<Button/>`.

Each MCP server row in the list view uses `<RoleCard pill="mcp" title={server.name} caption={server.url}>` with a `<StatusDot variant=…/>` somewhere inside (typically next to the action buttons, indicating reachability).

- [ ] **Step 2: Run admin-mcp tests**

```bash
pnpm --filter @ax/channel-web test admin-mcp
```

Update selectors as needed.

- [ ] **Step 3: Run full test suite**

```bash
pnpm --filter @ax/channel-web test
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/src/components/admin/McpServerForm.tsx packages/channel-web/src/components/admin/__tests__/admin-mcp.test.tsx
git commit -m "refactor(admin-settings): migrate MCP server form to shadcn"
```

---

### Task 4.3: Migrate `TeamList`

**Files:**
- Modify: `packages/channel-web/src/components/admin/TeamList.tsx`
- Possibly modify: `packages/channel-web/src/components/admin/__tests__/admin-teams.test.tsx`

- [ ] **Step 1: Rewrite `TeamList.tsx` with `<RoleCard/>` + `<Dialog/>` for member edit**

```tsx
// packages/channel-web/src/components/admin/TeamList.tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { listTeams, type Team } from '@/lib/teams';
import { RoleCard } from './RoleCard';

export function TeamList() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listTeams();
        if (!cancelled) setTeams(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <div className="mb-5">
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">Teams</h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Group users so an agent can be scoped to a team rather than a person.
        </p>
      </div>

      {teams === null && !error && (
        <div className="text-sm text-muted-foreground">Loading teams…</div>
      )}
      {error && (
        <div role="alert" className="px-3 py-2 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3.5">
        {teams?.map((team) => (
          <RoleCard
            key={team.id}
            pill="team"
            title={team.name}
            caption={`${team.memberIds.length} ${team.memberIds.length === 1 ? 'member' : 'members'}`}
          >
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditingTeam(team)}>
                Edit members
              </Button>
            </div>
          </RoleCard>
        ))}
      </div>

      <Dialog open={editingTeam !== null} onOpenChange={(open) => !open && setEditingTeam(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingTeam?.name}</DialogTitle>
            <DialogDescription>
              Add or remove members. Changes save when you click Done.
            </DialogDescription>
          </DialogHeader>
          {/* member list editor — preserve whatever the legacy implementation rendered. */}
          <DialogFooter>
            <Button onClick={() => setEditingTeam(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

> Behavior preserved: the legacy `TeamList` was a placeholder per the chat-ui plan. If member editing is unimplemented, leave the dialog body as a placeholder comment with a TODO matching the existing TODO. **Do not introduce new behavior that wasn't in the legacy version.**

- [ ] **Step 2: Run admin-teams tests**

```bash
pnpm --filter @ax/channel-web test admin-teams
```

Update selectors as needed.

- [ ] **Step 3: Run full test suite**

```bash
pnpm --filter @ax/channel-web test
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/src/components/admin/TeamList.tsx packages/channel-web/src/components/admin/__tests__/admin-teams.test.tsx
git commit -m "refactor(admin-settings): migrate team list to shadcn (RoleCard + Dialog)"
```

---

## PHASE 5 — Settings panel + Credentials

### Task 5.1: Migrate `CredentialsList` + `ApiKeyForm` + `OAuthFlowForm` + `CredentialAddMenu`

**Files:**
- Modify: `packages/channel-web/src/components/credentials/CredentialsList.tsx`
- Modify: `packages/channel-web/src/components/credentials/ApiKeyForm.tsx`
- Modify: `packages/channel-web/src/components/credentials/OAuthFlowForm.tsx`
- Modify: `packages/channel-web/src/components/credentials/CredentialAddMenu.tsx`

The credentials view becomes a `<ProviderRow/>`-style list (per design §4.4). The add-menu becomes a shadcn `<DropdownMenu/>` triggered from a primary `<Button/>`. Inline forms keep their behavior; only the visual layer changes.

- [ ] **Step 1: Rewrite `CredentialsList.tsx`**

Replace the existing `<table>` with a `<ProviderRow/>`-style list. Each row's `mark` is two letters from the credential `kind` (e.g., `api-key` → "AP", `anthropic-oauth` → "AO"). Status dot variant: `ok` for any present credential. Action buttons: `Edit` and `Delete`.

```tsx
// packages/channel-web/src/components/credentials/CredentialsList.tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { adminCredentials, myCredentials, type CredentialMeta } from '@/lib/credentials';
import { ProviderRow } from '../admin/ProviderRow';

function markFor(kind: string): string {
  // Take first letter of each segment of the kind, up to 2. e.g., 'anthropic-oauth' → 'AO'.
  const parts = kind.split('-');
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return kind.slice(0, 2).toUpperCase();
}

export function CredentialsList({ variant }: { variant: 'admin' | 'user' }) {
  const [list, setList] = useState<CredentialMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = variant === 'admin' ? adminCredentials : myCredentials;

  async function reload() {
    setError(null);
    try {
      setList(await client.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function onDelete(c: CredentialMeta) {
    if (!confirm(`Delete credential "${c.ref}"? This cannot be undone.`)) return;
    try {
      if (variant === 'admin')
        await adminCredentials.delete({ scope: c.scope, ownerId: c.ownerId, ref: c.ref });
      else await myCredentials.delete(c.ref);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (list === null && error === null) {
    return <div className="text-sm text-muted-foreground">Loading credentials…</div>;
  }
  if (error !== null) {
    return (
      <div role="alert" className="px-3 py-2 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive">
        {error}
      </div>
    );
  }

  if (list!.length === 0) {
    return <div className="text-sm text-muted-foreground">No credentials yet.</div>;
  }

  return (
    <div className="flex flex-col">
      {list!.map((c) => {
        const subtitle = `${c.scope}${c.ownerId ? ` · ${c.ownerId}` : ''} · ${c.kind}`;
        return (
          <div
            key={`${c.scope}:${c.ownerId ?? '_'}:${c.ref}`}
            className="border-b border-rule-soft last:border-b-0 py-[1.125rem] flex items-center gap-3.5"
          >
            <span className="w-8 h-8 rounded-md bg-muted inline-flex items-center justify-center text-[13px] font-medium text-foreground/75 shrink-0">
              {markFor(c.kind)}
            </span>
            <span className="flex flex-col gap-0.5 flex-1 min-w-0">
              <span className="text-[15px] font-medium tracking-[-0.01em]">{c.ref}</span>
              <span className="text-[12.5px] text-muted-foreground font-mono tracking-[0.02em]">
                {subtitle}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Delete ${c.ref}`}
              onClick={() => onDelete(c)}
            >
              Delete
            </Button>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `ApiKeyForm.tsx`**

Same recipe as `KeyForm` from Phase 2 — use `<Input/>` for the secret, `<Label/>` + `<Select/>` for scope (only when `variant='admin'`), `<Button/>` for save/cancel. Preserve the existing handler signatures and the create-payload base64 encoding.

- [ ] **Step 3: Rewrite `OAuthFlowForm.tsx`**

Convert the existing visual frame to a shadcn `<Alert/>` (default variant) explaining the paste step, plus a mono `<Input/>` for the auth code paste, plus `<Button/>` for "Open authorize URL" and "Submit code". Behavior preserved.

- [ ] **Step 4: Rewrite `CredentialAddMenu.tsx`** as a shadcn `<DropdownMenu/>`

```tsx
// packages/channel-web/src/components/credentials/CredentialAddMenu.tsx
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface CredentialAddMenuProps {
  kinds: Array<{ kind: string; label: string; flow: 'api-key' | 'oauth' }>;
  onSelect: (kind: string, flow: 'api-key' | 'oauth') => void;
}

export function CredentialAddMenu({ kinds, onSelect }: CredentialAddMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus className="h-3.5 w-3.5" /> Add credential
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {kinds.map((k) => (
          <DropdownMenuItem key={k.kind} onSelect={() => onSelect(k.kind, k.flow)}>
            {k.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 5: Run full test suite**

```bash
pnpm --filter @ax/channel-web test
```

Update any credentials-related test selectors as needed (for example, if a test queried `.credential-add-menu-button`, switch to `getByRole('button', { name: /add credential/i })`).

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/credentials packages/channel-web/src/components/credentials/__tests__
git commit -m "refactor(channel-web): migrate credentials components to shadcn"
```

---

### Task 5.2: Migrate `SettingsPanel`

**Files:**
- Modify: `packages/channel-web/src/components/settings/SettingsPanel.tsx`

The existing `SettingsPanel` is a small modal-style overlay opened from the user-chip dropdown (see `App.tsx`). Visual recipe: shadcn `<Dialog/>` with `<DialogContent class="max-w-[640px]"/>`, a stack of `<Card/>` blocks for each section.

- [ ] **Step 1: Rewrite `SettingsPanel.tsx`**

```tsx
// packages/channel-web/src/components/settings/SettingsPanel.tsx
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Card } from '@/components/ui/card';
import { CredentialsList } from '../credentials/CredentialsList';
import { useUser } from '@/lib/user-context';

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const user = useUser();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[640px] font-sans">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Manage your account-scoped settings.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <h3 className="text-[15px] font-medium tracking-[-0.01em] mb-1">Profile</h3>
            <div className="text-[13px] text-muted-foreground">
              Signed in as <span className="text-foreground">{user.email}</span>
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="text-[15px] font-medium tracking-[-0.01em] mb-3">
              My credentials
            </h3>
            <CredentialsList variant="user" />
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

> Behavior preserved: opens / closes via `open` / `onClose` like today; renders `CredentialsList` in user mode like today.

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @ax/channel-web test
```

Expected: green.

- [ ] **Step 3: Commit**

```bash
git add packages/channel-web/src/components/settings/SettingsPanel.tsx
git commit -m "refactor(channel-web): migrate SettingsPanel to shadcn Dialog"
```

---

## PHASE 6 — UserMenu mild restyle

### Task 6.1: Mild `UserMenu` restyle for admin parity

**Files:**
- Modify: `packages/channel-web/src/components/UserMenu.tsx`

The chat-side `UserMenu` is the trigger that opens admin and settings. Per design §4.2 we restyle the **dropdown body only** — the trigger button stays on its current chrome until the phase-2 chat-surface migration. This keeps blast radius small and ensures admin-mode opens via a familiar control.

- [ ] **Step 1: Read the existing `UserMenu.tsx`**

```bash
cat packages/channel-web/src/components/UserMenu.tsx
```

Identify:
- The trigger button (which stays as-is — same JSX, same classNames).
- The dropdown body / menu items (which get replaced with shadcn `<DropdownMenu/>` body).

- [ ] **Step 2: Replace the dropdown body with shadcn primitives**

Wrap the trigger in `<DropdownMenuTrigger asChild>` and replace the legacy popover/menu rendering with `<DropdownMenuContent>` + `<DropdownMenuItem/>`. Each item's onSelect calls the same handler the legacy item used (`onOpenAdminSettings`, `onOpenSettings`, sign-out, etc.).

```tsx
// near the top of UserMenu.tsx
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// inside the component's return:
return (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      {/* existing trigger button JSX, unchanged */}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="font-sans">
      {user.isAdmin && (
        <>
          <DropdownMenuItem onSelect={onOpenAdminSettings}>
            Admin settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem onSelect={onOpenSettings}>My credentials</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onSignOut}>Sign out</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);
```

> Adjust the items above to match whatever items the legacy menu had — do not add new items or remove existing ones. The structure here is illustrative.

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @ax/channel-web test
```

Update any test that drove the legacy menu via direct DOM clicks. Tests that simulate a user clicking a menu item should be reachable via `userEvent.click(getByRole('button', { name: /your-account-or-similar/i }))` then `userEvent.click(getByRole('menuitem', { name: /admin settings/i }))`.

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/src/components/UserMenu.tsx
git commit -m "refactor(channel-web): mild UserMenu restyle (shadcn DropdownMenu body)"
```

---

## PHASE 7 — Verification + cleanup

### Task 7.1: Final chat-surface audit

> Walk the chat surface end-to-end one more time, now with the full admin migration in place. The goal is to catch any latent regression that wasn't visible during Phase 0 (e.g., from `tailwindcss-animate` plugin overriding a transition the chat surface relies on).

- [ ] **Step 1: Start dev server**

```bash
pnpm --filter @ax/channel-web dev
```

- [ ] **Step 2: Walk every chat-surface component**

Same checklist as Task 0.6 Step 2. Note any new regression that wasn't there in Phase 0.

- [ ] **Step 3: Switch to admin mode and back, several times**

Open admin → close → open → switch tabs → close. Confirm the chat sidebar's session list, agent menu, and search-bar all re-mount with the same state they had before admin was opened (they should — they're held in stores, not local component state).

- [ ] **Step 4: Test dark mode toggle**

If your local environment has a dark-mode preference, confirm both light and dark render correctly across admin and chat. If `data-theme="dark"` is set on `<html>` (via the user toggle hidden in `lib/theme.ts`), confirm tokens flip.

- [ ] **Step 5: Fix any new regression as in Task 0.6 Step 3**

Same constraints: only modify legacy CSS below the shadcn block; do not disable preflight; do not modify the shadcn token block.

- [ ] **Step 6: Commit (only if Step 5 changed anything)**

```bash
git add packages/channel-web/src/index.css
git commit -m "fix(channel-web): final chat-surface audit fixes"
```

---

### Task 7.2: Run full test suite + build

- [ ] **Step 1: Run channel-web tests**

```bash
pnpm --filter @ax/channel-web test
```

Expected: all tests pass.

- [ ] **Step 2: Run repo-wide build**

```bash
pnpm build
```

Expected: clean build for every package.

- [ ] **Step 3: If anything fails, root-cause and fix**

Do **not** mark this task done until both `test` and `build` pass.

---

### Task 7.3: Bundle delta measurement

**Files:**
- No file changes.

- [ ] **Step 1: Build the production SPA**

```bash
pnpm --filter @ax/channel-web build
```

- [ ] **Step 2: Capture the dist-web sizes**

```bash
du -sh packages/channel-web/dist-web
ls -la packages/channel-web/dist-web/assets/*.js packages/channel-web/dist-web/assets/*.css
```

Expected: total under 1.5 MB (the existing baseline plus shadcn primitives + Radix dependencies). Capture the numbers for the PR description's "Bundle delta" section.

- [ ] **Step 2: Compare with baseline (main branch)**

In a separate worktree or after stashing your changes:

```bash
git stash
git checkout main
pnpm --filter @ax/channel-web build
du -sh packages/channel-web/dist-web
ls -la packages/channel-web/dist-web/assets/*.js packages/channel-web/dist-web/assets/*.css
git checkout - && git stash pop
pnpm --filter @ax/channel-web build
```

Record both numbers. Include in the PR description.

- [ ] **Step 3: If bundle delta exceeds +200 kB raw**

Investigate. Likely cause: an unused shadcn primitive that landed but isn't tree-shaken because something accidentally imports it. Use `pnpm --filter @ax/channel-web exec vite build --mode production --debug` to inspect. Remove unused primitives from `src/components/ui/` if any aren't reachable from production code paths.

---

## Cross-phase reminders

- **Conventional commit style.** Each commit message follows `<type>(scope): subject`. Types used: `chore`, `feat`, `refactor`, `test`, `fix`. Scopes used: `channel-web`, `admin-settings`.
- **Each task ends with a commit step.** Don't batch multiple tasks into one commit.
- **No legacy CSS deletions in this PR.** The chat surface still consumes `index.css`. Phase 2 deletes the now-unused blocks.
- **No new features.** Behavior of every form, list, and dialog is preserved exactly. Only the visual layer changes.
- **No snapshot tests.** Visual fidelity is checked by eye in the dev server + Playwright.
- **Tailwind preflight is enabled globally.** If a chat-surface regression appears mid-plan, fix it via legacy CSS rules per Task 0.6 Step 3 — do not disable preflight.

---

## Self-Review Notes

**Spec coverage check:**
- §3.1 Tailwind setup → Task 0.1 ✓
- §3.2 shadcn setup → Tasks 0.2 + 0.3 ✓
- §3.3 Fonts → Task 0.5 ✓
- §3.4 Preflight strategy → Tasks 0.4, 0.6, 7.1 ✓
- §3.5 Dark mode → Task 0.4 (token stanza scoped to `data-theme`) ✓
- §4.1 Shell topology → Tasks 1.2, 1.3, 1.4 ✓
- §4.2 File migration map → all phases collectively ✓
- §4.3 Local components → Tasks 1.1, 1.2, 1.3, 2.1, 2.2, 3.1, 3.2 ✓
- §4.4 Visual extrapolation (Agents/MCP/Teams/Settings/Credentials) → Tasks 4.1, 4.2, 4.3, 5.1, 5.2 ✓
- §5.1 Existing-test selector updates → Tasks 1.5, 2.3, 4.1, 4.2, 4.3, 5.1, 6.1 ✓
- §5.2 New tests (AdminShell, ProviderRow, ModelCombobox) → Tasks 1.4, 2.1, 3.2 ✓
- §5.4 Verification loop → Tasks 7.1, 7.2 ✓
- §7 PR shape (commit titles + bundle delta) → commit titles match §7's list; Task 7.3 captures bundle delta ✓

**Type consistency check:**
- `AdminTabId` defined in `AdminSidebar.tsx` (Task 1.2) and re-exported / consumed in `AdminShell.tsx` (Task 1.4) — consistent.
- `StatusDotVariant` defined in `StatusDot.tsx` (Task 1.1) and consumed in `ProviderRow.tsx` (Task 2.1), `ProviderKeysTab.tsx` (Task 2.3) — consistent.
- `ModelComboboxGroup` defined in `ModelCombobox.tsx` (Task 3.2) and consumed in `ModelConfigTab.tsx` (Task 3.3) — consistent.
- `KeyFormProps.helperRight` introduced in Task 2.2 and used in Task 2.3 — consistent.
- `CredentialMeta` is an existing type in `lib/credentials.ts` — referenced in Task 5.1.

**Placeholder scan:**
- Tasks 4.1 and 4.2 say "carry every field forward" rather than enumerating each form field — this is intentional because the legacy implementations (415 + 306 lines) define those field sets and we preserve them verbatim. The instruction directs the engineer to read the existing file first.
- Task 6.1's illustrative menu items say "Adjust the items above to match whatever items the legacy menu had" — this preserves the existing menu structure rather than risk inventing items that don't match.
- No "TBD" / "TODO" / "implement later" / "fill in details" tokens.
