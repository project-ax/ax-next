# TASK-1022 Native Anchor Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A /files download (from the Files tab, or from an agent-file chat chip) streams straight to disk through the browser's own download, so the tab never holds the file. Anything the route would refuse before its first byte is still said in words, in-page.

**Architecture:** Both download routes get a probe mode. `?probe=1` runs `sendUserFileDownload` exactly as a real download would, right up to the point where it would send the head. It then answers `200 {downloadable: true}` instead of the headers and body. The client probes first and shows the existing sentence if the probe is refused. Otherwise it clicks a same-origin `<a href={route} download="">` and leaves the filename to the route's sanitized `Content-Disposition`. Attachment chips (`/api/files`) are not touched.

**Tech Stack:** TypeScript, React, vitest + jsdom (client), vitest + `node:http` (server).

**Spec:** card TASK-1022. This is Vinay's call from 11-02: a native anchor plus an in-page pre-flight, with mid-stream failures left to the browser's download bar. Background is in `docs/plans/2026-10-29-agent-files-simplification-design.md` §4, "As built (TASK-1014/1016)". Decisions are in `.claude/memory/decisions/2026-11-02-TASK-1022.md`, with the TASK-1014/1016/1017 shards beside it.

## Global Constraints

- **Probe flag.** It is the query key `probe`, and any value counts (`req.query['probe'] !== undefined`; the router lowercases keys). The anchor URL never carries it.
- **Probe success.** The answer is **200 `{ downloadable: true }`** as JSON. It has no `content-disposition` and no octet-stream type, and `res.bodyStream()` is never called.
- **Probe caching.** Every probe answer carries `cache-control: private, no-store`, including the ACL's answers.
- **Probe refusals.** They are exactly the download's own pre-head answers:
  - 401
  - 404 `agent-not-found` | `file-not-found`
  - 400 `invalid-path` | `not-a-file`
  - 409 `file-changed`
  - 413 `file-too-large`
  - 503 `user-files-unavailable` | `file-read-failed`
- **No HEAD.** `@ax/http-server`'s `HttpMethod` has no HEAD (`types.ts:4`), and it answers a HEAD request with 405 (`plugin.ts:440`). Do not edit `@ax/http-server`.
- **The anchor's `href`.**
  - It is the root-relative route string, and each variable part is one `encodeURIComponent` segment. The key is encoded WHOLE, slashes included.
  - Build it inside the `try`, because `encodeURIComponent` throws `URIError` on a lone surrogate.
  - The `download` attribute is present and empty.
  - The href is never an agent-authored URL.
- **Limits.** `USER_FILE_DOWNLOAD_MAX_BYTES` stays at 1 GiB. No HTTP `Range`. No new dependency.
- **Invariant 2.** channel-web `src/` still imports no plugin. The route reads `req.query` off the duck-typed `RouteRequest` (`routes-chat.ts:100`).
- **Copy.** The only copy change is the Files-tab fallback sentence in Task 2, exactly as written there.
- **Out of scope** (decided, see the shard):
  - attachment-chip downloads (`/api/files?id=`)
  - HEAD
  - a status route for the agents scope
  - a canary change
  - cancelling the probe's body
  - HTTP `Range`
  - raising the ceiling
- **Gate** (CLAUDE.md, both traps): `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- **Package run:** `pnpm --filter @ax/channel-web test` (put `--filter` BEFORE the script). channel-web's `tsc --build` also type-checks its tests, so run `pnpm --filter @ax/channel-web build` after each task.

## Review Focus

1. **Parity.** For every refusal, a probe answers exactly what the download would answer before its head. It is one code path, so the two cannot drift. Test: Task 1, step 1 (parity table).
2. **No oracle.** A probe on someone else's agent or conversation gets the same 404 a download gets, with zero range reads. Test: Task 1, step 1.
3. **No bytes in the tab.** The client never reads a /files download's bytes in-page, so no `res.blob()` and no `arrayBuffer()`. The only fetch is the probe. Test: Task 2, step 1, the hook test that runs through the real `workspaceApi` with `fetch` stubbed.
4. **Hostile key.** A key like `//evil.example/x?y#z` stays one encoded segment of a same-origin href. Test: Task 2, step 1.
5. **Refusals and bad keys.** A refused probe clicks nothing and shows the existing sentence. A malformed key shows the generic sentence, not a crash. The existing chip test for that (`GeneratedFileChip.test.tsx:165`) must stay green. Test: Task 2, step 1.

