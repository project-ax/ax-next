# Chat visuals (`show_visual`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task heading carries a `[tier: …]` tag; map it to model and effort without re-deciding.

**Goal:** The agent can call `show_visual({ title, summary, html })` in either runner. The person then sees that HTML inline in the chat, in a scripts-only sandboxed frame that looks like AX in both themes. The visual survives a reload and can be downloaded as PNG or HTML.

**Architecture:** `@ax/tool-artifact-publish` registers a sandbox-executed `show_visual` descriptor. Its executor in `@ax/agent-runner-core` validates the input and stores the HTML through the existing `blob.put` + `artifact.publish` path as a `text/html` artifact, then returns `{ artifactId, title, summary }`. channel-web turns that tool result into a `ThreadVisual`, both on reload (`buildThread`) and live (`streamReply` → `onVisual`). `VisualFrame` fetches the bytes from `GET /api/files` as text and assembles a srcdoc in this order: CSP meta, theme tokens, inlined Inter subset, Chart.js, html-to-image, frame runtime, then the agent's HTML. The srcdoc goes in a `sandbox="allow-scripts"` iframe, and the parent talks to it only through a validated postMessage protocol. A one-directive parent CSP (`frame-src 'none'`) stops the frame navigating itself.

**Tech Stack:** TypeScript, React 19, shadcn/Radix (`Card`, `Button`, `DropdownMenu`, `Skeleton`, all already installed), Vite 6 `?raw`/`?inline` imports, vitest + jsdom, Playwright (hostile test only), `chart.js` 4.5.1 (UMD), `html-to-image` 1.11.13 (UMD), fonttools `pyftsubset` (authoring time only).

**Spec:** `docs/plans/2026-11-05-chat-visuals-design.md` (approved by Vinay 2026-11-05; decided points are not reopened here). Decisions: `.claude/memory/decisions/2026-11-05-VISUALS-1.md`.

## Global Constraints

- The iframe is `sandbox="allow-scripts"` and nothing else: no `allow-same-origin`, `allow-top-navigation*`, `allow-popups`, `allow-forms`, `allow-modals` or `allow-downloads`. Content is a `srcdoc`.
- No network from the frame. Its CSP is `default-src 'none'`, allowing only inline script and style plus `data:`/`blob:` where rendering and export need them. The CSP meta is **first in the srcdoc `<head>`, ahead of anything model-authored**.
- The parent trusts nothing from the frame. The only channel is `postMessage`. `event.source` must be that frame's `contentWindow`, only the fixed message types are accepted, and every field is validated and clamped. Frame strings are never rendered as markup or evaluated.
- HTML cap: **100 KB = 102,400 UTF-8 bytes**. Over the cap, the tool call fails with an error the agent can act on. v1 does not strip old visuals from history.
- No streaming skeleton and no new streaming event. The existing activity phrase covers the wait: `activityPhrase: 'Making a visual'`.
- Durable: the blob store plus the artifact row hold the bytes, and the transcript holds the reference. A visual renders after reload and reopen. It is a snapshot.
- Downloads are **PNG (2x) and HTML only, no PDF**, generated client-side. File names come from the sanitized title, falling back to `visual`.
- Model-authored tool **input** is never rendered or forwarded past the stream reader. The `lib/workspace-steps.ts` rule stays untouched.
- The download route keeps `content-disposition: attachment` and `x-content-type-options: nosniff`.
- Field names are backend-neutral (`visual`, `title`, `summary`, `artifactId`), with no storage terms.
- Invariant 6: the chrome (title, download menu, placeholder, error state) uses shadcn primitives and semantic tokens only. Inside the frame, colors come from `hsl(var(--x))` (tokens are bare HSL triplets).
- Invariant 2: channel-web imports only allow-listed `@ax/*` packages. Tool names are restated there, never imported from runner or tool packages.
- Invariant 3: the tool is loaded by both presets (via `@ax/tool-artifact-publish`, already in `cli/src/main.ts:329` and `presets/k8s/src/index.ts:1306`), reached by the canary, and exposed by both runners.
- Accessibility: the frame has a `title` attribute, and the summary is the accessible answer.
- Commands: `pnpm --filter <pkg> test` (filter **before** the script) or `pnpm --filter <pkg> exec vitest run <file>`. Always also run `pnpm typecheck`, because channel-web's `tsc` covers its tests. Never use bare `kubectl`: always pass `--context kind-ax-next-dev`.

## Review Focus

1. **The agent writes `hsl(var(--chart-1))` into a Chart.js option.** Canvas cannot parse CSS variables, so the bars paint black (the "jarring" failure). Expected: the theme plugin resolves it to the palette color. Pinned in Task 10, Step 1 (RF1).
2. **The agent sends a whole HTML document (doctype, head, its own `<style>`), and may also load Chart.js from a CDN out of habit.** Expected: our CSP is still `head.firstElementChild`, the agent's style applies, the CDN tag is blocked, and the injected `Chart` still renders. Pinned in Task 9, Step 1 and Task 14, Step 1 (RF2).
3. **The theme is toggled while the frame is still loading.** Expected: the frame ends in the current theme, never the one it was created with. Pinned in Task 11, Step 1 (RF3).
4. **The live visual hands over to the durable one at turn end, or the frame remounts for any reason.** Expected: no second fetch, no collapse to the default height and no blank gap. Pinned in Task 11, Step 1 and Task 12, Step 1 (RF4).
5. **A visual block names a large or non-HTML artifact** (a stale or forged id, such as a 50 MB zip published in the same conversation). Expected: the tab never reads it into memory and shows the quiet failure state. Pinned in Task 11, Step 1 (RF5).

## Where the code differs from the design (resolved in this plan)

- **Activity phrase.** The design says "add an entry to `activity-phrase-map.ts`", but that map is derived from descriptors (`agent-runner-core/src/activity-phrase-map.ts` `buildActivityPhraseMap`). Task 1 sets the descriptor's `activityPhrase`, and Task 15 fixes the design line.
- **The "no network" box leaks through self-navigation.** The frame's CSP cannot stop `location.href = 'https://x/?data'` or `<meta http-equiv=refresh>`, and the sandbox flags do not either. Only the embedder's `frame-src` can. Task 9 adds `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'">` to `packages/channel-web/index.html`. The app embeds no other iframes, and srcdoc is not fetched, so it is unaffected. Task 14 proves this in Chromium. This makes the design line "no app-wide CSP… the frame's own CSP is the only policy" (design :81-82) stale; Task 15 fixes it.
- **"Model-written tool input never reaches the browser"** (design :91). The SSE `tool-use` frame does carry `input` into `streamReply` (`lib/workspace-api.ts:2268-2276`), where `stepDetail` reduces it to one fenced line (the `title`). The rule (never rendered, never forwarded) is unchanged. Tasks 6 and 12 pin that the HTML goes no further, and Task 15 corrects the wording.
- **Fonts.** "Inter (and the mono stack) are inlined", but the chat's mono stack is system fonts (`index.css` `.ax-md code`), so only Inter is inlined. Tailwind's `font-mono` (IBM Plex Mono from Google Fonts) is not used in chat bubbles.
- **"Title + summary carried in the metadata".** No artifact-row or IPC field is needed. They ride the tool result (decisions row 1).
- **Serving the HTML.** `GET /api/files` would serve the first-ever `text/html` row as `content-type: text/html`. Task 5 serves active types as `application/octet-stream`, in line with the decisions.md:2787 precedent.
- **Tool description.** The claude-sdk sandbox bridge drops per-property descriptions (`agent-claude-sdk-runner/src/sandbox-mcp-server.ts:33-48`), so all model guidance lives in the top-level description.

## Boundary review and security notes (copy into the PR)

- **Hooks and IPC: no change.** `artifact.publish`'s request is unchanged, and `tool:register` carries the existing `ToolDescriptor`. **No new ToolDescriptor field.** If one is ever added, it must go into three places: `@ax/core` `types.ts`, `@ax/ipc-protocol` `actions.ts` `ToolDescriptorSchema`, and `@ax/mcp-client` `tool-dispatcher-plugin.ts`. The `{ returns }` z.object strips unknown keys.
- **New shapes.** The tool result JSON `{ artifactId, title, summary }` (runner → transcript → channel-web), and `ThreadMessage` (`kind: 'agent'`) `.visuals?: ThreadVisual[]` on channel-web's own REST.
  - *Alternate impl:* an object-store artifact backend serving the same opaque id, or a Slack renderer posting the same result's summary.
  - *Leaky names:* none. The row key `visuals/<sha256>.html` is `@ax/attachments`' private re-publish key and never leaves it.
  - *Subscriber risk:* none, because no subscriber hook is added.
- **Sandbox escape and reach.** The frame has an opaque origin: no cookies, storage or parent DOM. The frame CSP blocks every fetch-like load, and the parent `frame-src 'none'` blocks navigation. The parent filter checks source, `origin === 'null'`, the type allowlist, clamps and pending export ids. The only other window `message` listener (`lib/use-oauth-popup.ts:166`) is origin-locked to the app origin, so the frame (origin `'null'`) cannot reach it.
  - *Residuals:* resource hints (`preconnect`, `dns-prefetch`) may still touch a model-chosen host in some engines; `x-dns-prefetch-control: off` covers DNS prefetch in Chromium and Firefox. A CPU-bound script can slow the tab where sandboxed frames share a process. A downloaded HTML opened from disk runs its scripts in a `file://` tab under its own CSP. Firefox and WebKit are not verified for srcdoc under the parent `frame-src 'none'`.
- **Prompt injection.** A hijacked model can show a misleading visual (as with text). It cannot reach the app, fetch or navigate, or start a download without the person's click.
- **Supply chain.**
  - `chart.js` 4.5.1 (with `@kurkle/color` 0.3.x) and `html-to-image` 1.11.13: MIT, no install scripts, exact pins and lockfile integrity. They are imported as raw strings and execute **only inside the frame**, never in the app's realm.
  - fonttools runs only at authoring time.
  - `playwright` is already in the lockfile.
- **`security-checklist` is required** for Tasks 3, 5, 8, 9, 11, 14 and 16.
- **Rollback.** An older host ignores `show_visual` results (no visual, step row intact). No migration.

## File Structure

