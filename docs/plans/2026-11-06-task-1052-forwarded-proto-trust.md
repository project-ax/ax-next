# TASK-1052: Better Auth sees http-server's scheme, and a malformed Host is a counted 400 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No request header can choose the scheme Better Auth sees, break the URL we hand it, or move the path it routes on. A malformed `Host` gets a fixed 400 that Better Auth's rate limiter has already counted.

**Architecture:** `@ax/http-server` already decides the request scheme once, for cookie `Secure` (`deriveSecure`). It now also hands that decision to every route handler as `HttpRequest.protocol`. `@ax/auth-better` builds Better Auth's URL in one new helper, `better-auth-url.ts`. The helper takes the scheme from `req.protocol` and accepts the `Host` header only if it is a bare `host[:port]`. A malformed `Host` is still sent to Better Auth, on a placeholder host, with a flag in the per-request async-local box. A small Better Auth plugin answers the 400 from `onRequest`. Better Auth runs plugins' `onRequest` after its rate limiter, so the request is counted, and the endpoint never runs.

**Tech Stack:** TypeScript, vitest 5, better-auth 1.7.7 (exact pin, unchanged), kysely 0.28.17 (`DummyDriver`), `node:http`, `node:async_hooks`. No new dependency.

**Spec:** the card (condensed below) and `.claude/memory/decisions/2026-11-06-TASK-1052.md`. That file holds each decision with its rationale and the alternatives turned down.

## Spec

The card asks for:

- Read the scheme from `X-Forwarded-Proto` only when `trustProxy` is on, the same way http-server decides. Otherwise use the connection's own scheme.
- Validate the scheme and the host before building the URL. A malformed value answers a fixed 400, still logged code-only, and Better Auth's rate limiter counts it like any other auth request.
- Acceptance: (1) `trustProxy` is off and `x-forwarded-proto: https` arrives on a plain connection: Better Auth sees `http`. (2) A malformed `X-Forwarded-Proto` gets a 400, not a 500, and counts against the rate limit. Prove each test fails before its fix. Run the security-checklist skill.

Planning settled this (decisions rows in brackets). MEASURED means a probe ran on Node 24.19.0 against better-auth 1.7.7. READ means the claim comes from reading the source.

