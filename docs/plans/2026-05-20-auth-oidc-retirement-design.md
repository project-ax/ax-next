# Retire `@ax/auth-oidc` — design

**Date:** 2026-05-20
**Status:** approved, ready for implementation plan
**TODO entry retired by this work:** "Retire `@ax/auth-oidc` entirely" (Auth /
onboarding cleanup section) AND "Delete `/auth/dev-bootstrap` route +
`dev-bootstrap.ts`" (subsumed).

---

## Summary

`@ax/auth-better` has been the sole production auth surface since PR #55. The
k8s preset (`presets/k8s/src/index.ts:536`) and the CLI's `reset-bootstrap`
command (`cli/src/commands/admin/reset-bootstrap.ts:178`) both construct
`createAuthBetterPlugin`; `createAuthPlugin` (from `@ax/auth-oidc`) is not
loaded by any production code path. The four `auth:*` service hooks are fully
implemented in `auth-better`. The only remaining surface area for `auth-oidc`
is:

1. Six test fixtures (`agents`, `teams`, `mcp-client`, `onboarding` × 3) that
   boot `createAuthPlugin({providers:{}, devBootstrap:{token}})` and sign in
   via `POST /auth/dev-bootstrap`.
2. Boundary types (`User`, `HttpRequestLike`, the four bootstrap-user payloads)
   that `auth-better` type-imports from `auth-oidc`.
3. Six dangling `@ax/auth-oidc` workspace deps in consumer `package.json`s
   (`channel-web` has zero actual source imports — the dep is purely
   historical).
4. Stale comments in `channel-web` and `cli` that frame `auth-oidc` as the
   primary or as a fallback impl.

This document specifies a single-PR retirement: types move into `auth-better`,
test fixtures migrate to the bus surface via `signInAsAdmin` from
`@ax/test-harness`, every dangling dep + reference is removed, and the
`packages/auth-oidc/` directory is deleted.

## Goals

- `packages/auth-oidc/` no longer exists in the workspace.
- The four-hook contract (`auth:require-user`, `auth:get-user`,
  `auth:create-bootstrap-user`, `auth:complete-bootstrap-user`) is owned
  end-to-end by `@ax/auth-better`, with the boundary types living next to the
  impl.
- All consumer tests boot `auth-better` (not `auth-oidc`) and sign in via the
  impl-agnostic `signInAsAdmin` helper. No test file imports anything from
  `@ax/auth-oidc`.
- `pnpm build`, `pnpm test`, `pnpm lint` all pass with no `@ax/auth-oidc`
  references anywhere under `packages/`, `presets/`, `deploy/`, or
  `.claude/skills/`.

## Non-goals

- Password-as-default sign-in. The protocol layer (better-auth
  `emailAndPassword: enabled`) is already on, but the wizard, bootstrap hook,
  account-table migration, and LoginPage UI need work. **Separate slice,
  separate PR, separate design doc.**
- Rewriting the four auth service hooks. `auth-better` already implements all
  four; we are not touching the impls.
- Changing the hook-payload shapes. The boundary types move location but their
  shape stays identical so the alternate-impl-contract framing remains
  accurate.
- Spinning out an `@ax/auth-protocol` package. YAGNI until a second registered
  impl actually exists; if one ever does, that's the cue to extract.

## Invariants (carry into the impl plan as I1, I2, …)

These are the failure modes a careful reviewer would flag. The plan should
enumerate each as a numbered invariant the implementer protects.

- **I1 — No `@ax/auth-oidc` imports survive.** After the PR,
  `grep -rln '@ax/auth-oidc' packages/ presets/ deploy/ .claude/skills/`
  returns zero lines. (TypeScript would error before merge; this is the lint
  belt-and-suspenders.)