```
packages/tool-artifact-publish/src/show-visual.ts        NEW  descriptor + limits
packages/tool-artifact-publish/src/{plugin,index}.ts     MOD  register/export both descriptors
packages/tool-policy/src/rules.ts                        MOD  `visuals.show` catalog allow
packages/agent-runner-core/src/artifact-publish-executor.ts  MOD  export publishBytesToHost (shared put → publish)
packages/agent-runner-core/src/show-visual-executor.ts   NEW  validate + publish text/html
packages/agent-runner-core/src/{run-runner,index}.ts     MOD  register / export
packages/agent-claude-sdk-runner/src/main.ts             MOD  re-export for the canary
packages/agent-aisdk-runner/package.json                 MOD  devDep @ax/tool-artifact-publish (test)
packages/channel-web/index.html                          MOD  parent CSP `frame-src 'none'`
packages/channel-web/package.json                        MOD  devDeps chart.js, html-to-image, playwright
packages/channel-web/vendor-aliases.ts                   NEW  Vite aliases to the two UMD files
packages/channel-web/{vite,vitest}.config.ts             MOD  spread vendorAliases
packages/channel-web/src/assets.d.ts                     MOD  `*?raw` / `*?inline` typings
packages/channel-web/src/index.css                       MOD  --chart-1..5 in all three blocks
packages/channel-web/src/lib/workspace-types.ts          MOD  ThreadVisual; agent.visuals
packages/channel-web/src/lib/visual-result.ts            NEW  name match + result parser (server AND browser)
packages/channel-web/src/lib/workspace-api.ts            MOD  onVisual
packages/channel-web/src/server/routes-workspace.ts      MOD  buildThread visuals
packages/channel-web/src/server/routes-attachments.ts    MOD  downloadContentType
packages/channel-web/src/components/workspace/visual/
  fonts/inter-{400,500,600}-latin.woff                   NEW  Inter subsets
  visual-assets.ts                                       NEW  raw libs, inline fonts, DEFAULT_VISUAL_ASSETS
  visual-doc.ts                                          NEW  CSPs, sandbox, tokens, srcdoc, file names, heights
  frame-runtime.js / frame-runtime-source.ts             NEW  in-frame runtime (plain JS, ?raw)
  frame-messages.ts                                      NEW  parseFrameMessage, isPngBlob
  visual-source.ts                                       NEW  loadVisualHtml + html/height caches
  VisualFrame.tsx                                        NEW  card, iframe, downloads
packages/channel-web/src/components/workspace/{AgentConversation,AgentView}.tsx  MOD
presets/k8s/src/__tests__/{preset,acceptance}.test.ts    MOD
docs/plans/2026-11-05-chat-visuals-design.md, deploy/MANUAL-ACCEPTANCE.md  MOD (Task 15)
```

Order: Tasks 1, 2, 5, 6, 7, 8 and 9 are independent. 3 needs 1. 4 needs 3. 10 needs 8 and 9. 11 needs 6 and 10. 12 needs 11. 13 needs 4 and 5. 14 needs 10. 15 and 16 come last. Commits end with the session's attribution trailers.

---

### Task 1: `show_visual` descriptor and limits [tier: mechanical]

**Files:**
- Create: `packages/tool-artifact-publish/src/show-visual.ts`
- Modify: `packages/tool-artifact-publish/src/index.ts`, `packages/tool-artifact-publish/src/plugin.ts:9-45` (register both; fix its doc comment)
- Modify: `presets/k8s/src/__tests__/preset.test.ts:694-702` (add to the `BUILTIN_TOOL_DESCRIPTORS` roll-call)
- Test: `packages/tool-artifact-publish/src/__tests__/show-visual.test.ts`, `…/__tests__/plugin.test.ts`

**Interfaces:**
- Produces (exported from `@ax/tool-artifact-publish`):
  ```ts
  export const SHOW_VISUAL_TOOL_NAME = 'show_visual' as const;
  export const MAX_VISUAL_HTML_BYTES = 102_400;   // 100 KB, UTF-8 bytes
  export const MAX_VISUAL_TITLE_CHARS = 120;
  export const MAX_VISUAL_SUMMARY_CHARS = 1000;
  export const SHOW_VISUAL_DESCRIPTOR: ToolDescriptor;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// show-visual.test.ts
it('is a sandbox tool named show_visual with a short phrase', () => {
  expect(SHOW_VISUAL_DESCRIPTOR.name).toBe('show_visual');
  expect(SHOW_VISUAL_DESCRIPTOR.executesIn).toBe('sandbox');
  expect(SHOW_VISUAL_DESCRIPTOR.activityPhrase).toBe('Making a visual');
});
it('takes exactly title, summary and html, all required strings', () => {
  const s = SHOW_VISUAL_DESCRIPTOR.inputSchema as { properties: Record<string, { type: string }>; required: string[]; additionalProperties: boolean };
  expect(Object.keys(s.properties)).toEqual(['title', 'summary', 'html']);
  expect(Object.values(s.properties).map((p) => p.type)).toEqual(['string', 'string', 'string']);
  expect(s.required).toEqual(['title', 'summary', 'html']);
  expect(s.additionalProperties).toBe(false);
});
it('carries every rule in the top-level description (claude-sdk drops property descriptions)', () => {
  for (const needle of ['always make one', 'NO network', '100 KB', 'hsl(var(--', '--chart-1', 'Chart.js', 'ax.chartColor', 'reply text'])
    expect(SHOW_VISUAL_DESCRIPTOR.description).toContain(needle);
});
it('pins the limits', () => {
  expect([MAX_VISUAL_HTML_BYTES, MAX_VISUAL_TITLE_CHARS, MAX_VISUAL_SUMMARY_CHARS]).toEqual([100 * 1024, 120, 1000]);
});
// plugin.test.ts
it('registers artifact_publish then show_visual on init', async () => {
  // existing fakeBus; after init:
  expect(calls.filter((c) => c.hook === 'tool:register').map((c) => (c.payload as ToolDescriptor).name))
    .toEqual(['artifact_publish', 'show_visual']);
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found): `pnpm --filter @ax/tool-artifact-publish test`

- [ ] **Step 3: Implement `show-visual.ts`** (`inputSchema` property order: title, summary, html; one-line property descriptions). The `description` is this exact text, as a `[...].join('\n')` array:

```text
Show the person a visual (a chart or a small card) inline in this chat.

When: use it when the answer is a trend, a comparison, or naturally card-shaped
(a forecast, a status). If the person asks for a chart, graph, visual or card,
always make one. A short answer stays text: never make a visual for a one-line
answer.

How: pass a title, a plain-text summary and self-contained HTML (at most 100 KB).
The HTML runs in a sandboxed frame with scripts but NO network: nothing can be
fetched or loaded (no CDNs, web fonts, remote images or APIs). Gather the data
with your other tools first and write it into the HTML.

Look like the app:
- Color only with the provided CSS variables, written as hsl(var(--name)):
  --background, --foreground, --card, --card-foreground, --muted,
  --muted-foreground, --border, --primary, --accent, --destructive, --warning,
  and --chart-1 to --chart-5 for data series. No other colors.
- Fonts are already set (Inter; code uses the system monospace). Don't set font-family.
- The visual already sits in a card under its title. Don't repeat the title or
  add an outer border, background or shadow.
- Light and dark mode switch live; the CSS variables follow automatically.

Charts: Chart.js 4 is preloaded as the global Chart and themed to match. Leave
dataset colors unset to get the palette, or use ax.chartColor('chart-2'). For
your own canvas drawing, ax.color('foreground') returns the current color and
the window fires an 'ax:theme' event when the theme changes.

summary: the takeaway in one or two plain sentences. It is shown if the visual
can't be displayed, and screen readers read it.

Also say the takeaway in your reply text. Titles, memory and notifications read
your text, not the visual.
```

Register both descriptors in `plugin.ts` `init()` (artifact first), export everything from `index.ts`, and add `SHOW_VISUAL_DESCRIPTOR` to `preset.test.ts`'s roll-call.

- [ ] **Step 4: Run, expect PASS:** `pnpm --filter @ax/tool-artifact-publish test && pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/preset.test.ts`
- [ ] **Step 5: Commit:** `git commit -m "visuals: show_visual descriptor and limits in @ax/tool-artifact-publish"`

---

### Task 2: Policy rule `visuals.show` [tier: mechanical]

**Files:**
- Modify: `packages/tool-policy/src/rules.ts` (insert after `artifacts.publish`, :296-304)
- Test: `packages/tool-policy/src/__tests__/rules.test.ts:64-70` (`CATALOG_FACTS` += `'visuals.show'`), `:259-278` (host list += `'show_visual'`), plus one new case

**Interfaces:**
- Produces the rule `{ id: 'visuals.show', match: { tool: 'show_visual' }, providedBy: 'host', verdict: 'allow', capability: 'show you charts and visual cards in the chat', subject: 'agent', provenance: 'catalog' }`. It has no `effect` (not outward, not spending).

- [ ] **Step 1: Write the failing test**

```ts
it('(VISUALS-1) show_visual is a catalog allow with a lint-clean clause', () => {
  expect(evaluate(BUILTIN_RULES, { name: 'show_visual', input: {} }))
    .toMatchObject({ verdict: 'allow', ruleId: 'visuals.show', capability: 'show you charts and visual cards in the chat' });
  expect(lintCapability('show you charts and visual cards in the chat')).toEqual([]);
});
```
- [ ] **Step 2: Run, expect FAIL** (`ruleId: null`): `pnpm --filter @ax/tool-policy test`
- [ ] **Step 3: Add the rule** and the two list entries.
- [ ] **Step 4: Run, expect PASS:** `pnpm --filter @ax/tool-policy test`
- [ ] **Step 5: Commit:** `git commit -m "visuals: tool-policy catalog row for show_visual"`

---

### Task 3: Runner executor `createShowVisualExecutor` [tier: sensitive]

Run `security-checklist`: untrusted model output crosses into host storage over IPC.

**Files:**
- Modify: `packages/agent-runner-core/src/artifact-publish-executor.ts:244-299` (extract the put-then-publish pair; `publishToHost` keeps its degraded branches and calls it)
- Create: `packages/agent-runner-core/src/show-visual-executor.ts`
- Test: `packages/agent-runner-core/src/__tests__/show-visual-executor.test.ts`. The existing `artifact-publish-executor.test.ts` must stay green unchanged.

**Interfaces:**
- Consumes: `MAX_VISUAL_HTML_BYTES`, `MAX_VISUAL_TITLE_CHARS`, `MAX_VISUAL_SUMMARY_CHARS` (Task 1).
- Produces:
  ```ts
  export async function publishBytesToHost(args: {
    client: Pick<IpcClient, 'callBinaryUpload' | 'call'>; conversationId: string;
    bytes: Buffer; path: string; displayName: string; mediaType: string;
  }): Promise<{ artifactId: string; downloadUrl: string; sha256: string }>;
  export interface ShowVisualOutput { artifactId: string; title: string; summary: string }
  export interface CreateShowVisualExecutorOptions { client: Pick<IpcClient, 'callBinaryUpload' | 'call'>; conversationId: string | null }
  export function createShowVisualExecutor(opts: CreateShowVisualExecutorOptions): (call: ToolCall) => Promise<ShowVisualOutput>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const ID = 'f'.repeat(32);
