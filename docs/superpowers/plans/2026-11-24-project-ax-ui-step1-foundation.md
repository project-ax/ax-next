# `@project-ax/ui` Step 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `@project-ax/ui` with tokens and a generated theme that channel-web consumes with zero visual
change, plus the lint plugin, write guard and lint hook that stop new UI drift from today on.

**Architecture:** Tokens are `as const` TypeScript objects in `packages/ui/src/foundation/tokens.ts`. A generator
renders them to `packages/ui/theme.css` (committed, drift-tested). channel-web imports that file and maps its
legacy shadcn variable names onto the new `--ax-*` variables, so every existing class keeps working. A plain-JS
ESLint plugin (`@project-ax/eslint-plugin-ui`) bans the patterns the design removes; ESLint bulk suppressions
freeze today's violations so only new code is blocked.

**Tech Stack:** TypeScript 6, React 19 (types only in this step), Vitest 5, ESLint 10 flat config + bulk
suppressions, Node scripts for Claude Code hooks.

**Spec:** `docs/superpowers/specs/2026-11-24-agent-first-ui-design.md` (§4, §5.1, §5.2, §5.5, §6.4 step 1).
Roadmap: `docs/superpowers/plans/2026-11-24-project-ax-ui-roadmap.md`.

## Global Constraints

- Package names: `@project-ax/ui` at `packages/ui`; `@project-ax/eslint-plugin-ui` at `packages/eslint-plugin-ui`.
- Both packages stay `"private": true` until open item O2 (npm scope) is resolved.
- CSS variable prefix: `--ax-`. Color values are HSL triplets without `hsl()` (`220.00 42.86% 98.63%`) so Tailwind
  opacity modifiers keep working through the legacy aliases.
- Starting values are channel-web's current `index.css` values. No visual change in this step except where the
  contrast test forces one; any forced change is listed in the PR body with before/after values.
- The dark theme is written once in `tokens.ts`; the generator emits it for both
  `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }` and `:root[data-theme='dark']`.
- Lint rules are **errors**; existing violations are frozen with ESLint bulk suppressions (`eslint-suppressions.json`
  at the repo root). Never raise a suppressed count.
- Do not use core `no-restricted-imports` for the new import ban: the repo already configures it for invariant 2,
  and a second flat-config entry for the same rule replaces the first for matching files.
- `(ds)` work requires `.ax-ds-task` in the worktree root (created in Task 7, gitignored). Create it before
  Task 1 when executing this plan.

## Review Focus

1. **Explicit light on a dark OS:** `data-theme="light"` while the OS is dark must render light. The generated CSS
   keeps the `:not([data-theme='light'])` guard (Task 2 test `respects explicit light`).
2. **Opacity modifiers through aliases:** classes like `bg-primary/10` must still compile; aliases must be
   `var(--ax-…)` of a bare triplet, never `hsl(var(…))` (Task 4 test `aliases keep triplet format`).
3. **Losing invariant-2 enforcement in channel-web** if the import ban reuses `no-restricted-imports` (Task 6 test
   `cross-plugin import still errors in channel-web`).
4. **Guard path matching:** `packages/uix/…` or `packages/channel-web/../ui/…` must be judged on the resolved
   path, not a string prefix (Task 7 tests `prefix lookalike allowed`, `dotdot resolved`).
5. **Stale suppressions:** deleting or fixing a suppressed file must not leave slack that lets violations come back
   later (Task 6 test `unpruned suppressions fail lint`).

---

