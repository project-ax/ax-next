# TASK-1047: auth-better's handler-error line names the route, never the request path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `/auth/*` fails before Better Auth can answer, the stderr line says the method, the registered route `/auth/*` and the failure's codes. It never says the request path, the query or the error's message.

**Architecture:** One catch in `forwardToBetterAuth` (`packages/auth-better/src/plugin.ts:737-749`) changes to the line http-server adopted in #1122 (TASK-1044): `handler error on ${method} ${route} ${JSON.stringify(faultLogFields(err))}`. The route comes from a new module constant `AUTH_ROUTE = '/auth/*'`, which the registration loop also uses, so the label is the route as registered. A new Docker-free test boots the real plugin behind the real http-server, with Better Auth mocked to throw and an inert Kysely as the database.

**Tech Stack:** TypeScript, vitest 5, `@ax/core` (`faultLogFields`), `@ax/http-server` + `@ax/test-harness` (test devDeps, already declared), kysely 0.28.17 (`DummyDriver`, already a dependency).

**Spec:** the card (condensed below) and `.claude/memory/decisions/2026-11-05-TASK-1047.md`, which holds each decision with its rationale and the alternatives turned down.

## Spec

The card asks for:

- The handler-error line logs the method plus a fixed route label, as #1122 does. Never the raw path.
- Acceptance: a test where the handler throws on a path with a token-like segment. The stderr line holds no part of that segment. Prove the test fails before the fix.
- Run the security-checklist skill (request-derived input in a log).

Planning settled this (decisions rows in brackets):

1. Premise checked at fa778af8d. `plugin.ts:746` writes `${req.method} ${req.path}`. Better Auth 1.7.7's `GET /reset-password/:token` is already mounted, because `emailAndPassword.enabled` is true (`handler.ts:175`). No token can be minted today: `sendResetPassword` is unset, so `/request-password-reset` refuses with `RESET_PASSWORD_DISABLED` before it creates one. A path token today is always attacker-supplied, never live. [row 1]
2. Anyone can reach this catch today. A malformed `X-Forwarded-Proto` or `Host` header makes our own `new Request(url)` throw (measured on Node 24.19.0: `TypeError: Failed to parse URL from <the whole URL>`). So today's line writes an attacker-chosen path. Better Auth's endpoint errors never get here, because its router (better-call 1.4.0) answers them with its own 500. Only failures before routing do: adapter init, base-URL or origin resolution. [row 1]
3. The label is `/auth/*`, the route as registered, plus `faultLogFields(err)`. [row 2] The line stays on stderr with the same prefix. [row 3]
4. The test is Docker-free and has two cases: a controlled Better Auth throw, with the exact line pinned, and the malformed-header trigger. [row 4]
5. Rule 5: the comment at `plugin.ts:743-744` says "Method + path is enough to correlate with upstream http-server access logs". http-server keeps no access log. That comment made the raw-path line look fine, and Task 1 rewrites it. [row 5]
6. Not in scope: `handler.ts:111` and `:352` (`console.error(…, err)`), and Better Auth's own error logging. Neither is request-path logging. Both are returned as follow-ups. [row 6]

## Global Constraints

- Edit only `packages/auth-better/`. Sibling cards own `packages/database-postgres/` and `packages/routines/`.
- The line is exactly `` `[ax/auth-better] handler error on ${req.method} ${AUTH_ROUTE} ${JSON.stringify(faultLogFields(err))}\n` `` via `process.stderr.write`. It never carries `req.path`, `req.rawPath`, `req.query`, `req.params`, `url`, `err`, `err.message` or `String(err)`.
- The response stays 500 `{ error: 'auth-handler-failed' }`. The URL synthesis, `handler.ts` and the Better Auth config don't change.
- No hook change (no boundary review), no migration, no new dependency.
- `packages/auth-better` keeps tests out of `tsc` (`tsconfig.json` excludes `src/__tests__/**`). Lint the touched files.
- The new test needs no Docker. The rest of the auth-better suite starts Postgres testcontainers, so set `DOCKER_HOST` explicitly (CLAUDE.md).
- Run each new test red before the fix and put the red output in the PR body (card acceptance, Bug Fix Policy).
- Memory rows go to `.claude/memory/<kind>/2026-11-05-TASK-1047.md` shards only.

## Review Focus

