# First-use onboarding design

**Date:** 2026-05-08
**Author:** Vinay (with Claude)
**Status:** Design — pre-implementation
**Related:** PR #51 (credentials admin UI), PR #53 (chat UI Tailwind), `2026-04-25-week-9.5-multi-tenant.md` (auth bootstrap CLI), `feedback_no_oauth_credentials.md`

## Motivation

When someone runs ax for the first time, they hit `http://localhost:8080` and… we currently have no answer for what happens next. The `ax admin bootstrap` CLI mints an admin out-of-band, but a human-friendly first-use experience needs to live in the web UI.

This design covers the path from "operator runs `ax`" to "admin sends their first chat message in the Default Agent" — a 3-input wizard that defers everything non-essential.

## Scope and target user

In scope:

- Solo developer running ax on their laptop (docker-compose, kind, bare host).
- IT/ops person self-hosting ax for a small team on internal k8s.

Both walk the same wizard. Solo simply skips the "invite teammates" / OAuth-provider config later, but the first-use flow itself is identical.

Out of scope:

- Multi-tenant SaaS signup. The bootstrap-token model assumes single-instance deployment.
- Email verification / password reset by email. SMTP is not a first-class concept yet — see "Forward-compatibility" below.
- 2FA, magic-link sign-in. Punted to a later issue.

## High-level flow

```
operator runs ax
   ↓
[kernel boots]
   ↓
@ax/onboarding mints bootstrap token
   ↓ (printed to stdout + /var/run/ax/bootstrap-token)
operator opens http://localhost:8080
   ↓
[Wizard step 0] paste/click bootstrap token → mint short-lived bootstrap session
   ↓
[Wizard step 1] name + email + password → admin user created, bootstrap session swapped for real session
   ↓
[Wizard step 2] Anthropic API key (+ optional advanced model overrides) → credential validated, Default Agent created, wizard closed
   ↓
admin lands on /, Default Agent is selected, ready to chat
```

Total inputs: 3 (token, password, API key). Total HTTP calls: 3 (`/setup/claim`, `/setup/admin`, `/setup/model`).

After the wizard, the admin can configure OAuth providers (Google, GitHub, generic OIDC) at `/admin/auth` and add more credentials at `/admin/credentials` — both reachable from a new "Admin" entry in the user menu.

## Architecture

### New plugin: `@ax/onboarding`

Owns:

- `/setup/*` HTTP routes (wizard backend).
- `bootstrap_state` table — single row: `{ status: 'pending' | 'claimed' | 'completed', token_hash, completed_at }`.
- A startup hook (`bootstrap:initialize`) that mints the bootstrap token on first boot if `status='pending'` and prints it to stdout / writes it to `/var/run/ax/bootstrap-token` (mode 0600).
- An env-var override (`AX_BOOTSTRAP_TOKEN`) that wins over the auto-generated value.

Capabilities (per invariant 5):

- DB read/write on `bootstrap_state` only.
- HTTP route registration: `POST /setup/claim`, `POST /setup/admin`, `POST /setup/model`, `GET /setup` (SPA bundle).
- Filesystem: write to `/var/run/ax/bootstrap-token` (mode 0600), no other paths.
- Env access: `AX_BOOTSTRAP_TOKEN` (read once at boot).
- No process spawn. No outbound network.

### Reused (already shipped)

- **`@ax/auth-better`** (replacement / wrapper around the existing `@ax/auth-oidc`). Owns user table, session cookies, password hashing, OAuth providers via better-auth. The wizard calls existing hook `auth:create-bootstrap-user`. Session swap from bootstrap-session to real auth-better session happens at end of step 1.
- **`@ax/credentials*`** family. Step 2 reuses the API-key path from PR #51. The OAuth web-paste path is removed from the UI in this design (see §3 "scope addition outside the wizard").
- **`@ax/agents`**. Step 2 auto-creates a "Default Agent" owned by the new admin user.

### Hook surface added (≤4 new hooks)

| Hook | Type | Owner | Payload |
|---|---|---|---|
| `bootstrap:initialize` | startup | `@ax/onboarding` | none → mints token if needed |
| `bootstrap:status` | service | `@ax/onboarding` | → `{ status, has_token }` |
| `bootstrap:claim` | service | `@ax/onboarding` | `{ token }` → `{ ok: true }` \| `{ ok: false, reason }` |
| `bootstrap:complete` | service | `@ax/onboarding` | none → marks `completed` |
| `models:list-supported` | service | `@ax/llm-anthropic` (and any future LLM plugin) | → `[{ id, label, kind: 'fast' \| 'default' \| 'either' }]` |