### Task 1: Package scaffold and tokens

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vitest.config.ts`,
  `packages/ui/src/index.ts`, `packages/ui/src/foundation/tokens.ts`,
  `packages/ui/src/foundation/__tests__/tokens.test.ts`
- Modify: `tsconfig.json` (add `{ "path": "packages/ui" }` to `references`)

**Interfaces:**
- Produces (from `src/foundation/tokens.ts`, re-exported by `src/index.ts`):
  - `bg`, `fg`, `accent`, `action`, `line`, `brand`, `status` — `{ light: Record<Name, string>, dark: Record<Name, string> }`
  - `space`, `radius`, `motion`, `width` — `Record<Name, string>` (CSS lengths / durations)
  - `elevation` — `{ light: Record<ElevationToken, string>, dark: Record<ElevationToken, string> }`
  - `text` — `Record<TextRole, { size: string; line: string; weight: 400 | 500 | 600; font: 'sans' | 'mono' }>`
  - `font` — `{ sans: string; mono: string }`
  - Types: `BgToken`, `FgToken`, `StatusTone`, `SpaceToken`, `TextRole`, `RadiusToken`, `ElevationToken`,
    `MotionToken`, `WidthToken` (each the key union of its object)

`package.json`: `"name": "@project-ax/ui"`, `"private": true`, `"type": "module"`, `"version": "0.0.0"`,
`exports: { ".": {types, default → dist}, "./theme.css": "./theme.css" }`, `files: ["dist", "theme.css"]`,
scripts `build: "tsc --build"`, `test: "vitest run"`, `gen: "tsx scripts/gen-theme.ts"`; devDeps `typescript`,
`vitest`, `tsx` at the repo's versions. `tsconfig.json` extends `../../tsconfig.base.json`, `rootDir: "src"`.

Token values (light / dark). Source var in parentheses.

| Token | Light | Dark |
|---|---|---|
| `bg.canvas` (`--canvas`) | `216.00 17.24% 94.31%` | `230.00 15.00% 7.84%` |
| `bg.surface` (`--background`) | `220.00 42.86% 98.63%` | `226.67 15.25% 11.57%` |
| `bg.surface-raised` (`--card`) | `0.00 0.00% 100.00%` | `226.15 14.94% 17.06%` |
| `bg.overlay` (`--popover`) | `0.00 0.00% 100.00%` | `226.15 14.94% 17.06%` |
| `bg.muted` (`--muted`) | `216.00 17.24% 94.31%` | `226.15 14.94% 17.06%` |
| `fg.default` (`--foreground`) | `201.82 8.27% 26.08%` | `220.00 13.04% 90.98%` |
| `fg.muted` (`--muted-foreground`) | `201.18 8% 41%` | `219.00 11.90% 67.06%` |
| `fg.subtle` (`--state-quiet`) | `217.89 7.69% 51.57%` | `221.74 10.31% 56.27%` |
| `fg.inverse` (`--action-foreground`) | `0.00 0.00% 100.00%` | `200.00 11.54% 10.20%` |
| `fg.link` (`--primary`) | `242.71 63.03% 58.63%` | `245.33 100.00% 82.35%` |
| `accent.base` / `.soft` / `.hover` / `.fg` (`--primary`, `-soft`, `-hover`, `-foreground`) | copy from `index.css` | copy |
| `action.base` / `.hover` (`--action`, `--action-hover`) | copy | copy |
| `line.border` / `.soft` / `.input` / `.ring` (`--border`, `--rule-soft`, `--input`, `--ring`) | copy | copy |
| `brand.base` (`--brand`) | copy | copy |
| `status.danger.{base,soft,hover,fg}` (`--destructive*`) | copy | copy |
| `status.warning.{base,soft,fg}` (`--warning*`) | copy | copy |
| `status.info.{base,soft,fg}` | = accent base/soft/fg | = accent |
| `status.neutral.{base,soft,fg}` | `fg.muted` / `bg.muted` / `fg.default` | same mapping |
| `status.success.{base,soft,fg}` (new) | `152 55% 28%` / `152 45% 94%` / `0 0% 100%` | `152 50% 62%` / `152 35% 16%` / `223 45% 12%` |

`space`: `none 0`, `xs 4px`, `sm 8px`, `md 12px`, `lg 16px`, `xl 24px`, `section 32px` (the 18px frame inset
becomes `lg`; noted in Task 4's PR body as the one intended layout change, applied in S5a, not now).
`radius`: `none 0`, `sm 7px`, `md 9px`, `lg 16px`, `full 9999px`.
`elevation`: `flat none`; `raised` = `--shadow-panel`; `overlay` = `--shadow-popover` (light and dark values copied).
`motion`: `instant 0ms`, `fast 120ms`, `base 180ms`; plus `motion.ease = cubic-bezier(0.2,0.8,0.2,1)` exported as `ease`.
`width`: `narrow 360px`, `form 480px`, `content 680px`, `wide 900px`.
`text` (size/line/weight/font): `display 30px/41px/600`, `title 22px/28px/600`, `heading 17px/24px/600`,
`subheading 14px/20px/500`, `body 15px/22px/400`, `body-strong 15px/22px/500`, `meta 13px/18px/400`,
`caption 12px/16px/400`, `code 13px/20px/400 mono`.
`font`: `sans "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif`; `mono "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace`.

- [ ] **Step 1: Write the failing tests** in `tokens.test.ts`:
  - `every color group has the same keys in light and dark` — for each of `bg, fg, accent, action, line, brand`
    and each `status[tone]`: `Object.keys(g.light)` equals `Object.keys(g.dark)`.
  - `colors are bare HSL triplets` — every color value matches
    `/^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/`.
  - `token unions are exactly the spec's names` — `expectTypeOf<SpaceToken>().toEqualTypeOf<'none'|'xs'|'sm'|'md'|'lg'|'xl'|'section'>()`,
    same for `TextRole` (9 roles above), `StatusTone` (`neutral|info|success|warning|danger`), `RadiusToken`,
    `ElevationToken`, `MotionToken`, `WidthToken`, `BgToken` (`canvas|surface|surface-raised|overlay|muted`),
    `FgToken` (`default|muted|subtle|inverse|link`).
  - `starting values match channel-web` — `bg.light.surface === '220.00 42.86% 98.63%'`,
    `fg.dark.muted === '219.00 11.90% 67.06%'`, `text.body.size === '15px'`.
