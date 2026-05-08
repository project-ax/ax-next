# Phase 1 — `@ax/auth-better` plugin (PR notes)

**Plan reference:** `docs/plans/2026-05-08-first-use-onboarding-impl.md` Phase 1.

## Summary

Phase 1 of the first-use-onboarding work introduces a new alternate-impl of the auth hook surface: `@ax/auth-better`, wrapping better-auth with a dynamic-provider-config seam. The plugin is **built and tested but NOT loaded by any preset** — Phase 3 closes the half-wired window when CLI/k8s presets switch from auth-oidc to auth-better.

This PR also adds two new general-purpose service hooks on `@ax/credentials` (`credentials:envelope-encrypt` / `credentials:envelope-decrypt`) used by auth-better to seal OAuth provider client_secrets at rest. These hooks are themselves an alternate-impl seam (a future `@ax/credentials-kms` plugin would register the same surface).

## Half-wired window status

**OPEN.** Closed in Phase 3.

- `@ax/auth-better` is built, tested, and ready, but no preset (`packages/cli/src/main.ts` or `presets/k8s`) loads it. The existing `@ax/auth-oidc` continues serving requests.
- `auth:providers-changed` SUBSCRIBER + FIRER are both wired within this plugin (firer in the providers-CRUD admin routes; subscriber in the handler-rebuild path).

## Invariants checklist

- **I1 — Hook surface storage/transport-agnostic.** Pass. New hooks (`credentials:envelope-encrypt`, `credentials:envelope-decrypt`, `auth:providers-changed`, admin route payloads) carry no SQL/k8s vocabulary. `clientId`/`clientSecret`/`kind`/`enabled`/`discoveryUrl`/`allowedDomains` are auth-vocabulary; `plaintext`/`ciphertext` are crypto-vocabulary.
- **I2 — No cross-plugin runtime imports.** Pass. `@ax/auth-better` only TYPE-imports from `@ax/auth-oidc` (boundary types: `User`, `CreateBootstrapUserInput`, `CreateBootstrapUserOutput`) and `@ax/http-server` (`HttpRequest`, `HttpResponse`, `HttpRegisterRouteInput`, `HttpRegisterRouteOutput`, `HttpMethod`). Both peer packages live under `devDependencies` only — verbatim `import type` lines erase at compile time. Runtime communication is bus-only. `eslint.config.mjs` updated to `@typescript-eslint/no-restricted-imports` with `allowTypeImports: true` so type-only imports across plugins don't trip the rule, while runtime cross-plugin imports remain forbidden everywhere.
- **I3 — No half-wired plugins.** OPEN until Phase 3. Both subscriber + firer for `auth:providers-changed` are within this plugin. Manifest declares only what's actually used. `auth-better` is not loaded by CLI or k8s presets in this PR.
- **I4 — One source of truth.** Pass. `@ax/auth-better` owns `auth_better_v1_users`, `auth_better_v1_sessions`, `auth_providers`. No cross-plugin reach into other plugins' tables.
- **I5 — Capabilities explicit and minimized.** Pass. Manifest lists exactly the hooks called/registered/subscribed. Bootstrap-user input is validated (length caps + email regex). client_secret is encrypted before insert, never logged, and stripped from GET responses. Bootstrap user/session inserts run inside a single `db.transaction()` (no orphan admin row on partial failure). Set-Cookie multi-value joined correctly when better-auth emits multiple cookies in one response.
- **I6 — Bootstrap one-shot AND irreversible.** Partial. `auth-better` refuses a second `auth:create-bootstrap-user` call if any admin already exists. Full atomic CAS via a `bootstrap_state` table lands in Phase 2 Task 2.2.
- **I7 — Token validation constant-time.** Phase 2.
- **I8 — Credential validation timeout.** Phase 2.
- **I9 — Wizard transactional.** Pass for the bootstrap-user portion (user + session insert in a single `db.transaction()`).
- **I10 — Provider config hot-reloads without restart.** Pass. `__tests__/hot-reload.test.ts` proves: POST /admin/auth/providers + immediate sign-in path → behavior changes within the same process. PATCH (disable) + DELETE also exercise the rebuild seam via the `auth:providers-changed` subscriber.
- **I11 — `/setup/*` 410 Gone after `bootstrap:complete`.** Phase 2.
- **I12 — Provider credentials API-key-only.** Phase 4.