const client = () => ({
  callBinaryUpload: vi.fn(async (_a: string, b: Uint8Array) => ({ sha256: sha(Buffer.from(b).toString('utf8')), size: b.byteLength })),
  call: vi.fn(async () => ({ artifactId: ID, downloadUrl: `ax://artifact/${ID}` })),
});
const run = (c: ReturnType<typeof client>, input: unknown, conversationId: string | null = 'conv-1') =>
  createShowVisualExecutor({ client: c, conversationId })({ id: 'toolu_v', name: 'show_visual', input } as ToolCall);
const HTML = '<canvas id="c"></canvas><script>new Chart(c,{type:"bar",data:{labels:["a"],datasets:[{data:[1]}]}})</script>';

it('publishes the html as a text/html artifact and returns only id, title and summary', async () => {
  const c = client();
  expect(await run(c, { title: ' Issues per cycle ', summary: 'Down 12% over 20 cycles.', html: HTML }))
    .toStrictEqual({ artifactId: ID, title: 'Issues per cycle', summary: 'Down 12% over 20 cycles.' });
  expect(c.callBinaryUpload).toHaveBeenCalledWith('blob.put', Buffer.from(HTML, 'utf8'));
  expect(c.call).toHaveBeenCalledWith('artifact.publish', { conversationId: 'conv-1', sha256: sha(HTML),
    path: `visuals/${sha(HTML)}.html`, displayName: 'visual.html', mediaType: 'text/html', size: Buffer.byteLength(HTML) });
});
it('accepts exactly 102400 bytes and refuses 102401 before any IPC', async () => {
  await expect(run(client(), { title: 't', summary: 's', html: 'a'.repeat(102_400) })).resolves.toBeDefined();
  const c = client();
  await expect(run(c, { title: 't', summary: 's', html: 'a'.repeat(102_401) })).rejects.toThrow(/102401 bytes, over the 100 KB limit/);
  expect(c.callBinaryUpload).not.toHaveBeenCalled();
});
it('counts UTF-8 bytes, not characters', async () => {
  await expect(run(client(), { title: 't', summary: 's', html: '€'.repeat(34_134) })).rejects.toThrow(/over the 100 KB limit/);
});
it.each([
  [{ summary: 's', html: 'h' }, /title is required/], [{ title: '  ', summary: 's', html: 'h' }, /title is required/],
  [{ title: 'a\nb', summary: 's', html: 'h' }, /single line/], [{ title: 'x'.repeat(121), summary: 's', html: 'h' }, /title is too long/],
  [{ title: 't', html: 'h' }, /summary is required/], [{ title: 't', summary: 'x'.repeat(1001), html: 'h' }, /summary is too long/],
  [{ title: 't', summary: 's', html: '   ' }, /html is required/], [{ title: 't', summary: 's', html: 7 }, /html is required/],
])('refuses %j before any IPC', async (input, msg) => {
  const c = client();
  await expect(run(c, input)).rejects.toThrow(msg);
  expect(c.callBinaryUpload).not.toHaveBeenCalled();
});
it('refuses when the session has no conversation', async () => {
  const c = client();
  await expect(run(c, { title: 't', summary: 's', html: 'h' }, null)).rejects.toThrow(/not attached to a conversation/);
  expect(c.callBinaryUpload).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @ax/agent-runner-core exec vitest run src/__tests__/show-visual-executor.test.ts`
- [ ] **Step 3: Implement.** Validate everything before IPC, and trim title and summary. The row key is `visuals/<local sha256>.html`, with `displayName: 'visual.html'` and `mediaType: 'text/html'`. The error copy is exact, because the model reads it to self-correct:
  - `show_visual: title is required (a short single-line string)`
  - `show_visual: title must be a single line`
  - `show_visual: title is too long (${n} characters, max 120)`
  - `show_visual: summary is required (one or two plain sentences)`
  - `show_visual: summary is too long (${n} characters, max 1000)`
  - `show_visual: html is required`
  - ``show_visual: html is ${n} bytes, over the 100 KB limit (102400 bytes). Simplify it (fewer data points, shorter markup) and call show_visual again.``
  - ``show_visual: this session is not attached to a conversation, so a visual can't be shown here``
- [ ] **Step 4: Run, expect PASS:** `pnpm --filter @ax/agent-runner-core test` (the artifact tests prove the refactor).
- [ ] **Step 5: Commit:** `git commit -m "visuals: show_visual executor publishes text/html through blob.put + artifact.publish"`

---

### Task 4: Wire the executor into both runners [tier: integration]

**Files:**
- Modify: `packages/agent-runner-core/src/run-runner.ts:707-738` (register beside `artifact_publish`; update the comment at :707-708 that lists the sandbox tools); `packages/agent-runner-core/src/index.ts` (export executor + types)
- Modify: `packages/agent-claude-sdk-runner/src/main.ts:98-105` (re-export `createShowVisualExecutor` and its types, as is done for `createArtifactPublishExecutor`)
- Modify: `packages/agent-aisdk-runner/package.json` (devDependency `"@ax/tool-artifact-publish": "workspace:*"`, test-only)
- Test: `packages/agent-runner-core/src/__tests__/run-runner.test.ts`, `packages/agent-claude-sdk-runner/src/__tests__/sandbox-mcp-server.test.ts`, `packages/agent-aisdk-runner/src/__tests__/sandbox-tools.test.ts`

**Interfaces:**
- Consumes: `createShowVisualExecutor` (Task 3), `SHOW_VISUAL_TOOL_NAME`, `SHOW_VISUAL_DESCRIPTOR` (Task 1).
- Produces: `@ax/agent-claude-sdk-runner` re-exports `createShowVisualExecutor`, `CreateShowVisualExecutorOptions` and `ShowVisualOutput` (used by Task 13).

- [ ] **Step 1: Write the failing tests**

```ts
// run-runner.test.ts — harness as in 'runRunner — generated file attachment' (:198)
it('(VISUALS-1) registers show_visual when the catalog lists it, bound to the conversation', async () => {
  // tool.list → [{ name: 'show_visual', executesIn: 'sandbox', inputSchema: {} }]; session.get-config → conversationId 'c1'
  let dispatcher!: LocalDispatcher;
  const loop: Loop = { run: async () => {
    await dispatcher.execute({ id: 't1', name: 'show_visual', input: { title: 'T', summary: 'S', html: '<p>x</p>' } });
    return 0;
  } };
  await runRunner((deps) => { dispatcher = deps.localDispatcher; return loop; }, seams(fakeEnv));
  expect(dispatcher.has('show_visual')).toBe(true);
  expect(fakeClient.call.mock.calls.find((c) => c[0] === 'artifact.publish')?.[1])
    .toMatchObject({ conversationId: 'c1', mediaType: 'text/html', displayName: 'visual.html' });
});
it('(VISUALS-1) does not register show_visual when the catalog lacks it', /* tool.list → [] */ …);
// sandbox-mcp-server.test.ts
it('(VISUALS-1) exposes show_visual with its description and passes title/summary/html through', async () => {
  const dispatcher = createLocalDispatcher(); const seen: unknown[] = [];
  dispatcher.register('show_visual', async (c) => { seen.push(c.input); return { artifactId: 'a', title: 't', summary: 's' }; });
  const [entry] = buildSandboxToolEntries(dispatcher, [SHOW_VISUAL_DESCRIPTOR], () => 'id-1');
  expect([entry!.name, entry!.description]).toEqual(['show_visual', SHOW_VISUAL_DESCRIPTOR.description]);
  expect(await entry!.handler({ title: 't', summary: 's', html: '<p>x</p>' }, {} as never))
    .toEqual({ content: [{ type: 'text', text: JSON.stringify({ artifactId: 'a', title: 't', summary: 's' }) }] });
  expect(seen).toEqual([{ title: 't', summary: 's', html: '<p>x</p>' }]);
});
// sandbox-tools.test.ts: the same three facts for buildSandboxTools({ …existing allow-policy harness…, tools: [SHOW_VISUAL_DESCRIPTOR] }).show_visual —
// description equals the descriptor's; execute(input, opts) resolves to that JSON string.
```

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @ax/agent-runner-core test && pnpm --filter @ax/agent-claude-sdk-runner test && pnpm --filter @ax/agent-aisdk-runner test`
- [ ] **Step 3: Implement.** Use `if (tools.some((t) => t.name === SHOW_VISUAL_TOOL_NAME && t.executesIn === 'sandbox')) localDispatcher.register(SHOW_VISUAL_TOOL_NAME, createShowVisualExecutor({ client, conversationId }))`. Add the re-exports and run `pnpm install` for the devDep.
- [ ] **Step 4: Run the Step 2 command, expect PASS,** then `pnpm typecheck`.
- [ ] **Step 5: Commit:** `git commit -m "visuals: both runners expose show_visual through the local dispatcher"`

---

### Task 5: `/api/files` never serves active content as itself [tier: sensitive]

Run `security-checklist`: agent-authored bytes are served on the app origin.

**Files:**
- Modify: `packages/channel-web/src/server/routes-attachments.ts:221-277` (`getFile` uses the new function for `content-type` and `.body(…, type)`; extend the file header's I5 note)
- Test: create `packages/channel-web/src/__tests__/server/routes-attachments-content-type.test.ts`. Use no Postgres: copy only the stubbed `attachments:download` harness from `routes-attachments.test.ts:612-660`, because that file's `beforeAll` starts a container.

**Interfaces:**
- Produces: `export function downloadContentType(mediaType: string): string`. It returns `'application/octet-stream'` when the lowercased essence (before `;`) is one of `text/html`, `application/xhtml+xml`, `image/svg+xml`, `text/xml` or `application/xml`, and otherwise returns `mediaType` unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  ['text/html', 'application/octet-stream'], ['TEXT/HTML; charset=utf-8', 'application/octet-stream'],
  ['application/xhtml+xml', 'application/octet-stream'], ['image/svg+xml', 'application/octet-stream'],
  ['text/xml', 'application/octet-stream'], ['application/xml', 'application/octet-stream'],
  ['text/plain', 'text/plain'], ['application/pdf', 'application/pdf'], ['image/png', 'image/png'],
])('%s → %s', (input, expected) => expect(downloadContentType(input)).toBe(expected));
it('(VISUALS-1) GET /api/files serves a text/html row as an octet-stream attachment', async () => {
  // stub attachments:download → { bytes: Buffer.from('<p>x</p>'), mediaType: 'text/html', sizeBytes: 8, displayName: 'visual.html' }
  const r = await fetch(`http://127.0.0.1:${port}/api/files?conversationId=c1&id=att-1`);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toMatch(/^application\/octet-stream(;|$)/);
  expect(r.headers.get('content-disposition')).toBe('attachment; filename="visual.html"');
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await r.text()).toBe('<p>x</p>');
});
```
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-attachments-content-type.test.ts`
- [ ] **Step 3: Implement `downloadContentType`** and use it in `getFile`.
- [ ] **Step 4: Run, expect PASS** (plus `routes-attachments.test.ts` in CI or with Docker), then `pnpm typecheck`.
- [ ] **Step 5: Commit:** `git commit -m "visuals: /api/files serves html/svg/xml rows as octet-stream"`