Subscriber events emitted:

- `bootstrap:completed` — fires when the wizard closes. Could be subscribed to by analytics / future "guided tour" plugin.
- `auth:providers-changed` — fires when admin adds/removes/toggles an OAuth provider. Subscribed to by `@ax/auth-better` to re-instantiate the better-auth handler without restart.

### Boundary review (per CLAUDE.md)

- **Alternate impl this hook surface could have:** a file-based bootstrap (operator drops a token file in `/etc/ax/bootstrap`) — same `bootstrap:claim` shape works. A SaaS signup flow — `bootstrap:claim` is private to `@ax/onboarding` and gets replaced wholesale, so no leak.
- **Payload field names that might leak:** `token_hash` is internal to `@ax/onboarding`'s table, never on the wire. `bootstrap_state.status` uses provider-neutral terms. `auth_providers.kind` is provider-vocabulary (`'google'`, `'github'`, `'oidc'`), not backend-vocabulary. None.
- **Subscriber risk:** `auth:providers-changed` carries no provider details — subscribers re-read state from the DB. Backend-agnostic.
- **Wire surface:** `/setup/*` routes' schemas live in `packages/onboarding/src/routes/`, not in a central registry.

### Half-wired check

This design ships as one PR (or a tightly-coupled chain of PRs) including:

1. `@ax/onboarding` plugin + tests + preset wiring (CLI + k8s).
2. `@ax/auth-better` migration from `@ax/auth-oidc` with dynamic provider config.
3. `/admin/auth` UI for provider config.
4. `/admin/credentials` UI update — OAuth web-paste removed.
5. User-menu "Admin" entry in `channel-web`.
6. Default-agent auto-creation in step 2.
7. Stdout/file token printing in startup.
8. Manual acceptance walkthrough in `deploy/MANUAL-ACCEPTANCE.md`.

No "wire this up later" placeholders. The `credentials-anthropic-oauth` and `credentials-oauth-pending` plugins are unloaded from the default presets in the same PR; their code stays in tree (deletion is a follow-up cleanup).

## Section 1 — Bootstrap token lifecycle

### Generation (first boot)

`@ax/onboarding`'s startup hook `bootstrap:initialize`:

1. Read `bootstrap_state` row. If `status='completed'` → no-op, return.
2. If `AX_BOOTSTRAP_TOKEN` env var set → hash it (argon2id), store hash, set `status='pending'`, **don't print** (operator already knows it).
3. Else generate 32 random bytes → `ax_bs_<base64url>` (≈ 49 chars, distinctive prefix for secret scanners). Hash it, store hash, set `status='pending'`. Print to stdout AND write `/var/run/ax/bootstrap-token` (mode 0600).

Stdout output:

```
[ax-onboarding] First-run bootstrap:
  token: ax_bs_8c4f...c91a
  open:  http://localhost:8080/setup?token=ax_bs_8c4f...c91a
```

Token format: `ax_bs_` prefix + 32-byte base64url. Prefix purpose: humans recognizing it in logs, and git-secret-scanners (`gitleaks`, `trufflehog`) having a regex to fail commits that paste it.

### Consumption (HTTP)

`POST /setup/claim` with `{ token }`:

1. Rate-limit: 5 failed attempts per IP per 5 min, then 429.
2. Hash input, compare against `token_hash` (constant-time).
3. Atomic CAS: `UPDATE bootstrap_state SET status='claimed' WHERE status='pending' RETURNING *`. If 0 rows updated → 410 Gone (already claimed).
4. On success: mint a 10-min bootstrap-session cookie, scoped to `/setup/*` only (path attribute), HttpOnly, SameSite=Strict, Secure (if HTTPS).
5. Return `{ next: '/setup/admin' }`.

### Magic link

The SPA at `/setup?token=...` reads the query param, auto-POSTs to `/setup/claim`, then strips the token from the URL bar (`history.replaceState`). Pasting the token by hand into a form input also works — same backend route.

### Closing the window

When step 3 (model) completes, inside the same DB transaction that creates the credential:

1. `bootstrap:complete` is called.
2. `bootstrap_state.status='completed'`, `completed_at=now()`.
3. The bootstrap-session cookie is invalidated; the new auth-better session cookie is issued.
4. From here on, all `/setup/*` routes return **410 Gone** (not 404 — operators need to know the wizard is done, not missing).
5. The startup hook on subsequent boots short-circuits at step 1 of "Generation" above.

### Recovery

