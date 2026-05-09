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

**One nuance worth being honest about.** The task stub said "Phase 4 unloads `@ax/credentials-anthropic-oauth` and `@ax/credentials-oauth-pending` from default presets." That's only half true.

- `@ax/credentials-anthropic-oauth` is fully unloaded from both default presets.
- `@ax/credentials-oauth-pending` is still loaded in `presets/k8s/src/index.ts`, conditionally on `credentialsAdmin`. The reason: `@ax/credentials-admin-routes` declares its hooks (`credentials:oauth:stash-pending`, `credentials:oauth:claim-pending`) as hard `calls` in its manifest. Removing the plugin while the routes still call those hooks would fail manifest validation at startup.

So really: the Anthropic-OAuth credential kind is gone from default flows; the pending-credential intermediate plugin sticks around server-side until the admin OAuth routes also retire.

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

## Phase 5 — CLI tools + manual acceptance

**Deferred from:** Phase 5 (Tasks 5.1–5.4 of the impl plan). The CLI
tools, MANUAL-ACCEPTANCE walkthroughs, and final integration smoke all
shipped — but two of the originally-planned items got punted in flight
once their load-bearing premises didn't hold up under inspection.

### Deferred 1 — `ax admin reset-password` CLI

**What was deferred:** the `ax admin reset-password --email <e>` CLI
(plan Task 5.2) plus its companion `/auth/reset-password` route in
`@ax/auth-better`.

**Why deferred:** the canonical first-use flow doesn't actually use
local password sign-in. The wizard's admin step (`step-admin.tsx`)
captures only `name` + `email` — Phase 2 dropped the password field
when shipping against `@ax/auth-oidc` (which has no local password),
and Phase 3 said "add it back when auth-better becomes the preset
default" but never did. `@ax/auth-better/handler.ts:104` enables
better-auth's `emailAndPassword` flow, but no UI surface sets a
password and no preset writes a password row, so the feature is
effectively dormant. Building `reset-password` against a sign-in
flow nobody uses would be solving the wrong problem.

**Trigger to pick up:** when local password sign-in becomes a
real product surface — either the wizard re-adds the password
field, or a separate "Settings → Password" panel lands. At that
point `reset-password` becomes load-bearing recovery and the CLI
+ `/auth/reset-password` route make sense to build.

**Explicit cleanup targets** (so a future maintainer knows where
to look):

- The plan in `docs/plans/2026-05-08-first-use-onboarding-impl.md`
  Task 5.2 has the full spec we drafted.
- The existing `auth:complete-bootstrap-user` hook (Phase 2/3) is
  the natural template — `reset-password` would mirror its
  oneTimeToken / sessionCookie shape.

### Deferred 2 — full `ax admin bootstrap` deletion

**What's deferred:** outright deletion of the legacy `/auth/dev-bootstrap`
endpoint in `@ax/auth-oidc`. Phase 5's FU-1 commit (`b49e6db`) deleted
the *client-side* `ax admin bootstrap` CLI and its tests; the *server-side*
endpoint is intact in the auth-oidc plugin (along with `auth.devBootstrap.token`
config on `K8sPresetConfig`'s plumbing path, although `loadK8sConfigFromEnv`
no longer populates it).

**Why deferred:** `@ax/auth-oidc` is still in tree as the documented
fallback alternate-impl. Deleting `/auth/dev-bootstrap` from auth-oidc
would silently break any operator who has chosen to load auth-oidc
explicitly. Phase 3's PR #57 explicitly preserved that.

**Trigger to pick up:** when `@ax/auth-oidc` is itself retired (a
separate, larger cleanup that touches the boundary types in
`packages/auth-oidc/src/types.ts` which `@ax/auth-better` still
type-imports).

**Explicit cleanup targets:**

- `packages/auth-oidc/src/dev-bootstrap.ts`
- `/auth/dev-bootstrap` route in `packages/auth-oidc/src/admin-routes.ts`
- The `dev-bootstrap` provider rows the route inserts into
  `auth_oidc_v1_*` tables (none in default presets).
- `packages/auth-oidc/src/__tests__/dev-bootstrap.test.ts`.

## Future entries

### Phase N — TBD

(Future onboarding phases append cleanup-followup entries below as they ship.)