---

### Task 6: Thread contract, shared parser, `buildThread` [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-types.ts:652-686` (add `ThreadVisual`; `visuals?: readonly ThreadVisual[]` on the `agent` variant only)
- Create: `packages/channel-web/src/lib/visual-result.ts`. It is imported by the server, so it uses `.js` relative imports with no React and no assets; `__tests__/server-import-extensions.test.ts` already walks it.
- Modify: `packages/channel-web/src/server/routes-workspace.ts:3905-3960` (`buildThread` tool-turn branch)
- Test: `packages/channel-web/src/lib/__tests__/visual-result.test.ts`, `packages/channel-web/src/__tests__/server/routes-workspace.test.ts` (beside the TASK-995 chip case, :1151)

**Interfaces:**
- Produces:
  ```ts
  // workspace-types.ts
  export interface ThreadVisual { artifactId: string; title: string; summary: string }
  // visual-result.ts
  export const SHOW_VISUAL_TOOL_NAMES: readonly string[];        // ['show_visual', 'mcp__ax-sandbox-tools__show_visual']
  export function isShowVisualToolName(name: unknown): boolean;   // exactly those two
  export const VISUAL_ARTIFACT_ID_RE: RegExp;                     // /^[A-Za-z0-9_-]{1,128}$/ (mirrors AttachmentIdSchema)
  export const VISUAL_TITLE_MAX_CHARS = 120;                      // mirrors MAX_VISUAL_TITLE_CHARS (Task 1)
  export const VISUAL_SUMMARY_MAX_CHARS = 1000;
  export function visualFromToolResult(content: unknown): ThreadVisual | null;
  ```
  `visualFromToolResult` takes `tool_result.content` in **both** shapes: a string, or an array of blocks whose `{ type: 'text' }` entries are candidates. For each candidate it tries `JSON.parse` on the whole text, then on its first line. It accepts only an object with a valid `artifactId`, `title` passed through `fenceLine(·,120)` and `summary` passed through `fenceLine(·,1000)`, and returns exactly those three keys.
  In the tool-turn branch, `buildThread` collects the `tool_use` ids whose `isShowVisualToolName(name)`, parses their non-error, non-held results and dedupes by `artifactId`. It emits the `agent` message when there are attachments, text or visuals, and **omits** the `visuals` key when there are none, so the existing strict-equality tests stay green.

- [ ] **Step 1: Write the failing tests**

