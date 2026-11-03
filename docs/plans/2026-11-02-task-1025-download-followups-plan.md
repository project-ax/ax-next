# TASK-1025 /files Download Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three things, through any proxy:

- No browser can save a refused /files download as the file.
- One click on Download starts one download, and the page says the download started.
- A chat chip's console line names its route.

**Architecture:**

- **The probe keeps its words.** `?probe=1` still says every refusal in words, in the page.
- **The real GET tears its refusals.** The real GET is the browser's own download. It answers with the file or with a *torn* refusal: the refusal's status and JSON head, all of its body except the last byte, then a cut connection.
- **How the tearing is wired.** A response wrapper in both download handlers does it, using `bodyStream()`'s documented failure path. `@ax/http-server` does not change.
- **The client side.** The download hook and the chat chip hold a 4-second "started" window after they hand a download to the browser.

**Tech Stack:** TypeScript, Node `http` through `@ax/http-server`'s duck-typed adapter, React with shadcn, and vitest (node and jsdom).

**Spec:** card TASK-1025.

- Background: `docs/plans/2026-10-29-agent-files-simplification-design.md` §4 (the TASK-1014/1016/1022 as-built bullets) and `docs/plans/2026-11-02-task-1022-native-anchor-download-plan.md`.
- Decisions: `.claude/memory/decisions/2026-11-02-TASK-1025.md`. They supersede residual (a) in the TASK-1022 shard.

## What the walk found, and what it changes

The builder ran the item 2 walk before this plan. The setup was an `<a download="">` click on a refused real GET, served by a local harness.

| Response | Real Safari 26.5.2 / Playwright WebKit 26.4 | Chromium 147 | Firefox 148 |
|---|---|---|---|
| 409/404 with a JSON body | **saved** as `<name>.pdf.json` | failed | no download event |
| 409 with no body | **saved** as an empty `<name>.pdf.txt` | failed | no download event |
| connection reset before any head | nothing saved | failed | no download event |

That table does two things:

- It refutes the card's "answer non-2xx with no body" option.
- It makes a reset look sufficient, but only when nothing sits between the browser and the host.

Production has something in between. It reaches the host through the GKE `gce` Ingress, Google's L7 load balancer (`deploy/charts/ax-next/values.yaml:672`, `deploy/GKE.md:753`). A proxy always answers its client. When the backend closes before any head, GCLB answers 502 with its own HTML page (`backend_connection_closed_before_data_sent_to_client`), and Safari would save that page. Kind is reached through `kubectl port-forward`, which is TCP only, so no kind walk can show this.

A body cut short of its Content-Length is different: every client fails it, and a streaming proxy passes it on as a failure. That is the torn refusal, and Walk A checks Safari's side of it.

## Global Constraints

- **Real GET versus probe.** A probe is `req.query['probe'] !== undefined`, unchanged. The probe gets the raw response, and its JSON answers stay byte for byte the same.
- **The torn refusal (real GET only).** For a refusal `res.status(S).json({ error: E })`:
  - The status is `S`.
  - `content-type: application/json; charset=utf-8`.
  - `content-length` is the byte length of `JSON.stringify({ error: E })`.
  - The body is that JSON without its last byte, and then the connection is cut.
  - There is never a `content-disposition`, never the octet-stream type, and never a byte of the file.
- **The head leaves before the cut.** The torn body's source waits one event-loop turn (`setImmediate`) after yielding and before throwing. A first write made inside a promise job stays corked until the next tick. Without the turn, nothing reaches the wire: the planner measured this on Node 24.19 (ECONNRESET, no status).
- **The log.** Each torn refusal writes exactly one line: `initCtx.logger.info('workspace_user_file_download_refused', { status: S, reason: E })`. It carries no ids and nothing the caller sent. A probe's refusal logs nothing.
- **Untouched.** No change to `@ax/http-server`, and no new dependency. `sendUserFileDownload`'s own contract is unchanged; the tearing lives in the route's wrapper. Invariant 2 holds: there is no cross-plugin import.
- **The started window.** `DOWNLOAD_STARTED_MS = 4_000` and `DOWNLOAD_STARTED_NOTE = 'Download started. Check your browser’s downloads.'` (U+2019 apostrophe). Both are exported from `packages/channel-web/src/lib/file-download.ts`. The window starts only after the browser has been handed the download, never after a refusal.
- **Labels unchanged.** The Files-tab button still reads "Getting it…" or "Download". The chip's aria-labels don't change.
- **UI (Task 3).** Invoke the `shadcn` skill. Use the existing `Button` and semantic tokens (`text-muted-foreground`). No raw colours. The note is not an `Alert`, because `role="alert"` is for problems.
- **Commands.**
  - Package tests: `pnpm --filter @ax/channel-web test -- <pattern>`. `--filter` goes before the script.
  - channel-web's `tsc --build` also type-checks its tests, so run `pnpm --filter @ax/channel-web build` after each channel-web task.
  - The gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
  - The Docker-backed suites need `DOCKER_HOST`; see CLAUDE.md.
  - `@ax/preset-k8s`'s acceptance canary is `it.skipIf(!ON_LINUX)`, so CI is its only gate.
