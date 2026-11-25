# S2a: Build + stories infrastructure, first components. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@project-ax/ui` able to ship real components: a restricted Tailwind preset, a compiled `ui.css`,
the first six components (`Stack`, `Inline`, `Grid`, `Divider`, `Text`, `Heading`) with stories, axe and
screenshot tests in CI, real callers in channel-web, and the `no-classname` + `no-raw-elements` lint rules
switched on.

**Architecture:** Components are authored in `packages/ui/src` with `ax-`-prefixed Tailwind classes taken
from fixed lookup maps. A build script compiles them with the package's own preset into a committed `ui.css`,
with a drift test like the one for `theme.css`. channel-web imports `theme.css` then `ui.css`. Storybook builds
statically. A Playwright spec walks its `index.json` and runs axe and a screenshot comparison on every story in
light and dark. Baselines come from the pinned Playwright Docker image, so they match CI.

**Tech Stack:** React 19, Tailwind 3.4 (the same version as channel-web), Storybook 10 (react-vite),
`@playwright/test` 1.59.1, `@axe-core/playwright` 4.14.0, vitest 5 (jsdom, typecheck mode).

**Spec:** `docs/superpowers/specs/2026-11-24-agent-first-ui-design.md` (§4 Tailwind and SSR, §5.1–5.5).
**Roadmap:** `docs/superpowers/plans/2026-11-24-project-ax-ui-roadmap.md` (row S2a and "Rules every card follows").

## Global Constraints

