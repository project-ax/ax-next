# TASK-1016 Download Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three fixes to the streamed /files download. A client that stops reading gets disconnected. A cut-off body is never recorded as a complete 200. Anything that goes wrong before the head goes out is answered with a status. The Files tab's failure copy also stops claiming a deleted file is still there.

**Architecture:** `@ax/http-server`'s `bodyStream()` pump arms a per-wait idle timer while it is blocked on the client: the `drain` wait and the `finish` wait. `http:response-sent` gains `incomplete`. channel-web's `sendUserFileDownload` moves every check it can still answer in words (the first range's byte count, and a one-range file's final validation) ahead of its first `res.header()`.

**Tech Stack:** TypeScript, Node 24 `node:http`, vitest, React (copy only).

**Spec:** card TASK-1016. Background: `docs/plans/2026-10-29-agent-files-simplification-design.md` §4 "As built (TASK-1014)". Decisions with rationale and alternatives: `.claude/memory/decisions/2026-11-01-TASK-1016.md`, and TASK-1014's shard next to it.

## Global Constraints

- Idle window default **60 000 ms**. Plugin option `bodyStreamIdleTimeoutMs` is the only knob. No env var.
- New failure code spelled exactly `'client-stalled'`. New event field spelled exactly `incomplete: boolean` (required). New route answer: **409 `{ error: 'file-changed' }`**.
- Logs carry the agent id, a reason and error **codes** only. Never a path, filename, byte or error message.
- Invariant 2: channel-web reads the failure `code` duck-typed and never imports `@ax/http-server` from `src/` (tests already may).
- Do NOT edit `AgentView.tsx`, `AgentConversation.tsx`, `GeneratedFileChip.tsx`, `AgentFiles.tsx` or `agent-runner-core` (TASK-1019 is in flight there).
- Copy follows CLAUDE.md voice: short sentences, plain words, honest about what we don't know.
- Out of scope (decided, see shard): client stream-to-disk, HTTP `Range`, an agent-files status route, slicing writes below one chunk.
- Gate (CLAUDE.md, both traps): `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`. Package runs: `pnpm --filter @ax/http-server test`, `pnpm --filter @ax/channel-web test` (`--filter` BEFORE the script).

## Review Focus

1. A kept-alive connection reused after a finished download must not be killed by a leftover idle timer. Test: Task 1, step 6.
2. A slow source (a range read taking longer than the window) is not a stalled client. Test: Task 1, step 6.
3. A stall while the held final chunk is flushing (the `end()`/`finish` wait, not `drain`) is cut too. Test: Task 1, step 6.
4. An error answer sent before the head carries none of the download's headers (agent-authored filename in `content-disposition`, octet-stream type). Test: Task 2, step 1.
5. A 0-byte file still downloads through the new one-range path. Test: Task 2, step 1.

---

### Task 1: `@ax/http-server` — `incomplete` on `http:response-sent`, and the `bodyStream()` idle window  [tier: sensitive]

Needs `security-checklist` (HTTP surface, untrusted client behaviour, resource exhaustion, timers). Needs boundary review (subscriber payload change). The answers are at the end of this plan.

**Files:**
- Modify: `packages/http-server/src/plugin.ts`: constants and stale comment `:48-54`, options `:56-72`, `handle()` call `~:249`, `handle()` fire sites `:394-408`, `:523-568`, `ResponseWriter` `:660-1019`
- Modify: `packages/http-server/src/types.ts`: `bodyStream` doc `:91-133`, `BodyStreamFailureCode` `:146`, `HttpResponseSentEvent` `:260-268`
- Test: `packages/http-server/src/__tests__/body-stream.test.ts`, plus one assertion in `packages/http-server/src/__tests__/plugin.test.ts`

**Interfaces (Produces):**
- `HttpResponseSentEvent { status: number; durationMs: number; incomplete: boolean }`
- `BodyStreamFailureCode = 'client-gone' | 'client-stalled' | 'source-failed' | 'length-mismatch'`. Message: `'the client stopped reading, so the body was cut off'`.
- `CreateHttpServerPluginOptions.bodyStreamIdleTimeoutMs?: number`. Default `BODY_STREAM_IDLE_TIMEOUT_MS = 60_000` (module constant beside `HEADERS_TIMEOUT_MS`). Anything other than a positive safe integer → `createHttpServerPlugin` throws `TypeError`.