- **Shell.** Worktree-isolated agents: spell paths out literally in Bash, with no `$var` operands.

## Review Focus

1. **A proxy in front of the host.** A refused real GET must put its status head on the wire before the cut. Otherwise a proxy invents a 502 page and Safari saves it. Pinned by Task 1's over-the-wire tests (`status` present, `complete: false`) and by the mutation that drops the event-loop turn: it must give `status: undefined`.
2. **The page still says every refusal.** The probe's answers are whole and unchanged. Pinned by Task 1's parity table.
3. **No new oracle on the real GET.** A foreign agent or conversation is still a 404 with no range read, now torn. Pinned by Task 1's existing ACL tests, run through `expectTorn`.
4. **A double click or a quick re-click** starts one download. A deliberate retry after the window works. A refused probe never locks the button. Pinned by Task 3's hook and component tests.
5. **Leaving during the window.** An unmount or a file switch mid-window leaves no timer and no stuck guard. Pinned by Task 3's `vi.getTimerCount()` test. The existing per-file key tests must stay green.

---

## Walk A (builder): the gate for Task 1

Item 2's fix rests on one engine fact the walk didn't measure: does Safari treat a *torn* refusal (a head, then a short body) as a failed download?

- [ ] **Step 1: Add variant V5, "torn", to the harness's refusing route.** Make the writes from inside a promise job, after an `await`, the way the route will:
  - `res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'content-length': '24' })`
  - `res.write('{"error":"file-changed"')` (23 bytes)
  - `await new Promise((r) => setImmediate(r)); res.destroy();`
  - Do the same for a 404 with `{"error":"file-not-found"}` (26 bytes; send 25).
- [ ] **Step 2: Click an `<a download="">` to each variant.** Use real Safari (safaridriver), Playwright WebKit, Chromium and Firefox. For each, record whether the page navigated, what the browser's download list says, and what is left in the downloads folder.
- [ ] **Step 3: Check the pass criteria.**
  - Safari and WebKit list the download as failed or interrupted, and leave no file that looks finished: no `<name>.pdf`, `<name>.pdf.json` or `<name>.pdf.txt`. A `.download` partial bundle is Safari's own artifact for an interrupted download. It counts as failed; write it down.
  - Chromium fails the download.
  - Firefox gives no download event.
  - No engine navigates.
- [ ] **Step 4 (optional, worth doing if you can).** Put a real reverse proxy in front of the harness (nginx or Caddy, if your session may install one). Repeat the reset and V5 through it. Expect two results: the reset comes back as the proxy's own 5xx page (record what Safari saves), and V5 still fails. If you can't run a proxy, say so on the card: the proxy hop is then reasoned from GCLB's documented behavior, not measured.
- [ ] **Step 5: If V5 fails in Safari, stop before Task 1.** No server-side shape fixes Safari behind production's proxy. Move the card to Needs Input with the measurements and two options:
  - Accept the residual and document it.
  - Move the /files client from `<a download>` to a hidden-iframe navigation, so that a refusal renders invisibly. That is a client redesign, and it needs its own walk.

  Tasks 3 and 4 can still ship. So can Task 5, minus the torn-refusal sentences.

---

### Task 1: Server: a real download answers with the file or a torn refusal  [tier: sensitive]