- Every class a component emits starts with `ax-` and comes from a literal lookup map (no string building
  such as `` `ax-gap-${gap}` ``, which Tailwind can't see).
- Components never emit inline `style`. Every component renders under `renderToString` with no `window` or
  `document` access at import time.
- Public props never include `className`, `style` or `as`. Enums have at most 4 members, except token unions
  (`SpaceToken`) and `Grid` column counts.
- `src/index.ts` is the only public entry. Anything not exported there is internal.
- Each component lands in this card together with at least one real channel-web caller (CLAUDE.md
  half-wired policy).
- New dependencies: exact pins, each version published at least 14 days before it is added, and a
  `security-checklist` supply-chain note in the task report. Reuse versions already in the lockfile
  wherever one exists.
- `.ax-ds-task` must exist in the worktree root (the write guard requires it for `packages/ui/**`).
- Never hand-edit `eslint-suppressions.json`. Regenerate it with `pnpm lint:ui:suppress` and
  `pnpm lint:ui:prune`.
- Run a single package's tests with `pnpm --filter <pkg> exec vitest run <pattern>`. The
  `test -- pattern` form doesn't filter.

## Review Focus

1. **A class used in source but missing from `ui.css`** (a typo, or a map entry the preset doesn't generate).
   It renders unstyled with no error. Pinned by Task 2's "every `ax-` class in src is in ui.css" test.
2. **Dark mode in stories.** Every story must be captured with `data-theme="dark"` too, or a dark-only
   contrast failure ships. Pinned by Task 3's spec looping over both themes.
3. **A heading level that comes out wrong.** With no provider, `Heading` must render `h2`, never `h1`:
   S5b's `PageHeader` will own the one `h1`. Pinned in Task 2.
4. **Screenshots that differ between macOS and Linux CI.** Baselines must come from the same Docker image
   CI uses. Pinned by Task 3's `stories:update` script, and its CI job running in that image.
5. **Switching rules on where a rule was never off.** The ratchet must allow a total to rise only in the PR
   that turns that rule from `off` to `error`. Pinned in Task 5.

---

### Task 1: Restricted Tailwind preset and the `ui.css` build

**Files:**
- Create: `packages/ui/src/tailwind/preset.ts`, `packages/ui/scripts/build-css.ts`,
  `packages/ui/src/foundation/__tests__/preset.test.ts`, `packages/ui/ui.css` (generated, committed)
- Modify: `packages/ui/package.json` (exports `./tailwind-preset` → `./dist/tailwind/preset.js` and
  `./ui.css`; `files` adds `ui.css`; script `gen` runs both generators; devDeps `tailwindcss` and `postcss`
  pinned to channel-web's resolved versions)

**Interfaces:**
- Consumes: the token objects in `src/foundation/tokens.ts`.
- Produces: `export const axPreset: import('tailwindcss').Config` (default export too) and
  `export async function renderUiCss(): Promise<string>` in `scripts/build-css.ts`, which compiles
  `src/**/*.{ts,tsx}` with the preset (input: `@tailwind utilities;` only).

The preset sets `prefix: 'ax-'` and `corePlugins: { preflight: false }`. It **replaces**, not extends, these
theme keys, each value pointing at the `theme.css` variable (`var(--ax-space-md)`,
`hsl(var(--ax-bg-surface) / <alpha-value>)`):

- `spacing` = the `space` tokens.
- `colors` = `transparent`, `current`, plus one key per color variable. The key is the variable name without
  `--ax-`, with a leading `bg-` dropped and a trailing `-default`/`-base` folded into `DEFAULT`. So
  `bg-surface`, `text-fg-muted`, `border-line`, `bg-status-danger-soft`.
- `fontSize` = the text roles, as `[size, { lineHeight, fontWeight }]` read from the `--ax-text-<role>-*`
  variables.
- `fontFamily` = `sans` and `mono`. `borderRadius`, `boxShadow` (elevation), `maxWidth` (width) and
  `transitionDuration` (motion) each come from their token group.
- `screens` = `{ md: '768px', lg: '1024px' }`.

- [ ] **Step 1: Write failing tests** in `preset.test.ts`. Compile the content string
  `'ax-p-md ax-p-4 ax-gap-sm ax-text-meta ax-text-sm ax-bg-surface ax-bg-white ax-text-fg-muted ax-rounded-lg md:ax-grid-cols-2'`
  with the preset through postcss and assert:
  - `.ax-p-md{padding:var(--ax-space-md)}` is present;
  - nothing matches `/\.ax-p-4\b/`, `/\.ax-text-sm\b/` or `/\.ax-bg-white\b/`;
  - `.ax-text-meta` sets `font-size: var(--ax-text-meta-size)`;
  - `.ax-bg-surface` uses `var(--ax-bg-surface)`;
  - there is no `*, ::before` preflight rule.

  Add a drift test: `renderUiCss()` equals the committed `ui.css`.
- [ ] **Step 2:** Run `pnpm --filter @project-ax/ui exec vitest run preset`. It should fail (no preset).
- [ ] **Step 3:** Implement `preset.ts` and `build-css.ts`. The script writes `ui.css` with the same header
  style as `theme.css` ("Generated by …; run pnpm --filter @project-ax/ui gen").
- [ ] **Step 4:** Run `pnpm --filter @project-ax/ui gen`, then the tests. They should pass. Then run
  `pnpm --filter @project-ax/ui build && pnpm --filter @project-ax/ui typecheck`.
- [ ] **Step 5: Commit** `feat(ui): restricted Tailwind preset and compiled ui.css`.

### Task 2: The six components

**Files:**
- Create: `packages/ui/src/layout/{Stack,Inline,Grid,Divider}.tsx`, `packages/ui/src/components/{Text,Heading}.tsx`,
  `packages/ui/src/internal/cx.ts` (joins class strings), `packages/ui/src/internal/heading-level.ts`
  (React context, default 2, not exported publicly), tests in `packages/ui/src/__tests__/`
- Modify: `packages/ui/src/index.ts` (export the six components and their prop types),
  `packages/ui/package.json` (peerDeps `react`/`react-dom` `^19.0.0`; devDeps `react`, `react-dom`,
  `@types/react`, `@testing-library/react`, `jsdom` at channel-web's resolved versions),
  `packages/ui/tsconfig.json` (`jsx: react-jsx`, include `.tsx`), `packages/ui/vitest.config.ts`
  (`environment: 'jsdom'` for component tests), `packages/ui/ui.css` (regenerated)

**Interfaces (all in `src/index.ts`):**

```ts
type Align = 'start' | 'center' | 'end' | 'stretch';
export interface StackProps   { gap?: SpaceToken /* 'md' */; align?: Align /* 'stretch' */; id?: string; children?: ReactNode }
export interface InlineProps  { gap?: SpaceToken /* 'sm' */; align?: 'start'|'center'|'end'|'baseline' /* 'center' */;
                                justify?: 'start'|'between'|'end' /* 'start' */; wrap?: boolean; id?: string; children?: ReactNode }
export type GridColumns = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export interface GridProps    { columns: GridColumns | { base: GridColumns; md?: GridColumns; lg?: GridColumns };
                                gap?: SpaceToken /* 'md' */; id?: string; children?: ReactNode }
export interface DividerProps { orientation?: 'horizontal' | 'vertical' }
export type TextRoleName = 'body' | 'body-strong' | 'meta' | 'caption' | 'code';
export interface TextProps    { role?: TextRoleName /* 'body' */; inline?: boolean; truncate?: boolean; id?: string; children?: ReactNode }
export type HeadingRole = 'display' | 'title' | 'heading' | 'subheading';
export interface HeadingProps { role?: HeadingRole; id?: string; children?: ReactNode }
```

Rendering:

- **`Stack`** renders a `div` with flex column, gap and `items-*`.
- **`Inline`** renders a `div` with flex row, gap, items, justify and optional wrap.
- **`Grid`** renders a `div` with a grid, `grid-cols-N` and `md:`/`lg:` variants.
- **`Divider`**: horizontal renders `<hr>` with a `line` border. Vertical renders
  `<div role="separator" aria-orientation="vertical">`.
- **`Text`** renders `<p>`, or `<span>` when `inline`, with the role's font size. Colors by role:
  - `body` and `body-strong` use `fg`;
  - `meta` uses `fg-muted`;
  - `caption` uses `fg-subtle`;
  - `code` renders `<code>`, mono, and is a block unless `inline`.

  `truncate` adds the `truncate` class.
- **`Heading`** renders `h{level}`, where the level comes from `HeadingLevelContext` (default 2, capped at
  6). Its role defaults by level: 1 → `title`, 2 → `heading`, 3 and above → `subheading`.

- [ ] **Step 1: Write failing tests.**
  - `layout.test.tsx`:
    - `Stack` defaults have class `ax-gap-md` and `ax-flex-col`;
    - `Inline justify="between" wrap` has `ax-justify-between ax-flex-wrap`;
    - `Grid columns={{base:1, md:7}}` has `ax-grid-cols-1 md:ax-grid-cols-7`;
    - `Divider` has role `separator`, and the vertical one has `aria-orientation="vertical"`.
  - `text.test.tsx`:
    - `Text` renders `P`; `inline` renders `SPAN`; `role="code"` renders `CODE`;
    - `role="meta"` has `ax-text-meta ax-text-fg-muted`;
    - `Heading` with no provider renders `H2` with `ax-text-heading`;
    - `Heading` inside `HeadingLevelContext.Provider value={1}` renders `H1` with `ax-text-title`;
    - a provider value of 9 renders `H6`.
  - `ssr.test.tsx`: `renderToString` of every component (with each enum value) contains no `style=`.
  - `classes.test.ts`: every `ax-[\w:-]+` token found in `src/**/*.tsx` appears as a selector in `ui.css`.
  - `props.test-d.ts`: `@ts-expect-error` on `className`, `style` and `as` for each component, on
    `gap="4"`, and on `Text role="title"`.
- [ ] **Step 2:** Run `pnpm --filter @project-ax/ui exec vitest run`. It should fail.
- [ ] **Step 3:** Implement the components. Then run `pnpm --filter @project-ax/ui gen` so `ui.css` picks up
  their classes.
- [ ] **Step 4:** Run `pnpm --filter @project-ax/ui test && pnpm --filter @project-ax/ui typecheck && pnpm --filter @project-ax/ui build`.
  They should pass.
- [ ] **Step 5: Commit** `feat(ui): Stack, Inline, Grid, Divider, Text, Heading`.

### Task 3: Storybook, stories, axe and screenshots in CI

**Files:**
- Create: `packages/ui/.storybook/main.ts` (framework `@storybook/react-vite`, stories
  `src/**/*.stories.tsx`, no addons), `packages/ui/.storybook/preview.tsx` (imports `../theme.css` and
  `../ui.css`; a `theme` global, `light`|`dark`, that sets `data-theme` on `<html>`; page background
  `bg-surface` through a decorator that uses `Stack`, not a raw element);
  `src/layout/*.stories.tsx` and `src/components/*.stories.tsx` (one story per meaningful state: each gap
  extreme, each align and justify, wrap, responsive grid, both divider orientations, every text and heading
  role, truncate on a long line); `packages/ui/stories-test/stories.spec.ts`;
  `packages/ui/playwright.config.ts`; `packages/ui/stories-test/__screenshots__/**` (committed baselines)
- Modify: `packages/ui/package.json`:
  - scripts `storybook`, `build-storybook` (output `storybook-static/`, gitignored);
  - `stories:test` = build, then `playwright test`;
  - `stories:update` = the same inside
    `docker run --rm -v "$PWD/../..":/w -w /w/packages/ui mcr.microsoft.com/playwright:v1.59.1-noble … --update-snapshots`.

  Also modify `.github/workflows/ci.yml` (new job `ui-stories`: `runs-on: ubuntu-24.04`,
  `container: mcr.microsoft.com/playwright:v1.59.1-noble`; it installs, builds `@project-ax/ui`, and runs
  `pnpm --filter @project-ax/ui stories:test`, on `pull_request` and `push`). Add `.gitignore` entries
  for `storybook-static/` and `test-results/`.

- **The spec** reads `storybook-static/index.json`. It serves the directory with Playwright's `webServer`
  (`npx http-server`, or a 20-line node static server under `stories-test/`; no new dependency for it). For
  every entry of `type: 'story'` × `['light','dark']`, it:
  - opens `iframe.html?id=<id>&globals=theme:<theme>&viewMode=story` at 800×600;
  - waits for `#storybook-root > *`;
  - runs `AxeBuilder` and fails on any `serious` or `critical` violation, listing the rule ids;
  - calls `expect(page).toHaveScreenshot(\`${id}-${theme}.png\`, { fullPage: true })`.
- **Dependencies:** `storybook` and `@storybook/react-vite` pinned to the same exact version, the newest
  10.x published on or before 2026-11-10 (10.6.6 at planning time; check with `npm view storybook time`);
  `@playwright/test` `1.59.1`; `vite` pinned to channel-web's resolved version, if Storybook needs a peer.
  Put the `security-checklist` supply-chain note in the report.

- [ ] **Step 1:** Write the stories and the spec.
- [ ] **Step 2:** Run `pnpm --filter @project-ax/ui stories:test`. It should fail with missing screenshots,
  and axe should report nothing.
- [ ] **Step 3:** Run `pnpm --filter @project-ax/ui stories:update` (Docker, through the local daemon;
  OrbStack works here). Look at three baselines (the dark `Text` roles, the responsive `Grid`, and the
  vertical `Divider`) and describe them in the report.
- [ ] **Step 4:** Run `stories:test` inside the same image. It should pass.
- [ ] **Step 5: Commit** `feat(ui): Storybook stories with axe and screenshot tests in CI`.

### Task 4: channel-web uses `ui.css` and gets the first callers

**Files:**
- Modify: `packages/channel-web/src/index.css` (`@import '@project-ax/ui/ui.css';` directly after the
  `theme.css` import); the channel-web files you migrate, and their tests.

**Interfaces:**
- Consumes: the Task 2 exports.

Pick call sites so that **each of the six components gets at least one real caller**, preferring the
roadmap's most-repeated strings. Mapping:

| Today | Becomes |
|---|---|
| `text-sm text-muted-foreground` | `<Text role="meta">` |
| `flex flex-col gap-2` | `<Stack gap="sm">` (gap-1 → `xs`, 2 → `sm`, 3 → `md`, 4 → `lg`, 6 → `xl`) |
| `flex items-center gap-2` | `<Inline gap="sm">` |
| `grid grid-cols-N gap-*` | `<Grid columns={N} gap=…>` |
| `<hr>` / `border-t` separator | `<Divider />` |
| a section's `<h2>`/`<h3>` | `<Heading>` (a provider is not needed: default level 2) |

Keep it to at most ~6 files. S2b does the bulk migration. Leave `h1`s alone (S5b).

- [ ] **Step 1:** For each migrated file whose tests use `querySelector`/`toHaveClass` on the touched markup,
  move those assertions to role and text queries first. Confirm they pass on the old markup.
- [ ] **Step 2:** Migrate the call sites. Run `pnpm --filter @ax/channel-web exec vitest run <touched tests>`
  and `pnpm --filter @ax/channel-web typecheck`.
- [ ] **Step 3:** Run `pnpm lint:ui:prune` so the migrated files' frozen counts drop. Then run `pnpm lint`.
- [ ] **Step 4:** Run `pnpm --filter @ax/channel-web build`, then check visually with
  `packages/ui/eval/capture-baseline.ts --only=<routes>` in mock mode, before and after. Note in the report
  that the only expected difference is the §5.1 type collapse (for example meta 14px → 13px).
- [ ] **Step 5: Commit** `refactor(channel-web): first @project-ax/ui callers (Text, Stack, Inline, Grid, Divider, Heading)`.

### Task 5: Switch on `no-classname` and `no-raw-elements`; tighten the ratchet; fix the docs

**Files:**
- Modify: `eslint.config.mjs` (both rules → `'error'`; update the comment),
  root `package.json` (`lint:ui:suppress` adds `--suppress-rule ax-ui/no-classname --suppress-rule ax-ui/no-raw-elements`),
  `eslint-suppressions.json` (regenerated), `scripts/ui-suppressions-ratchet.mjs` and its test,
  `scripts/__tests__/ui-hooks.test.js`, the spec (§5.5, §6.4, steps 1 and 8), and
  `packages/ui/eval/results/2026-11-baseline/README.md` line 10.

Changes:

- **Ratchet: allow a rise only for a switch-on.** A rule's suppression total may rise only if the rule's
  severity in the base's `eslint.config.mjs` channel-web block is `'off'` (or the rule is absent) and in HEAD
  it is `'error'`. This replaces the "newly added to `lint:ui:suppress`" test, which allowed a two-PR bypass:
  drop the rule from the script in one PR, then re-add it at a higher count. Read the severity with a regex
  on `'ax-ui/<rule>':\s*'(off|warn|error)'`. If the regex finds no match, fail closed with a message naming
  the rule.
- **Ratchet: strip quotes.** `--suppress-rule "ax-ui/x"` and `'ax-ui/x'` parse as `ax-ui/x`.
- **Hook test.** Find the test in `ui-hooks.test.js` that still passes when `scripts/hooks/lint-ui-file.mjs`
  is reverted to its `72db4fb83` version (`git show 72db4fb83:scripts/hooks/lint-ui-file.mjs`). Tighten it so
  it fails there and passes on HEAD. Name the test in the report.
- **Docs (R18).** In the spec, replace "warn for unmigrated ones" and "only not-yet-migrated files stay at
  warn" with the as-built model: rules are `error`, existing violations are frozen in
  `eslint-suppressions.json`, and the CI ratchet only lets them go down. In §5.5, change "Public API only:
  `no-restricted-imports`" to "`ax-ui/no-internal-imports`". In §5.5, change the `AX_DS_TASK=1` mentions to
  the `.ax-ds-task` marker file. In the README, change the absolute home path to `~/ax-ui-eval/2026-11-baseline/`.

- [ ] **Step 1: Write failing ratchet tests:**
  - the two-PR bypass case: base severity `error`, rule absent from the base script, count rises → fails;
  - the switch-on case: base `off`, head `error`, count rises → passes;
  - quoted ids parse;
  - an unparseable severity → fails with the rule name.
- [ ] **Step 2:** Implement the ratchet changes. Run `pnpm test:scripts`.
- [ ] **Step 3:** Fix the hook test (see above). Run `pnpm test:scripts`.
- [ ] **Step 4:** Flip both rules, update the script, then run `pnpm lint:ui:suppress && pnpm lint:ui:prune && pnpm lint`.
  Run `node scripts/ui-suppressions-ratchet.mjs` against the merge base. It should pass, and print the new
  per-rule totals; put them in the report.
- [ ] **Step 5:** Make the doc edits.
- [ ] **Step 6: Commit** in two commits: `ci(ui): ratchet allows a rise only when a rule switches on`, then
  `chore(ui): switch on no-classname and no-raw-elements; doc pass`.

### Final gate (controller)

Run: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:scripts`, `pnpm test:eslint-rules`,
`pnpm --filter @project-ax/ui test`, `pnpm --filter @project-ax/eslint-plugin-ui test`, and the channel-web
tests touched in Task 4. Run `stories:test` in Docker. Docker-backed package suites need `DOCKER_HOST` set
explicitly (CLAUDE.md). Run them with
`DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock` if they are touched, otherwise leave them to CI.