---

### Task 1: Server — `?probe=1` on both download routes  [tier: sensitive]

Needs `security-checklist`: an authenticated route that serves agent-authored bytes, with ACL-first ordering and a new query mode. Boundary review is N/A, since no hook or IPC signature changes. Pre-filled answers are at the end of this plan.

**Files:**
- Modify `packages/channel-web/src/server/user-file-download.ts`:
  - module header `:1-67`. Line 5's "chips will too" is stale. Also add the probe to "WHAT THE STATUS CODES MEAN" at `:39-58`.
  - ceiling doc `:86-93` (line `:89` is stale)
  - `SendUserFileDownloadArgs` `:139-155`
  - `sendUserFileDownload` `:164-260`. The new branch goes right before `res.status(200)` at `:221`.
- Modify `packages/channel-web/src/server/routes-workspace.ts`:
  - file header `:21-27`
  - `agentUserFileDownload` doc and handler `:7929-7992`. Lines `:7949-7950` ("a long download the tab cannot hold") are stale.
  - `conversationAgentFileDownload` `:7993-8029`
- Test: `packages/channel-web/src/__tests__/server/routes-workspace-download.test.ts` and `packages/channel-web/src/__tests__/server/routes-workspace-conversation-file.test.ts`.

**Interfaces (Produces):**
- `SendUserFileDownloadArgs.probe?: boolean`. When true, every check runs as it would for a download. At the point where the download would set its status and headers, the helper instead answers `res.status(200).json({ downloadable: true })` and returns. It never sets the download headers and never calls `res.bodyStream()`.
- Wire: `GET /api/workspace/agents/:agentId/download/user-files/*?probe=1` and `GET /api/workspace/conversations/:conversationId/download/user-files/*?probe=1`.

- [ ] **Step 1: Failing tests.**
  - **Setup.** In the direct-handler describe of `routes-workspace-download.test.ts`, give `mkReq` an optional second argument, `query: Record<string, string> = {}`. Beside `download()`, add a helper `probeDownload(splat, d = mkRes())` that passes `{ probe: '1' }`. Don't call it `probe`: the socket describe already has a range spy by that name.
  - **Parity table.** Add `it.each` `'a probe answers $label exactly as the download does, with no body'`.
    - Each row runs the download and the probe on the same fixture. It expects equal `statusCode`, equal `json`, and equal `rangeCalls` offsets and lengths. The probe's chunks are empty, and its headers have no `content-disposition`.
    - Rows:
      - absent → 404 `file-not-found`
      - dir → 400 `not-a-file`
      - over the ceiling → 413 `file-too-large`
      - `unavailable` → 503 `user-files-unavailable`
      - thrown read → 503 `file-read-failed`
      - no range service → 503 `user-files-unavailable`
      - short first range → 409 `file-changed`
      - a one-range file whose final check sees a new version → 409
  - **Probe success.** Add `'a probe of a file that would download answers 200 { downloadable: true } and sends none of the download'`.
    - For a 3 MiB file, expect:
      - `statusCode` 200 and `json` `{ downloadable: true }`
      - `headers['cache-control']` `'private, no-store'`
      - no `content-disposition`, and no octet-stream `content-type`
      - `vi.spyOn(d.res, 'bodyStream')` never called
      - range calls exactly `[{offset: 0, length: MiB}]`
    - For a 4-byte file, expect range calls `[{0, MiB}, {offset: 4, length: 0}]`.
  - **ACL first.** Add `'a probe runs the ACL first: a foreign agent is a 404 with no read, and every probe answer is no-store'`.
    - Unauthenticated → 401, with `cache-control` `private, no-store`.
    - A foreign agent with a malformed path → 404, not 400. No range calls, and `no-store` is set.
  - **Over the wire.** In the socket describe, add `'answers a probe over the wire: JSON, no download headers, the splat without the query'`.
    - `GET ${DOWNLOAD}/notes%2Fplan.bin?probe=1` → 200, `content-type` matches `/^application\/json/`, no `content-disposition`, body `{ downloadable: true }`. The range spy sees only `relPath: 'notes/plan.bin'`.
    - `?probe=1` on a missing file → 404 `{ error: 'file-not-found' }`.
  - **Chip route.** In `routes-workspace-conversation-file.test.ts` (its `mkReq` already takes a `query`), add `'the chip route forwards a probe: 200 { downloadable: true }, no body, and a foreign conversation is still a 404 with no read'`.
