# S3 follow-ups

These are left over from building S3 (`2026-11-25-project-ax-ui-s3-states-feedback.md`). Each is either a ruling that was parked or a finding deferred as minor. None of them loses functionality badly enough to block S3.

The user's directive for this migration applies: **the functionality must stay the same, not the look.** The goal is maximum reuse of components. So visual-only differences are not listed here.

## Should become cards

- **Retry drops focus.** Pressing "Try again" switches `AsyncState` from error to loading, so the button unmounts and keyboard focus falls to `<body>`. Fix it once in `packages/ui`, for example by focusing the status container on retry.
- **GeneratedFileChip stays on its own markup until S4 `FileTile`.** Moving it onto the one-line ui `Button` (fixed 40px height, no wrap) made long names overflow the chip and cover the next one, checked on kind; the change was reverted in #1262. Its shadcn button still sets `disabled` while busy, which drops focus.
- **IconAction busy sites need a disabled-reason tooltip.** The sites are TaskPage 907/971/992/1019 and TaskReplyBox 316. The package `IconButton` shows no tooltip while disabled. Do this in S6a.
- **Delete task dialog.** It stays a `Dialog` because it offers "Pause instead". Moving it to `ConfirmAction` would drop that choice, which needs product sign-off; revisit in S6b. Pause agents also stays a `Dialog`, because it has a Reason field.
- **Conversation welcome needs a hero treatment.** Either a title role or an `EmptyState` size variant. S5b/S7.
- **Dialog scrim token.** `ConfirmAction` uses `canvas/80` for the scrim, which is faint in light mode. Add a dedicated `scrim` token.
- **Screenshot threshold.** Playwright's default per-pixel threshold of 0.2 let a fill change from white to 94% grey pass as no diff. Tighten it and confirm Docker runs stay stable.
- **`components/ui/alert.tsx` is dead and can't be imported.** A `.claude/memory` shard cites its path. A human hygiene commit with a `Memory-Rewrite:` trailer can fix the citation and delete the file.

## Small, file-level

- **Unannounced states:**
  - `LegacyConnectorEditDialog` no longer announces a finished OAuth host discovery. Keep one persistent status that holds the result text.
  - FactsMemory search: a no-match result isn't announced.
- **`readFailureCopy` callers with no `onRetry`.** In `ConnectorDetails` and `ConnectorsTab` (workspace), a failed read shows neither a retry nor a hint.
- **RoutinesList read-failure banner.** It says "Refresh" where the guide says "Try again". It was kept because the banner also carries write errors. Also, the busy "Refresh" while a fire is protected is reachable but has no test.
- **`focusAfterRemoval` relies on Radix's restore timing.** Consider a package-level focus-landing option on `Notice`. About six focusable notice frames re-implement this today with inconsistent rings.
- **Duplicate announcements:**
  - MarkDone confirmation: polite status plus focus means it is spoken twice.
  - Every agent switch announces "Loading agent".
  - VisualFrame announces "Loading visual" twice.
- **`AsyncState` API.** It requires `skeleton` and `loadingLabel` even when it only shows an error; a discriminated union would fix this. The convention test is case-sensitive on `label`.
- **ConfirmAction edge cases:**
  - a parent closes it mid-request, then the request rejects, so the error is stale on reopen;
  - a throwing `errorMessage` becomes an unhandled rejection;
  - `iconOnly` without an `icon` falls back silently.
- **Toast:**
  - `duration: 0` used to mean sticky and now dismisses immediately (no caller uses it);
  - `dismissAll` is public but only used by tests;
  - danger toasts are polite, by ruling.
- **Ratchet:**
  - A widening may raise totals for unrelated violations; the backstop is CODEOWNERS plus branch protection.
  - A second config block that matches channel-web goes unseen.
- **Lint coverage.** Channel-web `.ts` files aren't covered by the tsx-only `ax-ui` block.
- **Busy label swaps.** About 35 shadcn buttons still swap their label while busy ("Saving…"). Migrate them in S6a.