- *Token lost* (operator missed it in logs, file wiped): `ax admin reset-bootstrap` CLI generates a new token, but ONLY if `status` ≠ `'completed'`. Once setup is done, this CLI refuses — they should sign in or use `ax admin reset-password`.
- *Token leaked before claim*: operator runs `ax admin reset-bootstrap --force` which mints a new one and invalidates the old.
- *Bootstrap-session cookie expires mid-wizard*: 10-min TTL. If it does expire, the user re-pastes the token (still valid until claimed). Once `claimed`, an expired cookie means they have to use `reset-bootstrap`.

### What's deliberately not here

- No email-based reset during bootstrap — SMTP isn't configured yet.
- No TTL on unclaimed tokens. Threat model: anyone with stdout access already has shell on the host.
- No per-IP token binding. Adds complexity without much gain in single-tenant deployments.

## Section 2 — Auth: wizard step 1 + post-wizard provider config

### Wizard step 1 — claim admin

`POST /setup/admin` with `{ name, email, password }`:

1. Requires the bootstrap-session cookie from §1.
2. Calls `auth:create-bootstrap-user` (existing hook, ported to `@ax/auth-better`). Creates a user row with `role='admin'`, `email_verified=false` (no SMTP — admin's email is taken on trust since they have the bootstrap token).
3. Better-auth's `signUpEmail` hashes the password (scrypt by default).
4. Returns `{ next: '/setup/model' }` and swaps the bootstrap-session cookie for a real auth-better session cookie.

Password rules: min 12 chars, no other constraints. zxcvbn-style strength meter on the frontend (informational only — backend just checks length). Rationale: NIST 800-63B says length beats character-class rules.

UI copy on this step: "You'll be the first admin. We'll add other authentication methods later." (deliberately doesn't prejudge which providers — Google, GitHub, generic OIDC, Microsoft are all candidates depending on what the admin wires up later in `/admin/auth`).

### Better-auth dynamic provider config

Better-auth's standard config is code/env-static. For UI-driven OAuth setup we need providers reconfigurable at runtime without a process restart. Approach:

- `@ax/auth-better` reads provider config from an `auth_providers` table at startup.
- A `auth:providers-changed` subscriber event triggers re-instantiation of the better-auth handler.
- The HTTP route mounted by `auth-better` reads the *current* handler instance per request — so a provider added at 10:00:01 is live at 10:00:02 without restart.
- Secrets (`client_secret`) stored encrypted-at-rest using the existing credentials envelope (PR #51 already has the key-derivation plumbing — reuse it, don't invent a parallel one).

### Post-wizard `/admin/auth` page

Deferred from wizard, **not deferred from MVP** — this page ships in the same release as the wizard:

- List configured providers with on/off toggles.
- "Add Google" → form for `client_id`, `client_secret`, `allowed_domains` (optional). On save: write `auth_providers` row, fire `auth:providers-changed`, redirect to a "test sign-in" link the admin can click in another tab.
- "Add GitHub" / "Add generic OIDC" — same shape.
- "Email/password" is always present and not a row — it's a checkbox `enable_password_login` that defaults to true.

### What's deliberately not here

- No email verification flow. The admin's email is trust-on-bootstrap.
- No password reset by email. Admin recovery: `ax admin reset-password --email me@x.com` CLI prints a one-shot reset token (same threat model as bootstrap).
- No 2FA. Better-auth supports TOTP — punt to a later issue.
- No magic-link sign-in until SMTP is first-class.

## Section 3 — Wizard step 2: API key credential

### Page UI

Single primary input:

- **Anthropic API key** — text field for `sk-ant-…`, with a "Where do I get this?" link to `https://console.anthropic.com/settings/keys`.
- **`<details> Advanced`** disclosure containing:
  - Fast model: dropdown defaulting to `claude-haiku-4-5-20251001`.
  - Default model: dropdown defaulting to `claude-sonnet-4-6`.
  - Dropdowns populated by `models:list-supported` (owned by `@ax/llm-anthropic`).

No OAuth credential entry. Per `feedback_no_oauth_credentials.md`: provider credentials are API-key-only, no "Sign in with Claude" web-paste flow anywhere in the UI.

### Backend — `POST /setup/model`

Payload:

```ts
{
  apiKey: string,                         // sk-ant-...
  models?: { fast?: string, default?: string }
}
```

Single transaction:

1. Validate the API key by making a 1-token completion call against the chosen `default` model. If it 401s, return `{ ok: false, reason: 'credential-invalid' }` and don't write anything. (Catches typo'd API keys before the user is dumped into chat that doesn't work.)
2. Insert credential row, `kind='anthropic-api-key'`, scope=`global`, value encrypted-at-rest via the existing credentials envelope.
3. Insert "Default Agent" row in `@ax/agents`:
   - `name`: "Default Agent"
   - `owner_type='user'`, `owner_id=<the new admin>`
   - `runner='claude-sdk-runner'`
   - `fast_model`, `default_model` from the payload (or defaults)
   - `credential_id` pointing at row from step 2
4. Call `bootstrap:complete` (closes the wizard per §1).
5. Return `{ next: '/' }`.

If step 1 fails, the wizard stays on step 2 with an error banner. The bootstrap-session cookie is still valid; nothing has been written.

### Why validate the credential synchronously

The whole point of the wizard is "you finish, you can chat." If we accept any string and the user hits chat with a broken credential, we've moved the failure into a worse place (mid-conversation, less obvious where the problem is). Burning one token to validate is cheap.

### Why a "Default Agent" at all

Without it, the wizard ends and the user lands on a chat page that says "create an agent first." The Default Agent is owned by the admin user (`owner_type='user'`), not the org — solo users get something to chat with, team admins can clone-and-share later via the existing scope axis from PR #51.

### Scope addition outside the wizard

PR #51 currently exposes a Claude OAuth web-paste flow in `/admin/credentials`. Per the API-keys-only directive, this design also removes that exposure:

- The "Add credential" form in `/admin/credentials` drops the "Sign in with Claude" button — only API-key entry remains.
- `credentials-anthropic-oauth` and `credentials-oauth-pending` plugins are unloaded from the default presets (CLI + k8s) in the same PR. Code stays in the tree for now (deletion is a separate cleanup PR), but they're not wired and not reachable.
- Boundary review for the half-wired window: presets stop loading these two plugins in the same PR that ships the wizard. No dangling entry points.

### Hook surface added

- `models:list-supported` (service hook) — `[{ id, label, kind: 'fast' | 'default' | 'either' }]`.

### What's deliberately not here

- No multiple credentials in the wizard. Admins add more in `/admin/credentials` after the wizard.
- No MCP server setup. Deferred to `/admin/mcp`.
- No tool config. Default Agent gets the standard tool set; per-agent tool scoping is later.
- No runner picker. Only `claude-sdk-runner` exists in MVP. When a second runner ships, this step gains a third dropdown.

## Section 4 — Post-wizard `/admin` surfaces

After `bootstrap:complete` fires, the admin lands on `/` (chat with the Default Agent).

### In scope for this design

Must work end-to-end the same release:

- `/admin/auth` — better-auth provider config (Google/GitHub/generic OIDC). Per §2.
- `/admin/credentials` — already shipped (PR #51), with the OAuth web-paste path removed per §3.
- `/admin/agents` — already shipped (PR #51 covers the scope axis; agent CRUD UI exists). Default Agent shows up here.
- **User-menu "Admin" entry** (top-right of chat UI) → routes to `/admin`. Visible only when the signed-in user has `role='admin'`. **Required in the same PR** — without it, the admin finishes the wizard and has no way to find `/admin/auth`.

### Out of scope (deferred)

- `/admin/users` (invite teammates, manage roles) — needs SMTP for invite emails.
- `/admin/mcp` (MCP server config) — separate effort.
- `/admin/teams` (team CRUD) — `@ax/teams` plugin exists; UI not part of this design.
- Audit-log viewer — `@ax/audit-log` plugin exists; viewer is separate.

### Permission/route gating recap

| Path | Gate |
|---|---|
| `/setup/*` | Bootstrap-session cookie required; 410 Gone after `bootstrap:complete` |
| `/admin/*` | Authenticated user with `role='admin'` (403 for non-admin signed-in users — not a redirect) |
| `/` (chat) | Authenticated user with any role |
| `/auth/*` | Public (sign-in pages) |

## Section 5 — Testing and failure modes

### Unit-ish (per-package)

`@ax/onboarding`:

- Token generation produces `ax_bs_` prefix, 32 bytes of entropy.
- `AX_BOOTSTRAP_TOKEN` env wins over auto-gen; no stdout output in that case.
- Hash comparison is constant-time (use a known-vulnerable string-equals fixture; confirm we don't use it).
- Atomic CAS on `bootstrap:claim` — concurrent claim attempts: one wins, others get 410.
- `bootstrap:complete` is irreversible — claim/admin/model after completion → 410.

`@ax/auth-better`:

- `auth:create-bootstrap-user` produces `role='admin'`, `email_verified=false`.
- `auth:providers-changed` re-instantiates the handler — old provider gone, new provider live, no restart.
- Disabled provider (toggle off) returns 404 from `/auth/<provider>/...`.

### Integration (cross-plugin)

- **Happy-path wizard, end-to-end**: boot kernel → token in stdout (captured) → `POST /setup/claim` → `POST /setup/admin` → `POST /setup/model` (with mock LLM that 200s on validation call) → assert: `bootstrap_state.status='completed'`, user row exists with admin role, credential row exists, Default Agent row exists pointing at credential, all in one consistent state.
- **Bad API key**: `POST /setup/model` with key that mock LLM 401s on → `{ ok: false, reason: 'credential-invalid' }` → assert NO credential row, NO agent row, `bootstrap_state` still `claimed`. Wizard recoverable.
- **Token replay**: claim succeeds → second claim with same token → 410.
- **Wizard skip attempts**: `POST /setup/admin` without bootstrap-session cookie → 401. `POST /setup/model` without admin step → 401.
- **Post-completion lockdown**: complete the wizard, then `GET /setup` → 410, `POST /setup/claim` → 410.
- **Provider config hot-reload**: complete wizard → `POST /admin/auth/providers` (Google) → `/auth/google/start` now responds 302 to Google's authorize URL, with no process restart.

### Manual acceptance (in `deploy/MANUAL-ACCEPTANCE.md`)

- k8s-acceptance-loop case: bring up `ax-next-dev` kind cluster, fresh DB, follow the magic link from the kernel logs, walk all three steps with a real Anthropic API key, send a chat message in the Default Agent, get a response. Canary for "first-use experience actually works."
- Recovery walkthrough: kill the bootstrap-session cookie mid-wizard, re-paste token, finish.
- `ax admin reset-bootstrap` against an unfinished wizard: confirm it works; against a completed wizard: confirm it refuses.

### Failure modes the design must NOT silently swallow

- **Stdout print fails on first boot.** If we can't write the token to stdout AND can't write `/var/run/ax/bootstrap-token`, kernel must refuse to start (loud panic), not boot a "headless" instance with an unreachable token.
- **Better-auth provider misconfigured** (bad Google client secret). Hot-reload must not crash the kernel — failures get logged, previous handler stays live, `/admin/auth` shows the error to the admin. Test: post a syntactically-valid-but-wrong-secret config; confirm kernel still serving sign-in for previously-configured providers.
- **Credential-validation call hangs.** Hard 10s timeout. On timeout, return `{ ok: false, reason: 'credential-validation-timeout' }`.
- **Database transaction rollback in §3.** If credential insert succeeds but agent insert fails, clean rollback (no orphaned credential, no half-finished bootstrap). Single tx, not three separate calls.

## Forward-compatibility flags

Things that will need to change later, called out so we don't accidentally bake them in:

- *Multi-tenant SaaS*: bootstrap-token model is single-instance. SaaS tenant signup would replace this with email-verification-on-signup. Out of scope; `bootstrap:claim` hook is private to `@ax/onboarding` so swapping it is local.
- *SMTP*: when SMTP arrives, password reset and email verification become real. `email_verified=false` for the bootstrap admin should auto-flip to `true` once they verify, but that's a later issue.
- *Second LLM provider*: `models:list-supported` is multi-provider-ready (multiple plugins answer, results merged). The wizard's "API key" step assumes Anthropic; when OpenAI lands, the wizard needs a provider picker before the API-key field.

## Acceptance criteria

The implementation plan will be measured against these:

1. Operator runs `ax` with no env vars → token visible in stdout → token clickable as URL → wizard works end-to-end → admin lands in chat with a working Default Agent.
2. Operator runs `ax` with `AX_BOOTSTRAP_TOKEN` set → no token in stdout → wizard works using their token.
3. After wizard, `/admin/auth` lets admin add Google → admin signs out → signs back in via Google → still has admin role. Hot-reload, no restart.
4. After wizard, `/admin/credentials` shows only API-key entry; no OAuth web-paste anywhere.
5. Bootstrap is one-shot — re-running `/setup` after completion returns 410.

## Wizard mockup (for reference)

The 4-screen wireframe explored during brainstorming:

- **Step 0 (gate):** "Welcome to ax. Paste the bootstrap token from your server logs, or click the magic link." Single input + Continue.
- **Step 1 (admin):** "Create your account. You'll be the first admin. We'll add other authentication methods later." Name + email + password + Continue.
- **Step 2 (model):** "Connect a model. Paste your Anthropic API key. (Where do I get one?)" Single API-key input. `<details>` for advanced model overrides. Continue.
- **Step 3 (done):** "You're all set. Default agent is ready. Configure other authentication methods + invite teammates anytime in Admin." Open chat button.

Visualized in `.superpowers/brainstorm/` during brainstorming session 2026-05-08.