```ts
// visual-result.test.ts
const ok = { artifactId: '0123456789abcdef0123456789abcdef', title: 'Issues per cycle', summary: 'Down 12%.' };
it('reads the string form, the block-array form and a JSON first line', () => {
  expect(visualFromToolResult(JSON.stringify(ok))).toStrictEqual(ok);
  expect(visualFromToolResult([{ type: 'image' }, { type: 'text', text: JSON.stringify(ok) }])).toStrictEqual(ok);
  expect(visualFromToolResult(`${JSON.stringify(ok)}\nA runner note.`)).toStrictEqual(ok);
});
it('keeps only id, title and summary', () =>
  expect(visualFromToolResult(JSON.stringify({ ...ok, html: '<p>x</p>', path: 'visuals/x.html' }))).toStrictEqual(ok));
it.each(['', '../x', 'a b', 'x'.repeat(129), 7])('refuses artifactId %j', (id) =>
  expect(visualFromToolResult(JSON.stringify({ ...ok, artifactId: id }))).toBeNull());
it('agrees with AttachmentIdSchema', () => {
  for (const id of ['a', 'A-_9', 'x'.repeat(128), 'x'.repeat(129), 'a.b', 'a/b', ''])
    expect(VISUAL_ARTIFACT_ID_RE.test(id)).toBe(AttachmentIdSchema.safeParse(id).success);
});
it('fences title and summary; refuses blank ones and non-JSON', () => {
  const v = visualFromToolResult(JSON.stringify({ ...ok, title: 'Q3\u202Eevil', summary: 's'.repeat(1500) }))!;
  expect(v.title).not.toContain('\u202E');
  expect(v.summary.length).toBeLessThanOrEqual(1000);
  expect(visualFromToolResult(JSON.stringify({ ...ok, title: '  ' }))).toBeNull();
  expect(visualFromToolResult('not json')).toBeNull();
});
it('matches exactly the two runner spellings', () => {
  expect(['show_visual', 'mcp__ax-sandbox-tools__show_visual', 'mcp__linear__show_visual', 'artifact_publish'].map(isShowVisualToolName))
    .toEqual([true, true, false, false]);
});
// routes-workspace.test.ts
it('(VISUALS-1) draws a visual from a show_visual result and never sends its html', async () => {
  // assistant turn: tool_use v1 'mcp__ax-sandbox-tools__show_visual' input { title, summary, html: '<p>secret-markup</p>' },
  //                 tool_use v2 'show_visual', tool_use v3 'show_visual', tool_use p1 'artifact_publish'
  // tool turn: v1 result (array form, ok), v2 (is_error: true), v3 (held: true), p1 content = JSON.stringify(ok)
  const agents = body.thread.filter((m) => m.kind === 'agent');
  expect(agents.flatMap((m) => (m.visuals as unknown[] | undefined) ?? [])).toStrictEqual([ok]);
  expect(JSON.stringify(captured.body)).not.toContain('secret-markup');
});
it('(VISUALS-1) keeps two visuals from one turn and folds a repeated id', …); // → 2 entries, not 3
```
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/visual-result.test.ts src/__tests__/server/routes-workspace.test.ts`
- [ ] **Step 3: Implement** as specified above.
- [ ] **Step 4: Run the Step 2 command and `src/__tests__/server-import-extensions.test.ts`, expect PASS,** then `pnpm typecheck`.
- [ ] **Step 5: Commit:** `git commit -m "visuals: ThreadVisual from show_visual results in buildThread"`

---

### Task 7: Chart palette tokens [tier: mechanical]

**Files:**
- Modify: `packages/channel-web/src/index.css` in **all three** blocks: light `:root` (:34), `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])` (:91) and `:root[data-theme='dark']` (:146)
- Test: `packages/channel-web/src/__tests__/theme-contrast.test.ts`. Widen `tokensAfter`'s pattern at :60 from `(--[a-z-]+)` to `(--[a-z0-9-]+)`, because digit names are silently skipped today. Add the new describe **at the end of the file**, after `AA_NON_TEXT` (:1212) is declared.

**Interfaces:**
- Produces:
  - Light: `--chart-1: 242.71 63.03% 58.63%; --chart-2: 173 80% 29%; --chart-3: 28 90% 42%; --chart-4: 340 70% 47%; --chart-5: 201 90% 37%;`
  - Both dark blocks: `--chart-1: 245.33 100% 82.35%; --chart-2: 168 60% 50%; --chart-3: 38 92% 60%; --chart-4: 340 85% 72%; --chart-5: 199 88% 62%;`
  - Measured worst cases are 3.75:1 light and 5.75:1 dark. The builder may retune using the `dataviz` skill as long as the test stays green.

- [ ] **Step 1: Write the failing test**

```ts
describe('chart palette (VISUALS-1)', () => {
  for (const [name, selector] of THEMES) {
    const tokens = tokensAfter(selector);
    for (const n of [1, 2, 3, 4, 5]) for (const surface of ['--background', '--card'] as const) {
      it(`${name}: --chart-${n} on ${surface} clears ${AA_NON_TEXT}:1`, () => {
        const c = tokens.get(`--chart-${n}`);
        expect(c, `--chart-${n} missing from ${selector}`).toBeDefined();
        expect(contrast(c!, tokens.get(surface)!)).toBeGreaterThanOrEqual(AA_NON_TEXT);
      });
    }
  }
});
```
- [ ] **Step 2: Run, expect FAIL** (missing tokens): `pnpm --filter @ax/channel-web exec vitest run src/__tests__/theme-contrast.test.ts`
- [ ] **Step 3: Add the tokens and widen the regex.**
- [ ] **Step 4: Run, expect PASS.** The whole file must stay green after the widening.
- [ ] **Step 5: Commit:** `git commit -m "visuals: --chart-1..5 palette in both themes, contrast-pinned"`

---

### Task 8: Vendored libraries and the Inter subset [tier: sensitive]

Run `security-checklist`: new dependencies.

**Files:**
- Modify: `packages/channel-web/package.json` (devDependencies, **exact** pins `"chart.js": "4.5.1"` and `"html-to-image": "1.11.13"`, then `pnpm install`)
- Create: `packages/channel-web/vendor-aliases.ts`. It exports `vendorAliases: Record<string, string>` with two entries:
  - `'ax-vendor/chart.umd.min.js'` → `join(dirname(require.resolve('chart.js')), 'chart.umd.min.js')`. This is needed because chart.js's `exports` map hides `dist/`.
  - `'ax-vendor/html-to-image.js'` → `join(dirname(require.resolve('html-to-image')), '..', 'dist', 'html-to-image.js')`.
  - Use `createRequire(import.meta.url)`.
- Modify: `vite.config.ts` and `vitest.config.ts` (`resolve.alias: { '@': …, ...vendorAliases }`); `src/assets.d.ts` (`declare module '*?raw' { const source: string; export default source; }` and the same shape for `'*?inline'`)
- Create: `src/components/workspace/visual/fonts/inter-{400,500,600}-latin.woff` from the app's own TTFs (the command is recorded in the `visual-assets.ts` header). It uses fonttools 4.61.1; `pip install --user fonttools==4.61.1` if it is missing. The measured 400 subset is 30,820 bytes.
  ```bash
  for w in regular:400 medium:500 semibold:600; do
    pyftsubset "packages/channel-web/public/fonts/inter-${w%%:*}.ttf" \
      --unicodes='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2070-209F,U+20AC,U+2122,U+2190-2199,U+2212,U+2215,U+2248,U+2260,U+2264-2265,U+25A0-25FF' \
      --layout-features='*' --flavor=woff \
      --output-file="packages/channel-web/src/components/workspace/visual/fonts/inter-${w##*:}-latin.woff"
  done
  ```
- Create: `src/components/workspace/visual/visual-assets.ts`
- Test: `src/components/workspace/visual/__tests__/visual-assets.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const VISUAL_LIBRARY_SOURCES: readonly string[];          // [chart.js UMD, html-to-image UMD], via '?raw'
  export const INTER_FONT_URLS: Readonly<Record<400 | 500 | 600, string>>;  // via '?inline'
  export function fontFaceCss(urls: Readonly<Record<400 | 500 | 600, string>>): string;
  export const VISUAL_FONT_FACE_CSS: string;                        // fontFaceCss(INTER_FONT_URLS)
  ```
  Each rule has the form `@font-face{font-family:'Inter';font-style:normal;font-weight:<w>;font-display:block;src:url(<data url>) format('woff')}`.

- [ ] **Step 1: Write the failing tests**

```ts
it('inlines the three subsets as WOFF data URLs', () => {
  for (const url of Object.values(INTER_FONT_URLS)) expect(url).toMatch(/^data:font\/woff;base64,[A-Za-z0-9+/]+=*$/);
});
it('keeps each subset a small, real WOFF', () => {
  for (const w of [400, 500, 600]) {
    const b = readFileSync(join(FONTS_DIR, `inter-${w}-latin.woff`));
    expect(b.subarray(0, 4).toString('latin1')).toBe('wOFF');
    expect(b.byteLength).toBeLessThan(40_000);
  }
});
it('declares one face per weight from data URLs only', () => {
  const css = fontFaceCss({ 400: 'data:a', 500: 'data:b', 600: 'data:c' });
  expect(css.match(/@font-face/g)).toHaveLength(3);
  expect(css).toContain("font-family:'Inter'");
  expect(css).not.toMatch(/url\((?!data:)/);
});
it('vendors the pinned libraries', () => {
  expect(VISUAL_LIBRARY_SOURCES[0]).toMatch(/\bChart\b/);
  expect(VISUAL_LIBRARY_SOURCES[0]!.length).toBeGreaterThan(150_000);
  expect(VISUAL_LIBRARY_SOURCES[1]).toMatch(/htmlToImage/);
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
  expect([pkg.devDependencies['chart.js'], pkg.devDependencies['html-to-image']]).toEqual(['4.5.1', '1.11.13']);
});
```
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/visual/__tests__/visual-assets.test.ts`
- [ ] **Step 3: Implement.** If vitest returns a path rather than a data URL for `?inline`, switch to a runtime fetch of `/fonts/visual/*.woff`. In that case the files move to `public/fonts/visual/`, and `loadVisualHtml`'s caller converts them to `data:` URLs before assembly. Record the switch in the decisions shard.
- [ ] **Step 4: Run, expect PASS,** then `pnpm typecheck` and `pnpm --filter @ax/channel-web build`. The libraries must not appear in the main chunk; Task 12 lazy-loads this module.
- [ ] **Step 5: Commit** (lockfile included): `git commit -m "visuals: vendor chart.js 4.5.1 + html-to-image 1.11.13 as raw strings; Inter Latin subsets"`

---

### Task 9: srcdoc assembly and the parent `frame-src` policy [tier: sensitive]

Run `security-checklist`: this is the box.

**Files:**
- Create: `packages/channel-web/src/components/workspace/visual/visual-doc.ts`
- Modify: `packages/channel-web/index.html`. Add `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'" />` right after `<meta charset>`, with a short comment explaining why.
- Test: `…/visual/__tests__/visual-doc.test.ts`, `packages/channel-web/src/__tests__/index-html-csp.test.ts` (`// @vitest-environment node`)

**Interfaces:**
- Produces:
  ```ts
  export const VISUAL_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'";
  export const APP_FRAME_CSP = "frame-src 'none'";
  export const VISUAL_IFRAME_SANDBOX = 'allow-scripts';
  export const VISUAL_MIN_HEIGHT = 48, VISUAL_DEFAULT_HEIGHT = 280, VISUAL_MAX_HEIGHT = 1200;
  export const VISUAL_TOKEN_NAMES: readonly string[]; // --background --foreground --card --card-foreground --popover --popover-foreground
      // --muted --muted-foreground --border --primary --primary-foreground --accent --accent-foreground --destructive
      // --warning --ring --radius --chart-1 … --chart-5
  export type VisualMode = 'light' | 'dark';
  export interface VisualAssets { fontFaceCss: string; librarySources: readonly string[]; runtimeSource: string }
  export interface VisualDocInput { html: string; mode: VisualMode; tokens: Readonly<Record<string, string>>; standalone?: boolean }
  export function sanitizeTokens(tokens: Readonly<Record<string, string>>): Record<string, string>; // allow-listed names; value
      // must match /^(?:\d+(?:\.\d+)?(?:deg)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%|\d+(?:\.\d+)?(?:rem|px))$/
  export function readThemeTokens(root?: Element): Record<string, string>; // getComputedStyle → sanitizeTokens
  export function inlineScript(source: string): string;  // '</script' → '<\/script', '<!--' → '<\!--' (case-insensitive)
  export function buildVisualDocument(input: VisualDocInput, assets: VisualAssets): string;
  export function visualFileName(title: string, ext: 'png' | 'html'): string; // keep [A-Za-z0-9 ._-], collapse spaces,
      // trim, drop leading dots, cut to 80, fallback 'visual'
  ```
  The document is assembled in exactly this order:
  1. `<!doctype html><html lang="en" data-theme="{mode}" data-max-height="1200"><head>`
  2. The CSP meta: **the first child of head**.
  3. `<meta http-equiv="x-dns-prefetch-control" content="off">` and `<meta charset="utf-8">`.
  4. `<style id="ax-fonts">`.
  5. `<style id="ax-theme">:root{tokens…;color-scheme:{mode}}`.
  6. `<style id="ax-base">`, carrying the base CSS below, plus for `standalone`: `html{overflow:auto;background:hsl(var(--card))}body{max-width:720px;margin:24px auto}`.
  7. One `<script>` per library (through `inlineScript`).
  8. `<script>{runtime}\naxVisualRuntime(window, parent);</script>`.
  9. `</head><body>{html}</body></html>`.

  The base CSS:
  ```css
  html{overflow:hidden}
  body{margin:0;padding:12px 16px 16px;background:transparent;color:hsl(var(--card-foreground));font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-feature-settings:'cv11';letter-spacing:-0.005em;-webkit-font-smoothing:antialiased}
  h1,h2,h3{margin:0 0 8px;font-weight:600;line-height:1.3}h1{font-size:20px}h2{font-size:16px}h3{font-size:14px}
  p{margin:0 0 8px}small,.muted{color:hsl(var(--muted-foreground))}
  table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:6px 8px;text-align:left;border-bottom:1px solid hsl(var(--border))}th{font-weight:500;color:hsl(var(--muted-foreground))}
  code,pre,kbd{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:12.5px}
  canvas,svg,img{max-width:100%}
  ```

- [ ] **Step 1: Write the failing tests** (fake assets `{ fontFaceCss: '/*f*/', librarySources: ['/*lib*/'], runtimeSource: '/*rt*/' }`; parse with `new DOMParser().parseFromString(doc, 'text/html')`)

```ts
it('puts the CSP meta first in head with the exact policy', () => {
  const d = parse(buildVisualDocument({ html: '<p>hi</p>', mode: 'light', tokens: {} }, fake));
  const first = d.head.firstElementChild!;
  expect([first.getAttribute('http-equiv'), first.getAttribute('content')]).toEqual(['Content-Security-Policy', VISUAL_FRAME_CSP]);
  for (const bad of ["'unsafe-eval'", 'http:', 'https:', '*']) expect(VISUAL_FRAME_CSP).not.toContain(bad);
});
it('(RF2) keeps the box around a whole agent document', () => {
  const html = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><style>.k{color:hsl(var(--primary))}</style></head><body><div class="k">x</div></body></html>';
  const d = parse(buildVisualDocument({ html, mode: 'light', tokens: {} }, fake));
  expect(d.head.firstElementChild!.getAttribute('content')).toBe(VISUAL_FRAME_CSP);
  expect(d.querySelectorAll('html')).toHaveLength(1);
  expect(d.documentElement.innerHTML).toContain('.k{color:hsl(var(--primary))}');
  expect(d.querySelector('body .k')?.textContent).toBe('x');
});
it('runs the runtime from head, after the libraries, before any agent markup', …); // last head script ends 'axVisualRuntime(window, parent);'
it('escapes </script inside inlined sources', () => {
  const d = parse(buildVisualDocument({ html: '', mode: 'light', tokens: {} }, { ...fake, librarySources: ['var s="</script><img src=x>";'] }));
  expect(d.head.querySelector('img')).toBeNull();
  expect(d.head.innerHTML).toContain('<\\/script>');
});
it('writes only allow-listed, well-formed tokens', () => {
  const doc = buildVisualDocument({ html: '', mode: 'dark', tokens: { '--background': '226.67 15.25% 11.57%', '--radius': '0.5625rem', '--evil': '0 0% 0%', '--card': 'red;}</style><script>x</script>' } }, fake);
  expect(doc).toContain('--background:226.67 15.25% 11.57%');
  expect(doc).toContain('--radius:0.5625rem');
  expect(doc).not.toContain('--evil');
  expect(doc).not.toContain('<script>x</script>');
  expect(doc).toContain('color-scheme:dark');
  expect(doc).toContain('data-theme="dark"');
});
it('names downloads from the title', () => {
  expect(visualFileName('Issues per cycle (Q3)', 'png')).toBe('Issues per cycle Q3.png');
  expect(visualFileName('<script>', 'html')).toBe('script.html');
  expect(visualFileName('  ...  ', 'png')).toBe('visual.png');
  expect(visualFileName('x'.repeat(200), 'html')).toBe(`${'x'.repeat(80)}.html`);
});
// index-html-csp.test.ts
it("the app shell carries exactly one CSP, frame-src 'none', inside head", () => {
  const html = readFileSync(join(PKG_DIR, 'index.html'), 'utf8');
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi)];
  expect(metas.map((m) => m[1])).toEqual([APP_FRAME_CSP]);
  expect(html.indexOf(metas[0]![0])).toBeLessThan(html.indexOf('</head>'));
});
```
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/visual/__tests__/visual-doc.test.ts src/__tests__/index-html-csp.test.ts`
- [ ] **Step 3: Implement** `visual-doc.ts` and the index.html meta.
- [ ] **Step 4: Run, expect PASS,** then `pnpm typecheck`.
- [ ] **Step 5: Commit:** `git commit -m "visuals: srcdoc assembly with CSP first; parent frame-src 'none'"`

---

### Task 10: Frame runtime [tier: integration]

**Files:**
- Create: `…/visual/frame-runtime.js`: plain ES2020, no imports or exports. It defines `window.axVisualRuntime = function axVisualRuntime(win, host) {…}` (an assignment, so lint sees no unused binding). The runtime runs inside the untrusted box and grants nothing, so it is not a security boundary.
- Create: `…/visual/frame-runtime-source.ts` (`export { default as FRAME_RUNTIME_SOURCE } from './frame-runtime.js?raw'`)
- Modify: `…/visual/visual-assets.ts` (add `DEFAULT_VISUAL_ASSETS: VisualAssets`)
- Test: `…/visual/__tests__/frame-runtime.test.ts`. Evaluate `FRAME_RUNTIME_SOURCE` in a fresh `new JSDOM(doc, { runScripts: 'outside-only', pretendToBeVisual: true })` and call `win.axVisualRuntime(win, host)`, where `host` is a second JSDOM window with `postMessage` spied.

**Interfaces:**
- Consumes: the document shape from Task 9 (`#ax-fonts`, `data-max-height`).
- Produces the wire protocol (exact):
  - Parent → frame: `{ type: 'ax-visual:theme', mode: 'light'|'dark', tokens: Record<string,string> }` and `{ type: 'ax-visual:export', requestId: string, format: 'png' }`. Added after the kind walk (BUG-2): `{ type: 'ax-visual:visible' }`, posted by VisualFrame each time a ready card comes into view; the runtime refits its charts on it.
  - Frame → parent, always `host.postMessage(msg, '*')`: `{ type: 'ax-visual:size', height }`, `{ type: 'ax-visual:ready', height, rendered }`, `{ type: 'ax-visual:error' }` (never error text) and `{ type: 'ax-visual:export-result', requestId, ok, blob? }`.
- Produces `win.ax = { color(name): string, chartColor(name): () => string, resolve(css: string): string }`:
  - `color('chart-1')` returns `'hsl(' + <current --chart-1> + ')'`.
  - `chartColor` returns a Chart.js scriptable option, so it re-resolves on each update.
  - `resolve` replaces each `var(--x)` in a string with the current value.
- Required behavior:
  1. The first `error` or `unhandledrejection` **before ready** posts `ax-visual:error` once.
  2. Height is `Math.ceil(documentElement.scrollHeight)`. A ResizeObserver (guarded) watches it, coalesced per animation frame, and posts `size` on change. It sets `documentElement.style.overflowY` to `'auto'` only when the height exceeds `data-max-height`.
  3. On `load`, after two animation frames, it posts `ready` once. `rendered` is true when the body has an element child or non-whitespace text **and** the height is at least 8.
  4. It ignores every `message` whose `source !== host`.
     - For `theme`, the mode must be light or dark, and keys and values pass the Task 9 patterns. It then sets the properties, `style.colorScheme` and `dataset.theme`, reapplies the Chart defaults, calls `update('none')` on each `Chart.instances` entry, and dispatches `ax:theme`.
     - For `export` with `format === 'png'`, it calls `htmlToImage.toBlob(document.body, { pixelRatio: 2, fontEmbedCSS: <#ax-fonts text>, backgroundColor: ax.color('card') })`. `fontEmbedCSS` is required because CSP blocks html-to-image's own font fetch. It answers `ok:false` when the helper is missing or fails.
  5. When `win.Chart` exists:
     - Set `Chart.defaults.font.family` to `"Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"` and the size to 12.
     - Theme defaults: `color` comes from muted-foreground, `borderColor` from border, and the tooltip colors from popover, popover-foreground and border, with `borderWidth` 1.
     - Register `{ id: 'axTheme', beforeUpdate(chart) }`. For each dataset, an unset `backgroundColor`/`borderColor` becomes `chartColor('chart-' + (i % 5 + 1))`. `i` is `ctx.dataIndex` for pie, doughnut and polarArea, and the dataset index otherwise. A string containing `var(--` becomes `() => ax.resolve(original)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('posts ready once after load', async () => { /* dispatch load, flush rAF */
  expect(readyCalls(host)).toEqual([[{ type: 'ax-visual:ready', height: expect.any(Number), rendered: expect.any(Boolean) }, '*']]);
});
it('reports an error before ready, once, without its text', () => { /* two ErrorEvents before load */
  expect(posted(host, 'ax-visual:error')).toEqual([{ type: 'ax-visual:error' }]);
});
it('applies a theme only from the host', () => {
  // MessageEvent { source: host, data: { type: 'ax-visual:theme', mode: 'dark', tokens: { '--background': '226.67 15.25% 11.57%' } } }
  expect(win.document.documentElement.style.getPropertyValue('--background')).toBe('226.67 15.25% 11.57%');
  expect([win.document.documentElement.style.colorScheme, win.document.documentElement.dataset.theme]).toEqual(['dark', 'dark']);
  // the same message from another window changes nothing
});
it('answers an export with ok:false when the image helper is missing', () => {
  expect(posted(host, 'ax-visual:export-result')).toEqual([{ type: 'ax-visual:export-result', requestId: 'r1', ok: false }]);
});
it('(RF1) resolves var() colors a model writes into Chart.js options', () => {
  // :root{--chart-1:242.71 63.03% 58.63%;--chart-2:173 80% 29%}; win.Chart = { defaults: { font: {}, plugins: { tooltip: {} } }, register: vi.fn(), instances: {} }
  const plugin = win.Chart.register.mock.calls[0][0];
  const data = { datasets: [{ backgroundColor: 'hsl(var(--chart-1))' }, {}] };
  plugin.beforeUpdate({ config: { type: 'bar' }, data });
  expect(data.datasets[0].backgroundColor({ datasetIndex: 0, dataIndex: 0 })).toBe('hsl(242.71 63.03% 58.63%)');
  expect(data.datasets[1].backgroundColor({ datasetIndex: 1, dataIndex: 0 })).toBe('hsl(173 80% 29%)');
  expect(win.Chart.defaults.font.family).toMatch(/^Inter,/);
});
```
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/visual/__tests__/frame-runtime.test.ts`
- [ ] **Step 3: Implement** the runtime and `DEFAULT_VISUAL_ASSETS = { fontFaceCss: VISUAL_FONT_FACE_CSS, librarySources: VISUAL_LIBRARY_SOURCES, runtimeSource: FRAME_RUNTIME_SOURCE }`.
- [ ] **Step 4: Run, expect PASS,** then `pnpm lint` (the `.js` file is linted).
- [ ] **Step 5: Commit:** `git commit -m "visuals: in-frame runtime (size, ready, theme, png export, chart theme)"`

---

### Task 11: `VisualFrame`: message filter, chrome, downloads [tier: sensitive]

Run `security-checklist`: the parent's trust boundary. Run the `shadcn` skill for the chrome.

**Files:**
- Create: `…/visual/frame-messages.ts`, `…/visual/visual-source.ts`, `…/visual/VisualFrame.tsx`
- Test: `…/visual/__tests__/frame-messages.test.ts`, `…/visual/__tests__/VisualFrame.test.tsx`. Use `vi.mock('@/lib/http')` for `httpFetch`, `vi.mock('@/lib/file-download')` for `saveBlob`, and mock `../visual-assets` with tiny assets. Open the menu with `fireEvent.keyDown(trigger, { key: 'Enter' })`, as in `UserMenu.theme-keyboard.test.tsx`.

**Interfaces:**
- Consumes: `ThreadVisual` (Task 6); `buildVisualDocument`, `readThemeTokens`, `visualFileName`, `VISUAL_IFRAME_SANDBOX` and the height constants (Task 9); `DEFAULT_VISUAL_ASSETS` (Task 10); `useResolvedTheme` (`lib/theme.ts`); `httpFetch`; `saveBlob`.
- Produces:
  ```ts
  // frame-messages.ts
  export const VISUAL_MAX_EXPORT_BYTES = 15 * 1024 * 1024;
  export type FrameMessage = { type: 'size'; height: number } | { type: 'ready'; height: number; rendered: boolean }
    | { type: 'error' } | { type: 'export-result'; requestId: string; blob: Blob | null };
  export function clampHeight(h: number): number;      // [VISUAL_MIN_HEIGHT, VISUAL_MAX_HEIGHT]
  export function parseFrameMessage(event: Pick<MessageEvent, 'data' | 'source' | 'origin'>, frame: Window | null,
    pendingExports: ReadonlySet<string>): FrameMessage | null;
  export async function isPngBlob(blob: Blob): Promise<boolean>;   // first 8 bytes 89 50 4E 47 0D 0A 1A 0A
  // visual-source.ts
  export const VISUAL_MAX_FETCH_BYTES = 256 * 1024;
  export function loadVisualHtml(conversationId: string, artifactId: string): Promise<string>;
  export function rememberHeight(artifactId: string, h: number): void;
  export function recalledHeight(artifactId: string): number | undefined;
  // VisualFrame.tsx
  export function VisualFrame(props: { conversationId: string; visual: ThreadVisual }): JSX.Element;
  export default VisualFrame;
  ```
- Rules:
  - `parseFrameMessage` returns `null` unless `source === frame`, `origin === 'null'`, the data is a plain object and the type is one of the four. Heights must be finite and are then clamped.
  - For `export-result` the `requestId` must be pending, or the message is ignored. With `ok === true` the blob must be `instanceof Blob`, between 1 and 15 MiB, and of type `image/png`; anything else yields `blob: null`.
  - `loadVisualHtml` calls `httpFetch('/api/files?conversationId=<enc>&id=<enc>')`. It rejects when the response is not OK, when `content-length` exceeds 256 KiB (**before** `text()`) or when the text exceeds 256 KiB. It caches the promise per (conversationId, artifactId), keeps at most 32 entries and evicts a rejection.
  - The height cache keeps at most 200 entries.
  - Both caches are module-level. Tests must use a distinct `artifactId` per case, except the RF4 remount case, which depends on the cache.
- `VisualFrame` layout and behavior:
  - **Layout.** A shadcn `Card` (`w-full max-w-[604px] overflow-hidden`) holds a header with the title (`text-sm font-medium`) and a `DropdownMenu`. The trigger is `Button variant="ghost" size="icon" aria-label="Download visual"` with a lucide `Download` icon. The items are "Download as PNG" (disabled until ready) and "Download as HTML" (disabled until the HTML loads).
  - **The iframe** sets `sandbox={VISUAL_IFRAME_SANDBOX}`, `title={visual.title}` and `aria-describedby` → `<p className="sr-only">{summary}</p>`. Its height is `recalledHeight() ?? VISUAL_DEFAULT_HEIGHT`. It stays at `opacity-0` with a `Skeleton` until ready, then becomes `opacity-100 transition-opacity motion-reduce:transition-none`. The fade is skipped when a height was recalled.
  - **The srcdoc** is built **once per html** from the mode and tokens at that moment. A theme change posts `{ type: 'ax-visual:theme', mode, tokens: readThemeTokens() }` to `contentWindow` with `'*'` whenever `[mode, ready]` changes and the frame is ready. It never rebuilds the srcdoc.
  - **Failure** means the fetch failed, an error arrived before ready, `ready.rendered` was false, or there was no ready within 8 s. It replaces the frame with `<p className="text-sm text-muted-foreground">This visual couldn't be displayed.</p>` plus the summary.
  - **PNG download.** Use `crypto.randomUUID()` as the pending id and post the export request. The export times out after 10 s. On a PNG blob, call `saveBlob(new Blob([blob], { type: 'image/png' }), visualFileName(title, 'png'))`. Otherwise show the muted line "We couldn't make a picture of this visual. The HTML download still works."
  - **HTML download.** Call `saveBlob(new Blob([buildVisualDocument({ html, mode, tokens: readThemeTokens(), standalone: true }, DEFAULT_VISUAL_ASSETS)], { type: 'text/html' }), visualFileName(title, 'html'))`.

- [ ] **Step 1: Write the failing tests**

```ts
// frame-messages.test.ts
it('ignores other windows, other origins and unknown types', () => {
  const ev = (o: object) => ({ source: frameWin, origin: 'null', data: { type: 'ax-visual:size', height: 300 }, ...o });
  expect(parseFrameMessage(ev({}), frameWin, new Set())).toEqual({ type: 'size', height: 300 });
  expect(parseFrameMessage(ev({ source: window }), frameWin, new Set())).toBeNull();
  expect(parseFrameMessage(ev({ origin: window.location.origin }), frameWin, new Set())).toBeNull();
  expect(parseFrameMessage(ev({ data: { type: 'ax-oauth-done' } }), frameWin, new Set())).toBeNull();
  expect(parseFrameMessage(ev({ data: { type: 'ax-visual:size', height: 'NaN' } }), frameWin, new Set())).toBeNull();
});
it('clamps heights', () => {
  expect([99_999, -5].map((h) => parseFrameMessage({ source: frameWin, origin: 'null', data: { type: 'ax-visual:size', height: h } }, frameWin, new Set())))
    .toEqual([{ type: 'size', height: 1200 }, { type: 'size', height: 48 }]);
});
it('accepts an export result only for a pending id, and only a bounded png', () => {
  const r = (blob: unknown, requestId = 'r1') => parseFrameMessage({ source: frameWin, origin: 'null',
    data: { type: 'ax-visual:export-result', requestId, ok: true, blob } }, frameWin, new Set(['r1']));
  expect(r(new Blob(['x'], { type: 'image/png' }), 'forged')).toBeNull();
  expect(r(new Blob([new Uint8Array(VISUAL_MAX_EXPORT_BYTES + 1)], { type: 'image/png' }))).toEqual({ type: 'export-result', requestId: 'r1', blob: null });
  expect(r(new Blob(['<p>'], { type: 'text/html' }))).toEqual({ type: 'export-result', requestId: 'r1', blob: null });
});
it('checks the png signature', async () => {
  expect(await isPngBlob(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])]))).toBe(true);
  expect(await isPngBlob(new Blob(['GIF89a']))).toBe(false);
});
// VisualFrame.test.tsx
it('renders a frame sandboxed with exactly allow-scripts, titled and described', async () => {
  const f = await screen.findByTitle('Issues per cycle');
  expect(f.getAttribute('sandbox')).toBe('allow-scripts');
  expect(f.getAttribute('srcdoc')).toContain('<p>chart</p>');
  expect(document.getElementById(f.getAttribute('aria-describedby')!)?.textContent).toBe('Down 12%.');
  expect(httpFetch).toHaveBeenCalledWith('/api/files?conversationId=c1&id=0123456789abcdef0123456789abcdef');
});
it('grows to the size its own frame reports and ignores other windows', …);   // 400 → style.height '400px'
it('shows the quiet failure with the summary on an error before ready, and on a 404', …);
it('(RF5) never reads an oversized artifact', async () => {
  // httpFetch → Response with header content-length: 50000000 and a spied text()
  expect(await screen.findByText("This visual couldn't be displayed.")).toBeInTheDocument();
  expect(textSpy).not.toHaveBeenCalled();
});
it('posts a theme change to the frame without rebuilding it', …);  // srcdoc string identical before/after setTheme('dark')
it('(RF3) a theme toggled while loading reaches the frame on ready', async () => {
  // render; setTheme('dark') before any ready message; then dispatch ready from the frame
  expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'ax-visual:theme', mode: 'dark' }), '*');
});
it('(RF4) a remount reuses the html and the last height', async () => {
  // mount, report size 400, unmount, mount again with the same artifactId
  expect(httpFetch).toHaveBeenCalledTimes(1);
  expect((await screen.findByTitle('Issues per cycle')).style.height).toBe('400px');
});
it('downloads HTML: a standalone document with the CSP and the agent markup', …); // saveBlob(Blob text/html, 'Issues per cycle.html')
it('downloads PNG only when the frame answers with a real png', …);  // forged signature → no saveBlob + the muted line
```
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/visual`
- [ ] **Step 3: Implement** the three modules as specified. Use only installed shadcn primitives and semantic tokens (no raw colors).
- [ ] **Step 4: Run, expect PASS,** then `pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit:** `git commit -m "visuals: VisualFrame with validated postMessage, theme sync and PNG/HTML downloads"`

---

### Task 12: Thread rendering and the live path [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/workspace/AgentConversation.tsx`:
  - Use `const VisualFrame = lazy(() => import('./visual/VisualFrame'))`. Render `m.visuals` after `<Steps>` and before the file chips (:1266), only when `conversationId !== null`, with `key={v.artifactId}` and a `Suspense` fallback `Skeleton` of `VISUAL_DEFAULT_HEIGHT`.
  - In `threadGrowthKey` (:163), give `'agent'` its own case that includes `(m.visuals ?? []).length`.
- Modify: `packages/channel-web/src/lib/workspace-api.ts`:
  - `StreamHandlers` (:1059) gains `onVisual?: (visual: ThreadVisual) => void`.
  - In `streamReply` (:2149-2290), a per-stream `Set` records `toolCallId`s whose `isShowVisualToolName(frame.toolName)`. That check runs whether or not `onToolUse` is passed.
  - On the matching `tool-result`, unless `isError` or `held`, call `onVisual(visualFromToolResult(frame.output))` when the result is non-null. Never pass on `input` or `output`.
- Modify: `packages/channel-web/src/components/workspace/AgentView.tsx`:
  - Add state `liveVisuals: { conversationId: string; visuals: readonly ThreadVisual[] } | null`. `onVisual` appends, deduped by id, using `conversationRef.current`.
  - Keep the state through `resetLiveTurn`. Clear it in `load().finally` after the post-turn re-read (:1030), at the start of each stream (:980) and on agent or conversation change (:924).
  - Push `{ kind: 'agent', id: 'pending-visuals', text: '', at: '', visuals }` **after** the in-flight reply (:1539-1560). Include only visuals whose `artifactId` is not already in `detail.thread`.
  - Pass `conversationId={past ? … : (detail.conversationId ?? liveVisuals?.conversationId ?? null)}` (:1936), because a new chat has no `detail.conversationId` until its first re-read.
- Test: `src/lib/__tests__/workspace-api-stream-tools.test.ts`; create `src/components/workspace/__tests__/AgentViewVisuals.test.tsx` (harness as in `AgentViewStop.test.tsx`, with `vi.mock('../visual/VisualFrame', () => ({ default: ({ visual, conversationId }) => <div data-testid="visual" data-conv={conversationId}>{visual.title}</div> }))`)

**Interfaces:**
- Consumes: `isShowVisualToolName`, `visualFromToolResult`, `ThreadVisual` (Task 6); `VisualFrame` (Task 11).
- Produces: `StreamHandlers.onVisual`, and the `pending-visuals` live message id.

- [ ] **Step 1: Write the failing tests**

```ts
// workspace-api-stream-tools.test.ts
it('(VISUALS-1) forwards a parsed visual and nothing of its html', async () => {
  stubStream([
    { kind: 'tool-use', toolCallId: 'v1', toolName: 'mcp__ax-sandbox-tools__show_visual', input: { title: 'T', summary: 'S', html: '<p>secret-markup</p>' } },
    { kind: 'tool-result', toolCallId: 'v1', output: JSON.stringify({ artifactId: 'a1', title: 'T', summary: 'S' }) },
    { kind: 'tool-use', toolCallId: 'v2', toolName: 'show_visual', input: {} },
    { kind: 'tool-result', toolCallId: 'v2', output: JSON.stringify({ artifactId: 'a2', title: 'T', summary: 'S' }), isError: true },
    { kind: 'tool-use', toolCallId: 'p1', toolName: 'artifact_publish', input: {} },
    { kind: 'tool-result', toolCallId: 'p1', output: JSON.stringify({ artifactId: 'a3', title: 'T', summary: 'S' }) },
    { done: true },
  ]);
  const seen: unknown[] = [];
  await workspaceApi.streamReply('r1', { onText() {}, onDone() {}, onError() {}, onToolUse: (c) => seen.push(c),
    onToolResult: (r) => seen.push(r), onVisual: (v) => seen.push(v) });
  expect(seen.filter((x) => (x as { artifactId?: string }).artifactId)).toEqual([{ artifactId: 'a1', title: 'T', summary: 'S' }]);
  expect(JSON.stringify(seen)).not.toContain('secret-markup');
});
// AgentViewVisuals.test.tsx
it('(RF4) shows a live visual, keeps it through the re-read, then shows it exactly once', async () => {
  // stream: tool-use + tool-result for show_visual, then hold `done` and the re-read under test control
  expect(await screen.findAllByTestId('visual')).toHaveLength(1);
  // after done, while the re-read is pending
  expect(screen.getAllByTestId('visual')).toHaveLength(1);
  // the re-read returns a tool-turn agent message carrying the same visual
  await waitFor(() => expect(screen.getAllByTestId('visual')).toHaveLength(1));
});
it('(VISUALS-1) gives a new chat\'s live visual the stream\'s conversation id', …);  // detail.conversationId null → data-conv="c-new"
```
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/workspace-api-stream-tools.test.ts src/components/workspace/__tests__/AgentViewVisuals.test.tsx`
- [ ] **Step 3: Implement** the three edits.
- [ ] **Step 4: Run the Step 2 command and the whole `src/components/workspace/__tests__` folder, expect PASS,** then `pnpm typecheck && pnpm --filter @ax/channel-web build`. Confirm chart.js is only in a lazy chunk: `grep -l "Chart.js v4.5.1" dist-web/assets/*.js` must not list the entry chunk (`index-*.js`).
- [ ] **Step 5: Commit:** `git commit -m "visuals: render visuals in the thread, live and after reload"`

---

### Task 13: Canary reachability [tier: integration]

**Files:**
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts`, in the "Phase 3 canary: artifact_publish round-trip" test (:1715-2245). The stub at :1904 records each `tool:register` payload, and a new step 7 goes after step 6 (:2189).

**Interfaces:**
- Consumes: `createShowVisualExecutor` via `@ax/agent-claude-sdk-runner` (Task 4); `downloadContentType` behavior (Task 5).

- [ ] **Step 1: Write the failing assertions**

```ts
// registration (real @ax/tool-artifact-publish init → recording tool:register stub)
expect(registered.map((d) => [d.name, d.executesIn])).toEqual(expect.arrayContaining([['show_visual', 'sandbox']]));
// 7. show_visual through the REAL executor and the REAL ipc-core dispatcher (same hostClient, same runner session)
const VISUAL_HTML = '<div class="k">Rain, 54°F</div>';
const visual = await createShowVisualExecutor({ client: hostClient as never, conversationId })(
  { id: 'toolu_v1', name: 'show_visual', input: { title: 'Brooklyn', summary: 'Rain all day.', html: VISUAL_HTML } });
expect(visual).toEqual({ artifactId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/), title: 'Brooklyn', summary: 'Rain all day.' });
const got = await download(visual.artifactId, conversationId);
expect(got.status).toBe(200);
expect(await got.text()).toBe(VISUAL_HTML);
expect(got.headers.get('content-type')).toMatch(/^application\/octet-stream/);
expect(got.headers.get('content-disposition')).toMatch(/^attachment;/);
expect(got.headers.get('x-content-type-options')).toBe('nosniff');
expect((await download(visual.artifactId, otherConversationId)).status).toBe(404);
```
- [ ] **Step 2: Run, expect FAIL:** `DOCKER_HOST=<your socket> pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/acceptance.test.ts -t "artifact_publish round-trip"`. This needs Docker; CLAUDE.md "Docker-backed tests" explains `DOCKER_HOST`. Without Docker, say so in the PR and rely on CI.
- [ ] **Step 3: Implement** the recording stub and step 7.
- [ ] **Step 4: Run, expect PASS** (locally with Docker, or in CI).
- [ ] **Step 5: Commit:** `git commit -m "visuals: Phase 3 canary covers show_visual end to end"`

---

### Task 14: Hostile-content browser test [tier: sensitive]

Run `security-checklist`.

**Files:**
- Modify: `packages/channel-web/package.json`. Add devDependency `"playwright": "^1.59.1"`, the same spec as `presets/k8s`, so the lockfile entry is reused.
- Create: `packages/channel-web/src/__tests__/visual-hostile.browser.test.ts` (`// @vitest-environment node`). Locally, gate it with `describe.skipIf(!existsSync(chromium.executablePath()) && !process.env.CI)`. **In CI it must run and never skip** (Vinay, 2026-11-05): when `CI` is set and Chromium is missing, the suite FAILS. It does not skip.
- Modify: `.github/workflows/ci.yml`, job `test`. Before the "Test (affected packages + dependents)" step, add a step that runs `pnpm --filter @ax/channel-web exec playwright install --with-deps chromium`, cached on the resolved playwright version (`actions/cache` on `~/.cache/ms-playwright`). Both test steps (affected and full suite) then pick the test up. Verify on the PR that the CI log shows the hostile suite running, not skipped.

**Interfaces:**
- Consumes: `buildVisualDocument`, `VISUAL_IFRAME_SANDBOX` (Task 9); `DEFAULT_VISUAL_ASSETS` (Task 10); the parent CSP read from `packages/channel-web/index.html`, the same file the app ships.
- Harness:
  - A **canary** `http.createServer` on `127.0.0.1:0` records every request it receives. It also logs raw TCP `connection` events. Report any connection without a request in the PR as the resource-hint residual (`<link rel=preconnect>`); do not fail on it.
  - An **app** server on another port serves `/` with `Set-Cookie: ax_probe=secret`, a head carrying the index.html CSP meta, and a script.
  - The script creates `<iframe sandbox="allow-scripts">` frames whose `srcdoc` is the assembled document. The document is embedded as `JSON.stringify(doc).replace(/</g, '\\u003c')`, and the script collects every `message` from the frames into `window.__results`.
  - The test drives it with `chromium.launch()`, records `page.on('request')` and `page.frames()`, and waits about 3 s after ready.

- [ ] **Step 1: Write the test**

```ts
it('(RF2) a benign whole-document chart with a CDN script renders under both CSPs, and exports a PNG', async () => {
  // html: '<!doctype html><html><head><script src="http://127.0.0.1:<canary>/chart.js"></script></head><body><canvas id="c"></canvas>
  //        <script>new Chart(c,{type:"bar",data:{labels:["a","b"],datasets:[{data:[3,5]}]}})</script></body></html>'
  expect(results).toContainEqual({ type: 'ax-visual:ready', height: expect.any(Number), rendered: true });
  expect(results.some((m) => m.type === 'ax-visual:error')).toBe(false);
  // harness posts { type: 'ax-visual:export', requestId: 'r1', format: 'png' } and returns the blob's first 8 bytes
  expect(pngHead).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});
it('a hostile visual reaches nothing: no request leaves the frame', async () => {
  // probes, each reporting parent.postMessage({ probe, outcome }) in try/catch:
  // fetch, new Image().src, static <img>, <link rel=stylesheet|prefetch|preconnect|dns-prefetch>, <script src>, CSS @import + url(),
  // navigator.sendBeacon, new WebSocket('ws://…'), XMLHttpRequest, new Worker('data:…'), window.open, form.submit() to the canary,
  // document.cookie, localStorage, parent.document, top.location = canary, then (last) location.href = canary and
  // <meta http-equiv="refresh" content="0;url=<canary>">
  expect(canaryHits).toEqual([]);
  expect(requestUrls.filter((u) => u.includes(`:${canaryPort}`))).toEqual([]);
  expect(outcome('cookie')).toBe('threw');
  expect(outcome('localStorage')).toBe('threw');
  expect(outcome('parent.document')).toBe('threw');
  expect(outcome('window.open')).toBe('null');
  expect(page.url()).toBe(appUrl);                                  // top never navigated
  expect(page.frames().slice(1).map((f) => f.url())).toEqual(['about:srcdoc']); // the frame never navigated
});
```
- [ ] **Step 2: Run:** `pnpm --filter @ax/channel-web exec vitest run src/__tests__/visual-hostile.browser.test.ts`, expect PASS. If srcdoc is blocked by the parent `frame-src 'none'`, **stop and escalate**; do not loosen to a URL allowlist.
- [ ] **Step 3: Prove the test is not vacuous.** Predict which probes break, then confirm:
  - With the parent CSP meta removed from the harness page, the self-navigation probe reaches the canary (FAIL).
  - With `VISUAL_FRAME_CSP` swapped for `default-src *` in a local edit, fetch and img reach it (FAIL).
  - Restore both. Any probe that gets through for real is fixed in the box (Task 9 or 10), never in the test.
- [ ] **Step 4: Run, expect PASS,** and paste the output, including the Step 3 mutation results, into the PR.
- [ ] **Step 5: Commit:** `git commit -m "visuals: hostile-content browser test (CSP, sandbox, navigation)"`

---

### Task 15: Docs: design corrections and the acceptance scenario [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-05-chat-visuals-design.md`, as rule 5 stale-line fixes:
  - :4 status becomes "approved 2026-11-05; plan: docs/plans/2026-11-05-chat-visuals-plan.md".
  - :81-82 now describes the parent `frame-src 'none'`, which blocks the frame's own navigation, and notes that the srcdoc inherits it. Add the residuals from this plan's security notes.
  - :91-93 says the input is never rendered or forwarded past the stream reader (`stepDetail` keeps one fenced line).
  - :136-139 describes the descriptor `activityPhrase`, not `activity-phrase-map.ts`.
  - :153 notes that only Inter is inlined, as a Latin subset, and that mono is the system stack.
  - :157-160 names chart.js 4.5.1 and html-to-image 1.11.13, raw-imported and frame-only.
  - :161-165 says the guidance lives in the tool description.
  - "Left to the builder" records `show_visual`, 102,400 bytes and max height 1200.
- Modify: `deploy/MANUAL-ACCEPTANCE.md`. Append "## Scenario: chat visuals (VISUALS-1)" in the TASK-688 format: What this proves / Walk (once per runner) / Acceptance criteria / Cleanup, with the steps of Task 16.

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** Check with `grep -n "activity-phrase-map\|There is no app-wide CSP" docs/plans/2026-11-05-chat-visuals-design.md`. Expect no stale claim left.
- [ ] **Step 3: Full gate:** `pnpm build && pnpm typecheck && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. `@ax/auth-better`'s Docker teardown timeout with all assertions passing is the known flake; read past it.
- [ ] **Step 4: Commit:** `git commit -m "visuals: design doc as built; manual acceptance scenario"`

---

### Task 16: Kind browser walk (manual acceptance) [tier: sensitive]

Run `security-checklist` and use the `k8s-acceptance-loop` skill. Use the **image-rebuild** loop, because the runner, the host and the SPA all changed. Every `kubectl` call takes `--context kind-ax-next-dev` (bare kubectl reaches GKE prod).

- [ ] **Step 1:** Rebuild the images and roll the kind deployment. Grep the runner image's compiled `main.js` for `show_visual` to rule out a stale build cache.
- [ ] **Step 2:** Run each of the following on a `claude-sdk` agent, then repeat on an `aisdk` agent:
  - Ask "Show issues per cycle over the past 20 cycles" (Linear connector). If Linear is not connected, supply the 20 numbers inline and note that in the PR.
  - Ask "What's the weather forecast for Brooklyn?" (web tools). Without a web-tools key, supply the forecast inline.
  - Check that the step row reads "Making a visual: …", the chart has working hover tooltips, the card renders, there is no inner scrollbar and no layout jump, and a short text summary is present.
- [ ] **Step 3:** Toggle light, dark and system while the visual is on screen. Check that the frame swaps colors with no reload and no flash, and capture screenshots of both themes. Judge them against the "jarring" anti-goal: no off-palette colors, no foreign fonts, no wrong-theme backdrop.
- [ ] **Step 4:** Reload the page and reopen the conversation. The visuals must render from history.
- [ ] **Step 5:** Download both formats. The PNG opens at 2x. The HTML opens from disk, renders and makes no network request.
- [ ] **Step 6: Hostile visual.** Ask the agent to call `show_visual` with the probe HTML from Task 14, pointed at a URL you control. Then check:
  - `browser_network_requests` shows no request to it.
  - The console shows CSP refusals.
  - The app's cookies and session are untouched.
  - The frame stays on `about:srcdoc`.
- [ ] **Step 7:** Record the results in the PR. Add a line under "### Walks completed" in `deploy/MANUAL-ACCEPTANCE.md`. Write a `context`/`patterns` shard for anything learned. Commit: `git commit -m "visuals: kind walk passed (claude-sdk + aisdk)"`