**Cycle A: `incomplete`**

- [ ] **Step 1: Failing tests.** In `body-stream.test.ts`:
  - Extend `'http:response-sent fires once with status 200 after a streamed body'` with `expect(events[0]!.incomplete).toBe(false)`.
  - Add `it('a body torn after its head is reported incomplete, with the status it was given')`. The source yields `MiB` bytes, then throws, with contentLength `2 * MiB`. Await the outcome. Then `vi.waitFor` one event, and `expect(events).toEqual([{ status: 200, durationMs: expect.any(Number), incomplete: true }])`.
  - In `plugin.test.ts`'s `'http:response-sent observer fires with status + durationMs'`, add `expect((observed[0] as { incomplete?: boolean }).incomplete).toBe(false)`.
- [ ] **Step 2:** `pnpm --filter @ax/http-server test`. Expected: the new assertions FAIL (`incomplete` undefined).
- [ ] **Step 3: Implement.**
  - Add `incomplete` to `HttpResponseSentEvent`, documented as follows. True when `bodyStream()` cut the connection: a failure after the head, a client that stalled or left (including before the head), or any other teardown. The client then holds less than Content-Length promised, and `status` may never have reached it whole. False for `stream()` (no promised length) and for the single-shot terminators (Node is handed the whole body at once, and nothing tracks it after that).
  - Add `incomplete = false` to `ResponseWriter`. Set it `true` in `sendSizedBody`'s catch, right where it calls `res.destroy()`.
  - In `handle()`: `finish()` and the streaming path fire `incomplete: false`. The main path fires `writer.incomplete`. The required field makes tsc find every fire site.
- [ ] **Step 4:** Re-run the package tests. Expected: PASS.
- [ ] **Step 5: Commit** `[TASK-1016] http-server: http:response-sent says when a sized body was cut off (incomplete)`.

**Cycle B: idle window**

- [ ] **Step 6: Failing tests.** In `body-stream.test.ts`, add an outer-scope `let idleMs: number | undefined`. The existing `beforeEach` spreads `...(idleMs !== undefined ? { bodyStreamIdleTimeoutMs: idleMs } : {})` into `createHttpServerPlugin`. Then add a `describe('idle window')` NESTED inside `describe('res.bodyStream()')`, with `beforeAll(() => { idleMs = 200; })` and `afterAll(() => { idleMs = undefined; })`. Nesting it keeps `serveBody` and `rawGet` in reach. A sibling describe would need its own server. For paused clients, copy the pause / assert-server-side / `resume()` pattern of `'backpressure: a paused client stops the source being pulled'`. With the client paused, a closed connection is invisible to it until it reads.
  1. `it('a client that stops reading is cut after the idle window: client-stalled, source released, reported incomplete')`. The source lazily yields one reused `Buffer.alloc(MiB)` up to 1024 times (contentLength `1024 * MiB`), counting pulls and recording `return()`. The client pauses in `onResponse`, with `deadlineMs: 10_000`. Asserts:
     - `await outcome` matches `{ code: 'client-stalled' }`, and `return()` was called.
     - Pulls `< 1024`.
     - There is exactly one event, and it is `{ status: 200, incomplete: true }` (with `durationMs: expect.any(Number)`).
     - Then `paused.resume()`. The client result has `timedOut === false`, `complete === false` and `body.length < 1024 * MiB`.
  2. `it('a stall while the final chunk flushes is cut too')`. The source yields ONE `randomBytes(32 * MiB)` chunk, which is held and then `end()`ed. The client is paused. Assert the outcome matches `{ code: 'client-stalled' }`.
  3. `it('the idle window runs only while the client holds things up: a slow source is not a stalled client')`. The source yields three 64 KiB chunks, each after `await sleep(400)`, against a 200 ms window. The client reads normally. Asserts: outcome `'resolved'`, the body is byte-identical, and the event has `incomplete: false`.
  4. `it('the idle timer dies with the body: the kept-alive connection serves the next request')`. Use its own `new http.Agent({ keepAlive: true, maxSockets: 1 })` and plain `http.get`, not `rawGet`. Make a 2 MiB GET and read it fully, then `await sleep(400)`. A second GET on the same agent must answer 200, read complete, with `req.reusedSocket === true`.
  5. `it('refuses a bodyStreamIdleTimeoutMs that is not a positive safe integer')`. Use `it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])`. `createHttpServerPlugin({ host: '127.0.0.1', port: 0, cookieKey: COOKIE_KEY, allowedOrigins: [], bodyStreamIdleTimeoutMs: v })` throws `TypeError`.
