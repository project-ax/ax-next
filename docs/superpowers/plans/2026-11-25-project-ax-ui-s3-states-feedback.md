# S3 — States + feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `Button`, `IconButton`, `Notice`, `EmptyState`, `AsyncState`, `ConfirmAction` and `Toast` in `@project-ax/ui`. Migrate channel-web onto them so that §6.3 rule 5 ("Destructive = `ConfirmAction`, always") and rule 7 ("One state language") hold app-wide. First, make the suppressions ratchet understand rule options.

**Architecture:**
- **Components.** They follow the S2a pattern: literal class maps in `ax-` Tailwind, no `className`/`style`/`as` props, a story per state, axe and Docker screenshots.
- **Shared internals.** Radix (dialog, tooltip) and lucide stay internal to the package. A shared internal `ButtonBase` spreads Radix trigger props, so the public `Button` stays narrow.
- **Migration.** channel-web moves file by file, split by surface. Each named duplicate component is deleted in the task that removes its last caller.
- **Lint.** It switches on only for shadcn modules whose last caller is gone, so that switch freezes nothing.

**Tech Stack:**
- React 19, TypeScript, Tailwind 3.4.19 (restricted `ax-` preset).
- `@radix-ui/react-dialog` and `@radix-ui/react-tooltip`, at the exact versions channel-web's lockfile resolves.
- `lucide-react`, same rule.
- Vitest with jsdom, Storybook 10.6.7, `@playwright/test` 1.59.1 and `@axe-core/playwright` 4.14.0 in the digest-pinned Docker image.

**Spec:** `docs/superpowers/specs/2026-11-24-agent-first-ui-design.md` (§5.3 API rules, §5.4 table rows for `Button`, `IconButton`, `AsyncState`, `EmptyState`, `Notice`, `Toast`, `ConfirmAction`, §6.3 rules 5 and 7, §6.4). Roadmap card: `docs/superpowers/plans/2026-11-24-project-ax-ui-roadmap.md` → **S3 States + feedback**. Site inventory used to size this plan: copy of the 11-25 sweep is summarised in each migration task below.

## PR split