Needs `security-checklist`. The task changes the wire behavior of an authenticated route that serves agent-authored bytes, and adds a log line on requests, including unauthenticated ones. Pre-filled answers are at the end of this plan. Boundary review is N/A: no hook or IPC signature changes, and the http-server adapter is untouched.

**Files:**
- Modify `packages/channel-web/src/server/user-file-download.ts`:
  - prose at `:27-30`, `:38-40` and `:206-208`
  - add the exported `sendTornRefusal` and its source
- Modify `packages/channel-web/src/server/routes-workspace.ts`:
  - the file header, `:27-28`
  - add `realDownloadResponse` beside `DownloadRouteResponse` (`:2897-2913`)
  - `agentUserFileDownload`, doc and handler, `:7930-8007`
  - `conversationAgentFileDownload`, doc and handler, `:8009-8055`
- Test: `packages/channel-web/src/__tests__/server/routes-workspace-download.test.ts` and `packages/channel-web/src/__tests__/server/routes-workspace-conversation-file.test.ts`.

**Interfaces (Produces):**
- **`sendTornRefusal(res: Pick<StreamingDownloadResponse, 'status' | 'header' | 'bodyStream'>, status: number, body: unknown): Promise<void>`**, exported from `user-file-download.ts`.
  - It sets the status and the JSON content-type, then calls `await res.bodyStream(allButTheLastByte(bytes), { contentLength: bytes.byteLength })`, where `bytes` is `JSON.stringify(body)` encoded.
  - It swallows the rejection, which always comes by design. It never rejects.
- **`realDownloadResponse(res: DownloadRouteResponse, onRefused: (status: number, reason: string) => void): { res: DownloadRouteResponse; settled(): Promise<void> }`**, module-private in `routes-workspace.ts`. The returned `res`:
  - `status(n)`: records `n`, passes it through, and returns the wrapper.
  - `header(k, v)`: passes through and returns the wrapper.
  - `json(body)`: calls `onRefused(status, body.error)`, using `'unknown'` if `error` isn't a string. It then starts `sendTornRefusal(res, status, body)` on the RAW response. A second terminator call throws `response already finished`.
  - `bodyStream(...)`: passes through. This is the file.
  - `text()` and `end()`: throw. A real download answers with the file or a refusal.
  - `settled()`: resolves once any torn refusal is done.
- **Wire contract (Task 2 consumes it):** a real GET's refusal arrives as its status head, with a JSON content-type and a Content-Length one byte longer than the body it sends. `fetch` resolves with the status, and reading the body rejects (`TypeError: terminated`).

The one algorithm the tests don't fix is the source:

```ts
async function* allButTheLastByte(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes.subarray(0, bytes.byteLength - 1);
  // Node sends a response's first write on the NEXT tick. A connection cut in
  // the same microtask drain sends nothing at all: no status, which a proxy in
  // front of us answers with an error page of its own (and Safari saves THAT).
  // One turn of the event loop lets the head and these bytes go first.
  await new Promise<void>((resolve) => setImmediate(resolve));
  throw new Error('download refused');
}
```