- [ ] **Step 7:** Run. Expected: 1, 2 and 5 FAIL (1 and 2 hang until `deadlineMs`). 3 and 4 pass, and they pin the design against later regressions.
- [ ] **Step 8: Implement.**
  - Validate the option in `createHttpServerPlugin` and thread the resolved value through `handle()` into `new ResponseWriter(...)`.
  - `drainOrClose()` becomes `drainOrStall()`. It resolves on `drain`/`close`, as today. After the window with neither, it rejects `new BodyStreamError('client-stalled')`.
  - `endAndAwaitFinish()` gets the same timer beside its `finish`/early-`close` pair.
  - In both waits, one settle function clears the timer and removes every listener. The timer callback ONLY rejects. Never arm a timer around `it.next()`. The existing catch already does the teardown.
- [ ] **Step 9: Docs in code.**
  - `types.ts` `bodyStream` doc: add an idle-window paragraph. The window applies only while waiting on the client, and is fresh per wait. Progress is counted one write at a time, so at the default a client must take each chunk (1 MiB for /files) within 60 s, which works out to about 17 KiB/s. Then `'client-stalled'` in the code list.
  - Add one sentence: a failure before the head still tears the connection down, so a caller that wants to answer in words checks before calling, as channel-web's `sendUserFileDownload` does.
  - Stale fix `plugin.ts:48-51`: these three timeouts bound receiving the request, not sending the response. A sized body's stalled reader is bounded by `bodyStream()`'s idle window. `stream()` responses are not bounded here.
- [ ] **Step 10:** Run `pnpm --filter @ax/http-server test && pnpm --filter @ax/http-server build`. Expected: PASS, and tsc clean.
- [ ] **Step 11: Commit** `[TASK-1016] http-server: cut a bodyStream() client that stops reading (60 s idle window, client-stalled)`.

### Task 2: channel-web: answer before the head whatever can still be answered; log `client-stalled`  [tier: sensitive]

Needs `security-checklist`: the integrity of agent-authored bytes (a torn file must never look whole), and error answers carrying none of the download headers.

**Files:**
- Modify: `packages/channel-web/src/server/user-file-download.ts`: header `:20-45`, adapter doc `:104-113`, `sendUserFileDownload` `:146-248`, `sameFile` `:376-398`, `IncompleteReason`/`incompleteOutcome` `:420-440`
- Test: `packages/channel-web/src/__tests__/server/routes-workspace-download.test.ts`

**Interfaces:**
- Consumes: Task 1's failure code string `'client-stalled'` (duck-typed).
- Produces: route answer `409 { error: 'file-changed' }` (Task 3 writes its sentence). `isSameFile(answer: ReadUserFileRangeOutput, first: FileAnswer, offset: number, length: number): answer is FileAnswer` (module-private). `sameFile` keeps its signature and throws when `isSameFile` is false.

