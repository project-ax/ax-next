# Baseline, 2026-11 (before the theme swap)

Captured against the local kind cluster (`kind-ax-next-dev`, real data) through channel-web's Vite proxy at
`http://localhost:5173`, at base commit `5e8fd3a76`, signed in as the existing admin. The cluster was read-only
except one throwaway session row inserted for auth and deleted afterwards. 28 routes x light/dark x
1440x900/390x844 = 112 full-page PNGs, about 6.8 MB (local, see below).

## Where the images are

The 112 PNGs live **outside the repo**, in `/Users/vpulim/ax-ui-eval/2026-11-baseline/` (with the raw `axe.json`).
They are local-only because they show real dev-cluster data and this repo is public; `packages/ui/.gitignore`
keeps `eval/results/**/*.png` and `axe.json` out of git. What is committed here: this README, `axe-summary.json`
(rule id, impact and node count per route, nothing from the page) and the capture script.

Files are `<route>-<width>-<theme>.png`. Theme is set with `data-theme` on `<html>` before the shot.

Re-run for the "after" set (same path, so only CSS differs); the command and env are in the header of
`packages/ui/eval/capture-baseline.ts`:

```
pnpm --filter @ax/channel-web exec vite build
AX_BACKEND_URL=http://localhost:19090 pnpm --filter @ax/channel-web exec vite preview --port 5173 --strictPort
AX_SESSION_TOKEN=... AX_HTTP_COOKIE_KEY=... pnpm --filter @project-ax/ui exec tsx eval/capture-baseline.ts [<outDir>] --kind   # default outDir: ~/ax-ui-eval/capture
```

Why `vite preview` (a production build) and not `vite dev`: under `vite dev` the dependency optimizer cannot
serve the chat-visuals `ax-vendor/*?raw` imports ("optimized info should be defined"), so the agent page crashes
into its error boundary. That is a dev-server bug in current channel-web, not fixed here. Preview uses the same
proxy config, so the browser still talks to `http://localhost:5173`.

## Routes

Reached (all with real data): sign-in (signed out), today, agent-conversation (the agent's most recent existing
conversation, nothing sent), agent-files (the Files panel), tasks, task (first task), agent-settings x8
(instructions, model, connectors, slack, apps, memory, skills, routines), settings x5 (skills, sites, agents,
routines, storage), admin x9 (connectors, ai-model-keys, models, helper-model, sign-in-methods, teams, slack,
branding, usage). Settings tabs are shot in their default sub-view (for example Skills opens on Installed).

Not captured:
- Setup wizard: the cluster's bootstrap is complete, so `/setup` redirects away. Showing it would need a fresh install.
- Apps approve and shared-artifact pages: need a real platform/app/connector id and a share code, and creating
  either would write to the cluster. Not reachable read-only.
- Task check-in page, memory panel, activity and artifacts panels, onboarding, dialogs and other transient states.

## Axe (serious + critical violation nodes)

Light theme, 1440 wide only, one run per route. Totals: 24 serious, 1 critical.

| Route | Serious | Critical | Rules |
|---|---|---|---|
| sign-in | 0 | 0 | - |
| today | 1 | 0 | label-content-name-mismatch (serious, 1) |
| agent-conversation | 1 | 0 | label-content-name-mismatch (serious, 1) |
| agent-files | 1 | 0 | label-content-name-mismatch (serious, 1) |
| tasks | 1 | 0 | label-content-name-mismatch (serious, 1) |
| task | 1 | 0 | label-content-name-mismatch (serious, 1) |
| agent-settings-instructions | 1 | 0 | label-content-name-mismatch (serious, 1) |
| agent-settings-model | 1 | 0 | label-content-name-mismatch (serious, 1) |
| agent-settings-connectors | 1 | 0 | label-content-name-mismatch (serious, 1) |
| agent-settings-slack | 1 | 0 | label-content-name-mismatch (serious, 1) |
| agent-settings-apps | 1 | 0 | label-content-name-mismatch (serious, 1) |
| agent-settings-memory | 1 | 0 | label-content-name-mismatch (serious, 1) |
| agent-settings-skills | 1 | 0 | label-content-name-mismatch (serious, 1) |
| agent-settings-routines | 1 | 0 | label-content-name-mismatch (serious, 1) |
| settings-skills | 0 | 0 | - |
| settings-sites | 0 | 0 | - |
| settings-agents | 1 | 0 | label-content-name-mismatch (serious, 1) |
| settings-routines | 0 | 0 | - |
| settings-storage | 0 | 0 | - |
| admin-connectors | 0 | 0 | - |
| admin-ai-model-keys | 0 | 0 | - |
| admin-models | 5 | 0 | label-content-name-mismatch (serious, 5) |
| admin-helper-model | 0 | 0 | - |
| admin-sign-in-methods | 0 | 0 | - |
| admin-teams | 0 | 0 | - |
| admin-slack | 0 | 0 | - |
| admin-branding | 0 | 1 | label (critical, 1) |
| admin-usage | 5 | 0 | label-content-name-mismatch (serious, 5) |

`label-content-name-mismatch` on most routes is one node, almost certainly the same shared sidebar control. The
single critical is a `label` violation on the Branding tab.

## Inventory counts (spec section 6.1, `packages/channel-web/src`, tests excluded)

- 212 `.tsx` files; `className` in 202 of them; 608 raw `<div>`; 554 arbitrary `[Npx]` values in 104 files.
- 15 distinct font sizes; `text-[13px]` x122, `text-[12px]` x72, `text-[12.5px]` x62, `text-[11.5px]` x56.
  About 350 arbitrary font sizes vs 51 tokenized ones.
- Most repeated class strings: `text-sm text-muted-foreground` x87, `text-xs text-muted-foreground` x60,
  `flex flex-col gap-2` x52, `flex flex-col gap-3/4` x68, `flex justify-end gap-2` x18.
- About 20 list-row implementations, 4 navigation "active" styles, about 22 hand-rolled confirm dialogs, 5 loading
  languages, 4 error surfaces, 7 Save placements, 7 time formatters, about 8 `Card` overrides, 5 centered-page
  framings, 7 dialog widths.
- Dead code: `ProviderRow`, `KeyForm`, `StatusDot`, `AgentStateLabel`, `AdminPaneHeader`'s `eyebrow`/`badge`,
  `AdminNavItem`'s `icon`.
- Test coupling: 399 test files; 84 use `querySelector`/`toHaveClass` (200 + 92 occurrences).