- **I2 — Boundary-contract comments survive the move.** The block at
  `auth-oidc/src/types.ts:6-34` ("BOUNDARY CONTRACT — these types are the auth
  alternate-impl boundary…") moves verbatim into `auth-better/src/types.ts`
  with `@ax/auth-better-auth` references rephrased as appropriate (the
  hypothetical alternate impl naming is no longer about "next to auth-oidc",
  it's about "next to auth-better").
- **I3 — No production behavior change.** The k8s preset and CLI
  reset-bootstrap already use `auth-better`. The retirement must not perturb
  their plugin lists, their boot order, or the kernel's verifyCalls() graph.
- **I4 — `signInAsAdmin` round-trips against real http-server.** Every
  migrated test boots real `@ax/http-server` (it already does for the
  dev-bootstrap fetch) and the migrated `signIn()` helper produces a cookie
  that `signedCookie()` validates back to the same `oneTimeToken`. This is
  enforced by the existing test assertions; the migration is a successful
  no-op iff they all still pass.
- **I5 — Second-user SQL inserts match auth-better's schema.** The raw-SQL
  paths (agents, teams, mcp-client) insert into `auth_better_v1_users` +
  `auth_better_v1_sessions` with the documented column shapes. No FKs are
  violated (sessions.user_id REFERENCES users(id) ON DELETE CASCADE — must
  insert user before session).
- **I6 — Tests that don't load `@ax/credentials` mock the envelope hooks.**
  `auth-better`'s manifest declares `credentials:envelope-encrypt` /
  `credentials:envelope-decrypt` in `calls`. The kernel's `verifyCalls()`
  refuses to boot without registrations. Tests that don't load real
  credentials register no-op pass-through services on the harness — mirroring
  `auth-better/src/__tests__/bootstrap-user.test.ts:80-88`.
- **I7 — `dev-bootstrap.ts` and its rate-limit middleware vanish with the
  package.** No replacement for the dev-bootstrap route; it had no production
  caller. The retirement subsumes the standalone "Delete /auth/dev-bootstrap"
  TODO entry. **See "Known risk: rate-limit posture" below for the auth-wide
  rate-limit consequence.**
- **I8 — Re-exports stay backward-compatible across the workspace.** Any
  package that type-imports `User` from `@ax/auth-oidc` (today: `auth-better`)
  flips to either `./types.js` (within `auth-better`) or `@ax/auth-better`
  (everyone else). Public re-exports from `auth-better/src/index.ts` add
  `User`, `HttpRequestLike`, `Require/GetUserInput/Output`,
  `Create/CompleteBootstrapUserInput/Output` so downstream consumers (when
  any land) have a single import target.

## Known risk: rate-limit posture

`@ax/auth-oidc` registers an `http:request` subscriber
(`auth-oidc/src/plugin.ts:155-167`) that token-buckets at 30 requests / minute
per source IP, scoped to `/auth/*` paths. `@ax/auth-better` has no equivalent
http-request subscriber — its surface is delegated wholesale to better-auth's
internal handler.

**Open question for the implementer (resolve before merging):**

1. Does better-auth's WebStandards handler ship its own rate-limit gate on
   `/sign-in/email`, `/forget-password`, `/reset-password`, the OAuth
   callbacks, and the `/admin/auth/providers/*` CRUD routes?
2. If yes, are the defaults at least as strict as auth-oidc's 30/min?
3. If no (or weaker), the retirement PR MUST either:
   - Port the http:request rate-limit subscriber into `auth-better`, OR
   - Document the regression and open a follow-up issue with a target date.

Do not merge the retirement until this question is answered explicitly in the
PR description. The risk is real: deleting auth-oidc without verifying
better-auth's rate-limit posture would silently downgrade the auth surface's
brute-force protection.

(The `auth-oidc/src/__tests__/rate-limit.test.ts` coverage is also dropped
when the package goes; that's acceptable because it tested an
auth-oidc-specific subscriber, but the *behavior* it protected must still
hold somewhere.)

## Out of scope (called out so they're not forgotten)

- **Password-as-default sign-in.** See "Non-goals" above. To track:
  - `auth-better/src/plugin.ts:516-637` (`createBootstrapUser`) currently
    ignores `input.password`. A follow-up slice wires it through to
    better-auth's credential-account creation.
  - `packages/channel-web/src/components/setup/StepAdmin.tsx` captures only
    name + email; needs a password field.
  - `packages/channel-web/src/components/LoginPage.tsx` is a single "Sign in
    with Google" button; needs an email/password form with OAuth as
    secondary.
  - `auth_better_v1_users` has no password column; better-auth stores
    credentials in a separate `account` table (`providerId='credential'`).
    Migration needed.
  - `ax admin reset-password` CLI + `/auth/reset-password` UI — already in
    TODO, gated on password being a real surface.
- **`@ax/auth-protocol` extraction.** Defer until a second registered impl
  exists.

## Plan reference

Implementation steps live in
`docs/plans/2026-05-20-auth-oidc-retirement-impl.md` (to be written next via
`writing-plans`). The plan enumerates each invariant I1–I8 as a checkpoint
and orders the file edits so partial states still pass `pnpm build`.