- [ ] **Step 1: Failing tests** (unit `download()`/`mkRes()` section unless noted):
  - Move `'a short FIRST chunk …'` out of `CHANGES` into `it('a short FIRST range is answered 409 file-changed, with none of the download headers')`. Asserts:
    - `statusCode` 409, `json` `{ error: 'file-changed' }`, `contentLength` null.
    - `headers['content-disposition']` and `headers['content-type']` both undefined.
    - `rangeCalls` length 1, and `logs` `[]`.
  - Add `it.each` `'a one-range file whose final check finds $label is answered $status before the head'`. Use a 3-byte `small.txt` and tamper only the `{ offset: 3, length: 0 }` call. Every case has `contentLength` null, no `content-disposition`, and `rangeCalls` length 2. The cases:
    - version change → 409 `file-changed`, `logs` `[]`.
    - size change → 409 `file-changed`, `logs` `[]`.
    - `{ kind: 'dir' }` → 400 `not-a-file`, `logs` `[]`.
    - `{ kind: 'absent' }` → 404 `file-not-found`, `logs` `[]`.
    - a thrown `PluginError` code `unknown` with an `EIO` cause → 503 `file-read-failed`. `logs` is one warn `workspace_user_file_download_read_failed` with `{ agentId: 'a1', code: 'unknown', causeCode: 'EIO' }`. Copy the cause shape from `'REGRESSION: an EACCES read is a 503'`.
    - a thrown `PluginError` code `user-files-download-unavailable` → 503 `user-files-unavailable`.
  - Add `it('serves a one-range file whole after its final check, which runs before the head')`. Record `rangeCalls.length` inside the fake's `status()` call. It must be 2 when `status(200)` is called. Also `complete` true and the body is byte-identical.
  - Add `it('serves an empty file: its final check, then a zero-length body')`: `statusCode` 200, `contentLength` 0, `complete` true, `rangeCalls` length 2.
  - Add `it('a client cut off for stalling is logged as client-stalled, at info')`. Use `mkRes({ failWith: Object.assign(new Error('stalled'), { code: 'client-stalled' }) })` on the 3 MiB `live.log`. `logs` equals `[{ level: 'info', msg: 'workspace_user_file_download_incomplete', bindings: { agentId: 'a1', reason: 'client-stalled' } }]`.
  - Over the wire (the `boot()` section), add `it('a one-range file that changes before its final check is a 409 over the wire, never a reset')`. Add a small file to its files map and tamper its `length === 0` call to `version: v('v2')`. Asserts:
    - `rawGet` gives `timedOut` false, `status` 409, `complete` true.
    - `headers['content-disposition']` undefined.
    - `JSON.parse(body)` equals `{ error: 'file-changed' }`.
  - The remaining `CHANGES` cases (3 MiB, torn after the head) stay as they are and must still pass.
- [ ] **Step 2:** `pnpm --filter @ax/channel-web test -- routes-workspace-download`. Expected: the new cases FAIL. The short-first-range case gets 200 plus `source-failed`, and the one-range cases reach `bodyStream`.
- [ ] **Step 3: Implement** in `sendUserFileDownload`. After the ceiling check and before `res.status(200)` and any `res.header()`:
  - If `first.bytes.byteLength !== Math.min(USER_FILE_DOWNLOAD_CHUNK_BYTES, first.size)`, answer 409 `file-changed`.
  - If `first.size <= USER_FILE_DOWNLOAD_CHUNK_BYTES`, `await range(first.size, 0)` now:
    - A throw goes to the same handling as the first read: one shared helper for both, giving the warn log plus 503 `user-files-unavailable` or `file-read-failed`.
    - A non-`file` answer is mapped exactly as the first answer is, by one shared helper:
      - not an object → 503 `file-read-failed` plus the `invalid-answer` warn.
      - `unavailable` → 503 `user-files-unavailable`.
      - `absent` → 404 `file-not-found`.
      - `dir` → 400 `not-a-file`.
    - A `file` answer that fails `isSameFile(last, first, first.size, 0)` → 409 `file-changed`.
  - The body is then a one-shot source yielding `first.bytes` for a one-range file, and `wholeFile(range, first)` otherwise (unchanged).
  - `IncompleteReason` gains `'client-stalled'`. `incompleteOutcome` returns `{ reason: 'client-stalled' }` for that code, and it logs at info beside `client-gone`/`changed`.