- [ ] **Step 1: Write the failing direct tests.**
  - **The helper.** In each of the two test files, beside `mkRes`, add `expectTorn(d: ReturnType<typeof mkRes>, status: number, error: string): void`:
    ```ts
    const whole = JSON.stringify({ error });
    expect(d.captured.statusCode).toBe(status);
    expect(d.captured.json).toBeUndefined();
    expect(d.captured.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(d.captured.headers['content-disposition']).toBeUndefined();
    expect(d.captured.contentLength).toBe(Buffer.byteLength(whole));
    expect(d.body().toString('utf-8')).toBe(whole.slice(0, -1));
    expect(d.captured.complete).toBe(false);
    ```
  - **The rewrite rule.** It applies to every test that sends a REAL GET (the `download(...)` helper with no `probe` query) and gets a refusal.
    - Remove these assertions: `captured.json`, `captured.contentLength … toBeNull()`, `captured.headers … toEqual({})`, and `headers['content-type'] … toBeUndefined()`.
    - Put one `expectTorn(d, <status>, '<error>')` in their place. Use the status and error the test asserts today. Where a test destructures `{ captured }`, keep the whole `d`.
    - Keep every other assertion: status-only lines, range, metadata and resolve call lists, and logs.
    - Tests that send `{ probe: '1' }`, and the 200 tests, don't change.
  - **Which tests in `routes-workspace-download.test.ts`** (the direct describe):

    | Line | Case |
    |---|---|
    | `:384` | foreign agent: 404 `agent-not-found` |
    | `:428` | `it.each`: 400 `invalid-path` |
    | `:449` | 400 `missing-agent-id` |
    | `:489` | 503 |
    | `:652` | 413 |
    | `:691` | 400 `not-a-file` |
    | `:700` | 404 `file-not-found` |
    | `:708` | 503 |
    | `:725` | 503 `file-read-failed` |
    | `:757` | `it.each` |
    | `:784` | 503 |
    | `:803` | 503 |
    | `:827` | `it.each` |
    | `:970` | `it.each`: 409 |
    | `:1002` | table; keep its exact `expect(logs).toEqual(logged)` |

  - **Which tests in `routes-workspace-conversation-file.test.ts`:** `:408`, `:419` (`it.each`), `:435`, `:465` (keep its exact `warn.mock.calls`), `:488` (keep "`warn` not called"), `:508`, `:521`, `:532` (`it.each`), `:544`, `:556`, `:565`, `:574`, `:588`.
  - **The parity table** (`routes-workspace-download.test.ts:1252`).
    - Rename it to `'a probe answers $label in words, and the real download sends the same refusal torn'`.
    - For each row, assert `expectTorn(asDownload, status, error)` and `expect(asProbe.captured).toMatchObject({ statusCode: status, json: { error } })`. The range-call equality stays as it is.
    - Its `expect(asDownload.captured.headers).toEqual({})` at `:1373` is replaced by `expectTorn`.
    - Set `const info = vi.spyOn(initCtx.logger, 'info').mockImplementation(() => undefined)` before the download. Afterwards, `info.mock.calls` is exactly `[['workspace_user_file_download_refused', { status, reason: error }]]`. Then `info.mockClear()`, run the probe, and expect no call at all.
  - **The probe ACL test** (`:1453`).
    - At `:1484-1486`, assert `expectTorn(foreignDownload, 404, 'agent-not-found')` and `expect(foreign.captured.json).toEqual({ error: 'agent-not-found' })`.
    - Add a signed-out real GET: torn 401 `unauthenticated`, with one info line `{ status: 401, reason: 'unauthenticated' }`.
- [ ] **Step 2: Write the failing wire tests.**
  - **`routes-workspace-download.test.ts`, the socket describe.**
    - Add `expectTornOverTheWire(got: RawResponse, status: number, error: string): void`. It asserts:
      - `toMatchObject({ status, complete: false, timedOut: false })`
      - the content-type above, exactly
      - no `content-disposition`
      - `content-length` equal to `String(Buffer.byteLength(whole))`
      - `body.toString('utf-8') === whole.slice(0, -1)`
    - **Rewrite `:1795`** as `'a one-range file that changes before its final check sends its 409 head over the wire, never a bare reset: torn to the real GET, whole to a probe'`.
      - Assert `expectTornOverTheWire(await rawGet(b.port, \`${DOWNLOAD}/notes%2Fplan.bin\`), 409, 'file-changed')`, then the same two range calls. Assert those before the probe twin, which adds its own two reads.
      - Then `rawGet` of the same URL with `?probe=1` gives `{ status: 409, complete: true }` and the body `{ error: 'file-changed' }`.
    - **Rewrite `:1817` (503 `file-read-failed`) and `:1827` (413 `file-too-large`, one read) the same way:** a `rawGet` plus `expectTornOverTheWire`, and a probe twin that answers whole.
    - `:1835` and `:1842` only check the status, so they stay.
  - **`routes-workspace-conversation-file.test.ts`, the wire describe:** `'404s a teammate’s conversation over the wire…'` and `'400s an encoded traversal over the wire…'`.
    - Keep `r.status`.
    - Replace `await r.json()` with `await expect(r.text()).rejects.toThrow('terminated')`.
    - Fetch the same URL with `?probe=1`, and expect its `.json()` to be the error.
    - Keep "without reading".