1. **The premise holds.** `plugin.ts:718-721` builds `${x-forwarded-proto ?? 'http'}://${host ?? 'localhost'}${path}?${query}` with no check against proxy trust. When `baseURL` isn't pinned (AX_PUBLIC_BASE_URL unset: kind, local, tests), Better Auth takes its base URL, its trusted origin and the OAuth `redirect_uri` from that URL's origin (READ: `better-auth/dist/auth/base.mjs`, `utils/url.mjs` `getBaseURL`). Better Auth never reads `X-Forwarded-Proto` or `X-Forwarded-Host` itself unless `advanced.trustedProxyHeaders` is set, and we don't set it. (It does read `X-Forwarded-For` for its rate limiter: follow-up (a).) [row 1]
2. **Refuted: "a malformed X-Forwarded-Proto gets a 400".** That clause contradicts the card's own fix line and the orchestrator's learning: decide the scheme exactly the way http-server does. http-server's rule cannot produce a malformed scheme. Trust off ignores the header. Trust on reads the first hop, and anything but `https` means `http`. So in auth-better a malformed `X-Forwarded-Proto` is an ordinary `http` request. It can no longer cause a 500, it reaches Better Auth, and Better Auth's limiter counts it. Acceptance (2) is kept, with Better Auth's own answer in place of a 400. The PR body states this deviation. [row 3]
3. **The scheme lives on `HttpRequest.protocol`, derived once.** The same value feeds cookie `Secure`, so the two can never disagree. This changes the hook surface, so the PR body needs boundary review (answers below). [row 2]
4. **Host is the real malformed input, and the old code had two failure shapes** (MEASURED). Some values throw in `new Request`: `a b`, `x:99999`, `u@x` (Request refuses credentials), `x<y`, `999.1.1.1`. Others don't throw but move the path or query Better Auth routes on: `x/y` gives path `/y/auth/...`, `x?y` gives path `/`, plus `x#y`, `x\y`, and the empty Host `""`, where the URL becomes `http:///auth/x`, which parses as host `auth`, path `/x`. Validation must cover both shapes. [row 4]
5. **Counting works through a Better Auth plugin.** In better-auth 1.7.7, the router's `onRequest` runs disabled paths, then the schema check, then the rate limiter, then each plugin's `onRequest`. A plugin that returns `{ response }` short-circuits before routing (READ: `better-auth/dist/api/index.mjs:163-182`, `better-call/dist/router.mjs` `handler`). MEASURED with the real better-auth (schema check off for the probe): three flagged requests got 400, the 4th got 429, an unflagged 5th got 429 (same bucket), and the endpoint ran 0 times. [row 5]
6. **The counting tests don't need Docker, with one caveat** (the builder's open question). Real Better Auth on kysely's `DummyDriver` fails every request with "Database schema mismatch" (MEASURED). Its runtime schema check runs before the limiter. The tests therefore wrap the real `betterAuth` and turn only `advanced.database.validateSchema` off. Everything under test is still Better Auth's own: the limiter, the plugin pipeline and the router. A counting `DummyDriver` proves the endpoint never ran. [row 6]
7. **Sending a custom Host in a test** (MEASURED): `fetch` silently replaces a custom `host` header, and `node:http.request` replaces an empty one. Use `node:http.request` with `setHost: false`. HTTP/1.1 without any Host never reaches us, because Node answers 400 itself. [row 6]
8. **Rule 5, the stale line:** `plugin.ts:715-717` says "Hostname doesn't matter; better-auth keys off the pathname + search." That is false, as item 1 shows, and it is what made trusting `Host` and `X-Forwarded-Proto` look harmless. Task 2 replaces it and corrects the comments that describe the old URL build. `docs/plans/2026-05-20-google-login-auth-integration-impl.md:476` and the TASK-1047 plan quote the old code. They are historical records, so leave them alone. [row 7]
9. **Behaviour change for operators.** Without `AX_TRUST_PROXY=1`, Better Auth now sees `http` even behind a TLS proxy. That only matters when `AX_PUBLIC_BASE_URL` is unset, because a set value pins Better Auth's `baseURL` in the preset. The GKE recipe sets it (READ: `deploy/GKE.md:1704`, `deploy/charts/ax-next/gke-values.yaml:239`). Nothing in the repo sets `AX_TRUST_PROXY`. **The live prod value can't be seen from the repo.** If prod lacked `onboarding.publicBaseUrl`, this change would flip Better Auth to `http` behind the GKE load balancer and Google sign-in would refuse the `redirect_uri`. So the PR body tells the deployer to confirm it before deploying (Task 4). kind is plain http and doesn't change. The one place `AX_TRUST_PROXY` is documented (`docs/dev/2026-04-26-google-oauth-setup.md:132-135`) gains a sentence. [row 8]
10. **Out of scope, returned as follow-ups:** see the end of this plan. [row 9]

## Global Constraints