- [ ] **Step 2:** `pnpm --filter @project-ax/ui test` → FAIL (module not found).
- [ ] **Step 3:** Implement `tokens.ts` with the values above (`as const`); export everything from `src/index.ts`.
- [ ] **Step 4:** `pnpm --filter @project-ax/ui test` → PASS; `pnpm build` → no errors.
- [ ] **Step 5:** Commit `feat(ui): @project-ax/ui scaffold and tokens`.

### Task 2: Theme CSS generator and contrast test

**Files:**
- Create: `packages/ui/src/foundation/theme-css.ts`, `packages/ui/src/foundation/contrast.ts`,
  `packages/ui/scripts/gen-theme.ts`, `packages/ui/theme.css` (generated, committed),
  `packages/ui/src/foundation/__tests__/theme-css.test.ts`, `packages/ui/src/foundation/__tests__/contrast.test.ts`

**Interfaces:**
- Consumes: Task 1 token objects.
- Produces: `renderThemeCss(): string`; `contrastRatio(a: string, b: string): number` (bare HSL triplets, WCAG 2.x
  relative-luminance formula); file `packages/ui/theme.css`.
- Variable names: `--ax-bg-<name>`, `--ax-fg-<name>`, `--ax-accent`, `--ax-accent-soft|hover|fg`,
  `--ax-action`, `--ax-action-hover`, `--ax-line-<name>`, `--ax-brand`, `--ax-status-<tone>` and
  `--ax-status-<tone>-<soft|hover|fg>`, `--ax-space-<name>`, `--ax-radius-<name>`, `--ax-elevation-<name>`,
  `--ax-motion-<name>`, `--ax-motion-ease`, `--ax-width-<name>`, `--ax-text-<role>-size|line|weight|font`,
  `--ax-font-sans`, `--ax-font-mono`.

- [ ] **Step 1: Write the failing tests** in `theme-css.test.ts`:
  - `light root` — output contains `:root {` with `--ax-bg-surface: 220.00 42.86% 98.63%;` and `color-scheme: light;`.
  - `respects explicit light` — output contains `@media (prefers-color-scheme: dark)` followed by
    `:root:not([data-theme='light']) {` holding `--ax-bg-surface: 226.67 15.25% 11.57%;`.
  - `explicit dark` — `:root[data-theme='dark'] {` block's declarations are byte-identical to the media block's.
  - `non-color tokens only in :root` — `--ax-space-lg: 16px;` appears exactly once.
  - `committed file is current` — `readFileSync('theme.css')` equals `renderThemeCss()` (failure message:
    "run pnpm --filter @project-ax/ui gen").
- [ ] **Step 2: Write the failing tests** in `contrast.test.ts`:
  - `contrastRatio('0 0% 0%', '0 0% 100%')` ≈ 21 (±0.01); identical inputs → 1.
  - For both themes: each of `fg.default`, `fg.muted`, `fg.link` on each of `bg.canvas`, `bg.surface`,
    `bg.surface-raised`, `bg.muted` ≥ 4.5; `fg.subtle` on the same ≥ 3.0; `fg.inverse` on `action.base` ≥ 4.5;
    `accent.fg` on `accent.base` ≥ 4.5; for each status tone: `<tone>.fg` on `<tone>.base` ≥ 4.5,
    `<tone>.base` on `<tone>.soft` ≥ 4.5, `<tone>.base` on `bg.surface` ≥ 4.5.
    Each failure names the pair and the ratio.