1. **A failure whose message quotes the request.** Node's `TypeError` quotes the whole URL, token included, and Better Auth's errors can echo state, email or callback params. Only identifier-shaped codes reach the line. Pinned by Task 1's two tests: test 1 puts the token in the message, and test 2 uses Node's real error.
2. **A client sends a malformed `X-Forwarded-Proto` or `Host`.** Anyone can do this today. The client gets the same 500 and the log gets the same fixed line, with no attacker-chosen text. Pinned by Task 1 test 2.
3. **The token appears anywhere in output, not just the auth-better line.** This covers stdout (the core logger's channel) and http-server's own lines. Pinned by `not.toContain(TOKEN)` over stdout and stderr in both tests.

Known and not handled here: the `handler.ts` `console.error` sites and Better Auth's own `# SERVER_ERROR:` / logger lines (decisions row 6, follow-ups).

## File map

| File | Change | Task |
|---|---|---|
| `packages/auth-better/src/plugin.ts` | `AUTH_ROUTE` const, used at the registration loop (`:338`) and in the catch (`:737-749`). `faultLogFields` import. Comment rewritten. | 1 |
| `packages/auth-better/src/__tests__/handler-error-log.test.ts` | new, Docker-free, 2 tests | 1 |

---

### Task 1: The handler-error line names `/auth/*` and codes only [tier: sensitive]

Needs the **security-checklist** skill. This is a log of request-derived, untrusted input, and a path segment can be a future capability.

**Files:**
- Create: `packages/auth-better/src/__tests__/handler-error-log.test.ts`
- Modify: `packages/auth-better/src/plugin.ts` (imports `:2-9`, constants `:44-46`, registration `:338`, catch `:737-749`)

**Interfaces:**
- Consumes: `faultLogFields(err: unknown): FaultLogFields` from `@ax/core`.
- Produces: module-private `const AUTH_ROUTE = '/auth/*'` in `plugin.ts`. Nothing is exported.

- [ ] **Step 1: Write the failing test file.** It goes in its own file because the `better-auth` module mock would break the files that use the real one (same reason as `handler-ready.test.ts`).

```ts
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';

// Header comment: TASK-1047, what is pinned, why Docker-free (mocked Better Auth throws;
// DummyDriver answers every query with no rows, which is all init needs).

// A Better Auth reset token is generateId(24): 24 letters and digits.
const { TOKEN } = vi.hoisted(() => ({ TOKEN: '<RESET-TOKEN-FIXTURE>' }));

vi.mock('better-auth', () => ({
  betterAuth: () => ({
    handler: async () => {
      // A message can quote the request; this one carries the token.
      throw Object.assign(new Error(`PRIVATE-MESSAGE reset-password:${TOKEN}`), { code: '57P01' });
    },
    $context: Promise.resolve({}),
  }),
}));
const { createAuthBetterPlugin } = await import('../plugin.js');
```

`beforeAll`: save `AX_HTTP_ALLOW_NO_ORIGINS` and set it to `'1'` (hot-reload.test.ts pattern). Build `inertDb = new Kysely<unknown>({ dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => new DummyDriver(), createIntrospector: (db) => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler() } })`. Then `createHttpServerPlugin({ host: '127.0.0.1', port: 0, cookieKey: randomBytes(32), allowedOrigins: [] })` and `createTestHarness({ services, plugins: [http, createAuthBetterPlugin()] })`, where `services` holds `'database:get-instance': async () => ({ db: inertDb })` and the two `credentials:envelope-*` stubs from `init-awaits-adapter.test.ts`. The plugin declares them in `calls`, and no provider rows means they're never reached. Set `baseUrl = http://127.0.0.1:${http.boundPort()}`. `afterAll`: `harness.close({ onError: () => {} })`, then restore the env var.

Helper `captureOutput<T>(run: () => Promise<T>): Promise<{ result: T; output: string[] }>`. It spies both `process.stderr.write` and `process.stdout.write` (one entry per write) and restores both in `finally`. Helper `resetLink(): string` returns `` `${baseUrl}/auth/reset-password/${TOKEN}?callbackURL=%2F` ``, the shape of a real reset link.

```ts
describe('@ax/auth-better: the /auth/* handler-error line (TASK-1047)', () => {
  it('a Better Auth throw logs the route and its codes, never the path, the token or the message', async () => {
    const { result: res, output } = await captureOutput(() => fetch(resetLink()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'auth-handler-failed' });
    expect(output.filter((l) => l.startsWith('[ax/auth-better]'))).toEqual([
      '[ax/auth-better] handler error on GET /auth/* {"code":"57P01","name":"Error"}\n',
    ]);
    expect(output.join('')).not.toContain(TOKEN);
    expect(output.join('')).not.toContain('PRIVATE-MESSAGE');
  });

  it('a malformed X-Forwarded-Proto (our Request build throws, the URL in its message) logs the same line', async () => {
    const { result: res, output } = await captureOutput(() =>
      fetch(resetLink(), { headers: { 'x-forwarded-proto': 'a b' } }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'auth-handler-failed' });
    const lines = output.filter((l) => l.startsWith('[ax/auth-better]'));
    expect(lines).toHaveLength(1);
    const prefix = '[ax/auth-better] handler error on GET /auth/* ';
    expect(lines[0]!.startsWith(prefix)).toBe(true);
    // Node's own TypeError. Its cause codes are a Node detail, so only the name is pinned.
    expect(JSON.parse(lines[0]!.slice(prefix.length))).toMatchObject({ name: 'TypeError' });
    expect(output.join('')).not.toContain(TOKEN);
  });
});
```

- [ ] **Step 2: Run it red against the unfixed `plugin.ts`.** First, the background `pnpm build` must have finished (`@ax/http-server` and `@ax/test-harness` resolve through `dist`).

Run: `pnpm --filter @ax/auth-better exec vitest run src/__tests__/handler-error-log.test.ts`
Expected: both FAIL on assertions. Test 1 receives `'[ax/auth-better] handler error on GET /auth/reset-password/<RESET-TOKEN-FIXTURE>\n'`, and test 2's `startsWith(prefix)` is false. A boot or harness error isn't red; fix the test first. Save this output for the PR body.

- [ ] **Step 3: Implement in `packages/auth-better/src/plugin.ts`.**
  - Add `faultLogFields` to the `@ax/core` import.
  - After `DEFAULT_SESSION_LIFETIME_SECS`, add `const AUTH_ROUTE = '/auth/*';` with a one-line comment: it's the splat every Better Auth request arrives on, and the handler-error line names it in place of the request path (TASK-1047).
  - The registration loop (`:338`) uses `path: AUTH_ROUTE`.
  - The catch drops `void err;` and writes the Global Constraints line.
  - Replace the comment above it (the rule 5 fix). It must say: why the route and not the path (Better Auth's `GET /reset-password/:token` is mounted, so once `sendResetPassword` is configured a failing reset link would write a live token here); why codes and not the message (Better Auth's errors can echo state, email or callback-URL params, and `new Request` quotes the whole URL); and what reaches this catch (Better Auth failing before it routes, such as adapter init or base-URL or origin resolution, or a malformed `Host`/`X-Forwarded-Proto` header; an endpoint's own error never does, because Better Auth's router answers it with a 500). It must not claim an access log to correlate with. http-server keeps none.

- [ ] **Step 4: Run green.** Same command as Step 2. Expected: 2 passed.

- [ ] **Step 5: Security checklist + lint.** Invoke the `security-checklist` skill and keep its note for the PR body. The threat is secret leakage and attacker-chosen text in logs. Sandbox escape and supply chain are N/A, with reasons: no sandbox change, and no new dependency (`DummyDriver` ships in kysely, already a dependency). Run `pnpm exec eslint packages/auth-better/src`. Expected: clean (`no-unused-vars` is an error in tests).

- [ ] **Step 6: Commit.**

```bash
git add packages/auth-better/src/plugin.ts packages/auth-better/src/__tests__/handler-error-log.test.ts
git commit -m "[TASK-1047] auth-better's handler-error line names /auth/* and faultLogFields, never the request path or message"
```

### Task 2: Gate [tier: mechanical]

**Files:** none changed.

- [ ] **Step 1: Build.** Run `pnpm build`. Expected: exit 0.
- [ ] **Step 2: Package suite.** Run `pnpm --filter @ax/auth-better test` with `DOCKER_HOST` set explicitly (CLAUDE.md). Expected: every file passes, including the 2 new tests. If no local daemon is reachable, run the new file alone (Task 1 Step 2's command). Then say in the PR body that the Docker-backed files ran only in CI. Don't call the package suite green.
- [ ] **Step 3: No path left in a log.** Run `git grep -n "req\.path\|rawPath\|err\.message" -- packages/auth-better/src ':!packages/auth-better/src/__tests__'`. Expected: only the URL build (`const url = …${req.path}…`, `:718`), comment lines, and `sendValidationError`'s 400 body (`message: err.message`, `:1012`, a response, not a log). None is a `stderr`/`console`/logger call.
- [ ] **Step 4: PR body.** Include the red output from Task 1 Step 2, the security-checklist note, "no hook change, no boundary review", and the follow-ups from decisions row 6.