- [ ] **Step 4: Docs in code.**
  - Header "A FILE THAT CHANGES UNDER THE DOWNLOAD": a difference tears the body down only once the head is out. Before that (the first range, or a one-range file's final check) it is answered: 409, or 404 if it is gone.
  - Stale fix `:31` "WHAT THE STATUS CODES MEAN": add `changed before the head → 409 file-changed`. The list now really is everything decided before the first byte.
  - Adapter doc `:109-112`: add `'client-stalled'`.
- [ ] **Step 5:** Run `pnpm --filter @ax/channel-web test -- routes-workspace` (the conversation-file chip route shares this function), then `pnpm --filter @ax/channel-web build`. Expected: PASS.
- [ ] **Step 6: Commit** `[TASK-1016] channel-web: a download that fails before its head answers 409/404/503, never a reset`.

### Task 3: Files-tab copy and as-built docs  [tier: mechanical]

**Files:**
- Modify: `packages/channel-web/src/lib/file-download.ts:60-103`
- Test: `packages/channel-web/src/lib/__tests__/file-download.test.ts`
- Modify: `docs/plans/2026-10-29-agent-files-simplification-design.md` (new bullet after `:120`; chip answers `~:384-388`)
- Modify: `docs/plans/2026-05-24-current-architecture.md:487-489`

**Interfaces:** Consumes Task 2's 409 `file-changed`, which the client matches on status only.

- [ ] **Step 1: Failing tests** in `file-download.test.ts`:
  - `it('a 409 says the file changed while we were getting it, and to try again')`. The message for `new HttpError('/x', 409)` contains `'changed'` and `'Try again'`, and does not contain `'file-changed'`.
  - `it('the fallback never claims the file is still there: after a mid-download deletion it is not')`. Check two errors: `new TypeError('network error')` and `new HttpError('/x', 500)`. Neither message contains `'still there'`. Both contain `'deleted'` and `'nothing was saved'`.
- [ ] **Step 2:** `pnpm --filter @ax/channel-web test -- file-download`. Expected: FAIL.
- [ ] **Step 3: Implement** in `downloadFailureMessage`. This is exact copy:
  - 409: `That file changed while we were getting it, so we stopped rather than hand you a mix of old and new. Try again in a moment.`
  - Fallback (stale fix `:102`): `That download didn't finish, so nothing was saved. The connection may have dropped, or the file changed or was deleted on the way. Try again in a moment.`
  - Update the doc comment: "Four outcomes, four sentences" becomes five. The paragraph at `:70-72` should say three things: a change found before the first byte is a 409 with its own sentence; a break after it lands on the fallback; the fallback does not claim the file survived.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5: Docs.**
  - Design doc: add a bullet after "As built (TASK-1014)":

    `- **As built (TASK-1016):** a download whose client stops reading is cut after 60 s without progress (\`bodyStream()\`'s idle window, \`client-stalled\`). What fails before the head is answered: a short first range, or a one-range file failing its final check, is 409 \`file-changed\` (404 if gone). \`http:response-sent\` carries \`incomplete: true\` for a cut-off body, so a torn download is never recorded as a complete 200. Browser stream-to-disk and HTTP \`Range\` stay deferred.`
  - In the chip paragraph's answer list, add `409 \`file-changed\` when it changed before the first byte` after the 503 clause.
  - `current-architecture.md:487-489`: the parenthetical gains `a 60 s idle window for a client that stops reading` and `\`http:response-sent\` reports a cut-off body \`incomplete\``. The ceiling sentence gains `a change found before the head is a 409 \`file-changed\``.
- [ ] **Step 6: Commit** `[TASK-1016] Files tab: say a broken download saved nothing (no "still there"); 409 copy; as-built docs`.

## Finish

- [ ] Full gate (see Global Constraints). Expected: all green. Also `pnpm --filter @ax/http-server build` and `pnpm --filter @ax/channel-web build`, which run tsc.
- [ ] PR description:
  - Run the `security-checklist` skill note for Tasks 1 and 2:
    - Resource exhaustion: a stalled reader is now bounded at 60 s. Source waits are bounded by the 30 s bus timeout. There are no new buffers.
    - Untrusted content: bytes stay octet-stream, attachment, nosniff. A pre-head error is fixed JSON with no download headers. Logs carry codes only.
    - Sandbox escape: N/A, because confinement is untouched.
    - Supply chain: no new deps.
  - Paste the boundary review below.
  - Out of scope: client stream-to-disk (needs the product owner's pick among Save-As / Service Worker / native download), HTTP `Range`, and slicing writes to under one chunk.

**Boundary review (`http:response-sent`):**
- *Alternate impl:* an HTTP/2 or serverless adapter. It knows a cut-off body as a stream reset.
- *Leaky field names:* none. `incomplete` is HTTP-generic, with no `destroyed`/`socket`/`writableFinished`.
- *Subscriber risk:* there are no production subscribers today (`git grep "http:response-sent"`: tests only). From now on, success means `!incomplete`, not `status === 200`.
- *Wire surface:* none. Not an IPC action.