- [ ] **Step 3:** `pnpm --filter @project-ax/ui test` → FAIL.
- [ ] **Step 4:** Implement `contrastRatio`, `renderThemeCss`, and `scripts/gen-theme.ts` (writes `theme.css`); run `pnpm --filter @project-ax/ui gen`.
- [ ] **Step 5:** `pnpm --filter @project-ax/ui test`. If a contrast pair fails, adjust only that token's
  lightness to the nearest passing value, regenerate, and record old → new in the PR body (Global Constraints).
  Expected: PASS.
- [ ] **Step 6:** Commit `feat(ui): generated theme.css with contrast test`.

### Task 3: Baseline capture (before the theme swap)

**Files:**
- Create: `packages/ui/eval/results/2026-11-baseline/README.md`, screenshots under the same directory.

- [ ] **Step 1:** Start channel-web against the mock backend (`pnpm --filter @ax/channel-web dev`, `AX_BACKEND_URL` unset).
- [ ] **Step 2:** With Playwright, capture every route the mock reaches (sign-in, setup wizard steps, Today,
  agent conversation, agent settings tabs, Tasks, a Task, Settings tabs, every Admin tab, apps approve, shared
  artifact) at 1440×900 and 390×844, light and dark (`data-theme`). Name files `<route>-<width>-<theme>.png`.
- [ ] **Step 3:** Add `@axe-core/playwright` as an exact-pinned devDependency of `@project-ax/ui` (not installed in
  the repo today; run the `security-checklist` supply-chain walk and note it in the PR). Run axe on each route;
  write serious/critical counts per route and the spec's §6.1 counts into `README.md`.
- [ ] **Step 4:** Commit `chore(ui): baseline screenshots and axe counts`.

### Task 4: channel-web consumes `theme.css`

**Files:**
- Modify: `packages/channel-web/package.json` (devDependency `"@project-ax/ui": "workspace:*"`),
  `packages/channel-web/tsconfig.json` (reference `../ui`), `packages/channel-web/src/index.css`
- Create: `packages/channel-web/src/__tests__/theme-parity.test.ts`,
  `packages/channel-web/src/__tests__/theme-parity.fixture.json`

**Interfaces:**
- Consumes: `packages/ui/theme.css` variable names from Task 2; token objects from Task 1 (for the test).

`index.css`: put `@import '@project-ax/ui/theme.css';` first, replace the three legacy variable blocks with one
`:root` alias block, and keep everything else. Aliases (legacy → new):
`--canvas → --ax-bg-canvas`; `--background`, `--panel`, `--sidebar-background → --ax-bg-surface`;
`--card`, `--secondary → --ax-bg-surface-raised`; `--popover → --ax-bg-overlay`; `--muted → --ax-bg-muted`;
`--foreground`, `--card-foreground`, `--popover-foreground`, `--secondary-foreground`, `--accent-foreground → --ax-fg-default`;
`--muted-foreground → --ax-fg-muted`; `--state-quiet → --ax-fg-subtle`; `--primary → --ax-accent`;
`--primary-soft`, `--accent`, `--bubble → --ax-accent-soft`; `--primary-hover → --ax-accent-hover`;
`--primary-foreground → --ax-accent-fg`; `--action → --ax-action`; `--action-hover → --ax-action-hover`;
`--action-foreground → --ax-fg-inverse`; `--brand → --ax-brand`; `--border → --ax-line-border`;
`--rule-soft → --ax-line-soft`; `--input → --ax-line-input`; `--ring → --ax-line-ring`;
`--destructive[-soft|-hover|-foreground] → --ax-status-danger[-soft|-hover|-fg]`;
`--warning[-soft|-foreground] → --ax-status-warning[-soft|-fg]`; `--radius → --ax-radius-md`;
`--radius-panel → --ax-radius-lg`; `--shadow-panel → --ax-elevation-raised`; `--shadow-popover → --ax-elevation-overlay`.
Kept as literal light/dark values in `index.css` (they move into components in S3/S7): `--send*`,
`--composer-start|end`, `--chart-1..5`, `--shadow-key`, `--shadow-action`, `--shadow-composer`, `--radius-well`.
The dark block for those few is still emitted under both dark selectors.