- [ ] **Step 3:** Run `pnpm --filter @ax/channel-web test -- routes-workspace-download routes-workspace-conversation-file`. Expected: the rewritten tests FAIL, because today a real GET's refusal is whole (`json` set, `contentLength` null). The probe and 200 tests still pass.
- [ ] **Step 4: Implement.**
  - Write `sendTornRefusal` and its source in `user-file-download.ts`, and `realDownloadResponse` in `routes-workspace.ts`.
  - **In both handlers:**
    - Name the response parameter `raw`, and keep `if (probe) raw.header('cache-control', 'private, no-store')` first.
    - Then add `const real = probe ? undefined : realDownloadResponse(raw, (status, reason) => initCtx.logger.info('workspace_user_file_download_refused', { status, reason }));` and `const res = real?.res ?? raw;`.
    - Wrap the existing body, unchanged, in `try { … } finally { await real?.settled(); }`. Awaiting the cut means `http:response-sent` reports `{ status, incomplete: true }`.
  - **Prose:**
    - `user-file-download.ts:27-30`, `:38-40` and `:206-208`: a refusal before the head is said in words to a probe. A real download gets the same status with its words torn (TASK-1025), because the browser's download receives it, not our page, and Safari saves a whole refusal as the file.
    - The route header (`:27-28`) and both handler docs get one line each.
- [ ] **Step 5:** Re-run the command from step 3. Expected: PASS. Then prove two mutations, one at a time, reverting each:
  - Drop the `setImmediate` turn. The rewritten agent-route wire tests must FAIL with `status: undefined`. The direct tests can't see this, because the fakes don't cork.
  - Hand the real GET the raw response (`const res = raw`). Every `expectTorn` test must FAIL.

  Note both mutations in the commit body.
- [ ] **Step 6:** Run `pnpm --filter @ax/channel-web build`. Expected: PASS.
- [ ] **Step 7: Commit** `[TASK-1025] channel-web: a real /files download answers the file or a torn refusal, so no browser can save a refusal as the file`.

### Task 2: Canaries: a refusal's words come from the probe; the real GET is torn  [tier: integration]

**Files:**
- Modify `presets/memory/src/__tests__/canary.test.ts:1876-1884`.
- Modify `presets/k8s/src/__tests__/acceptance.test.ts:2870-2877`, `:3022-3036` and `:3050-3084`.

**Interfaces (Consumes):** Task 1's wire contract.

- [ ] **Step 1: The memory canary.**
  - In `'an unauthenticated caller gets the routes own JSON 401 on every splat route, not the shell'`, ask for the download entry as `…/download/user-files/docs/inner.txt?probe=1`. The probe is where the route's JSON lives now.
  - After the loop, add a real GET of the same path with no user. Expect `status` 401, a `content-type` containing `application/json`, and `await expect(r.text()).rejects.toThrow()`.
- [ ] **Step 2: The k8s canary.**
  - Add a local helper, `expectRefused(url: string, init: RequestInit, status: number, error: string): Promise<void>`.
    - The real GET has `status`, and `await expect(real.text()).rejects.toThrow()`.
    - Then `fetch(\`${url}?probe=1\`, init)` has the same `status`, and its `.json()` equals `{ error }`.
  - Use the helper for five checks:
    - step 9, the symlink: 404 `file-not-found`
    - step 11c, the loop over both keys as `OTHER_USER`: 404 `file-not-found`. This replaces the `not.toContain('%PDF')` read: the torn body never completes, and Task 1's `expectTorn` pins what it carries.
    - step 11d, the folder: 400 `not-a-file`
    - the linked file: 404
    - the deleted file: 404
  - Keep `(await fetch(chipUrl)).status` as 401, and keep every status-route assertion as it is.
- [ ] **Step 3:** Run `pnpm --filter @ax/preset-memory test` with `DOCKER_HOST` set. Expected: PASS. `@ax/preset-k8s`'s canary skips off Linux. Read that diff twice; CI is its gate.
- [ ] **Step 4: Commit** `[TASK-1025] canaries: a refusal's words come from the probe; the real GET's refusal is torn`.

### Task 3: Client: "Download started", then a few quiet seconds, on both surfaces  [tier: integration]

Invoke the `shadcn` skill before editing UI.

**Files:**
- Modify `packages/channel-web/src/lib/file-download.ts`:
  - add the two constants
  - `FileDownloadState`, `:180-198`
  - `useFileDownload`, `:200-241`, including the in-flight ref comment at `:208-216`
