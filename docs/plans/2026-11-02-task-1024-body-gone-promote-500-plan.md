# TASK-1024 — body readers settle on gone requests; promote maps host faults to 500

Follow-ups from TASK-1018 (#1102). Two independent fixes, each test-first.

## Probe (before any change, against the built `dist/body.js` of 29eb61a51)

Every shape below returned `HUNG` (no settle within 300 ms) for `readJsonBody`, and the
first for `readRawBody` too:

1. request destroyed before the read (no error)
2. request destroyed with an error before the read
3. request already ended before the read
4. request destroyed AFTER the listeners attached, with no error — **not named by the card**:
   the readers listen for `data` / `error` / `end` only, and a bare `destroy()` emits `close`
   and nothing else.

## Task 1 — `@ax/ipc-core` body.ts  `[tier: integration]`

- One shared guard, `bodyGoneError(req)`, called first in both readers. It checks in this
  order. (a) `req.errored`: reject with it, so stream errors still propagate unchanged, as the
  existing test pins. (b) `req.readableEnded`: the bytes were already consumed, so reject
  with a fixed-text "ended" Error. (c) `req.destroyed`: reject with a fixed-text
  "destroyed" Error. Ended goes before destroyed because a request auto-destroys right
  after `end`. Round-1 review caught the original destroyed-first order, which made
  the ended branch unreachable. The dispatcher
  already maps a non-size, non-JSON failure to the structured `ipc_body_read_failed` log
  plus a 500 (TASK-1018), so nothing changes there.
- Both readers also listen for `close`. If the reader has not settled when `close` fires,
  it rejects. Normal flow is `end` and then `close`, and the `settled` latch makes the late
  `close` a no-op.
- Tests in `body.test.ts`, for both readers: pre-destroyed, pre-errored (rejects with that
  same error), pre-ended, and destroyed-after-attach. Each one runs under a timeout race,
  so a regression reads as a hang failure, not a vitest timeout.

## Task 2 — `@ax/agents` admin-routes.ts promote  `[tier: integration]`

- In the `skills:upsert` catch: keep `writeServiceError` (forbidden / not-found /
  invalid-payload). Then send a 400 with `{ error, code }` ONLY for
  `err instanceof PluginError && MANIFEST_CODE_SET.has(err.code)`. Anything else (other
  PluginErrors and non-PluginErrors) is logged as `ctx.logger.error('agents_admin_promote_failed',
  { agentId, skillId, targetScope, err })` and answered with `500 { error: 'internal' }`, the
  generic body the http-server catch-all uses. Fix the stale comment that names
  invalid-host / invalid-slot / invalid-mcp-command.
- Test: a new Docker-free unit test that stubs `auth:require-user`,
  `agents:list-authored-skills` and `skills:upsert` through `createTestHarness`. It covers
  three things. A host fault (`PluginError` code `missing-owner`, plus a plain `Error`)
  returns 500, the body does not echo the message, and the log line is emitted. Every
  `MANIFEST_CODES` code returns 400 with its code. `invalid-payload` still returns 400.

## Boundary review

No hook signature changes. No new hooks. Internal implementation only.

## YAGNI pass

- A named error class for "body gone": no. The dispatcher doesn't branch on it, so it would
  be an export nobody reads.
- The http-server's own `readBodyCapped` has the same `close`-only gap. That's out of scope
  (a different plugin), so it goes back as a follow-up.