- [ ] **Step 2:** Run `pnpm --filter @ax/channel-web test -- routes-workspace-download routes-workspace-conversation-file`. Expected: the new tests FAIL. Today a probe streams the file: 200 with `content-disposition` and chunks.
- [ ] **Step 3: Implement.**
  - **`sendUserFileDownload`.** Destructure `probe`. Immediately before `res.status(200)`, add `if (probe === true) { res.status(200).json({ downloadable: true }); return; }`. Nothing else in the function changes. The doc comment on `probe` should say why it exists: the client asks first because the browser's download bar can say none of these answers.
  - **Both route handlers.**
    - First line: `const probe = req.query['probe'] !== undefined;`.
    - Before `authOr401` / `chipFileOr404`, add `if (probe) res.header('cache-control', 'private, no-store');`. This mirrors `conversationAgentFileStatus`.
    - Pass `probe` through to `sendUserFileDownload`.
  - **Stale prose.**
    - `user-file-download.ts:5`: both the Files tab's route and the chat chips' route use it.
    - `user-file-download.ts:89`: drop the "Files tab holds a download in memory" rationale. The ceiling bounds how long one download keeps a range reader busy. The browser now saves to disk itself (TASK-1022).
    - `routes-workspace.ts:7949-7950`: make no claim that the tab holds the file.
    - Headers `:21-27` and `:39-58`: add one line each for `?probe=1`: the same answers up to the first byte, then `200 {downloadable:true}` instead of the bytes.
- [ ] **Step 4:** Re-run step 2's command, then `pnpm --filter @ax/channel-web build`. Expected: PASS.
- [ ] **Step 5: Commit** `[TASK-1022] channel-web: ?probe=1 on the /files download routes answers the pre-head checks without the bytes`.

### Task 2: Client — probe, then a native `<a download>`  [tier: sensitive]

Needs `security-checklist`: an agent-authored key goes into an href, and agent-authored bytes reach the browser's download with no JS of ours in between. This task consumes Task 1's wire contract. Its tests stub `fetch`, so they don't depend on Task 1's code, but land Task 1 first.

**Files:**
- Modify `packages/channel-web/src/lib/file-download.ts`:
  - header `:1-33`
  - `saveBlob` doc `:38-45`
  - `downloadFailureMessage` doc and fallback `:60-108`
  - `FileDownloadState.start` doc `:113`
  - `useFileDownload` body `:150-157`
- Modify `packages/channel-web/src/lib/workspace-api.ts:1554-1588`: replace `downloadFile`.
- Modify `packages/channel-web/src/components/workspace/GeneratedFileChip.tsx`: doc `:12-27`, and `download()` `:90-114`.
- Test, all under `packages/channel-web/src`:
  - `lib/__tests__/file-download.test.ts`
  - `components/workspace/__tests__/AgentFiles.test.tsx`
  - `components/workspace/__tests__/AgentFilesCompact.test.tsx`
  - `components/workspace/__tests__/GeneratedFileChip.test.tsx`
  - `components/workspace/__tests__/TaskCheckinPage.test.tsx`