- [ ] **Step 1:** Before editing `index.css`, write `theme-parity.fixture.json`: `{ light: {<legacy var>: value}, dark: {...} }`
  for every aliased legacy var, copied from the current file.
- [ ] **Step 2: Write the failing test** `theme-parity.test.ts`:
  - `every legacy var is aliased` — parse `src/index.css`; each fixture key appears as `--x: var(--ax-…);` in
    the alias block.
  - `aliases keep triplet format` — no alias value contains `hsl(`.
  - `resolved values match the fixture` — resolve each alias through `packages/ui/theme.css` (parse its `:root`
    and dark blocks) and compare to the fixture per theme. Allowed differences are only those listed in
    `fixture.changed` (from Task 2 step 5), each with old/new.
- [ ] **Step 3:** `pnpm --filter @ax/channel-web test -- theme-parity` → FAIL.
- [ ] **Step 4:** Edit `index.css` as specified; add the dependency and tsconfig reference; `pnpm install`.
- [ ] **Step 5:** `pnpm --filter @ax/channel-web test -- theme-parity` → PASS.
- [ ] **Step 6:** `pnpm --filter @ax/channel-web build`, then `grep -c -- '--ax-bg-surface' packages/channel-web/dist-web/assets/*.css` → ≥ 1.
- [ ] **Step 7:** Re-capture three Task 3 routes (Today, Admin › Models, agent conversation) light + dark at 1440 and
  diff against the baseline; expect no pixel differences beyond Task 2's recorded contrast changes.
- [ ] **Step 8:** Commit `feat(channel-web): consume @project-ax/ui theme through legacy aliases`.

### Task 5: `@project-ax/eslint-plugin-ui`

**Files:**
- Create: `packages/eslint-plugin-ui/package.json`, `packages/eslint-plugin-ui/index.js`,
  `packages/eslint-plugin-ui/rules/{no-classname,no-style-prop,no-raw-elements,no-arbitrary-values,no-internal-imports}.js`,
  `packages/eslint-plugin-ui/__tests__/rules.test.js`, `packages/eslint-plugin-ui/vitest.config.js`

**Interfaces:**
- Produces: default export `{ meta: { name: '@project-ax/eslint-plugin-ui' }, rules: {...} }`; rule ids used as
  `ax-ui/<rule>`. Plain ESM JavaScript with JSDoc (no build step, so `eslint.config.mjs` can import it before
  `tsc`). `package.json`: `private: true`, `type: module`, `main: index.js`, `test: vitest run`.

Rule behavior:
- `no-classname`: report any JSX attribute named `className` or `class`. Message: "Pages don't style elements.
  Use a component from @project-ax/ui (Stack, Inline, Text, …) or a composite in src/composites/."
- `no-style-prop`: report JSX attribute `style`. Message names tokens/components.
- `no-raw-elements`: report lowercase JSX elements in this map, with the replacement in the message:
  `div|section|article|header|footer|main|aside|nav → Stack / Inline / Section / AppShell`,
  `span|p → Text`, `h1–h6 → PageHeader / Section / Heading`, `ul|ol|li → List / ListRow`,
  `button → Button / IconButton`, `input|textarea|select|label → TextField / TextArea / Select`,
  `table|thead|tbody|tr|td|th → DataTable`. Other lowercase elements (`svg`, `a`, `img`, `form`, `iframe`, `canvas`) are allowed in this step.
- `no-arbitrary-values`: report any string literal or template-literal quasi in a `className`/`class` attribute
  (or inside `cn(…)`/`clsx(…)`/`cva(…)` call arguments) containing a class token with `[` (e.g. `text-[13px]`, `max-w-[660px]`).
  Message: "Arbitrary values bypass the tokens. Use a token (space, text role, width)."
- `no-internal-imports`: report `ImportDeclaration`s whose source matches `^@radix-ui/`, `^@/components/ui(/|$)`,
  `^@project-ax/ui/(internal|src)(/|$)`, or a relative path containing `/components/ui/`. Message: "Import from @project-ax/ui."

