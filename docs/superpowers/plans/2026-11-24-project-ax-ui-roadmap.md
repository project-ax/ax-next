# `@project-ax/ui` + channel-web consolidation — roadmap

> Workstreams 1 and 2 of the design, as PR-sized cards. Step 1 has a full task-level plan
> (`2026-11-24-project-ax-ui-step1-foundation.md`). Every later card gets its own task-level plan when it's
> picked up (yolo-ship's planner writes it), because each step's API is shaped by what the previous one
> migrated.

**Spec:** `docs/superpowers/specs/2026-11-24-agent-first-ui-design.md` (§5, §6). Read it first.

## Rules every card follows

- Title prefix `[TASK-n] (ds)`. `(ds)` cards create `.ax-ds-task` in their worktree root (step 1 adds the guard
  that requires it).
- A component lands **in the same PR as its first channel-web callers** (no half-wired exports).
- Migrated files: removed from `eslint-suppressions.json` with `pnpm lint:ui:prune`; the suppression count only
  goes down.
- UI lint rules switch on as their replacements ship (ruling R15: S1 = `no-arbitrary-values` + `no-style-prop`;
  S2a = `no-classname` on intrinsic elements only + `no-raw-elements` for `div`/`span`/`p`/`h2`–`h6`, the tags
  S2a's components replace (ruling R12); S3–S6 = `no-internal-imports`, per area, and each area widens the
  `no-raw-elements` element list and extends `no-classname` to the components it replaces; S8 ends with the full
  lists). Each switch-on adds its rule
  to the root `lint:ui:suppress` script and regenerates `eslint-suppressions.json` — the CI ratchet
  (`scripts/ui-suppressions-ratchet.mjs`) lets a rule's total rise only in the PR that flips its severity in
  `eslint.config.mjs` from `off` to `error` or widens its options (and it refuses narrowing a rule that has frozen
  entries). S1, S2a and S3 are on (`no-internal-imports` with `uiModules: ['alert', 'skeleton', 'empty']`); S4–S6 are still to come.
- Tests on a migrated screen move from `querySelector`/`toHaveClass` to role/label queries in the same PR.
- A PR that applies a §6.3 rule visible to users (rules 2, 3, 4, 5, 9) attaches before/after screenshots
  (light + dark, 1440 + 390).
- Pre-PR: `pnpm build`, `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`,
  `pnpm lint`, `tsc` for touched packages.
- New dependencies: `security-checklist` supply-chain walk, exact pins.
- `scripts/check-*-layout.mjs` (workspace composer, agent connectors/memory/skills, routines) assert specific
  channel-web markup. A card migrating one of those surfaces updates or retires its check in the same PR.

## Cards

| Card | Scope | Depends on | Done when |
|---|---|---|---|
| **S1 Foundation** | `@project-ax/ui` scaffold, tokens, generated `theme.css`, contrast test, channel-web consumes `theme.css` through legacy aliases, `@project-ax/eslint-plugin-ui` (className/style/raw-elements/arbitrary/imports) with ESLint bulk suppressions on channel-web, write guard hook + lint hook, CODEOWNERS | — | Step-1 plan's tasks pass; channel-web renders identically; a new arbitrary value or `style` in channel-web fails `pnpm lint` |
| **S2a Build + stories infra** | Restricted Tailwind preset (`prefix: 'ax-'`, token scales only), generated `ui.css`, Storybook (react-vite) + axe + Playwright story screenshots in CI (Storybook's `preview.css` supplies the base layer). Ships with `Text`, `Heading`, `Stack`, `Inline`, `Grid`, `Divider` and their stories; switch on `ax-ui/no-classname` (intrinsic elements only) + `ax-ui/no-raw-elements` (`div`/`span`/`p`/`h2`–`h6`) and regenerate suppressions — the element list and component `className` widen per area in S3–S6, and S8 ends with the full lists | S1 | Stories pass axe; screenshot baseline committed; preset test proves `p-4` is not generated |
| **S2b Text + layout migration** | Replace the 15 most-repeated class strings app-wide (`text-sm text-muted-foreground` ×87, `flex flex-col gap-2` ×52, …) with `Text`/`Stack`/`Inline` | S2a | Suppression count drops by the migrated occurrences; no visual diff beyond the §5.1 type-scale collapse (screenshots) |
| **S2c Composites escape hatch** | `CustomSection` (`reason`) + `defineComposite({name,purpose,render})` + lint rules `custom-section`, `composites-only-preset`; channel-web `src/composites/` created. First caller: move one existing bespoke widget behind `CustomSection` (no half-wired export) | S2a | A `CustomSection` with no `reason`, or wrapping anything but one composite, fails lint; Tailwind outside `src/composites/` fails lint |
| **S3 States + feedback** | `AsyncState`, `EmptyState`, `Notice`, `Toast`, `Button` (`intent`, `size`, `busy`), `IconButton`, `ConfirmAction`. Migrate every loading/error/empty/confirm site; delete PaneStatus, ReadFailure, ReadError×2, LoadingRows×2, Note×2, SectionNote, the 3 LoadFailures, the 3 `Busy` copies, private ConfirmDialog. Add confirms to Revoke and site Remove (rule 5) | S2a | §6.3 rules 5 + 7 hold app-wide; retry copy is "Try again" everywhere. **Built (S3a–c)** |
| **S4 Rows + status** | `List`, `ListRow`, `KeyValueList`, `StatusBadge`, `StatusMark`, `Timestamp`, `Avatar`, `FileTile`, `Timeline`, `InsetBlock`, `Card`. Migrate ~20 row impls, all badges/dots/pills, 7 time helpers; delete dead `ProviderRow`, `KeyForm`, `StatusDot`, `AgentStateLabel` | S2a (S3 for row menus' confirms) | Rules 8, 10, 11 hold; one divider method; no nested cards |
| **S5a Shell + nav** | `AppShell`, `Sidebar`, `NavSection`, `NavItem`, `Header`, `Footer`; migrate workspace frame + AdminShell; drop Button `navigation`/`settings-nav`/`settings-row` | S2a | One active-row style |
| **S5b Headers + archetypes** | `PageHeader`, `Section` (incl. `scope="workspace"`), `ListPage`, `DetailPage`, `SettingsPage`, `FocusPage`, `WorkspacePage`, `BasePage`. Migrate every page frame (split by surface: admin/settings/routines vs workspace/today/tasks vs full-page) | S5a, S4, S2c | Rules 1, 2, 3, 9 hold; one `h1` per page |
| **S5-walk (walk)** | Drive migrated surfaces on kind (light/dark, 1440/390) incl. approval, streaming, error, focus-restore | S5b | Walk report filed; regressions carded |
| **S6a Fields + controls** | `TextField`, `TextArea`, `Select`, `Combobox`, `Checkbox`, `Switch`, `RadioGroup`, `Form`, `FormActions`, `DataTable`, `Tabs`, `Menu`, `Tooltip`. Swap them in place inside existing editors and tables (layout and editing flow unchanged) | S2a, S3 | No shadcn field/table/tabs/menu/tooltip import left in channel-web outside `components/ui/`; every field has a label |
| **S6b Editing model** | `FormDialog`. Apply rule 4 (dialog ≤ ~6 fields, else routed `DetailPage`) and rule 6 (Save model) to every editor | S5b, S6a | Rules 4 + 6 hold; dialog widths are `sm|md|lg` only |
| **S6-walk (walk)** | Same as S5-walk for editors and tables | S6b | as above |
| **S7 Chat + media** | `Thread`, `Message`, `Composer`, `Markdown`, `Frame`, `Chart`, `Image`, `Progress`; AX chat composites into `src/composites/`. `security-checklist` (untrusted HTML/markdown). The workspace page frame around chat stays with S5b | S4, S2c | Chat, artifacts, visuals behave as before (walk) |
| **S7-walk (walk)** | Chat surfaces: streaming, approvals in chat, visuals, artifacts, attachments | S7 | as above |
| **S8 Finish** | Delete `src/components/ui/`; channel-web Tailwind config → restricted preset over `src/composites/**`; suppressions file empty for channel-web; CLAUDE.md invariant #6 → `@project-ax/ui` + "UI work uses the `ax-ui` skill"; shadcn skill → `-c packages/ui`, DS tasks only; DESIGN.md → `packages/ui`; `ax-ui` skill + `build-skill.ts` + CI drift check; final baseline re-run into `packages/ui/eval/results/` | S6b, S7 | Zero UI-rule violations in channel-web; every story axe-clean; §6.1 counts re-recorded |

## Parallelism

```
S1 → S2a → { S2b, S2c, S3, S4, S5a }        S3 → S6a
           S4 + S2c          → S7  → S7-walk
           S5a + S4 + S2c    → S5b → S5-walk
           S5b + S6a         → S6b → S6-walk
           S6b + S7          → S8
```

- After S2a, up to six cards can be in flight (S2b, S2c, S3, S4, S5a, then S6a once S3 lands). auto-ship runs
  3 at a time by default, so this drains in waves unless that cap is raised.
- S2a gates everything. Keep it to its listed scope; anything that can wait goes to a later card.
- Within S5b, S6b and S7, split by surface; the component lands with whichever surface PR gets there first and
  the others rebase onto it.
- `eslint-suppressions.json` is one file every card edits, so parallel cards conflict on it. Never hand-merge
  it: after rebasing, take either side and regenerate with `pnpm lint:ui:prune` (plus `pnpm lint:ui:suppress`
  in a card that switches a rule on), then let the CI ratchet check the totals.

**Baseline capture** (part of S1): before the theme swap, capture light/dark × 1440/390 screenshots of every
surface on kind and an axe run, into `packages/ui/eval/results/2026-11-baseline/` (the §6.1 counts are already
in the spec).