## Boundary review (per CLAUDE.md)

**Two new service hooks: `credentials:envelope-encrypt` / `credentials:envelope-decrypt`** (registered by `@ax/credentials`):

- **Alternate impl:** A future `@ax/credentials-kms` plugin (AWS KMS / GCP KMS / Azure KeyVault) would register the same `(plaintext: string) → ciphertext: Uint8Array` surface. The key never leaves the HSM in that impl; the hook signature is identical.
- **Payload field names that might leak:** None. `plaintext`/`ciphertext` are crypto-vocabulary, NOT backend-specific (no `aes`, `gcm`, `iv`, `kms_arn`).
- **Subscriber risk:** N/A — services, not events.

**Auth hook surface (`auth:require-user`, `auth:get-user`, `auth:create-bootstrap-user`)** — UNCHANGED from auth-oidc. Same shapes, same boundary contract. Type-imported from `@ax/auth-oidc`. The `User` boundary type stays the single source of truth across both impls.

**Subscriber `auth:providers-changed`:**

- Payload is `{}` (empty) — subscribers re-read state from DB. Backend-agnostic.
- Subscriber risk: a future subscriber that keys off a backend-specific field would not break (no fields).

**Admin routes (`/admin/auth/providers/*`):**

- Wire surface (HTTP) lives in `packages/auth-better/src/plugin.ts`, not a central file.
- Field names: `kind`, `clientId`, `clientSecret`, `enabled`, `discoveryUrl`, `allowedDomains` — all auth-vocabulary.

## Tests

- `@ax/credentials`: 8 new tests in `__tests__/envelope-hooks.test.ts` (envelope-encrypt/decrypt round-trip, validation, IV randomness, tamper detection). Full package: 62 tests, all green.
- `@ax/auth-better`: 21 tests across 4 files (`migrations.test.ts`, `handler.test.ts`, `bootstrap-user.test.ts`, `hot-reload.test.ts`).
- `@ax/test-harness`: existing 52 tests still green; `signInAsAdmin` covered transitively by `auth-better`'s hot-reload test.
- Full repo `pnpm test`: green across all 30+ packages (channel-web 341, workspace-git-server 472, conversations 98, cli 89, k8s preset 68, agents 69, teams 69, credentials 62, auth-better 21, etc.).
- `pnpm build`: clean.
- `pnpm lint`: 0 errors (2 pre-existing unused-eslint-disable warnings in unrelated files).

## Files changed (top-level)

- NEW: `packages/auth-better/` (plugin + 4 test files: migrations, handler, plugin, providers-store).
- MODIFIED: `packages/credentials/` (envelope service hooks + tests).
- NEW: `packages/test-harness/src/sign-in.ts` + index re-export + `@ax/http-server` runtime dep (per Task 1.5).
- MODIFIED: `eslint.config.mjs` (Task 1.5 added the test-harness src/** exception; this PR switches `no-restricted-imports` → `@typescript-eslint/no-restricted-imports` with `allowTypeImports: true` so type-only cross-plugin imports — the boundary-types-as-shared-contract pattern — are universally allowed).

## Phase 3 follow-ups (out of scope)

- Switch CLI + k8s presets from `@ax/auth-oidc` to `@ax/auth-better` (closes I3 half-wired window).
- Add `auth:complete-bootstrap-user` to the registers list (Phase 3.1).
- Tighten better-auth `trustedOrigins` (currently `['*']` because the perimeter CSRF gate is upstream in `@ax/http-server`, but the wildcard should be replaced with configured origins).
- Phase 3 will exercise the full Google OAuth happy-path including better-auth's verification/account tables (the hot-reload test in this PR proves the rebuild contract via the gate-flip pattern).

## Manual acceptance

N/A for this PR — no preset loads the plugin yet. Phase 3 ships the manual acceptance walkthrough.