S3 is three stacked PRs on one branch (`design/project-ax-ui-s3`, stacked on #1258). Every task is one or more commits, so the split is a commit range:

| PR | Tasks | Visible change |
|---|---|---|
| **S3a** components + rule 5 | 1–7 | confirms gain one look; Revoke ×3, site Remove, Remove key and app-grant Remove gain a confirm; toasts restyled |
| **S3b** rule 7, admin/settings/routines/top-level | 8–9 | loading/error/empty look the same on those surfaces |
| **S3c** rule 7, workspace + lint switch-on | 10–12 | same for workspace; lint locks it |

Rules 5 and 7 change visible behavior, so each PR attaches before/after screenshots (light/dark, 1440/390) of 3–5 representative sites. The controller captures them on kind at finish, not the tasks.

## Global Constraints

- Component API (§5.3): no styling props (`className`, `style`, `as`, raw colors); enums ≤ 4 members; required a11y props; destructive actions only through `ConfirmAction`; status as enums, never colors.
- `Button`: `intent: primary | secondary | quiet`, `size: sm | md`, `busy`. No `danger` intent in the public API. `busy` always shows spinner + the unchanged label; label-swapping ("Saving…") goes away.
- `IconButton`: `label` required; tooltip built in.
- Retry copy is exactly **"Try again"** everywhere.
- Rule 5: Cancel label is **"Cancel"**; the confirm label is the verb ("Remove site", "Revoke").
- Rule 7: loading = skeleton shaped like the content (`rows` / `lines` / `block`); spinners only inside buttons and for whole-page boot. Error = `AsyncState` error (danger `Notice` + "Try again"). Empty = `EmptyState`.
- Package files use the restricted preset only: `ax-` classes from token scales, no arbitrary values; class strings are literal lookups (`cx` + maps), never built from strings.
- Everything SSR-safe (no `window`/`document` at module scope or during render).
- New deps: exact pins, the version channel-web already resolves in `pnpm-lock.yaml`; `security-checklist` supply-chain walk recorded in the task report.
- Every migrated channel-web file: no new `ax-ui/*` violations; afterwards `pnpm lint:ui:prune` (never `lint:ui:suppress` except in Task 12); totals only go down.
- Tests on a migrated screen move from `querySelector`/`toHaveClass`/`data-slot`/`data-testid` to role/label/text queries in the same task.
- `.ax-ds-task` marker exists in the worktree root (write guard).
- Pre-commit gate per task: `pnpm --filter @project-ax/ui test` (package tasks), `pnpm --filter @ax/channel-web exec tsc --noEmit -p .` + `pnpm --filter @ax/channel-web test` (channel-web tasks; Docker suites need `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`), `pnpm lint`.

## Review Focus

1. **Double submit.** If someone clicks Confirm twice, or presses Enter while `onConfirm` is pending, `onConfirm` must run once. Escape, an overlay click and Cancel must not close the dialog mid-request. Tests go in Task 4.
2. **`onConfirm` rejects with a server error string.** The dialog shows the caller's mapped copy, or the generic default, and never `String(err)`. The confirm button is re-enabled, and the error clears when the dialog reopens. Tests go in Task 4.
3. **A long or unbreakable error message, or a 40-character title.** `Notice` and `EmptyState` must wrap without horizontal scroll at 390px. Stories with long copy go in Task 3, so the screenshot pins it.
4. **The session expired while reading.** The read-register policy (`lib/read-register.ts`: expired session → neutral tone, no retry button) has to survive the move to `AsyncState`. Test goes in Task 6.
5. **Rapid toasts.** Five toasts within a second stack, `danger` toasts stay until dismissed, `info` toasts auto-dismiss after 5000 ms, and dismissing one doesn't drop another. Tests go in Task 5.

---

### Task 1: Ratchet understands rule options (rulings R18 + R19)

**Model:** standard. **Files:**
- Modify: `scripts/ui-suppressions-ratchet.mjs`
- Test: `scripts/__tests__/ui-suppressions-ratchet.test.js` (existing harness; add cases)
- Modify: `docs/superpowers/specs/2026-11-24-agent-first-ui-design.md` §6.4 (one sentence), roadmap "Rules every card follows" (one sentence)

**Interfaces:** Produces `ruleScope(ref, rule) → { kind: 'off' } | { kind: 'scope', scope: Scope } | { kind: 'unreadable' }`, used only inside the script.

Today a rule's total may rise only on an off→error switch. Widening an `error` rule's options (more elements, more banned modules, dropping `intrinsicOnly`) is the other legitimate rise. Narrowing an `error` rule that has frozen entries is laundering. This is ruling R18 plus a narrowing check, and it's the same shape as the downgrade check.

Option semantics. A rule given as plain `'error'` (no options) means its widest scope.

| Rule | Option | Wider means |
|---|---|---|
| `ax-ui/no-raw-elements` | `elements: string[]` (absent = every element) | HEAD set ⊋ base set, or HEAD absent and base present |
| `ax-ui/no-classname` | `intrinsicOnly: boolean` (absent = false), `components: string[]` (absent = none; ignored when `intrinsicOnly` is false) | `intrinsicOnly` true→false, or `components` HEAD ⊋ base with `intrinsicOnly` unchanged |
| `ax-ui/no-internal-imports` | `uiModules: string[]` (absent = all of `components/ui/*`) | HEAD set ⊋ base set, or HEAD absent and base present |
| any other `ax-ui/*` rule | — | an options object is `unreadable` |

Read the options from the same comment-stripped channel-web block `severity()` uses. An options object counts as readable only when it's an object literal whose keys are in the table, with string-literal arrays and boolean literals as values. Anything else is `unreadable`, which fails closed whenever the total rose or a narrowing check needs it.

New decision rules:
1. **Allow a rise when the rule was already `error` and HEAD is strictly wider.** The rule must be in the `lint:ui:suppress` script. Print `"<rule>: widened in this range (<what>): frozen <h> (base <b>)."`.
2. **Fail when the rule was `error` with b > 0 at the base, and HEAD is strictly narrower or incomparable.** That covers fewer elements, `intrinsicOnly` false→true, fewer modules, or a set that is neither ⊇ nor ⊆. The message mirrors the downgrade message, whatever the totals.
3. **Everything else keeps today's behaviour.**

- [ ] **Step 1: Write failing tests.** Use the harness's existing temp-repo fixture: commit a base, commit a HEAD, run the script. Add these cases:
  - `widen elements div→div,button with total rise: exit 0, prints "widened"`
  - `same elements with total rise: exit 1`
  - `narrow elements with frozen entries: exit 1 even with no total change`
  - `intrinsicOnly true→false rise: exit 0`
  - `intrinsicOnly false→true with frozen entries: exit 1`
  - `components [] → ['Button'] rise: exit 0`
  - `uiModules ['alert'] → ['alert','skeleton'] rise: exit 0`
  - `options object with an unknown key and a rise: exit 1 "cannot be read"`
  - `options given as a variable (elements: LIST) and a rise: exit 1`
  - `widened but rule missing from lint:ui:suppress: exit 1`
- [ ] **Step 2:** Run `pnpm exec vitest run scripts/__tests__/ui-suppressions-ratchet.test.js`. Expect the new cases to fail and the old ones to pass.
- [ ] **Step 3:** Implement `ruleScope` and the two decision rules. Update the header comment: replace the "Switching a rule on is the one legitimate way" paragraph with switch-on and widening, and add the narrowing rule.
- [ ] **Step 4:** The same command now passes. `pnpm test:scripts` passes.
- [ ] **Step 5:** Doc sentences:
  - spec §6.4: "a rule's frozen total may rise only in the PR that switches the rule on **or widens its options**".
  - Roadmap: same, and remove "S3 must make it options-aware" from memory-facing notes, if any exist in docs.

  Commit `feat(ratchet): allow a total to rise when a rule's options widen; refuse narrowing a rule with frozen entries`.

### Task 2: `Button`, `IconButton` (and the package's motion, spinner, button base)

**Model:** standard. **Files:**
- Create: `packages/ui/src/internal/ButtonBase.tsx`, `packages/ui/src/internal/Spinner.tsx`, `packages/ui/src/components/Button.tsx`, `packages/ui/src/components/IconButton.tsx`, `Button.stories.tsx`, `IconButton.stories.tsx`
- Modify: `packages/ui/src/index.ts`, `packages/ui/package.json` (deps), `packages/ui/src/tailwind/preset.ts` (animation), `packages/ui/ui.css` (regenerated by `pnpm --filter @project-ax/ui gen`), `packages/ui/src/__tests__/props.test-d.ts`
- Test: `packages/ui/src/__tests__/button.test.tsx`

**Interfaces (produces):**
```ts
export type ButtonIntent = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'sm' | 'md';
export interface ButtonProps {
  intent?: ButtonIntent;            // default 'secondary'
  size?: ButtonSize;                // default 'md'
  busy?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset'; // default 'button'
  icon?: LucideIcon;                // leading, aria-hidden
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  form?: string;
  autoFocus?: boolean;
  'aria-describedby'?: string;
  ref?: React.Ref<HTMLButtonElement>;
  children: React.ReactNode;
}
export interface IconButtonProps {
  label: string;                    // aria-label + tooltip text
  icon: LucideIcon;
  intent?: 'secondary' | 'quiet';   // default 'quiet'
  size?: ButtonSize;
  busy?: boolean; disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  ref?: React.Ref<HTMLButtonElement>;
}
// internal (not exported from index): ButtonBase accepts the above visual
// props plus `tone?: 'danger'` and spreads any other props (Radix triggers),
// Spinner renders lucide Loader2 with ax-animate-spin motion-reduce:ax-animate-none.
```
Look: these are today's shadcn variants, re-expressed in tokens.
- `primary` = `default` (the `action` token).
- `secondary` = `outline`.
- `quiet` = `ghost`.
- Internal `tone="danger"` = `destructive`.
- `md` = 40 px high, and `sm` = 36 px.
- Below the `md` breakpoint, minimum 44 × 44 (today's `max-md:min-h-11 min-w-11`).
- Busy: `aria-busy="true"`, `disabled` set, spinner before the unchanged label, width stable.
- IconButton wraps `@radix-ui/react-tooltip`. Its own `Tooltip.Provider` has `delayDuration={300}`. Tooltip content uses the `overlay` surface and the `caption` text role.

- [ ] **Step 1: Failing tests in `button.test.tsx` (jsdom pragma):**
  - `renders a <button type="button"> by default`.
  - `busy: aria-busy=true, disabled, keeps label text, onClick not called on click`.
  - `intent/size map to distinct class sets (snapshot the class attr for the 3×2 matrix)`.
  - `IconButton has accessible name = label and shows label in tooltip on focus`.
  - `icon is aria-hidden`.
  - `ssr: renderToString(<Button busy>Save</Button>) does not throw`.
  - Add to `props.test-d.ts`: `// @ts-expect-error className is not a prop` on Button and IconButton, plus `// @ts-expect-error label required` on IconButton.
- [ ] **Step 2:** `pnpm --filter @project-ax/ui test`. The new tests fail.
- [ ] **Step 3:** Add the dependencies `lucide-react`, `@radix-ui/react-tooltip` and `@radix-ui/react-dialog` (the last is used by Task 4; add it now, one supply-chain walk). Pin the exact versions from `pnpm-lock.yaml`'s channel-web entries. Add `animation: { spin, pulse }` and their keyframes to the preset, and confirm the `motion-reduce` variant and `sr-only` are generated. Implement the components. Export `Button`, `ButtonProps`, `ButtonIntent`, `ButtonSize`, `IconButton` and `IconButtonProps`. Run `gen`.
- [ ] **Step 4:** Add stories with one per state:
  - `Button`: every intent × size, Busy, Disabled, WithIcon, LongLabel.
  - `IconButton`: Quiet, Secondary, Busy, and TooltipOpen with the tooltip forced open by `defaultOpen`.

  Then run `pnpm --filter @project-ax/ui stories:update`, then `stories:test`. Unit tests, axe and screenshots pass, and `classes.test.ts` passes.
- [ ] **Step 5:** Commit `feat(ui): Button and IconButton`.

### Task 3: `Notice`, `EmptyState`, `AsyncState`

**Model:** standard. **Files:**
- Create: `packages/ui/src/components/{Notice,EmptyState,AsyncState}.tsx` and `.stories.tsx`
- Create: `packages/ui/src/internal/Skeleton.tsx`
- Modify: `index.ts`, `props.test-d.ts`, `ui.css`
- Test: `packages/ui/src/__tests__/states.test.tsx`

**Interfaces (produces):**
```ts
export type NoticeTone = 'info' | 'warning' | 'danger' | 'success';
export interface NoticeProps {
  tone: NoticeTone;
  title?: string;
  children?: React.ReactNode;             // body text
  action?: { label: string; onClick: () => void };   // secondary sm Button
  onDismiss?: () => void;                 // quiet IconButton label "Dismiss", X icon
}
export interface EmptyStateProps {
  title: string;                          // rendered by Heading, role 'subheading'
  description?: string;
  icon?: LucideIcon;
  action?: { label: string; onClick: () => void };   // secondary Button
}
export type SkeletonShape = 'rows' | 'lines' | 'block';
export interface AsyncStateProps {
  status: 'loading' | 'error' | 'empty' | 'ready';
  skeleton: SkeletonShape;
  loadingLabel: string;                   // sr-only text inside role=status
  error?: { message: string; onRetry?: () => void; tone?: 'danger' | 'info' };
  empty?: EmptyStateProps;
  children?: React.ReactNode;             // shown when ready
}
```
Behaviour:
- **Notice role.** `danger` and `warning` → `role="alert"`; `info` and `success` → `role="status"`.
- **Notice look.** Soft status fill, status-colored text, and an icon per tone (Info, TriangleAlert, CircleAlert, CircleCheck). The title uses `body-strong` and the body uses `meta`.
- **AsyncState loading.** A `role="status"` wrapper with `aria-busy="true"` and an sr-only `loadingLabel`, then the skeleton:
  - `rows` = 3 bars of 40 px, `md` gap;
  - `lines` = 3 text-height bars at 100%, 90% and 60% width;
  - `block` = one 160 px block.

  Bars use `ax-animate-pulse motion-reduce:ax-animate-none` on the `surface-raised` fill.
- **AsyncState error.** A `Notice` with tone `error.tone ?? 'danger'`, body `error.message`, and the action `{label: 'Try again', onClick: onRetry}` only when `onRetry` is set. A missing `error` falls back to the message "Something went wrong."
- **AsyncState empty.** `<EmptyState {...empty}/>`. A missing `empty` renders nothing.
- **AsyncState ready.** Renders `children`.

- [ ] **Step 1: Failing tests:**
  - `Notice danger has role alert; info has role status`.
  - `Notice action renders a button with the label and calls onClick`.
  - `Notice onDismiss renders "Dismiss"`.
  - `EmptyState title is a heading`.
  - `AsyncState loading: role status, aria-busy, sr label, no children rendered`.
  - `AsyncState error with onRetry shows exactly "Try again"; without onRetry shows no button`.
  - `AsyncState error tone info renders role status (read-register: expired session)`.
  - `AsyncState empty renders EmptyState`.
  - `AsyncState ready renders children only`.
  - SSR render of each status.
  - Type tests: no `className`; `tone` rejects `'error'`.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement, export (`Notice`, `NoticeProps`, `NoticeTone`, `EmptyState`, `EmptyStateProps`, `AsyncState`, `AsyncStateProps`, `SkeletonShape`), then run `gen`.
- [ ] **Step 4: Stories:**
  - `Notice`: each tone, WithTitle, WithAction, Dismissible, and LongUnbreakableMessage. A 200-character URL must wrap at 390 px (add a `viewport` story parameter or a 390 px decorator).
  - `EmptyState`: Basic, WithAction, WithIcon, LongTitle.
  - `AsyncState`: Loading for each skeleton, ErrorWithRetry, ErrorNoRetry, ErrorInfoTone, Empty, Ready.

  Run `stories:update` and `stories:test`, then the unit tests. Everything passes.
- [ ] **Step 5:** Commit `feat(ui): Notice, EmptyState, AsyncState`.

### Task 4: `ConfirmAction`

**Model:** most capable (async state machine + focus + a11y). **Files:**
- Create: `packages/ui/src/components/ConfirmAction.tsx`, `ConfirmAction.stories.tsx`
- Modify: `index.ts`, `props.test-d.ts`, `ui.css`
- Test: `packages/ui/src/__tests__/confirm-action.test.tsx`

**Interfaces (produces):**
```ts
interface ConfirmActionBase {
  title: string;                       // "Remove example.com?"
  description?: string;
  confirmLabel: string;                // the verb: "Remove site"
  onConfirm: () => Promise<void> | void;
  errorMessage?: (err: unknown) => string;  // default () => "That didn't work. Try again."
  tone?: 'danger' | 'neutral';         // confirm button: danger (default) or primary, e.g. Pause agents
}
export type ConfirmActionProps = ConfirmActionBase & (
  | { trigger: { label: string; intent?: 'secondary' | 'quiet'; size?: ButtonSize; icon?: LucideIcon; iconOnly?: boolean } }
  | { open: boolean; onOpenChange: (open: boolean) => void }   // controlled: from a menu item
);
```
Generalized from `DisconnectDialog` in `packages/channel-web/src/components/admin/SlackTab.tsx`, built on `@radix-ui/react-dialog`:
- **Dialog:** the `overlay` surface, width `narrow`, `title` as Dialog.Title, `description` as Dialog.Description.
- **Footer:** right-aligned. A `quiet` "Cancel" comes first, then the confirm button, which is `ButtonBase tone="danger"` (or `primary` when `tone="neutral"`) with label `confirmLabel`.
- **While busy:**
  - the confirm button is `busy`, and Cancel is disabled;
  - `onOpenChange(false)` is ignored, so Escape, an overlay click and Cancel do nothing;
  - a second confirm is a no-op.
- **When `onConfirm` resolves:** the dialog closes, and Radix returns focus to the trigger.
- **When it rejects:** it stays open and shows a danger `Notice` with `errorMessage(err)` above the footer, with busy cleared. A reopened dialog has no error.
- **Trigger:**
  - `iconOnly` renders an `IconButton` with `label` and `icon`; otherwise a `Button`.
  - Both go through `Dialog.Trigger asChild` on `ButtonBase`.
  - The trigger's default intent is `quiet` when `iconOnly`, else `secondary`.

- [ ] **Step 1: Failing tests (jsdom, `@testing-library/react` with `userEvent` from the package's devDeps; add `@testing-library/user-event` at channel-web's resolved version only if it's missing):**
  - `opens from trigger; title and description are the dialog's name and description`.
  - `Cancel closes without calling onConfirm`.
  - `confirm resolves → onConfirm called once, dialog closes, focus back on trigger`.
  - `double click on confirm while pending calls onConfirm once`.
  - `Escape while pending does not close; Cancel disabled while pending`.
  - `reject → dialog stays, error Notice (role alert) shows errorMessage(err); confirm enabled again`.
  - `default error copy is "That didn't work. Try again." and never includes the thrown message`.
  - `error is cleared when reopened`.
  - `controlled mode: open=true renders dialog; resolve calls onOpenChange(false)`.
  - `labels: cancel is exactly "Cancel", confirm is confirmLabel`.
  - Type test: `trigger` and `open` together is an error, `confirmLabel` is required.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement and export (`ConfirmAction`, `ConfirmActionProps`). Run `gen`.
- [ ] **Step 4:** Stories, with the dialog open via the controlled mode so the screenshot captures it: Danger, Neutral, Busy (an `onConfirm` that never resolves, clicked in a `play` function), Error (rejects in `play`), IconTrigger (closed). Run `stories:update`/`stories:test` and unit tests until they pass.
- [ ] **Step 5:** Commit `feat(ui): ConfirmAction`.

### Task 5: `Toast` replaces channel-web's toast store

**Model:** standard. **Files:**
- Create: `packages/ui/src/components/Toast.tsx` (store + `ToastRegion`), `Toast.stories.tsx`
- Modify: `index.ts`, `ui.css`
- Test: `packages/ui/src/__tests__/toast.test.tsx`
- channel-web:
  - Delete: `src/lib/toast-store.ts`, `src/components/Toast.tsx`, and the `.toast*` CSS in `src/index.css`.
  - Modify: the 24 call sites and the 4 `<ToastStack />` mounts. The sites are:
    - `App.tsx` ×6
    - `workspace/ArtifactOwnerMenu` ×3
    - `workspace/ArtifactViewer` ×3
    - `admin/UsageTab` ×2
    - `workspace/WorkspaceShell` ×2
    - `lib/copy-share-link.ts` ×2
    - one each in `SharedArtifactPage`, `workspace/ArtifactCard`, `workspace/GrantRow`, `admin/ModelsTab`, `admin/StorageLimitsCard` and `admin/UsageLimitsCard`
  - Rewrite: `src/__tests__/toast.test.tsx` and any test mocking `toast-store` (grep `toast-store`).

**Interfaces (produces):**
```ts
export type ToastTone = NoticeTone;
export interface ToastInput { title: string; description?: string; tone?: ToastTone; duration?: number }
export const toast: {
  show(input: ToastInput): string;   // returns id
  dismiss(id: string): void;
};
export function ToastRegion(): JSX.Element;   // region aria-label "Notifications", aria-live polite, stacks newest last
```
Behaviour:
- **Auto-dismiss.** `info` and `success` toasts auto-dismiss after `duration ?? 5000` ms. `warning` and `danger` stay until dismissed, as today's `error` does.
- **Look and dismiss.** Each toast has the Notice look and a "Dismiss" IconButton.
- **Store.** A module singleton read through `useSyncExternalStore`, with a server snapshot of `[]`. Timers are cleared on dismiss.
- **Call mapping:**
  - `toastActions.show({title, detail, kind:'info'})` → `toast.show({title, description: detail})`.
  - `toastActions.error(t, d)` → `toast.show({title: t, description: d, tone: 'danger'})`.
  - `kind:'error'` → `tone:'danger'`.

- [ ] **Step 1: Failing package tests (fake timers):**
  - `info auto-dismisses at 5000ms`.
  - `danger stays after 60s`.
  - `dismiss(id) removes only that toast`.
  - `five rapid shows render five, in order`.
  - `region has accessible name "Notifications"`.
  - `SSR renderToString(<ToastRegion/>) is empty region, no throw`.
- [ ] **Step 2:** Run them and confirm they fail. Implement and export. Add stories: Info, Danger, Stack of 3. Run `stories:update`/`stories:test`.
- [ ] **Step 3:** Migrate the channel-web calls and mounts, and delete the old store, component and CSS. Rewrite `toast.test.tsx` around role/name queries, covering the same behaviours it covered.
- [ ] **Step 4:** channel-web `tsc`, tests, `pnpm lint`, then `pnpm lint:ui:prune`. Run `grep -rn "toast-store\|ToastStack\|toastActions" packages/channel-web/src` and confirm it's empty.
- [ ] **Step 5:** Commit `feat(ui): Toast; channel-web toasts move to it`.

### Task 6: Delete the named duplicates (first callers of every component)

**Model:** standard. **Files (channel-web `src/components/...`):**

| Duplicate (definition) | Becomes | Callers |
|---|---|---|
| `Busy` ×7: `workspace/AgentSlackBotLifecycle:55`, `workspace/AgentSlackBotChanges:72`, `workspace/AgentSlackBot:177`, `admin/SlackBotsCard:90`, `admin/SlackBotRequests:57`, `admin/SlackTab:123`, `slack/BotTokenReplaceDialog:59` | `Button busy` with the idle label kept (no "…ing" swap). The surrounding shadcn `Button` becomes `Button` per the intent map below. | 17 `{busy ? <Busy>…</Busy> : 'Label'}` sites in those files |
| `ConfirmDialog` (private), `workspace/AgentSlackBotLifecycle:79` | `ConfirmAction` (controlled) | `:195`, `:261` |
| `TasksLoadFailure` (`workspace/TasksPage:231`), `CheckinLoadFailure` (`workspace/TaskCheckinPage:267`), `TaskLoadFailure` (`workspace/TaskPage:1095`) | `AsyncState` error. Tone and retry come from `lib/read-register.ts` (`readAlertVariant` → `'danger' \| 'info'`; no `onRetry` unless `error === 'failed'`). | one each |
| `ReadError` (`admin/StorageTab:172`, `admin/SlackTab:145`) | `AsyncState` error | StorageTab `:259`, `:398`; SlackTab `:1005` |
| `LoadingRows` (`admin/StorageTab:185`) | `AsyncState` loading, `skeleton="rows"` | `:256`, `:340` |
| `PaneStatus` (`components/PaneStatus.tsx`) | `AsyncState` (loading/error/empty) | `admin/TeamList` ×3, `admin/AuthProvidersTab` ×4, `routines/AgentSelfImprovementSection` ×6 |
| `ReadFailure` (`workspace/bits.tsx:564`) | `AsyncState` error. Tone `info` when `status === 'unavailable'`, with no retry; `danger` with `onRetry` otherwise, where the caller passes its reload. Copy unchanged. | `workspace/ConnectorsTab:526`, `workspace/ConnectorDetails:222` |
| `Note` ×2 (`workspace/LearnedInChat:101`, `workspace/ConnectorsTab:37`), `SectionNote` (`workspace/AgentFiles:171`) | `Text role="meta"` when it is explanatory copy. Use `EmptyState` when the note says there is nothing yet, such as "No …" or "Nothing …". | 8 + 7 + 1 |

Shadcn-to-`Button` intent map (also used by Tasks 7–11):

| shadcn variant | `Button` intent |
|---|---|
| none or `default` | `primary` |
| `outline` or `secondary` | `secondary` |
| `ghost` or `link` | `quiet` |
| `destructive` | only allowed inside `ConfirmAction`; elsewhere `secondary` |

Size: `sm` → `sm`; `default`/`lg` → `md`; `size="icon"` → `IconButton`, whose `label` is the existing `aria-label` or `sr-only` text. A Button with `asChild` (link) stays shadcn until S5a/S6a.

- [ ] **Step 1:** Each touched screen's tests get role/text assertions for the new behaviour:
  - busy: the button keeps its label and has `aria-busy`;
  - failures show "Try again" only when retryable;
  - an expired session shows no retry (Review Focus 4: add one test for `TasksPage` with `error='expired'` and assert there is no "Try again" button);
  - PaneStatus sites show the status role.

  Update tests that pinned the old markup. Run them and confirm they fail.
- [ ] **Step 2:** Migrate and delete each definition (and `PaneStatus.tsx`). Running `grep -rnE "function (Busy|ConfirmDialog|TasksLoadFailure|CheckinLoadFailure|TaskLoadFailure|ReadError|LoadingRows|ReadFailure|Note|SectionNote)\b|PaneStatus" packages/channel-web/src` returns nothing.
- [ ] **Step 3:** channel-web `tsc`, tests, `pnpm lint`, `pnpm lint:ui:prune`; `node scripts/ui-suppressions-ratchet.mjs design/project-ax-ui` reports `ok`.
- [ ] **Step 4:** Commit `refactor(channel-web): replace the duplicate state components with @project-ax/ui`.

### Task 7: Rule 5: every destructive action goes through `ConfirmAction`

**Model:** standard. **Files:**
- **Existing hand-rolled confirm `Dialog`s → `ConfirmAction`.** Use the trigger form where the dialog has one button trigger, and controlled where a menu item or a row action opens it.
  - `workspace/`:
    - `AgentConnectors:371`, with `ConnectorDetails:256` as its trigger;
    - `ConnectorsTab:356` (Turn off Run code);
    - `AgentAppsRows:175` (UnlinkDialog);
    - `AgentSlackBot:862`;
    - `SidebarChats:287`;
    - `AgentSwitcher:248`;
    - `TaskOptions:161`;
    - `TaskNotes:167`;
    - `ArtifactOwnerMenu:46`;
    - `MemoryCorrection:269` (Forget).
  - `admin/`:
    - `SlackBotsCard:359`;
    - `SlackTab:425` (`DisconnectDialog`);
    - `AgentForm:543`;
    - `DefaultRoutinesSection:263`;
    - `AuthProvidersTab:258,290`;
    - `AuthoredSkillsSection:390`;
    - `PauseAgentsDialog` (`tone="neutral"`).
  - `routines/RoutinesList:486`.
  - `settings/`:
    - `SkillsAppStore:1006,1048`;
    - `ConnectorsTab:438,491`.
- **New confirms, missing today:**

  | Site | Title | Confirm label |
  |---|---|---|
  | `workspace/bits.tsx:507` `GrantLine` Revoke (callers `ConnectorDetails:229`, `ConnectorsTab:548`) | "Revoke this permission?" | "Revoke" |
  | `workspace/AgentAppsRows:131` `ApprovalRow` Revoke | same | "Revoke" |
  | `routines/RoutineConsentSection:106` Revoke | same | "Revoke" |
  | `settings/AllowedSitesPanel:167` Remove | "Remove {host}?" | "Remove site" |
  | `credentials/CredentialSlotForm:101` "Remove key" | "Remove this key?" | "Remove key" |
  | `workspace/AgentAppsRows:115` app-grant Remove | "Remove this app?" | "Remove app" |

  Each description says what stops working, in plain words. Reuse the copy already near the site; for example, `AgentRail.tsx:48`'s "Anything already running may still have it…" belongs in the Revoke description.
- **Kept out (ruling):** draft edits applied only on Save (`SelectedModelsPane`, `BrandingTab`, form-local row removals), the pre-send attachment Remove, `TaskFinishDate` "Remove date", `TaskSteps` "Delete step", `SkillsAppStore` "Remove from this agent", and `UsagePricesCard` "Remove price". Each of these can be undone in one step from the same screen, so a dialog adds friction without protecting anything. They're listed in the PR body. `MemoryCorrection:395` "Fix" is an edit form, not a confirm, and stays for S6b.
- **Copy and controls in migrated dialogs.** Cancel becomes "Cancel"; "Keep it" and the like go. The confirm label becomes the verb. The dialog body copy stays. Busy label swaps go (`Button busy`). The caller's error mapping moves into `errorMessage`. A flow that closes on a specific error (SlackTab's `slackStateChanged → onChanged()`) catches it inside `onConfirm` and returns normally.

- [ ] **Step 1: Tests.**
  - Each new-confirm site gets a test: clicking the action opens a dialog, nothing is called until "Revoke" or "Remove site" is clicked, then it's called once.
  - Migrated sites update existing tests to the "Cancel" label and role queries.
  - Run them and confirm they fail.
- [ ] **Step 2:** Migrate. Running `grep -rn "<DialogFooter" packages/channel-web/src` lists only non-confirm dialogs (forms); list them in the task report.
- [ ] **Step 3:** channel-web `tsc`, tests, `pnpm lint`, `pnpm lint:ui:prune`, ratchet `ok`.
- [ ] **Step 4:** Commit `feat(channel-web): every destructive action confirms through ConfirmAction (rule 5)`.

**End of S3a.**

### Rule 7 migration guide (Tasks 8–11)

For each file in a task:

| Today | Becomes |
|---|---|
| `Skeleton` blocks or `Spinner` + "Loading…" while data loads | `AsyncState status="loading"` with the nearest shape (`rows` for lists and tables, `lines` for text, `block` for a preview or chart) and a `loadingLabel` naming the thing ("Loading connectors") |
| `Spinner` inside a button | `Button busy` |
| `Spinner` for whole-page boot (`App.tsx` boot, `WorkspaceShell` boot) | stays (shadcn `Spinner`), the only allowed use |
| Error `Alert variant="destructive"` for a failed read, with or without retry | `AsyncState` error, or `Notice tone="danger" action={{label:'Try again', …}}` when the content beside it still renders |
| Error `Alert` for a failed action (save or submit) | `Notice tone="danger"`, no retry button unless the action is idempotent and it was there before |
| Default or informational `Alert` (`role=note`/`status`) | `Notice tone="info"`; use `tone="warning"` when the copy warns about loss or reset (for example `endpoint-change-resets-tools`) |
| `readAlertVariant(...)` | `tone={readAlertVariant(...) === 'destructive' ? 'danger' : 'info'}`, via a helper `readNoticeTone()` added once to `lib/read-register.ts` with a unit test |
| `Empty` (`components/ui/empty`) or a plain "No … yet" `<p>` that is the whole content of a list or pane | `EmptyState` (title = the existing heading or sentence, description = the rest) |
| Retry labels "Retry", "Retry …", "Reload app setup", "Check again", or "Refresh" used as a retry | "Try again" |
| Kept, not a retry | "Reload page" (ErrorBoundary), "Reload and discard my changes" (conflict resolution), and UsageTab's "Refresh" action |
| `data-testid` on an Alert asserted by tests | drop it; the test asserts the `Notice` by role and text |

A shadcn `Button` touched in passing follows the Task 6 intent map. Untouched Buttons stay; their migration is S6a.

### Task 8: Rule 7, admin + routines

**Model:** standard. **Files:**
- `admin/`: `ModelCatalogPane`, `SelectedModelsPane`, `ModelConfigTab`, `ModelsTab`, `UsageTab`, `UsageLimitsCard`, `UsagePricesCard`, `StorageTab`, `StorageLimitsCard`, `SlackTab`, `SlackBotsCard`, `SlackBotRequests`, `AuthProvidersTab`, `AuthoredSkillsSection`, `SkillAttachmentsSection`, `DefaultRoutinesSection`, `AgentForm`, `AgentToolPicker`, `BundleReviewDialog`, `BundleFileView`, `TeamList`, `AgentAdvancedLimits`.
- `routines/`: all files with `Alert`, `Skeleton`, `Spinner`, `Empty` or retry copy (`RoutinesList`, `RoutineEditor`, `AgentSelfImprovementSection`, `RoutineConsentSection`).
- Their `__tests__`.

- [ ] **Step 1:** List each file's sites (`grep -nE "<(Alert|Skeleton|Spinner|Empty)\b|Retry|Reload|Check again"`) in the task report. Update the tests to the new roles and text, and confirm the changed assertions fail.
- [ ] **Step 2:** Migrate per the guide. Then `grep -rnE "components/ui/(alert|skeleton|empty)'" packages/channel-web/src/components/{admin,routines}` must be empty, and spinner imports must remain only for boot sites.
- [ ] **Step 3:** channel-web `tsc`, tests, `pnpm lint`, `pnpm lint:ui:prune`, ratchet `ok`.
- [ ] **Step 4:** Commit `refactor(channel-web): admin and routines use AsyncState, Notice, EmptyState (rule 7)`.

### Task 9: Rule 7, settings + credentials + top-level pages

**Model:** standard. **Files:**
- `settings/` (all), `credentials/` (all), `onboard/` (all).
- `src/components/*.tsx` at top level: `LoginPage`, `AppsApprovePage`, `SharedArtifactPage`, `ErrorBoundary` (keep "Reload page"; its retry stays "Try again"), `PersonalUsageLine`, `UserMenu`.
- `src/App.tsx`.
- Their tests.
- `scripts/check-*-layout.mjs` if a selector breaks (check-workspace-composer-layout's `data-slot=empty-title` is Task 10's).

Steps 1–4 are the same as Task 8 for these folders. Commit `refactor(channel-web): settings, credentials and top-level pages use AsyncState, Notice, EmptyState (rule 7)`.

**End of S3b.**

### Task 10: Rule 7, workspace (agent surfaces)

**Model:** standard. **Files (`workspace/`):**
- Connectors: `AgentConnectors`, `ConnectorsTab`, `ConnectorDetails`, `AddConnector`, `SkippedConnectorsNotice`.
- Apps: `AgentApps`, `AgentAppsRows`, `AppGrantEditor`.
- Slack: `AgentSlack`, `AgentSlackBot*`, `AgentSlackDms`.
- Memory: `FactsMemory`, `LearnedInChat`, `MemoryCorrection`.
- Files and instructions: `AgentFiles`, `AgentInstructions`.
- Artifacts: `AgentArtifacts`, `ArtifactPreview`, `ArtifactViewer`, `ArtifactCard`.
- Settings and rail: `AgentSettings`, `AgentRail`, `GrantRow`.
- Their tests.
- `scripts/check-workspace-composer-layout.mjs:53`: replace `[data-slot=empty-title]` with a role=heading query for the same text, if the composer's empty state is among these files; otherwise Task 11.

Steps 1–4 are the same as Task 8. Commit `refactor(channel-web): agent workspace surfaces use AsyncState, Notice, EmptyState (rule 7)`.

### Task 11: Rule 7, workspace (tasks, today, conversation, shell)

**Model:** standard. **Files (`workspace/`):**
- Tasks: `TasksPage`, `TaskPage`, `TaskCheckinPage`, `TaskForm`, `TaskDialog`, `TaskSteps`, `TaskMarkDone`, `TaskAppUpdates`, `RepeatTaskBody`.
- `TodayView`, `AgentConversation`, `AgentView`, `WorkspaceShell` (boot spinner stays), `WorkspaceAttachmentChip`.
- Every remaining workspace file that the grep in Task 8 step 1 still finds.
- `visual/`.
- Their tests.
- `scripts/check-workspace-composer-layout.mjs` if not done in Task 10.

Fix `AgentViewHeadings.test.tsx:298` (`svg.animate-spin` / `.animate-pulse` counts) to assert role=status with `aria-busy` instead.

Steps 1–4 are the same as Task 8. After this task, `grep -rnE "components/ui/(alert|skeleton|empty)['\"]" packages/channel-web/src` must return nothing outside `components/ui/` itself. Commit `refactor(channel-web): tasks, today, conversation and shell use AsyncState, Notice, EmptyState (rule 7)`.

### Task 12: Lock it: `uiModules` option, lint switch-on, conventions

**Model:** standard. **Files:**
- Modify: `packages/eslint-plugin-ui/rules/no-internal-imports.js` (+ tests in `packages/eslint-plugin-ui/__tests__/`)
- Modify: `eslint.config.mjs` channel-web block, root `package.json` `lint:ui:suppress`, `eslint-suppressions.json`
- Create: `packages/channel-web/src/__tests__/state-language-convention.test.ts`
- Delete: `packages/channel-web/src/components/ui/{alert,skeleton,empty}.tsx` if `grep` shows no importer left (their tests in `ui/__tests__` go with them)
- Modify: roadmap S3 row (done note), spec §6.4 lint sentence if wording changes

**Interfaces:** `ax-ui/no-internal-imports` option `{ uiModules?: string[] }`.
- When present, only `components/ui/<name>` imports whose module name is in the list are reported, whether through `@/components/ui/<name>` or a relative path.
- Radix and `@project-ax/ui` internals are reported regardless.
- When absent, behaviour is unchanged (every `components/ui` module).

- [ ] **Step 1: Failing plugin tests:**
  - `uiModules ['alert'] reports @/components/ui/alert and ../ui/alert`.
  - `does not report @/components/ui/button`.
  - `still reports @radix-ui/react-dialog`.
  - `schema rejects non-string entries`.
- [ ] **Step 2:** Implement. Channel-web block: `'ax-ui/no-internal-imports': ['error', { uiModules: ['alert', 'skeleton', 'empty'] }]` (not `'spinner'`: the whole-page boot sites keep it). Add `--suppress-rule ax-ui/no-internal-imports` to `lint:ui:suppress`; run `pnpm lint:ui:suppress`, then `pnpm lint:ui:prune` as separate steps. Expected: `no-internal-imports` total frozen is **0** for these modules except any Radix direct imports, which get frozen (switch-on, allowed by the ratchet).
- [ ] **Step 3:** `state-language-convention.test.ts` (source scan like `spinner-convention.test.ts`): fails on a JSX button text of `Retry`, `Retry <word>`, `Check again`, `Reload app setup` anywhere in `src/` (allowed: `Reload page`, `Reload and discard my changes`, UsageTab `Refresh`); fails on `toastActions` or `toast-store`. Run → passes on the migrated tree; prove it bites by temporarily adding `>Retry<` in a scratch file, then delete it.
- [ ] **Step 4:** Full gate: `pnpm build`, `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts` (with `DOCKER_HOST`), `pnpm lint`, ratchet against `design/project-ax-ui` reports the switch-on and `ok`.
- [ ] **Step 5:** Roadmap S3 row gains "built (S3a–c)"; commit `feat(lint): no-internal-imports bans the replaced shadcn state modules; state-language convention test`.

**End of S3c.**
