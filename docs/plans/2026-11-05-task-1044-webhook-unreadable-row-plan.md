# TASK-1044: an unreadable routine refuses its webhook deliveries quietly, and no 5xx log carries a path token

Decisions and their alternatives: `.claude/memory/decisions/2026-11-05-TASK-1044.md`.

## Premise check (at 2739cb157)

- The throw is in the store, not in `webhook-handler.ts`: `findWebhookByToken`
  (`webhook-address.ts:39-43`) and `findWebhook` (`store.ts:1179-1184`) map the row
  through the strict `rowToRoutine`. The handler awaits both with no catch, so a
  ZodError reaches http-server's fallback.
- http-server's fallback (`plugin.ts:525-529`) writes
  `handler error on ${method} ${path}: ${err.message}`: the raw path (with the
  `rt_…` token) and the ZodError text. The outer `.catch` (`plugin.ts:288-292`)
  writes `err.message` too.

## Tasks

1. **[tier: integration] Store lookups answer unreadable rows.**
   - Test first (`webhook-router.test.ts`): a task-address delivery and a
     legacy-address delivery to a row whose `name` is too long (TASK-913's fixture)
     answer 404 without throwing; the only routing log line is
     `routines_webhook_routine_unreadable` `{ agentId, routineId, issuePath: 'name', issueCode: 'too_big' }`;
     nothing written to stdout/stderr contains the token. A wrong path under the
     same token answers 404 with no log line.
   - `webhook-address.ts`: helpers take `readRoutineRow`; `findWebhookByToken`
     returns `UnreadableWebhookRoutine` when the stored path matches or isn't a
     string. `store.ts`: `findWebhook` the same. Export the type.
   - `webhook-handler.ts`: an unreadable row logs once and answers 404.
2. **[tier: integration] http-server's handler-error line is code-only.**
   - Test first (`plugin.test.ts`): a pattern route `/hooks/:token/*` that throws an
     Error whose message carries a marker answers 500 and writes one stderr line
     naming the pattern and `name`, with neither the fake token nor the marker.
   - `router.ts`: `MatchResult.route` (registered path or pattern).
     `plugin.ts`: log `${method} ${route}` + `faultLogFields(err)`; the outer catch
     logs `faultLogFields(err)` only.
3. **[tier: mechanical] Gate**: build, routines + http-server tests, lint, tsc.
   Prove each new test red against the unfixed code (commit, mutate, restore with git).

Security-checklist: required (log redaction on an untrusted-input path, capability token).
