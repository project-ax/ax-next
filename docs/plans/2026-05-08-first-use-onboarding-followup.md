# First-use onboarding — follow-ups

**Date:** 2026-05-08
**For:** anyone picking up cleanup work deferred out of [`2026-05-08-first-use-onboarding-impl.md`](./2026-05-08-first-use-onboarding-impl.md).

Tracker for cleanup work deliberately deferred out of the onboarding implementation phases. Each entry names the deferring phase, what was deferred, why we punted, and the trigger condition for picking it up. Phases that ship later append their own entries below.

---

## Phase 4 — credentials cleanup

**Deferred from:** Phase 4 (`I12` — API-key-only credentials). Tasks 4.1 through 4.4 stripped the OAuth UI path from the chat web app and removed `createCredentialsAnthropicOauthPlugin()` from the default presets (`packages/cli/src/main.ts` and `presets/k8s/src/index.ts` — the plan's preliminary survey said only the CLI preset existed; turns out both did).

**What's deferred:** outright deletion of two packages that no supported user flow reaches anymore but that still have code paths a custom preset could wire up:

- `@ax/credentials-anthropic-oauth`
- `@ax/credentials-oauth-pending`

**One nuance worth being honest about.** The task stub said "Phase 4 unloads `@ax/credentials-anthropic-oauth` and `@ax/credentials-oauth-pending` from default presets." That's only half true. `@ax/credentials-anthropic-oauth` is fully unloaded from both default presets. `@ax/credentials-oauth-pending` is still loaded in `presets/k8s/src/index.ts`, conditionally on `credentialsAdmin`, because `@ax/credentials-admin-routes` declares its hooks (`credentials:oauth:stash-pending`, `credentials:oauth:claim-pending`) as hard `calls` in its manifest. Removing the plugin while the routes still call those hooks would fail manifest validation at startup. So really: the Anthropic-OAuth credential kind is gone from default flows; the pending-credential intermediate plugin sticks around server-side until the admin OAuth routes also retire.

**Why deferred:** code remains in tree because legacy paths still depend on it.

- `packages/cli/src/commands/credentials.ts:206` still loads `createCredentialsAnthropicOauthPlugin()` for the standalone `ax credentials login` CLI subcommand. The workspace dep at `packages/cli/package.json:32` and the project ref at `packages/cli/tsconfig.json:17` are genuinely needed for that command.
- `packages/credentials-admin-routes/` still exposes `/admin/credentials/oauth/start` and `/admin/credentials/oauth/finish` server-side. The package's `oauth-flow.test.ts` still exercises them. These routes are no longer reached from the chat UI (Task 4.1 deleted `OAuthFlowForm.tsx` and stripped the path from `CredentialAddMenu`), but the routes themselves are alive.
- `packages/channel-web/src/lib/credentials.ts` still exports `oauthStart` and `oauthFinish` client helpers. Their only known UI caller (`OAuthFlowForm`) is gone. Whether anything else imports them was deliberately not audited in Phase 4.

None of those legacy paths is reachable from the supported first-use onboarding flow, but a downstream caller could in theory depend on them. We didn't want to delete-and-find-out in the same PR that closed the onboarding window.

**Trigger to pick up:** confirm — via internal survey, external-consumer notice, or just enough elapsed time that we trust the answer — that no off-default preset depends on the Anthropic-OAuth credential kind, the pending-credentials hooks, or the legacy `ax credentials login` command. Once that's the case, a separate cleanup PR can land the deletion.

**Explicit cleanup targets** (so a future maintainer knows what to grep for):

- `packages/credentials-anthropic-oauth/` — entire package.
- `packages/credentials-oauth-pending/` — entire package.
- The `/admin/credentials/oauth/start` and `/admin/credentials/oauth/finish` routes in `packages/credentials-admin-routes/` plus the corresponding `oauth-flow.test.ts`.
- `oauthStart` and `oauthFinish` exports in `packages/channel-web/src/lib/credentials.ts` (audit callers first; only delete if the audit comes back clean).
- The `ax credentials login` subcommand in `packages/cli/src/commands/credentials.ts` (the file has more than just login — surgical edit, not a full delete).
- Workspace deps: `@ax/credentials-anthropic-oauth` in `packages/cli/package.json:32` + `tsconfig.json:17`; `@ax/credentials-oauth-pending` in `presets/k8s/package.json` + `tsconfig.json` once `credentials-admin-routes` no longer calls its hooks.
- `pnpm-workspace.yaml` and root `tsconfig.json` references to the deleted packages.

When that PR ships, drop this entry and reference its commit SHA from a "completed" section here.

---

## Future entries

### Phase N — TBD

(Future onboarding phases append cleanup-followup entries below as they ship.)