- Modify `packages/channel-web/src/components/workspace/AgentFiles.tsx`: `FileViewer`, `:586-664` (the button at `:616-635`, and the note just before the error `Alert` at `:650`).
- Modify `packages/channel-web/src/components/workspace/GeneratedFileChip.tsx`:
  - the header doc at `:12-31`: one sentence
  - the state at `:42-45`
  - `download()`, `:94-132`
  - the button and its live line, `:134-157`
- Test, all under `packages/channel-web/src`:
  - `lib/__tests__/file-download.test.ts`
  - `components/workspace/__tests__/AgentFiles.test.tsx`
  - `components/workspace/__tests__/GeneratedFileChip.test.tsx`
  - `components/workspace/__tests__/TaskCheckinPage.test.tsx` (its mock factory only)

**Interfaces (Produces):**
- **`export const DOWNLOAD_STARTED_MS = 4_000;`** and **`export const DOWNLOAD_STARTED_NOTE = 'Download started. Check your browser’s downloads.';`**
- **`FileDownloadState.started: boolean`.** It is true from the moment the browser is handed the download until `DOWNLOAD_STARTED_MS` later. While it is true, `start()` does nothing.
- **The hook.**
  - After the probe says yes, call `saveFromUrl(…)` and set `started`. The in-flight ref stays held, so same-frame clicks are refused too. After `DOWNLOAD_STARTED_MS`, release the ref and clear `started`.
  - `busy` still ends when the probe answers.
  - A refusal, or a throw from `saveFromUrl`, behaves as it does today: the ref is released at once and `started` stays false.
  - Unmounting clears the timer.
- **The Files tab (`FileViewer`).**
  - The button gets `disabled={download.busy || download.started}`. Its label doesn't change.
  - Add an always-present `<p role="status">` before the error `Alert`. While the window is open, it shows `DOWNLOAD_STARTED_NOTE` with `mb-5 text-[13px] text-muted-foreground`. Otherwise it is empty and `sr-only`. It is always present so that a screen reader announces the change.
- **The chip.**
  - It keeps its own `started`, with the same window rules, after either hand-over: `saveFromUrl` for an agent file, `saveBlob` for an attachment.
  - The button gets `disabled={busy || started || !downloadable}`.
  - The live line reads `busy ? 'Downloading…' : gone ? 'No longer available' : started ? DOWNLOAD_STARTED_NOTE : <size · Download>`.
  - Unmounting clears the timer.

- [ ] **Step 1: Fix the mock factories first.** In `GeneratedFileChip.test.tsx:9` and `TaskCheckinPage.test.tsx:41`, write `vi.mock('@/lib/file-download', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/file-download')>()), saveBlob: vi.fn(), saveFromUrl: vi.fn() }))`. The chip now reads the two constants from that module. The bare factory would hand it `undefined`, which means a 0 ms window and no note.
- [ ] **Step 2: Write the failing tests.** For any test that waits on the window, use `vi.useFakeTimers({ shouldAdvanceTime: true })`, so that `waitFor` and `findBy` still poll, and `vi.useRealTimers()` in cleanup. Assert "ignored" right after `started` is seen.
  - **`file-download.test.ts`, `useFileDownload`:**
    - New: `'after the browser has the download, holds it for DOWNLOAD_STARTED_MS: says so, and starts nothing on another click'`.
      - Run it through the real `workspaceApi`, with `stubFetch(200, { downloadable: true })` and `clickedLinks()`.
      - `start()`, then wait until `busy` is false. Expect `started === true`, one fetch and one link.
      - `start()` again: still one fetch.
      - `act(() => vi.advanceTimersByTime(DOWNLOAD_STARTED_MS))`: `started === false`.
      - `start()`: two fetches and two links.
    - New: `'leaving during the window leaves no timer behind'`. Same set-up: `start()`, wait for `started`, then `unmount()`. Expect `vi.getTimerCount() === 0`.
    - Existing `'probes the route, then hands the route itself to the browser…'`: add `expect(result.current.started).toBe(true)`.
    - Existing `'lets the next attempt through once the first one has finished'`, which is a refusal: add `expect(result.current.started).toBe(false)` after the first attempt.
  - **`AgentFiles.test.tsx`, `'AgentFiles: downloading'`:** new `'says the download started and holds the button for a moment, then offers it again'`.
    - `downloadMock.mockResolvedValue(Q3_ROUTE)`, then click Download.
    - `findByRole('status')` has the text `DOWNLOAD_STARTED_NOTE`. The button is disabled and still reads "Download".
    - Click it: `downloadMock` has been called once.
    - Advance by `DOWNLOAD_STARTED_MS`: the button is enabled, and the status text is empty.
    - Click: called twice, and `saved` has two entries.
  - **`GeneratedFileChip.test.tsx`:**
    - New, under `'agent-file chips (TASK-1012)'`: `'after the browser has it, the chip says so and ignores clicks for a moment'`.
      - `chipFetch()`, then click: `saveFromUrl` is called once. `getByText(DOWNLOAD_STARTED_NOTE)` is visible, and the button named `'Download Q3 plan #1.pdf'` is disabled.
      - Click: the fetch URLs are still `[STATUS_URL, \`${DOWNLOAD_URL}?probe=1\`]`.
      - Advance: the button is enabled, and `'10 B · Download'` is visible.
      - Click: `saveFromUrl` has been called twice.
    - Attachment: at the end of `'prevents overlapping downloads and gives a failed download a retry'`, after `saveBlob` has been called once, `findByText(DOWNLOAD_STARTED_NOTE)` is visible.
    - Refusals start no window: in `'keeps the generic copy on a 503'`, after the alert, the button is enabled.