- Edit only `packages/http-server/`, `packages/auth-better/` and `docs/dev/2026-04-26-google-oauth-setup.md`. TASK-1054 (not in flight) will later rework the query part of `better-auth-url.ts`. Keep all URL building in that one file.
- `@ax/auth-better` imports `@ax/http-server` **type-only**, as today (invariant 2). No new dependency. better-auth stays at 1.7.7.
- auth-better's tests and `tsc` read `@ax/http-server` from its **`dist/`** (package `exports`). After Task 1, run `pnpm --filter @ax/http-server build` before any auth-better test or build. Otherwise `req.protocol` is `undefined` there.
- The one new log line is exactly `` `[ax/auth-better] bad request on ${req.method} ${AUTH_ROUTE} {"code":"malformed-host"}\n` `` via `process.stderr.write`, written only when the 400 is actually served. No new line ever carries a header value, the path, the query or an error message (TASK-1047).
- The refusal is exactly status 400, JSON body `{"error":"malformed-host"}`. Over the limit, the client gets Better Auth's own 429.
- Host grammar (pinned, MEASURED against every shape in Task 2's tables): `/^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/`, and `` new URL(`http://${host}`) `` must also parse. An absent or empty Host means `localhost` and is not malformed.
- Run single test files with `pnpm --filter <pkg> exec vitest run <path>`. Put `--filter` before the script (CLAUDE.md). Every new test file in this plan is Docker-free. The rest of the auth-better suite starts Postgres, so set `DOCKER_HOST` for package runs.
- Every bug-fix test is run red before its fix, or against the named mutant, and the red output goes in the PR body (Bug Fix Policy, card acceptance).
- No secret-shaped literals in this plan or the PR body (TASK-1047 gitleaks mistake). Test passwords live in a test constant.
- Memory rows go to `.claude/memory/<kind>/2026-11-06-TASK-1052.md` shards only.

## Review Focus

1. **Legitimate Host shapes must never be refused:** a port, an IPv6 literal, uppercase, an underscore (compose-style service names), punycode. Pinned by Task 2's `ACCEPTED` table.
2. **An empty Host** (an authority-less request, which RFC 9110 allows) means `localhost`, not a 400, and must not move the path. Today it does: host `auth`, path `/x`. Pinned by Task 2's unit table and its integration test.
3. **Proxy trust on with a multi-hop or odd-case header** (`HTTPS, http`) means `https`, and garbage means `http`, the same as cookie `Secure`. Pinned by Task 1's table.
4. **A refused request's flag never leaks into a concurrent one.** Pinned by Task 3 test 4, which holds all four requests at a barrier inside Better Auth's handler so they overlap between writing the box and the plugin reading it. (Review found the first version didn't overlap, so a shared box passed it.)
5. **Log volume is bounded by the limiter, per client per path.** A malformed request answered 429 writes no line. The limiter keys on `ip|path` and the refusal runs before routing, so rotating the path under `/auth/*` starts fresh buckets (no worse than before, when every throwing Host wrote a line). Pinned by Task 3 test 1 (four malformed requests, exactly three lines).

Known and not handled here: Better Auth's limiter keys on the client-controlled `X-Forwarded-For` (follow-up (a)).

## Boundary review (paste into the PR body)

- **Change:** the `HttpRequest` every `http:register-route` handler receives gains `readonly protocol: 'http' | 'https'`.
- **Alternate impl:** an http-server on an `https.Server` (TLS on the socket), or a fetch-style edge adapter. Both know the scheme the client used.
- **Leaky field names:** none. `protocol` is HTTP's own vocabulary on http-server's own adapter, like `method` and `path`. The proxy mechanism (`X-Forwarded-Proto`, `AX_TRUST_PROXY`) stays inside http-server.
- **Subscriber risk:** a handler that builds absolute URLs relies on every impl applying proxy trust the same way. The field's doc comment states the rule. Today's only reader is auth-better.
- **Wire surface:** none. This is not an IPC action.

## File map

| File | Change | Task |
|---|---|---|
| `packages/http-server/src/types.ts:15-45` | `HttpRequest.protocol` + doc comment | 1 |
| `packages/http-server/src/plugin.ts:416,483-495` | derive `protocol` once; feed `cookieEnv` and `adapterReq` | 1 |
| `packages/http-server/src/__tests__/request-protocol.test.ts` | new | 1 |
| `packages/auth-better/src/better-auth-url.ts` | new: `betterAuthUrl`, Host grammar, `serializeQuery` (moved) | 2 |
| `packages/auth-better/src/plugin.ts:687-759,839-845` | use `betterAuthUrl`; rewrite stale comments; drop `serializeQuery` | 2, 3 |
| `packages/auth-better/src/handler.ts:180-193` | comment (Task 2); `plugins: [refuseMalformedHost]` (Task 3) | 2, 3 |
| `packages/auth-better/src/session-bridge.ts:1-12` | `AuthRequestBox` type + doc | 3 |
| `docs/dev/2026-04-26-google-oauth-setup.md:132-135` | one sentence | 2 |
| `packages/auth-better/src/__tests__/support/request-with-host.ts` | new test helper | 2 |
| `packages/auth-better/src/__tests__/better-auth-url.test.ts` | new, unit | 2 |
| `packages/auth-better/src/__tests__/better-auth-scheme.test.ts` | new, Docker-free integration | 2 |
| `packages/auth-better/src/__tests__/handler-error-log.test.ts:14-30,162-175` | retarget test 2 + header comment (Task 2); import moved helper (Task 3) | 2, 3 |
| `packages/auth-better/src/__tests__/support/capture-output.ts` | `captureOutput` moved out of handler-error-log.test.ts | 3 |
| `packages/auth-better/src/__tests__/malformed-host-rate-limit.test.ts` | new, Docker-free, wraps the real Better Auth | 3 |

---

### Task 1: `HttpRequest.protocol`, decided once by http-server [tier: sensitive]

Needs the **security-checklist** skill (proxy trust over an untrusted header, exposed to every handler) and the **boundary review** above.

**Files:**
- Modify: `packages/http-server/src/types.ts` (`HttpRequest`, after `rawPath`)
- Modify: `packages/http-server/src/plugin.ts` (`handle()`: `:416` and the `adapterReq` literal `:483-495`)
- Test: `packages/http-server/src/__tests__/request-protocol.test.ts`

**Interfaces:**
- Produces: `readonly protocol: 'http' | 'https'` on `HttpRequest` (exported from `@ax/http-server`). Its doc comment states the rule: `https` when the socket is TLS, or, only when proxy trust is on (`AX_TRUST_PROXY=1`), when the first `X-Forwarded-Proto` hop is `https` (case-insensitive). Everything else, malformed or untrusted, is `http`, never an error.

- [ ] **Step 1: Write the failing test.** Copy `cookies-adapter.test.ts`'s harness: save and delete `AX_TRUST_PROXY` in `beforeEach`, restore it in `afterEach`, and use a real listener on `127.0.0.1:0`. Register `GET /proto`, whose handler calls `res.setSignedCookie('probe', 'v')` and answers `res.status(200).json({ protocol: req.protocol })`.

```ts
it.each([
  { trust: false, xfp: 'https', protocol: 'http' },
  { trust: true, xfp: 'https', protocol: 'https' },
  { trust: true, xfp: 'HTTPS, http', protocol: 'https' },
  { trust: true, xfp: 'a b', protocol: 'http' },
  { trust: true, xfp: undefined, protocol: 'http' },
])('trust=$trust, X-Forwarded-Proto=$xfp → $protocol, and cookie Secure agrees', async ({ trust, xfp, protocol }) => {
  // trust ? process.env.AX_TRUST_PROXY = '1' : delete it; fetch /proto with the header when xfp is set
  expect(await r.json()).toEqual({ protocol });
  expect(/; Secure/.test(r.headers.get('set-cookie') ?? '')).toBe(protocol === 'https');
});
```

- [ ] **Step 2: Run it red.** `pnpm --filter @ax/http-server exec vitest run src/__tests__/request-protocol.test.ts`. Expected: all 5 FAIL, because the body is `{}` (`protocol` is undefined and JSON drops it). Save the output for the PR.
- [ ] **Step 3: Implement.** In `handle()`, compute `const protocol = deriveSecure(req, headers, trustProxy) ? 'https' : 'http'` once. Set `cookieEnv.isSecureRequest` to `protocol === 'https'`, and add `protocol` to `adapterReq`. Leave `deriveSecure`'s body unchanged: the rule doesn't move.
- [ ] **Step 4: Run it green**, then the package: `pnpm --filter @ax/http-server test` passes. Then `pnpm --filter @ax/http-server build` (auth-better reads this `dist/`).
- [ ] **Step 5: Commit** (`http-server: hand route handlers the request scheme (TASK-1052)`).

---

### Task 2: The URL Better Auth sees can't be steered by request headers [tier: sensitive]

Needs the **security-checklist** skill (untrusted `Host` and `X-Forwarded-Proto` headers into the auth URL).

**Files:**
- Create: `packages/auth-better/src/better-auth-url.ts`
- Modify: `packages/auth-better/src/plugin.ts` (`forwardToBetterAuth` `:709-759`, adapter comment `:693-694`, catch comment `:741-753`, delete `serializeQuery` `:839-845`)
- Modify: `packages/auth-better/src/handler.ts:184-189` (comment only)
- Modify: `docs/dev/2026-04-26-google-oauth-setup.md:132-135`
- Create: `packages/auth-better/src/__tests__/support/request-with-host.ts`
- Test: `packages/auth-better/src/__tests__/better-auth-url.test.ts`, `packages/auth-better/src/__tests__/better-auth-scheme.test.ts`
- Modify: `packages/auth-better/src/__tests__/handler-error-log.test.ts` (test 2 `:162-175` and header comment `:14-30`)

**Interfaces:**
- Consumes: `HttpRequest.protocol` (Task 1).
- Produces:
  - `export type BetterAuthUrlRequest = Pick<HttpRequest, 'protocol' | 'headers' | 'path' | 'query'>`
  - `export function betterAuthUrl(req: BetterAuthUrlRequest): { url: string; malformedHost: boolean }`. The URL is `${req.protocol}://${host}${req.path}` plus `?${serializeQuery(req.query)}` when the query is non-empty. `host` is the `Host` header if it is well-formed (Global Constraints grammar). An absent or empty Host gives `localhost` with `malformedHost: false`. A malformed Host gives `localhost` with `malformedHost: true`. The helper never reads `X-Forwarded-Proto`. `serializeQuery` moves here unchanged (TASK-1054 will replace it).
  - Test helper `requestWithHost(port: number, req: { method: 'GET' | 'POST'; path: string; host: string; headers?: Record<string, string>; json?: unknown }): Promise<{ status: number; body: string }>`. It uses `node:http.request` with `setHost: false` and sends `host` verbatim, `''` included. For POST it adds `content-type: application/json`, `content-length` and `x-requested-with: ax-admin` (http-server's CSRF bypass; these tests aren't about CSRF). Comment why: `fetch` replaces a custom Host and plain `http.request` replaces an empty one (MEASURED).

- [ ] **Step 1: Write the unit test** `better-auth-url.test.ts` (no Better Auth, no server). Use `const base = { path: '/auth/get-session', query: { a: '1' } }`.
  - `it('takes the scheme from req.protocol, never from X-Forwarded-Proto')`: `{ ...base, protocol: 'http', headers: { host: 'ax.example.com', 'x-forwarded-proto': 'https' } }` gives `{ url: 'http://ax.example.com/auth/get-session?a=1', malformedHost: false }`. With `protocol: 'https'` the URL starts `https://ax.example.com/`.
  - `ACCEPTED = ['ax.example.com', 'ax.example.com:8443', '127.0.0.1:8080', '[::1]', '[::1]:3000', 'localhost', 'my_service:80', 'AX.Example.COM', 'xn--9ca.com']`. `it.each`: `malformedHost` is false and `` new URL(url).host === new URL(`http://${h}`).host ``.
  - `it.each([undefined, ''])`: an absent or empty Host gives exactly `http://localhost/auth/get-session?a=1` with `malformedHost: false`.
  - `REFUSED = ['a b', 'evil.example/x', 'x?y', 'x#y', 'u@x', 'x\\y', 'x:99999', '999.1.1.1', '[::1', 'x:', 'x:8080:9', 'x<y', 'x%41', 'é.com']`. `it.each`: `malformedHost` is true and the URL is exactly `http://localhost/auth/get-session?a=1`.
  - `it('no Host value can move the path, the query or the userinfo')`: for every value in `ACCEPTED`, `REFUSED` and `''`, `new URL(url)` parses, `pathname === '/auth/get-session'`, `search === '?a=1'` and `username === ''`.
- [ ] **Step 2: Write the integration test** `better-auth-scheme.test.ts`. Boot it like `handler-error-log.test.ts`: the inert `DummyDriver` Kysely, the two credential stubs, the real `@ax/http-server`, `AX_HTTP_ALLOW_NO_ORIGINS=1`, and save/restore of `AX_TRUST_PROXY`. Mock `better-auth` with a `betterAuth(cfg)` that pushes `cfg` into a hoisted `configs` array and returns `{ handler: async (r: Request) => { seen.push(r.url); return Response.json({ ok: true }); }, $context: Promise.resolve({}) }`. Tests:
  - `'trust off: x-forwarded-proto https on a plain connection — Better Auth sees http'`: `fetch` `GET /auth/get-session` with the header gives status 200 and `new URL(seen.at(-1)!).protocol === 'http:'`.
  - `'trust on: x-forwarded-proto https — Better Auth sees https'`: `AX_TRUST_PROXY=1`, so `'https:'`.
  - `it.each([false, true])('trust=%s: a malformed x-forwarded-proto (a b) — Better Auth sees http and answers')`: status 200 and `'http:'`.
  - `'an empty Host keeps the path Better Auth routes on'`: `requestWithHost(port, { method: 'GET', path: '/auth/get-session', host: '' })`, then `seen.at(-1) === 'http://localhost/auth/get-session'`.
  - `it.each(['evil.example/x', 'evil.example?x', 'evil.example#x'])('a Host that smuggles %j never moves the path')`: `new URL(seen.at(-1)!)` has host `localhost` and pathname `/auth/get-session`. Don't assert the status: Task 3 changes it.
  - `'Better Auth is not told to read proxy headers itself'`: `configs.at(-1)?.advanced?.trustedProxyHeaders` is not `true`. With it on, Better Auth would read a client's `X-Forwarded-Proto` again (`getBaseURL`).
- [ ] **Step 3: Retarget `handler-error-log.test.ts` test 2.** New title: `'a malformed X-Forwarded-Proto no longer breaks our URL build: the request reaches Better Auth'`. Expect `{ status: 500, body: { error: 'auth-handler-failed' } }` and `authLines` equal to test 1's exact line, `[ax/auth-better] handler error on GET /auth/* {"code":"57P01","name":"Error"}\n` on stderr. Keep `not.toContain(TOKEN)`. In the header comment, drop "Node's `new Request` TypeError quotes the whole URL" as a live trigger. Keep the reason messages never reach the line.
- [ ] **Step 4: Run the bug-fix tests red** on the current code. `pnpm --filter @ax/auth-better exec vitest run src/__tests__/better-auth-scheme.test.ts src/__tests__/handler-error-log.test.ts`. Expected FAIL: trust-off gives `'https:'`; malformed XFP gives 500 instead of 200; empty Host gives URL `http://auth/get-session`; the smuggled Hosts give host `evil.example` or pathname `/x/auth/get-session` or `/`; test 2 gives a `TypeError` line. (`better-auth-url.test.ts` fails as a missing module, which is expected for a new helper.) Save the output for the PR.
- [ ] **Step 5: Implement `better-auth-url.ts`** per Interfaces. In `forwardToBetterAuth`, replace `:715-721` with `const { url } = betterAuthUrl(req)`; Task 3 uses `malformedHost`. The new file's doc comment says what was false before (rule 5): the origin is not decoration. With no pinned `baseURL`, Better Auth takes its base URL, trusted origin and OAuth `redirect_uri` from it. So the scheme is http-server's, and the Host must be a bare `host[:port]`.
- [ ] **Step 6: Fix the stale prose.**
  - `plugin.ts:693-694`: "URL = path + query" becomes "URL = `betterAuthUrl(req)`: http-server's scheme, the Host header when well-formed, the path and the query".
  - Delete the false "Hostname doesn't matter" comment (`:715-717`).
  - Catch comment `:741-753`: drop "or our own `new Request(url, init)` throwing on a malformed `Host` or `X-Forwarded-Proto` header". No request header can reach that throw now. Keep the codes-not-message reasoning.
  - `handler.ts:187-189`: "builds it from the `Host` header + `x-forwarded-proto`" becomes "builds it in `better-auth-url.ts` from http-server's `req.protocol` (`X-Forwarded-Proto` counts only under `AX_TRUST_PROXY=1`) and the Host header when well-formed".
  - Docs, appended to the HTTPS bullet in `docs/dev/2026-04-26-google-oauth-setup.md`: "The same setting decides whether Better Auth sees `https`. If `AX_PUBLIC_BASE_URL` isn't set either, sign-in builds `http://` callback URLs behind your TLS proxy, and Google will refuse them."
- [ ] **Step 7: Run green.** First `pnpm --filter @ax/http-server build` (if it hasn't run since Task 1), then the two files from Step 4 plus `better-auth-url.test.ts`. All pass. `pnpm --filter @ax/auth-better build` exits 0.
- [ ] **Step 8: Commit** (`auth-better: Better Auth's URL takes http-server's scheme and a well-formed Host only (TASK-1052)`).

---

### Task 3: A malformed Host is a fixed 400 that Better Auth's rate limiter counted [tier: sensitive]

Needs the **security-checklist** skill (auth rate limiter, untrusted Host, a new in-process Better Auth plugin).

**Files:**
- Modify: `packages/auth-better/src/session-bridge.ts:1-12`
- Modify: `packages/auth-better/src/handler.ts` (the `betterAuth({…})` options, `:169-330`)
- Modify: `packages/auth-better/src/plugin.ts` (`forwardToBetterAuth`)
- Create: `packages/auth-better/src/__tests__/support/capture-output.ts`. Move `captureOutput` and its `Captured` type here unchanged from `handler-error-log.test.ts`, and import them back there.
- Test: `packages/auth-better/src/__tests__/malformed-host-rate-limit.test.ts`

**Interfaces:**
- Consumes: `betterAuthUrl(req).malformedHost` and `requestWithHost` (Task 2).
- Produces: `export interface AuthRequestBox { token?: string; malformedHost?: boolean; refused?: boolean }` in `session-bridge.ts`, with `sessionTokenALS = new AsyncLocalStorage<AuthRequestBox>()` (keep the name). Doc comment: one box per `/auth/*` request. `forwardToBetterAuth` sets `malformedHost`, `session.create.after` sets `token`, and the refuse plugin sets `refused` when it answers.

- [ ] **Step 1: Write the failing tests** in `malformed-host-rate-limit.test.ts`. Use the inert harness from Task 2's integration file, with two differences.
  - **The real Better Auth, wrapped:** `vi.mock('better-auth', async (importOriginal) => { const actual = await importOriginal<typeof import('better-auth')>(); return { ...actual, betterAuth: (o) => actual.betterAuth({ ...o, advanced: { ...o.advanced, database: { ...o.advanced?.database, validateSchema: false } } }) }; })`. Comment it: there is no Postgres here; with `DummyDriver` the runtime schema check fails every request before the limiter (MEASURED); everything under test is Better Auth's own. (Repo precedent for this `importOriginal` wrap: `packages/agent-aisdk-runner/src/__tests__/parity.e2e.test.ts:65-66`.)
  - **A counting driver:** a `DummyDriver` subclass whose connection pushes each compiled query's `sql` into a hoisted `queries` array and answers `{ rows: [] }`.
  - `AX_TRUST_PROXY` is unset (save/restore). One stack for the file, in `beforeAll`. Better Auth's memory store is module-level, so every Better Auth instance in this file shares it. **Give each test its own path**, so buckets never mix. Send no `x-forwarded-for`, so the IP is Better Auth's test fallback, `127.0.0.1`.

  1. `'a malformed Host gets a fixed 400 that the rate limiter counted, and one code-only line per 400'`. Inside `captureOutput`, send `POST /auth/sign-in/email` (JSON `{ email: 'nobody@example.com', password: PASSWORD }`) via `requestWithHost` with hosts `'marker one'`, `'marker-two.example/x'` and `'marker3@x'`. Each gives status 400 and `JSON.parse(body)` equal to `{ error: 'malformed-host' }`. The 4th, host `'marker four'`, gives 429. The 5th, a well-formed host `` `127.0.0.1:${port}` ``, gives 429 (same bucket as legitimate requests). `authLines` is exactly three `{ via: 'stderr', line: '[ax/auth-better] bad request on POST /auth/* {"code":"malformed-host"}\n' }`. `output.join('')` does not contain `'marker'`.
  2. `'a refused request never reaches the endpoint'`. Set `queries.length = 0`, then `POST /auth/sign-up/email` with host `'marker five'` and JSON `{ email: 'refused@example.com', password: PASSWORD, name: 'Refused' }`. Expect status 400, body `{ error: 'malformed-host' }` and `queries` equal to `[]`. **Assert the body**: Better Auth's own answer to this sign-up on the inert driver is also a 400 (`FAILED_TO_CREATE_USER`, after 2 queries — MEASURED), so the status alone proves nothing. Control: the same request with a well-formed host gives `queries.length > 0`. Don't assert the control's status.
  3. `'a malformed X-Forwarded-Proto is an ordinary request that the rate limiter counts'`. Three `fetch` `POST /auth/change-password` calls with `x-forwarded-proto: a b`, `content-type: application/json`, `x-requested-with: ax-admin` and a JSON body each get Better Auth's own answer, 401 `UNAUTHORIZED`, because there is no session (MEASURED with the real Better Auth, 0 queries). Pin 401. The 4th, without the header, gives 429.
  4. `'a refusal never leaks into a concurrent request'`. `Promise.all` one `requestWithHost` `GET /auth/get-session` with host `'marker six'` and three plain `fetch` `GET /auth/get-session`. Statuses are `[400, 200, 200, 200]`. With no cookie, Better Auth answers `null` with 200 (MEASURED).
- [ ] **Step 2: Run red on Task 2's code.** `pnpm --filter @ax/auth-better exec vitest run src/__tests__/malformed-host-rate-limit.test.ts`. Expected: test 1 FAILS (401 instead of 400, no line; the 4th and 5th already get 429 here, because Task 2 lets malformed requests reach the limiter). Test 2 FAILS (the refused sign-up runs its queries and answers Better Auth's own 400 body). Test 4 FAILS (200 instead of 400). Test 3 passes, because Task 2 already fixed it. **Prove test 3 red with a mutant:** in `better-auth-url.ts`, temporarily use `req.headers['x-forwarded-proto'] ?? 'http'` in place of `req.protocol`. Test 3 FAILS with 500s and no 429. Revert. Save all red output for the PR.
- [ ] **Step 3: Implement.**
  - `session-bridge.ts`: `AuthRequestBox` per Interfaces.
  - `handler.ts`: add `const refuseMalformedHost: BetterAuthPlugin` (`import type { BetterAuthPlugin } from 'better-auth'`) with `id: 'ax-refuse-malformed-host'` and an `onRequest` that reads `sessionTokenALS.getStore()`. When `malformedHost === true`, it sets `refused = true` and returns `{ response: Response.json({ error: 'malformed-host' }, { status: 400 }) }`: a fresh Response each call, since bodies are single-use. Otherwise it returns nothing. (`Response.json` is typed: `undici-types` 7.x via `@types/node` 25 declares `static json`.) Pass `plugins: [refuseMalformedHost]` to `betterAuth`. The comment names the order it relies on: better-auth 1.7.7 router `onRequest` runs disabled paths, the schema check, the rate limiter, then each plugin's `onRequest` (`dist/api/index.mjs`). This test file pins it, so a Better Auth upgrade that reorders them goes red here.
  - `plugin.ts`: `const { url, malformedHost } = betterAuthUrl(req)` and `const box: AuthRequestBox = malformedHost ? { malformedHost: true } : {}`, run as today. After the try/catch, if `box.refused === true`, write the Global Constraints line. Then the normal response copy forwards the 400. Nothing else changes.
- [ ] **Step 4: Run green.** The new file passes, and so do the three Task 2 test files. Then the whole package, which needs Docker for the other suites: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/auth-better test`. The Docker-backed real-Better-Auth suites (`social-signin`, `hot-reload`, `admin-routes`) now run with the plugin registered and the schema check on, which covers "the plugin is a no-op for good requests".
- [ ] **Step 5: Commit** (`auth-better: a malformed Host is a 400 that Better Auth's rate limiter counted (TASK-1052)`).

---

### Task 4: Gate [tier: mechanical]

- [ ] `pnpm build` exits 0. It runs tsc across the repo, so it catches any typed `HttpRequest` literal missing `protocol`. Today only http-server builds one; tests cast.
- [ ] `pnpm --filter @ax/http-server test` and `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/auth-better test` both pass.
- [ ] `pnpm lint` exits 0.
- [ ] Repo gate per CLAUDE.md: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. auth-better's Docker *teardown* timeout with every assertion passing is known local noise. Anything else is real.
- [ ] Run the **security-checklist** skill over the branch and put its note in the PR body. Also add: the boundary review above, each red run (Tasks 1–3), the deviation from acceptance (2) (Spec item 2), and the follow-ups below.
- [ ] Add a **deploy precondition** to the PR body (Spec item 9): before deploying, confirm that the prod release sets `onboarding.publicBaseUrl` (`helm get values ax-next --kube-context <gke ctx>`, read-only). If it doesn't, set it (or `AX_TRUST_PROXY=1`) in the same upgrade. Otherwise Better Auth sees `http` behind the load balancer and Google sign-in breaks. Do not run that command against prod yourself.

## Follow-ups (return to the orchestrator; not fixed here)

- (a) **Better Auth's rate limiter keys on `X-Forwarded-For`, which auth-better forwards as-is.** Better Auth trusts a single-value header when no `trustedProxies` are set, so a direct client can rotate it and get a fresh bucket on every request. Behind a proxy that appends (a multi-value header), Better Auth gets no IP. With `NODE_ENV` neither `test` nor `development` (so prod, where nothing sets it), that leaves every client in one `no-trusted-ip` bucket per path, for example `/sign-in*` at 3 per 10 s for everyone. INFERRED from better-auth 1.7.7 source (`@better-auth/core/dist/utils/ip.mjs`, `api/rate-limiter/index.mjs`); not measured on a cluster. Confirm by looking for Better Auth's one-time warning "Rate limiting could not determine a client IP" in the host's logs.
- (b) Host validation for every route (RFC 9112 §3.2 says 400) belongs in http-server once a second Host reader exists. auth-better is the only one today.
- (c) Already known: auth-better gates cookie `Secure` on `NODE_ENV`, and nothing sets `AX_TRUST_PROXY` in the chart (`decisions/2026-11-05-ARTIFACTS-20261105.md` row 25).