**Interfaces:**
- Consumes: Task 1's `?probe=1`. A 200 means go. Any other status is the download's own refusal.
- Produces:
  - **`saveFromUrl(url: string): void`**, in `lib/file-download.ts`. It creates an `<a>`, sets `href = url`, calls `setAttribute('download', '')`, sets `rel = 'noopener'`, appends it to `document.body`, calls `click()`, then `remove()`. Its doc says `url` must be a root-relative route this app built from encoded segments. The empty `download` leaves the name to the route's sanitized `Content-Disposition`.
  - **`workspaceApi.probeFileDownload(agentId: string, path: string): Promise<string>`**, replacing `downloadFile`.
    - `route = /agents/${enc(agentId)}/download/user-files/${enc(path)}`.
    - It calls `httpFetch('/api/workspace' + route + '?probe=1')`.
    - On a non-ok answer it throws `new WorkspaceApiError(route, res.status)`. On ok it returns `'/api/workspace' + route`.
    - It never reads the body.
  - **`saveBlob` stays**, for attachment chips only.
  - **`FALLBACK_SAVED_FILENAME` stays.** The chip uses it instead of its `'download'` literal.

- [ ] **Step 1: Failing tests.**
  - **`file-download.test.ts`: `workspaceApi.probeFileDownload`.** Replace `describe('workspaceApi.downloadFile')` with `describe('workspaceApi.probeFileDownload')`, covering:
    - (a) It fetches `'/api/workspace/agents/a%201/download/user-files/notes%2Fplan.md?probe=1'` and resolves to `'/api/workspace/agents/a%201/download/user-files/notes%2Fplan.md'`.
    - (b) A 413 rejects with `{ name: 'WorkspaceApiError', status: 413 }`, and the error message is not the response body.
    - (c) For the key `'//evil.example/x?y#z'`, it resolves to `'/api/workspace/agents/a1/download/user-files/%2F%2Fevil.example%2Fx%3Fy%23z'`, and `new URL(resolved, location.href).origin === location.origin`.
    - (d) The `blob`, `arrayBuffer` and `text` methods of the probe's Response, spied on the instance, are never called.
  - **`saveFromUrl`.** Add `describe('saveFromUrl')`, copying the `saveBlob` test's `createElement` spy. It clicks one anchor where:
    - `getAttribute('href')` is the given URL
    - `getAttribute('download') === ''`, with the attribute present
    - the resolved origin is `location.origin`
    - no `<a>` is left in the document afterwards
    - the `URL.createObjectURL` stub is never called
  - **`useFileDownload`, new test 1:** `'probes the route, then hands the route itself to the browser: the bytes never come into the tab'`. It runs through the REAL `workspaceApi`, with `fetch` stubbed to answer `200 {"downloadable":true}`. After `start()`:
    - `fetch` was called once, with the `?probe=1` URL
    - one anchor was clicked, with the route URL (no `?probe`) and an empty `download`
    - the `Response.prototype.blob` and `arrayBuffer` spies were never called
    - `error` is null and `busy` is false
  - **`useFileDownload`, new test 2:** `'a refused probe hands nothing to the browser'`. A 404 sets `error` to the 404 sentence, and no anchor is clicked.
  - **`useFileDownload`, existing tests.** Retarget the two existing guard tests from `downloadFile` to `probeFileDownload`, resolving a URL string.
  - *(Superseded in review round 1: only a probe with no answer at all — a `TypeError`, or status 0 — gets the connection sentence below; a 400 gets the 404 sentence, and a 5xx or a malformed key gets "That download didn’t start, so nothing was saved. Try again in a moment." See the decisions shard.)*
  - **`downloadFailureMessage`.** For status 0 and for 500, the fallback is exactly `That download didn’t start, so nothing was saved. The connection may have dropped. Try again in a moment.`
    - Rewrite `'the fallback never claims the file is still there…'`, because its mid-download premise is gone. It now asserts the sentence contains `didn’t start` and `nothing was saved`, and does not contain `still there`.
    - In `'has a sentence for a failure that was not an HTTP answer at all'`, `didn’t finish` becomes `didn’t start`.
  - **`AgentFiles.test.tsx`.**
    - In the mock factory, `downloadFile` → `probeFileDownload`. `downloadMock` now resolves a URL string.
    - In both `saved` spies (`:479`, `:673`), push `{ href: this.getAttribute('href'), download: this.getAttribute('download') }`.
    - Rewrite `'saves under the name the SERVER sanitized…'` as `'leaves the name to the server: the anchor is the route with an empty download attribute'`. It expects `[{ href: <the resolved URL>, download: '' }]`.
    - Change `/download didn’t finish/i` to `/download didn’t start/i`.
  - **`AgentFilesCompact.test.tsx`.** In its factory, `downloadFile` → `probeFileDownload`.
  - **`GeneratedFileChip.test.tsx`.**
    - The `vi.mock('@/lib/file-download')` factory gains `saveFromUrl: vi.fn()`, and the `beforeEach` clears it. `TaskCheckinPage.test.tsx`'s factory gets the same.
    - Rewrite `'downloads live through the conversation route…'` (`:121-139`). The fetch URLs are `[STATUS_URL, DOWNLOAD_URL + '?probe=1']`, both in conversation `c%20%26%201`. `saveFromUrl` is called once, with the download URL (no `?probe`). `saveBlob` is never called.
    - Leave the 404/400/413/503 tests (`:141-186`) as they are, since `chipFetch` routes the probe to `answers.download`. The attachment-chip tests (`:75-117`) stay on `saveBlob`.
