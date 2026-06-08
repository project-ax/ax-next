# TASK-169 — Add an `auth.secret` Helm value for AX_AUTH_SECRET

## Problem

`ax-next-secrets` holds three keys:
- `credentials-key` — settable via `--set credentials.key` (lookup-stable, `required`)
- `http-cookie-key` — settable via `--set http.cookieKey` (lookup-stable, `required`)
- `auth-secret` — `AX_AUTH_SECRET`, used by `@ax/auth-better` to encrypt OAuth tokens
  at rest. **Has NO Helm value.** The chart only `randBytes 32 | b64enc`-generates a
  fresh one, or reuses an existing in-cluster Secret (lookup-stable).

Consequence: standing up a **new** cluster against an **existing** DB (e.g. the GKE
Autopilot→Standard migration, PR #330) mints a fresh `auth-secret`, so every account
that linked Google can no longer decrypt its stored OAuth tokens → broken logins.

Today's workaround (deploy/GKE.md Step M4): back the value up to Secret Manager and
`kubectl patch` it into `ax-next-secrets` post-install, then `rollout restart` the host.

## Approach

Add an `auth.secret` value and make the template's `auth-secret` key honor it, mirroring
the exact lookup-stable shape `credentials-key`/`http-cookie-key` use — **but keep
auto-generation as the fall-through default** (no `required`), so fresh installs that
don't pass the value still work. Precedence:

1. Existing in-cluster Secret already carries `auth-secret` → reuse verbatim (upgrade-safe).
2. Else `--set auth.secret=<raw>` provided → `| b64enc` it.
3. Else → `randBytes 32 | b64enc` (today's behavior; preserved).

`| b64enc` matches `credentials.key`: operators pass the **decoded** raw secret; the
Secret's `data` holds its base64; the deployment's `secretKeyRef` decodes it back to the
env var.

## Tasks

### Task 1 — Chart: `auth.secret` value + lookup-stable template branch (+ test)
- `values.yaml`: add an `auth:` block with `secret: ""`, documented in the voice rules.
  Slot it in the "Auth / better-auth" section (~line 481+), and update the prose there
  ("you don't supply it") to mention the new optional override.
- `templates/hook-secret.yaml`: change the `auth-secret` branch (lines ~75–80) from a
  bare `if existing / else randBytes` to a 3-way: existing → `.Values.auth.secret | b64enc`
  → `randBytes 32 | b64enc`. Update the comment block to document the new middle branch.
- **Test first** (`__tests__/render.test.ts`, helm-gated suite): a new `describe` that
  asserts:
  - default (no `--set auth.secret`): `data.auth-secret` is present and non-empty (auto-gen).
  - `--set auth.secret=<raw>`: `data.auth-secret` == `base64(<raw>)`.
  - two renders with the same `--set auth.secret` produce the **same** `auth-secret`
    (deterministic — proves the value path isn't re-randomizing).
  - (auto-gen path stays random: two default renders differ — guards we didn't break gen.)

### Task 2 — GKE.md Step M4: replace backup+patch dance with `--set`
- Step M4: drop the blockquote's `kubectl patch` + `rollout restart` workaround. Add
  `AX_AUTH_SECRET` to the `gcloud secrets versions access` exports, and add
  `--set auth.secret="$AX_AUTH_SECRET"` to the Step M6 `helm upgrade`. Keep a short note
  that this carries the OAuth-token encryption secret across the cluster rebuild.

### Task 3 — GKE.md Step 4b: back up `auth-secret` in the original key-backup list
- Step 4b: when generating/backing up the keys, capture `auth-secret` too so a *future*
  migration has it in Secret Manager from day one (closing the "the original Step 4b
  didn't back it up — an oversight" gap the M4 blockquote calls out). On a fresh install
  the value is chart-generated, so the backup must read it **after** install from
  `ax-next-secrets` (or accept that first-install operators set it explicitly). Document
  the read-after-install + Secret-Manager-store step.

## YAGNI pass
- Task 1: load-bearing (the feature). Keep.
- Tasks 2 & 3: doc simplification the card explicitly asks for. Keep — they're the
  payoff that makes the value usable, and stale docs would otherwise contradict the chart.
- No `required`, no `existingSecret` indirection (rejected in decisions.md). Keep minimal.

## Boundary review
No hook surface, IPC, or plugin change — this is Helm chart values/template + docs. No
boundary-review checklist needed. No untrusted-input / sandbox / network / new-dep change,
so no security-checklist trigger (the secret value is operator-supplied at install, same
trust class as the existing `credentials.key`).