- [ ] **Step 1: Write failing tests** with ESLint `RuleTester` (languageOptions `ecmaFeatures.jsx: true`), one
  `describe` per rule, valid + invalid cases including:
  - `no-classname`: invalid `<Stack className="x" />`, `<div class="x" />`; valid `<Stack gap="md" />`.
  - `no-raw-elements`: invalid `<div/>` (message contains `Stack`), `<p/>` (contains `Text`), `<h2/>` (contains
    `Section`); valid `<svg/>`, `<Stack/>`, `<a href="/x"/>`.
  - `no-arbitrary-values`: invalid `className="text-[13px] text-sm"`, ``className={`gap-[3px] ${x}`}``,
    `cn('max-w-[660px]')`; valid `className="text-sm"`, `aria-label="[draft]"`.
  - `no-internal-imports`: invalid `'@radix-ui/react-dialog'`, `'@/components/ui/button'`, `'../ui/button'`
    from a file under `components/`; valid `'@project-ax/ui'`, `'@ax/core'`.
- [ ] **Step 2:** `pnpm --filter @project-ax/eslint-plugin-ui test` → FAIL.
- [ ] **Step 3:** Implement the five rules and `index.js`.
- [ ] **Step 4:** `pnpm --filter @project-ax/eslint-plugin-ui test` → PASS.
- [ ] **Step 5:** Commit `feat(eslint-plugin-ui): rules for className, style, raw elements, arbitrary values, internal imports`.

### Task 6: Wire the plugin into the repo lint with bulk suppressions

**Files:**
- Modify: `eslint.config.mjs`, root `package.json` (devDependency `"@project-ax/eslint-plugin-ui": "workspace:*"`; scripts below)
- Create: `eslint-suppressions.json` (generated), `scripts/__tests__/ui-lint-wiring.test.js`

Config entry (after the existing entries): `files: ['packages/channel-web/src/**/*.tsx']`,
`ignores: ['packages/channel-web/src/components/ui/**', '**/__tests__/**', '**/*.test.tsx']`,
`plugins: { 'ax-ui': axUi }`, all five rules at `'error'`.
Root scripts: `"lint:ui:suppress": "eslint packages/channel-web/src --suppress-rule ax-ui/no-classname --suppress-rule ax-ui/no-style-prop --suppress-rule ax-ui/no-raw-elements --suppress-rule ax-ui/no-arbitrary-values --suppress-rule ax-ui/no-internal-imports"`,
`"lint:ui:prune": "eslint . --prune-suppressions"`.

- [ ] **Step 1: Write failing tests** in `scripts/__tests__/ui-lint-wiring.test.js` using ESLint's Node API
  (`new ESLint({ cwd: repoRoot })`, `lintText(code, { filePath })`):
  - `new channel-web file with a div errors` — `lintText('export const X = () => <div/>;', { filePath: 'packages/channel-web/src/components/NewThing.tsx' })`
    has an `ax-ui/no-raw-elements` message with severity 2.
  - `shadcn internals are exempt` — same code at `packages/channel-web/src/components/ui/button.tsx` → no `ax-ui/*` messages.
  - `cross-plugin import still errors in channel-web` — `import x from '@ax/agents/src/x';` in a channel-web
    `.tsx` still reports the existing `no-restricted-imports` error.
  - `unpruned suppressions fail lint` — run the `eslint` CLI with `--suppressions-location` pointing at a temp
    copy of `eslint-suppressions.json` plus a fake entry for a file with no violations; expect a non-zero exit
    and output containing "There are suppressions left that do not occur anymore" (ESLint 10.2.1's default;
    never add `--pass-on-unpruned-suppressions` to `pnpm lint`).
- [ ] **Step 2:** `pnpm test:scripts -- ui-lint-wiring` → FAIL.
- [ ] **Step 3:** Add the dependency, config entry and scripts; `pnpm install`; `pnpm lint:ui:suppress`.
- [ ] **Step 4:** `pnpm lint` → exit 0; `pnpm test:scripts -- ui-lint-wiring` → PASS.
- [ ] **Step 5:** Record the per-rule suppressed totals (from `eslint-suppressions.json`) in the PR body; these are the ratchet's starting numbers.
- [ ] **Step 6:** Commit `chore(lint): enforce UI rules on channel-web with bulk suppressions`.

### Task 7: Agent guardrails, ownership and docs

**Files:**
- Create: `scripts/hooks/guard-ds-writes.mjs`, `scripts/hooks/lint-ui-file.mjs`,
  `scripts/__tests__/ui-hooks.test.js`, `.github/CODEOWNERS`
