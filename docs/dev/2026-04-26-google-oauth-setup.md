# Setting up Google OAuth for ax-next (dev mode)

We're using Google's OIDC flow for sign-in. This walks through getting
real credentials wired up so the channel-web "Sign in with Google" button
does the actual handshake.

## What you'll get

- A Google Cloud OAuth 2.0 client ID + secret.
- env vars to drop into your shell.
- A working dev loop: `ax-next serve` on :8080, `vite dev` on :5173,
  Vite proxies auth to the backend, browser sees same-origin.

If you just want to click around the UI without real Google, skip this
and run `pnpm --filter @ax/channel-web dev` — the mock backend simulates
sign-in as a fake user.

## Step 1 — Get OAuth credentials from Google

Go to [Google Cloud Console](https://console.cloud.google.com/) →
APIs & Services → Credentials.

1. **Pick (or create) a project.** Anything works for dev.
2. **OAuth consent screen** (sidebar): set User Type to "External",
   fill in App name (`ax-next dev`), support email, dev contact.
   Add scopes `email` and `profile`. Add yourself under Test users.
   (External apps in "Testing" mode work fine for dev — no Google review
   needed unless you want non-test-users to sign in.)
3. **Create credentials → OAuth client ID:**
   - Application type: **Web application**
   - Name: `ax-next dev`
   - Authorized JavaScript origins: `http://localhost:5173`
   - **Authorized redirect URIs:** `http://localhost:5173/auth/callback/google`
4. Copy the **Client ID** and **Client secret**.

> ☝️ Heads up: the redirect URI must EXACTLY match what `@ax/auth-oidc`
> sends to Google. The backend's `redirectUri` config is the source of
> truth — Google rejects the handshake if there's any mismatch (trailing
> slash, scheme, port, all of it). Use `http://localhost:5173/...` (the
> Vite-proxied origin) so the cookie lands on the same origin the
> browser is on.

## Step 2 — Backend env vars

In the terminal where you'll run `ax-next serve`:

```bash
# Postgres (use any local instance — testcontainer cookbook works too)
docker run -d --name ax-pg -p 5432:5432 -e POSTGRES_PASSWORD=ax postgres:16-alpine
export DATABASE_URL="postgres://postgres:ax@localhost:5432/postgres"

# Required keys (32 bytes each; hex)
export AX_CREDENTIALS_KEY=$(openssl rand -hex 32)
export AX_HTTP_COOKIE_KEY=$(openssl rand -hex 32)
export AX_DEV_BOOTSTRAP_TOKEN=$(openssl rand -hex 16)

# HTTP listener
export AX_HTTP_HOST=127.0.0.1
export AX_HTTP_PORT=8080
export AX_HTTP_ALLOWED_ORIGINS="http://localhost:5173"

# Google OIDC — paste from step 1
export AX_AUTH_GOOGLE_CLIENT_ID="<paste>"
export AX_AUTH_GOOGLE_CLIENT_SECRET="<paste>"
export AX_AUTH_GOOGLE_ISSUER="https://accounts.google.com"
export AX_AUTH_GOOGLE_REDIRECT_URI="http://localhost:5173/auth/callback/google"

# Workspace + LLM (use llm-mock if you don't want real Anthropic calls)
export AX_K8S_HOST_IPC_URL="http://127.0.0.1:7777"   # not used in this flow
export AX_WORKSPACE_BACKEND=local
export AX_WORKSPACE_ROOT=/tmp/ax-workspace
export ANTHROPIC_API_KEY="<your-key>"

ax-next serve --port 8080
```

## Step 3 — Frontend with proxy

In a separate terminal:

```bash
cd packages/channel-web

# Tells Vite to proxy /auth/*, /admin/*, /api/* to the real backend
# instead of running the mock middleware.
export AX_BACKEND_URL="http://localhost:8080"

pnpm dev
```

## Step 4 — Open the app

[http://localhost:5173](http://localhost:5173) → click **Sign in with Google**.

You should bounce to `accounts.google.com` → consent screen → back to
`localhost:5173`. The session cookie lands and the chat UI loads.

## Troubleshooting

**"redirect_uri_mismatch"** — the URI you configured in Google Cloud
doesn't EXACTLY match `AX_AUTH_GOOGLE_REDIRECT_URI`. Check trailing
slashes, http vs https, port number. They're all load-bearing.

**Cookie isn't being sent** — make sure both Vite and the proxy target
agree on the origin. If the browser bar shows `:5173`, the cookie
should have been set on `:5173` via the proxy. If you went straight to
`:8080`, the cookie's on `:8080` and Vite at `:5173` won't see it.

**`AX_HTTP_ALLOWED_ORIGINS` errors** — for the dev loop, it must
include `http://localhost:5173` (no trailing slash). The backend's
CSRF guard rejects POSTs from origins not in this list (unless they
send `X-Requested-With: ax-admin`).

**`auth_callback_failed` in logs with code `state-mismatch`** — the
state-cookie expired (5 minutes) or someone tampered with it.
Restart the sign-in flow.

**`@kubernetes/client-node` errors at boot** — preset-k8s tries to
talk to a kube-apiserver. For local dev without k8s, the sandbox
won't actually spawn pods (chats run anyway because the orchestrator
mints a session row before sandbox open). If the boot itself fails,
check the env vars in `presets/k8s/src/index.ts`'s
`loadK8sConfigFromEnv` — every required one is named in the error.

## What's NOT covered here

- **Production deployment** — same-origin assumes `vite dev` proxy.
  In prod, channel-web's `dist/` should be served by the same listener
  (e.g., a static-files plugin on `@ax/http-server`, or an nginx in
  front of both). That's a separate piece of work; for now, dev is
  functional.
- **HTTPS** — dev runs over plain HTTP. Cookies won't have `Secure`.
  Production must terminate TLS in front of `ax-next serve` and set
  `AX_TRUST_PROXY=1` so the cookie picks up `Secure` from
  `X-Forwarded-Proto`.