- [ ] **Step 2:** Run `pnpm --filter @ax/channel-web test -- file-download AgentFiles GeneratedFileChip TaskCheckinPage`. Expected: the new tests FAIL for three reasons:
  - `probeFileDownload` and `saveFromUrl` don't exist.
  - The hook fetches the route without `?probe=1` and calls `res.blob()`.
  - The chip calls `saveBlob` for an agent file.

  The refusal-sentence tests pass both before and after. That is expected: they guard the behaviour that stays.
- [ ] **Step 3: Implement.**
  - **`useFileDownload.start`.** Inside the existing `try`: `saveFromUrl(await workspaceApi.probeFileDownload(agentId, path))`.
  - **The chip's `download()`.** Inside the existing `try`:
    - If `file.agentFilePath !== undefined`:
      - `const url = downloadUrl()`, then `httpFetch(url + '?probe=1')`.
      - On a non-ok answer, `throw new HttpError('file download', status)`.
      - On ok, `saveFromUrl(url)`.
    - Otherwise keep today's fetch + `saveBlob`, with `FALLBACK_SAVED_FILENAME` as the fallback name.
    - The catch block's sentences don't change.
  - **Fallback sentence** in `downloadFailureMessage`: exactly the string above.
  - **Delete** `workspaceApi.downloadFile` and its doc.
  - **Stale prose.**
    - Rewrite the `file-download.ts` header (`:1-33`) to cover four points. Why it's a native download now: the browser streams to disk, so the tab never holds the file (TASK-1022). Why the probe: the download bar can't say our sentences. What's left to the download bar: a failure after the first byte, and the gap between the probe and the download. And the filename still comes from the server.
    - Fix the `downloadFailureMessage` doc (`:66-75`): a mid-body failure no longer lands on the last sentence.
    - `start`'s doc becomes "Ask the route, then hand the download to the browser."
    - The `saveBlob` doc says only attachment chips use it now.
    - Add one sentence to the chip's header (`:12-27`): an agent file is probed and then saved by the browser's own download, while an attachment is still fetched in-page.
- [ ] **Step 4:** Re-run step 2's command, then `pnpm --filter @ax/channel-web build`. Expected: PASS.
- [ ] **Step 5: Commit** `[TASK-1022] channel-web: /files downloads go to the browser's own download after an in-page pre-flight`.

### Task 3: As-built docs  [tier: mechanical]

**Files:**
- Modify `docs/plans/2026-10-29-agent-files-simplification-design.md`. Lines `:128-129` are stale ("Browser stream-to-disk and HTTP `Range` stay deferred."). Also edit the chip paragraph at `:393-399`.
- Modify `docs/plans/2026-05-24-current-architecture.md:477-492`.