- Modify: `.claude/settings.json`, `.gitignore` (add `.ax-ds-task`), `CLAUDE.md` (invariant #6),
  `.claude/skills/yolo-ship/SKILL.md` (worktree setup)

**Interfaces:**
- Hooks read the Claude Code hook JSON from stdin and use `tool_input.file_path`.
- `guard-ds-writes.mjs`: resolve `file_path` with `path.resolve`; find the enclosing worktree root by walking up
  to the first directory containing a `.git` entry (file or directory); if the resolved path is inside
  `<root>/packages/ui/` or `<root>/packages/eslint-plugin-ui/` (compare path segments, not string prefix) and
  `<root>/.ax-ds-task` doesn't exist → write to stderr "packages/ui is the design system. Feature work uses its
  public API; design-system changes need a (ds) card — see docs/superpowers/specs/2026-11-24-agent-first-ui-design.md."
  and exit 2. Otherwise exit 0.
- `lint-ui-file.mjs`: if the resolved path matches `packages/channel-web/src/**/*.tsx` (not under
  `components/ui/`, not a test), spawn the ESLint **CLI** from the worktree root
  (`pnpm exec eslint --format json --pass-on-unpruned-suppressions <file>`) — bulk suppressions are applied only
  by the CLI, not the Node API, and the hook must not nag about frozen legacy violations. If any `ax-ui/*` error
  remains, print `file:line rule message` lines to stderr and exit 2. Otherwise exit 0.
- `.claude/settings.json`: `PreToolUse` and `PostToolUse` entries, matcher `Edit|Write|MultiEdit`, commands
  `node "$CLAUDE_PROJECT_DIR"/scripts/hooks/guard-ds-writes.mjs` and `…/lint-ui-file.mjs`. No Stop hook
  (yolo-ship already runs build/test/lint before a PR; a Stop hook would run on every session in this repo).
- `.github/CODEOWNERS`: `/packages/ui/ @vpulim`, `/packages/eslint-plugin-ui/ @vpulim`, `/eslint-suppressions.json @vpulim`.

- [ ] **Step 1: Write failing tests** in `ui-hooks.test.js` (spawn `node` with JSON on stdin, temp dirs as fake worktrees):
  - `blocks packages/ui without marker` → exit 2, stderr mentions "(ds) card".
  - `allows packages/ui with marker` → exit 0.
  - `prefix lookalike allowed` — `<root>/packages/uix/a.ts` → exit 0.
  - `dotdot resolved` — `<root>/packages/channel-web/../ui/a.ts` → exit 2 without marker.
  - `worktree root via .git file` — root has a `.git` *file*; marker there → exit 0.
  - `lint hook reports new div` — real repo root, a temp `.tsx` under `packages/channel-web/src/components/`
    containing `<div/>` → exit 2, stderr contains `ax-ui/no-raw-elements`; clean file → exit 0. Remove the temp file in `afterEach`.
  - `lint hook ignores frozen violations` — run it on an existing suppressed file (e.g.
    `packages/channel-web/src/components/Toast.tsx`) unchanged → exit 0.
- [ ] **Step 2:** `pnpm test:scripts -- ui-hooks` → FAIL.
- [ ] **Step 3:** Implement both hooks; add settings, CODEOWNERS, `.gitignore` entry.
- [ ] **Step 4:** `pnpm test:scripts -- ui-hooks` → PASS.
- [ ] **Step 5:** CLAUDE.md invariant #6 — append: "**Migration in progress (2026-11):** the shared design system is
  moving to `@project-ax/ui` (`packages/ui`). New or edited channel-web screens must pass `@project-ax/eslint-plugin-ui`
  (no `className`, raw layout elements, arbitrary values or `@/components/ui` imports in new code); existing violations are
  frozen in `eslint-suppressions.json` and may only go down. Design: `docs/superpowers/specs/2026-11-24-agent-first-ui-design.md`."
  yolo-ship SKILL.md worktree step — add: "If the card title contains `(ds)`, `touch .ax-ds-task` in the worktree root before editing."
- [ ] **Step 6:** Full pre-PR gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint` → all pass.
- [ ] **Step 7:** Commit `chore(ui): write guard, lint hook, CODEOWNERS, invariant #6 note`.