- [ ] **Step 3:** Run `pnpm --filter @ax/channel-web test -- file-download AgentFiles GeneratedFileChip TaskCheckinPage`. Expected: the new tests FAIL. `started` is undefined, the button re-enables at once, and there is no note.
- [ ] **Step 4: Implement** as the Interfaces say. Also update the docs:
  - `FileDownloadState`'s `busy` and `start`.
  - The in-flight ref comment: the ref now also covers the window.
  - The chip header: after the hand-over, the chip says the download started and ignores clicks for a few seconds.
- [ ] **Step 5:** Re-run the command from step 3, then `pnpm --filter @ax/channel-web build`. Expected: PASS.
- [ ] **Step 6: Commit** `[TASK-1025] channel-web: after a download starts, say so and ignore clicks for a few seconds (Files tab and chat chips)`.

### Task 4: The chip's console line carries its route  [tier: mechanical]

**Files:** `packages/channel-web/src/components/workspace/GeneratedFileChip.tsx` (the two `new HttpError('file download', …)` calls in `download()`), and its test.

- [ ] **Step 1: Write the failing tests.**
  - In `'says the file is too big on a 413'`, replace the regex with `expect(warn).toHaveBeenCalledWith(\`[file chip download] ${DOWNLOAD_URL} → 413\`)`. The arrow is `' → '`, U+2192, from `HttpError.detail`.
  - In `'keeps the generic retry copy on a 400 for an attachment-id chip'`, spy on `console.warn` and expect `'[file chip download] /api/files?conversationId=c1&id=0123456789abcdef0123456789abcdef → 400'`.
- [ ] **Step 2:** Run `pnpm --filter @ax/channel-web test -- GeneratedFileChip`. Expected: FAIL, because the line says `file download → 413`.
- [ ] **Step 3:** Change both calls to `new HttpError(url, …)`. That is the route the chip asked about, without `?probe=1`, which is how the Files tab's line logs it.
- [ ] **Step 4:** Re-run the command from step 2, then `pnpm --filter @ax/channel-web build`. Expected: PASS.
- [ ] **Step 5: Commit** `[TASK-1025] channel-web: a chip's failed download logs its route`.

### Task 5: As-built docs and the stale lines  [tier: mechanical]

**Files:**
- `packages/channel-web/src/lib/file-download.ts:26-35`
- `docs/plans/2026-10-29-agent-files-simplification-design.md`, after the TASK-1022 bullet (`:130-137`)
- `docs/plans/2026-05-24-current-architecture.md:492-495`

- [ ] **Step 1: The stale line, `file-download.ts:33-35`.** It reads "Chromium treats a refused download as failed. Other browsers are not verified, and one may save the short error body under the file's name." That hedge is what made item 2 an open question. Replace it with the measured facts:
  - Safari saves a whole refusal as a file.
  - So the route sends a real download's refusal torn: its status, then a cut body.
  - Chromium, Firefox and Safari all treat that as a failed download (TASK-1025).

  Keep the two things that are still left to the download bar.