- [ ] **Step 1: Design doc.**
  - Lines `:128-129` become "HTTP `Range` stays deferred."
  - After the TASK-1016 bullet, add an `**As built (TASK-1022):**` bullet with four points:
    - The Files tab and agent-file chips save a /files download through the browser's own download: a same-origin `<a download>` to the route. The file streams to disk and the tab never holds it.
    - Before that, they ask the same route with `?probe=1`. It runs every pre-head check and answers `200 {downloadable:true}` in place of the bytes (`no-store`), so a refusal is said in-page.
    - A failure after the first byte, or a change between the probe and the download, shows in the browser's download bar.
    - Attachment chips still fetch in-page.
  - In the chip paragraph, note that its answers (404/400/409/413/503) now reach the chip through its probe.
- [ ] **Step 2: Architecture doc.** At the end of the "Agent file downloads stream" bullet, add: "The browser saves it natively (TASK-1022): the client asks `?probe=1` first (the same pre-head checks, a JSON 200 instead of the body), then clicks a same-origin `<a download>`."
- [ ] **Step 3:** Run `git grep -n -i "stream-to-disk\|stream to disk\|tab's memory\|tab cannot hold\|holds a download in memory" -- docs packages/channel-web/src`. Expected: no hit still claims the client buffers.
- [ ] **Step 4: Commit** `[TASK-1022] docs: as-built for native /files downloads`.

## Finish

- Run the gate from Global Constraints. Expected: green. The Docker-backed suites need `DOCKER_HOST` set (see CLAUDE.md).
- **500 MB acceptance on kind (optional).** It needs `make image`, because Task 1 is host-side and `make dev-fast` syncs only the SPA.
  1. Ask a test agent in chat to run `head -c 524288000 /dev/urandom > big.bin` in its files.
  2. In Chromium, through Playwright or DevTools' Performance monitor, note the JS heap.
  3. Open the Files tab, select `big.bin`, and click Download.
  4. Expect one `?probe=1` request answering a small JSON 200, then a download of the route that completes.
  5. Expect the heap not to grow by anything near 500 MB.
  6. Delete the file and click again. Expect the in-page 404 sentence, and no download.
- **Minimum evidence if kind is skipped:**
  - Task 2's hook test: one fetch (the probe), no `blob()`/`arrayBuffer()`, and the anchor points at the route.
  - Task 1's parity table and its over-the-wire probe test.
  - The existing 50 MiB wire test (`routes-workspace-download.test.ts:1435`), for server-side streaming.

  The PR leaves the 500 MB box unticked and says it was not run. Don't claim it.

## Security checklist — pre-filled for Tasks 1–2 (verify, don't copy)

- **Sandbox escape:** N/A. No sandbox, IPC or confinement code changes. The probe makes the same `sandbox:read-user-file-range` calls the download makes before its head, and the O_NOFOLLOW walk is unchanged.
- **Untrusted content:**
  - The agent-authored key reaches the href only as one `encodeURIComponent` segment after a fixed root-relative prefix. It cannot set a scheme, a host, a query or a fragment.
  - The browser now handles agent bytes with no JS of ours in between. So the 200's `application/octet-stream` + `nosniff` + `attachment` headers are what keep those bytes from rendering on our origin. Those headers are unchanged and test-pinned.
  - The filename is sanitized only on the server (`download=""`).
  - The probe runs after the same ACL and path validation, and answers only what the download would. It is not a new oracle, and it is `no-store`.
- **Supply chain:** no new dependency.
- **Capabilities:** no new fs, network, process or env reach. A probe reads at most the download's first range (1 MiB) plus one length-0 check.
- **Residuals for the PR note:**
  - **(a) The file changes or is deleted between the probe and the download.** The download then gets a pre-head 409 or 404, and the browser shows a failed download. Chromium treats a 4xx/5xx download as failed. Other engines are not verified here, and may save the small JSON error under the file's name.
  - **(b) Mid-body failures fail in the download bar.** The same goes for a download paused in the browser's UI for over 60 s, which the TASK-1016 idle window cuts. Resuming restarts from the beginning, because there is no `Range`.
  - **(c) A 409 reaches the page only when the change happens during the probe itself.**