- [ ] **Step 2: The design doc.** Add an `**As built (TASK-1025):**` bullet that covers four points:
  - A real GET's refusals are torn, and why: Safari saves a whole refusal, and a reset before the head becomes the load balancer's own error page.
  - The probe is unchanged.
  - Each torn refusal logs one info line.
  - Both surfaces show the 4 s "Download started" note.
- [ ] **Step 3: The architecture doc.** At the end of the "Agent file downloads stream" bullet, append: "A real download's refusal goes out torn (its status, then a cut body), so no browser saves it as the file (TASK-1025)."
- [ ] **Step 4:** Run `git grep -n -i "not verified\|may save the short error" -- packages/channel-web/src docs/plans/2026-10-29-agent-files-simplification-design.md docs/plans/2026-05-24-current-architecture.md`. Expected: no hit about downloads.
- [ ] **Step 5: Commit** `[TASK-1025] docs: as-built for torn download refusals and the started note`.

## Finish

- [ ] **The gate.** Run `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`. Expected: green.
- [ ] **Walk B (item 1): a 500 MB download on kind.** It needs `make image`, because Task 1 is host-side and `make dev-fast` syncs only the SPA, and then a kind redeploy. Give every kubectl or make target `--context kind-ax-next-dev`: the default context is GKE prod.
  1. In chat, ask a test agent to run `head -c 524288000 /dev/urandom > big.bin` in its files.
  2. In Chromium (Playwright MCP), read the JS heap: `performance.memory.usedJSHeapSize`, or CDP `Performance.getMetrics` → `JSHeapUsedSize`.
  3. Open the Files tab, select `big.bin`, and click Download. Expect:
     - one `?probe=1` request, a small JSON 200
     - then the route's download
     - the note, with the button disabled for about 4 s
     - no request from a second click inside that window
  4. When the download finishes, there are 524288000 bytes on disk.
  5. Read the heap again. Pass: it grew by far less than 500 MB, say under 50 MB.
  6. Ask the agent to delete `big.bin`, then click Download. Expect the in-page 404 sentence and no download.

  Kind is reached through `kubectl port-forward`, which is TCP, so this walk can't show the production proxy hop.
- [ ] **Write the results on the card (acceptance):**
  - the walk table with V5 added
  - whether the proxy hop was measured or reasoned
  - Walk B's heap numbers

## Not in this plan (YAGNI cuts, decided in the shard)

- An `@ax/http-server` change that lets the pump flush a written head before its teardown destroys the connection. Follow-up note: a source that fails with no I/O right after its first chunk loses its head. Today's range reads do I/O between pulls, so nothing hits it now.
- Tearing an unexpected 500 thrown on a real GET. The probe runs the same code first.
- An agentId in the refusal log line.
- A hidden-iframe client. It is the fallback only if Walk A fails.
- HEAD, HTTP `Range`, and attachment-route changes.

## Security checklist: pre-filled for Task 1 (verify, don't copy)

- **Sandbox escape:** N/A. No sandbox, IPC or confinement code changes. A real GET makes exactly the range reads it made before, and every refusal is decided at the same point.
- **Untrusted content:**
  - A torn refusal's bytes are our own `{error}` JSON, a fixed code. They are never a byte of the file.
  - A torn refusal carries no download header (no `content-disposition`, no octet-stream type) and never the agent-authored filename.
  - The probe's in-page answers, and TASK-1022's href rules, are unchanged.
- **Supply chain:** no new dependency.
- **Capabilities:** no new fs, network, process or env reach. One info line is written per refused real download, including unauthenticated ones. That is one line per request, with fixed fields, and nothing from the caller.
- **Resource use:** a torn refusal holds its connection for one event-loop turn. There is no other new timer.
- **Residuals for the PR note:**
  - (a) An unexpected throw on a real GET still gets the kernel's whole 500 JSON, which Safari would save. The probe runs the same code first.
  - (b) Behind GCLB, the torn shape relies on GCLB passing a partial response on as a failed one (`backend_connection_closed_after_partial_response_sent`). That is documented, not measured here.
  - (c) The pump's head-loss for a source that fails with no I/O; see "Not in this plan".
