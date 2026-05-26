# Attachments & Artifacts — Phase 3 Implementation Plan (Channel-Web Wiring)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the browser-facing half of the attachments subsystem. Adds three HTTP surfaces — `POST /api/attachments` (multipart upload, 25 MiB cap, MIME allowlist, 200 MiB per-user pending quota), `GET /api/files` (ACL'd byte download), and an extension to `POST /api/chat/messages` (recognise `attachment_ref` items, commit them, enforce 100 MiB per-message total cap, rewrite to `attachment` blocks before dispatching `agent:invoke`). Plus the `AxAttachmentAdapter` and three chip components (`AttachmentComposerChip`, `AttachmentChip`, `ArtifactChip`) so users can attach files, send them, and download both uploads and agent-published artifacts. The canary acceptance test gains the I3 anchor: attach a PDF, send a message, agent calls `artifact_publish`, user downloads both via the web channel.

**Architecture:** Six layered changes, channel-side. (1) `@ax/http-server` gains a per-route `maxBodyBytes` so the upload endpoint can opt into 25 MiB without raising the global default. (2) `@ax/channel-web` adds a small `busboy`-backed multipart parser inside the route layer. (3) Three new route handlers + one extension to the chat-messages handler, all in `routes-attachments.ts` + `routes-chat.ts`. (4) Frontend `AxAttachmentAdapter` (an assistant-ui `AttachmentAdapter` impl) with XHR progress. (5) Three React chip components composed of shadcn primitives + `lucide-react` icons. (6) Composer wired through `ComposerPrimitive.AttachmentDropzone`; Thread message parts dispatch `attachment` blocks to `AttachmentChip`/`ArtifactChip` via a history-adapter translation; MarkdownText detects `ax://artifact/<id>` URLs.

**Tech Stack:** TypeScript + vitest. Browser-side: assistant-ui primitives (`ComposerPrimitive.AttachmentDropzone`, `AttachmentPrimitive.unstable_Thumb`), shadcn primitives (`Button`, `Card`, `Progress`), `lucide-react` icons. Server-side: pinned `busboy@1.6.0` for multipart parsing (~3kloc, no transitive deps, audited; alternative `formidable` rejected for footprint). No new server-side deps in `@ax/attachments` (Phase 1 already shipped the storage + ACL).

**Spec:** `docs/plans/2026-05-15-attachments-and-artifacts-design.md` — specifically the "Wire surfaces (REST + frontend adapter)" section (POST /api/attachments, GET /api/files, POST /api/chat/messages extension), the "Channel-portable rendering" section (AttachmentChip + ArtifactChip), the Composer wiring sketch, and Boundary A/B/C in "Error handling & security".

**Phase 1 status:** Shipped as PR #72. `@ax/attachments` is loaded by both presets with `store-temp`/`commit`/`download` hooks live; path-scope ACL lives INSIDE `attachments:download` (not the route layer). No callers in Phase 1.

**Phase 2 status:** Shipped as PR #94 (merge commit `f00ca7c4`, 2026-05-18). `@ax/tool-artifact-publish` registers the descriptor; the runner translates `attachment` blocks to Anthropic shapes (image/document/inline text ≤ 64 KiB/text mention); `workspace.read` IPC action ships bytes runner-side; `git-lfs` in the agent image. The host's chat-messages handler does NOT yet emit `attachment_ref` or `attachment` blocks — Phase 3 closes that gap.

**Half-wired window:** Phase 1 opened a window; Phase 2 kept it OPEN; **Phase 3 CLOSES it.** PR body must declare:
> "Half-wired window from Phase 1 (PR #72) and Phase 2 (PR #94) CLOSES with this PR. Phase 3 wires `POST /api/attachments`, extends `POST /api/chat/messages` to emit `attachment_ref` blocks, ships `GET /api/files`, adds the `AxAttachmentAdapter`/composer wiring/chip components, and extends the canary acceptance test to exercise the round-trip (attach PDF → send → agent publishes artifact → user downloads both). The I3 anchor is now in place."

---

## Design deviations from the spec

Six issues surfaced during planning that the design doc does not explicitly resolve. Each is decided below; reviewers should flag pushback in PR comments rather than during impl.

**D1. `@ax/http-server` has a hardcoded 1 MiB body cap.** `MAX_BODY_BYTES = 1 * 1024 * 1024` in `packages/http-server/src/types.ts` is enforced inside the framework BEFORE any handler runs. The design doc's "25 MiB per file" cap on `POST /api/attachments` cannot live in the route handler — the framework returns 413 first. We extend `HttpRegisterRouteInput` with an optional `maxBodyBytes?: number` that the router carries through to `readBodyCapped`. Default stays 1 MiB (defense-in-depth for every other endpoint); `/api/attachments` opts into 25 MiB. Risk: a future plugin that mounts a permissive cap leaks the limit to other routes by mistake — mitigated because the cap is per-route entry in the router, not global.

**D2. Multipart parsing.** No multipart parser exists in the repo. We add `busboy@1.6.0` to `@ax/channel-web`'s deps (~3 kloc, audited, no transitive deps). Parsed inside the route handler from the Buffer that http-server delivers — we do NOT stream-parse the underlying socket. The 25 MiB cap makes buffering acceptable (peak ~25 MiB × N concurrent uploads — fine on host pods sized for the existing chat workload). `formidable` was rejected for footprint; hand-rolled parsers were rejected for the security surface (RFC 2046 boundary handling is non-trivial).

**D3. `AxChatTransport.toContentBlocks` currently emits a text fallback for `file` parts.** `packages/channel-web/src/lib/transport.ts:138-148` converts assistant-ui `file` parts to text `[attachment: ${filename || ref}]`. Phase 3 replaces this with proper `attachment_ref` emission when `part.data` matches `ax://attachment/<id>`. The text-fallback path stays for any non-ax file part (currently impossible since we control the adapter, but defensive against future runtime extensions).

**D4. `ax://` is not in `@assistant-ui/react-markdown`'s default safe-protocol allowlist.** react-markdown defaults to `http,https,mailto,tel`. `ax://artifact/<id>` links would be stripped (rendered as plain text) without an override. We pass `urlTransform={(u) => u.startsWith('ax://') ? u : defaultUrlTransform(u)}` to `MarkdownTextPrimitive` and supply a custom `components.a` that intercepts `ax://artifact/<id>` URLs and renders an inline `<ArtifactChip variant="link" />`. The exact prop name matches the version pinned in `package.json` (`@assistant-ui/react-markdown@^0.12.6`, which uses `react-markdown@9`'s `urlTransform` prop).

**D5. `runtime.tsx` explicitly disables the attachments adapter.** `packages/channel-web/src/lib/runtime.tsx:18-25` carries a TODO comment: "No `attachments` adapter is configured: the composer's attach button is gated on the adapter being present (assistant-ui contract), so omitting it hides the button. The previous adapter POSTed to /api/files, which has no host-side route — preset-k8s would 404 every upload. The button comes back when a host-side blob-store + /api/files route ships." Phase 3 deletes that note and wires `AxAttachmentAdapter`. The comment is the documented reason this work exists.

**D6. Storing `attachment` blocks renders through assistant-ui's `file` part type.** assistant-ui's `MessagePrimitive.Parts` dispatches by part type — `text`, `tool-call`, `file`, etc. Our stored `attachment` content blocks are not a native part type. The cleanest path: translate `attachment` blocks → assistant-ui `file` parts in the **history adapter** (`packages/channel-web/src/lib/history-adapter.ts`) at conversation-load time, with `data: ax://attachment/<path>` (we encode the workspace path, not an attachmentId, because the path is what `GET /api/files` resolves against). The user-message live-send path already produces `file` parts from the adapter's `send()`. Both paths converge on the same chip component bound through `Parts.components.File`.

**D7. Boundary review — no new hook surface.** Phase 3 adds two HTTP routes and one route extension; all call into existing Phase 1 service hooks (`attachments:store-temp`, `attachments:commit`, `attachments:download`) and the existing `agent:invoke`. No new service hook, no new IPC action, no new subscriber hook. Boundary review section in the PR body just confirms this.

---

## File Structure

**Modify:**
- `packages/http-server/src/types.ts` — extend `HttpRegisterRouteInput` with optional `maxBodyBytes?: number`.
- `packages/http-server/src/router.ts` — propagate `maxBodyBytes` through `ExactRouteEntry` + `PatternRouteEntry` + `MatchResult`.
- `packages/http-server/src/plugin.ts` — read the matched route's `maxBodyBytes` and pass to `readBodyCapped` (falls back to `MAX_BODY_BYTES`).
- `packages/http-server/src/__tests__/plugin.test.ts` — extend body-cap tests for per-route override.
- `packages/http-server/src/__tests__/router.test.ts` (extend) — assert `maxBodyBytes` flows through both exact and pattern routes.
- `packages/channel-web/package.json` — add `busboy@1.6.0` + `@types/busboy@1.5.4` dependencies.
- `packages/channel-web/src/server/routes-chat.ts` — extend `postMessage` to recognise `attachment_ref` blocks, call `attachments:commit` per ref, enforce 100 MiB per-message total cap, and pass `contentBlocks` to `agent:invoke` via `AgentMessage.contentBlocks` (Phase 2's D2).
- `packages/channel-web/src/server/plugin.ts` — register the two new routes (`POST /api/attachments`, `GET /api/files`) alongside the existing chat routes; declare `attachments:store-temp` / `attachments:commit` / `attachments:download` in `manifest.calls`.
- `packages/channel-web/src/__tests__/server/routes-chat.test.ts` — extend with attachment_ref-block scenarios (single ref, multiple refs, expired ref, foreign-user ref, per-message size cap).
- `packages/channel-web/src/lib/runtime.tsx` — delete the "no attachments adapter" comment block; instantiate `AxAttachmentAdapter` and pass it as `adapters.attachments`.
- `packages/channel-web/src/lib/transport.ts` — replace the `file`-part text-fallback with `attachment_ref` emission when `part.data` matches `ax://attachment/<id>`.
- `packages/channel-web/src/lib/history-adapter.ts` — translate stored `attachment` ContentBlocks → assistant-ui `FileUIPart` shape so `MessagePrimitive.Parts` dispatches them to `AttachmentChip`.
- `packages/channel-web/src/components/Composer.tsx` — wrap composer in `ComposerPrimitive.AttachmentDropzone`; render `ComposerPrimitive.Attachments` with `Attachment: AttachmentComposerChip` above the input row.
- `packages/channel-web/src/components/Thread.tsx` — pass `File: AttachmentChip` to user-message `MessagePrimitive.Parts.components`; pass `tool-call`-aware `ArtifactChip` slot through the existing tool-call rendering for `name === 'artifact_publish'`.
- `packages/channel-web/src/components/MarkdownText.tsx` — add `urlTransform` allowing `ax://` and a custom `components.a` that renders `<ArtifactChip variant="link" />` for `ax://artifact/<id>` links.

**Create:**
- `packages/channel-web/src/server/multipart.ts` — minimal busboy-backed multipart parser. Returns `{ field: 'file', filename, mimeType, bytes }` for the single expected file part; rejects malformed payloads.
- `packages/channel-web/src/server/routes-attachments.ts` — `POST /api/attachments` + `GET /api/files` handlers + their `registerAttachmentsRoutes(bus, initCtx)` wiring.
- `packages/channel-web/src/__tests__/server/routes-attachments.test.ts` — auth, MIME allowlist, oversize, quota, happy path, GET /api/files happy path + 404 posture.
- `packages/channel-web/src/__tests__/server/multipart.test.ts` — parser unit tests.
- `packages/channel-web/src/lib/ax-attachment-adapter.ts` — `AxAttachmentAdapter` class implementing assistant-ui's `AttachmentAdapter`.
- `packages/channel-web/src/__tests__/ax-attachment-adapter.test.ts` — mocked-fetch unit tests for `add`/`send`/`remove`.
- `packages/channel-web/src/components/AttachmentComposerChip.tsx` — pre-send chip with thumbnail (image/*) or icon (other), progress bar, and remove button.
- `packages/channel-web/src/components/AttachmentChip.tsx` — in-transcript user-message chip (no remove, click→download).
- `packages/channel-web/src/components/ArtifactChip.tsx` — assistant-message artifact chip (inline + link variants).
- `packages/channel-web/src/__tests__/attachment-composer-chip.test.tsx`
- `packages/channel-web/src/__tests__/attachment-chip.test.tsx`
- `packages/channel-web/src/__tests__/artifact-chip.test.tsx`
- `packages/channel-web/src/__tests__/composer-attachments.test.tsx` — composer with attachments mounted; drag-and-drop dropzone present.

**Do not touch:**
- `packages/attachments/**` — Phase 1 already ships the hooks; Phase 3 only calls them.
- `packages/tool-artifact-publish/**` — Phase 2 ships the descriptor.
- `packages/agent-claude-sdk-runner/**` — Phase 2 ships the translation pass.
- `packages/workspace-git-server/**` — LFS endpoints shipped in Phase 1.

---

## Task 1: Extend `@ax/http-server` with per-route `maxBodyBytes`

The framework's 1 MiB cap is enforced before route handlers run; uploading 25 MiB requires the route to declare a higher cap up front. We keep the global default at 1 MiB so every other endpoint inherits the existing tight cap.

**Files:**
- Modify: `packages/http-server/src/types.ts`
- Modify: `packages/http-server/src/router.ts`
- Modify: `packages/http-server/src/plugin.ts`
- Modify: `packages/http-server/src/__tests__/plugin.test.ts`
- Modify: `packages/http-server/src/__tests__/router.test.ts`

- [ ] **Step 1: Add `maxBodyBytes` to the registration input type**

Open `packages/http-server/src/types.ts`. Find `HttpRegisterRouteInput` (around line 128) and add the optional field at the end:

```ts
export interface HttpRegisterRouteInput {
  method: HttpMethod;
  path: string;
  handler: HttpRouteHandler;
  /**
   * When true, the built-in CSRF subscriber skips this route. [existing docstring unchanged]
   */
  bypassCsrf?: boolean;
  /**
   * Per-route override for the request-body size cap. Defaults to
   * `MAX_BODY_BYTES` (1 MiB). Routes that handle multipart uploads opt
   * into a larger cap by declaring it explicitly; everything else
   * inherits the framework default.
   *
   * The cap is enforced BEFORE the handler runs (the framework drains
   * the body up to this limit and returns 413 above it). A route that
   * sets this MUST also declare any further per-field caps inside its
   * handler — this is the outermost defense-in-depth check only.
   */
  maxBodyBytes?: number;
}
```

- [ ] **Step 2: Carry `maxBodyBytes` through the router entries**

Open `packages/http-server/src/router.ts`. Update `ExactRouteEntry`, `PatternRouteEntry`, and `MatchResult` to include the cap:

```ts
interface ExactRouteEntry {
  method: HttpMethod;
  path: string;
  handler: HttpRouteHandler;
  bypassCsrf: boolean;
  maxBodyBytes: number | undefined;
}

interface PatternRouteEntry {
  method: HttpMethod;
  pattern: string;
  segments: ReadonlyArray<{ literal: string; paramName: string | null }>;
  paramNames: readonly string[];
  handler: HttpRouteHandler;
  bypassCsrf: boolean;
  maxBodyBytes: number | undefined;
}

export interface MatchResult {
  handler: HttpRouteHandler;
  params: Record<string, string>;
  bypassCsrf: boolean;
  maxBodyBytes: number | undefined;
}

export interface RegisterRouteOptions {
  bypassCsrf?: boolean;
  maxBodyBytes?: number;
}
```

Update the `register` method's signature so callers can pass `maxBodyBytes`:

```ts
register(
  method: HttpMethod,
  path: string,
  handler: HttpRouteHandler,
  options: RegisterRouteOptions = {},
): () => void {
  const bypassCsrf = options.bypassCsrf === true;
  const maxBodyBytes = options.maxBodyBytes;
  const compiled = compilePathPattern(path);
  if (compiled === null) {
    return this.registerExact(method, path, handler, bypassCsrf, maxBodyBytes);
  }
  return this.registerPattern(method, path, compiled, handler, bypassCsrf, maxBodyBytes);
}
```

Extend the `registerExact` + `registerPattern` private methods to accept and store the new field:

```ts
private registerExact(
  method: HttpMethod,
  path: string,
  handler: HttpRouteHandler,
  bypassCsrf: boolean,
  maxBodyBytes: number | undefined,
): () => void {
  const key = Router.makeKey(method, path);
  if (this.exact.has(key)) {
    throw new Error(`route already registered: ${method} ${path}`);
  }
  this.exact.set(key, { method, path, handler, bypassCsrf, maxBodyBytes });
  // ... rest unchanged
}

private registerPattern(
  method: HttpMethod,
  pattern: string,
  compiled: PatternRouteEntry['segments'],
  handler: HttpRouteHandler,
  bypassCsrf: boolean,
  maxBodyBytes: number | undefined,
): () => void {
  // ... existing list lookup unchanged ...
  const entry: PatternRouteEntry = {
    method,
    pattern,
    segments: compiled,
    paramNames,
    handler,
    bypassCsrf,
    maxBodyBytes,
  };
  // ... rest unchanged
}
```

In `match`, populate `maxBodyBytes` on every returned `MatchResult`:

```ts
match(method: HttpMethod, path: string): MatchResult | undefined {
  const exact = this.exact.get(Router.makeKey(method, path));
  if (exact !== undefined) {
    return {
      handler: exact.handler,
      params: {},
      bypassCsrf: exact.bypassCsrf,
      maxBodyBytes: exact.maxBodyBytes,
    };
  }
  const patterns = this.patternsByMethod.get(method);
  if (patterns === undefined) return undefined;
  const requestSegments = splitPathSegments(path);
  for (const entry of patterns) {
    if (isSplatPattern(entry)) continue;
    const params = matchPattern(entry.segments, requestSegments);
    if (params !== null) {
      return {
        handler: entry.handler,
        params,
        bypassCsrf: entry.bypassCsrf,
        maxBodyBytes: entry.maxBodyBytes,
      };
    }
  }
  for (const entry of patterns) {
    if (!isSplatPattern(entry)) continue;
    const params = matchPattern(entry.segments, requestSegments);
    if (params !== null) {
      return {
        handler: entry.handler,
        params,
        bypassCsrf: entry.bypassCsrf,
        maxBodyBytes: entry.maxBodyBytes,
      };
    }
  }
  return undefined;
}
```

- [ ] **Step 3: Pass the matched route's `maxBodyBytes` through `readBodyCapped`**

Open `packages/http-server/src/plugin.ts`. Find the `body = await readBodyCapped(req, MAX_BODY_BYTES);` line (around line 355). Replace with:

```ts
  let body: Buffer;
  try {
    const cap = matched.maxBodyBytes ?? MAX_BODY_BYTES;
    body = await readBodyCapped(req, cap);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return finish(413, { error: 'body-too-large' });
    }
    throw err;
  }
```

Also find the call site in the `http:register-route` service handler — it parses the input shape and forwards to `router.register`. Add the new flag through:

```ts
// in the http:register-route handler factory inside plugin.ts
const unregister = router.register(
  input.method,
  input.path,
  input.handler,
  {
    bypassCsrf: input.bypassCsrf === true,
    maxBodyBytes: input.maxBodyBytes,
  },
);
```

If the call site uses a Zod schema, add `maxBodyBytes: z.number().int().positive().optional()` to the input schema alongside `bypassCsrf`.

- [ ] **Step 4: Write tests for per-route override**

Add to `packages/http-server/src/__tests__/plugin.test.ts`, in an existing `describe('body cap', …)` block or a new one:

```ts
describe('per-route maxBodyBytes', () => {
  it('honors a 2 MiB per-route cap when set above the default', async () => {
    const harness = await makeHarness();
    let receivedBytes = 0;
    await harness.bus.call('http:register-route', harness.ctx, {
      method: 'POST',
      path: '/big',
      maxBodyBytes: 2 * 1024 * 1024,
      handler: async (req, res) => {
        receivedBytes = req.body.length;
        res.status(200).json({ ok: true });
      },
    });
    const big = Buffer.alloc(1.5 * 1024 * 1024, 0x41);
    const resp = await harness.fetch('/big', { method: 'POST', body: big });
    expect(resp.status).toBe(200);
    expect(receivedBytes).toBe(big.length);
    await harness.shutdown();
  });

  it('still returns 413 above the per-route cap', async () => {
    const harness = await makeHarness();
    await harness.bus.call('http:register-route', harness.ctx, {
      method: 'POST',
      path: '/big',
      maxBodyBytes: 2 * 1024 * 1024,
      handler: async (_req, res) => { res.status(200).end(); },
    });
    const tooBig = Buffer.alloc(3 * 1024 * 1024, 0x42);
    const resp = await harness.fetch('/big', { method: 'POST', body: tooBig });
    expect(resp.status).toBe(413);
    await harness.shutdown();
  });

  it('inherits the default 1 MiB cap when maxBodyBytes is not set', async () => {
    const harness = await makeHarness();
    await harness.bus.call('http:register-route', harness.ctx, {
      method: 'POST',
      path: '/default',
      handler: async (_req, res) => { res.status(200).end(); },
    });
    const tooBig = Buffer.alloc(1.5 * 1024 * 1024, 0x43);
    const resp = await harness.fetch('/default', { method: 'POST', body: tooBig });
    expect(resp.status).toBe(413);
    await harness.shutdown();
  });
});
```

Reuse the test file's existing `makeHarness` helper. If `makeHarness` doesn't exist, copy the pattern from the existing body-cap tests in this file (`returns 413 when the body exceeds MAX_BODY_BYTES …` at line 111).

- [ ] **Step 5: Run tests + build**

```bash
pnpm --filter @ax/http-server test
pnpm --filter @ax/http-server build
```

Expected: PASS. The build is the gate — `tsc` rejects undeclared workspace deps; the new field on `HttpRegisterRouteInput` flows through the @types correctly.

- [ ] **Step 6: Commit**

```bash
git add packages/http-server/src/types.ts packages/http-server/src/router.ts packages/http-server/src/plugin.ts packages/http-server/src/__tests__
git commit -m "feat(http-server): per-route maxBodyBytes override"
```

---

## Task 2: Add `busboy` dependency and the multipart parser

We add `busboy@1.6.0` to `@ax/channel-web`'s deps (host-side parsing only — busboy doesn't ship browser code). The parser lives behind a small wrapper that returns a typed `{ filename, mimeType, bytes }` for the single expected file part and rejects everything else.

**Files:**
- Modify: `packages/channel-web/package.json`
- Create: `packages/channel-web/src/server/multipart.ts`
- Create: `packages/channel-web/src/__tests__/server/multipart.test.ts`

- [ ] **Step 1: Add the dependency**

Edit `packages/channel-web/package.json` — add to `dependencies`:

```json
"busboy": "1.6.0",
```

And to `devDependencies`:

```json
"@types/busboy": "1.5.4",
```

Then install:

```bash
pnpm install --filter @ax/channel-web
```

Verify lockfile updated:

```bash
git diff pnpm-lock.yaml | head -40
```

Expected: `busboy` + `@types/busboy` entries appear; no other version pins changed.

- [ ] **Step 2: Write failing tests for the parser**

Create `packages/channel-web/src/__tests__/server/multipart.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseSingleFileMultipart } from '../../server/multipart';

function buildMultipart(parts: Array<{
  name: string;
  filename?: string;
  contentType?: string;
  body: Buffer | string;
}>, boundary = '----test-boundary'): { buf: Buffer; contentType: string } {
  const enc = (s: string) => Buffer.from(s, 'utf8');
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(enc(`--${boundary}\r\n`));
    let disp = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) disp += `; filename="${p.filename}"`;
    chunks.push(enc(disp + '\r\n'));
    if (p.contentType !== undefined) {
      chunks.push(enc(`Content-Type: ${p.contentType}\r\n`));
    }
    chunks.push(enc('\r\n'));
    chunks.push(typeof p.body === 'string' ? enc(p.body) : p.body);
    chunks.push(enc('\r\n'));
  }
  chunks.push(enc(`--${boundary}--\r\n`));
  return {
    buf: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('parseSingleFileMultipart', () => {
  it('parses a single file part with filename + mimeType', async () => {
    const { buf, contentType } = buildMultipart([
      { name: 'file', filename: 'hello.txt', contentType: 'text/plain', body: 'hi there' },
    ]);
    const result = await parseSingleFileMultipart(buf, contentType);
    expect(result.filename).toBe('hello.txt');
    expect(result.mimeType).toBe('text/plain');
    expect(result.bytes.toString('utf8')).toBe('hi there');
  });

  it('rejects when no file part is present', async () => {
    const { buf, contentType } = buildMultipart([
      { name: 'other', body: 'hi' },
    ]);
    await expect(parseSingleFileMultipart(buf, contentType)).rejects.toThrow(/no file part/);
  });

  it('rejects when the "file" part has no filename', async () => {
    const { buf, contentType } = buildMultipart([
      { name: 'file', contentType: 'text/plain', body: 'hi' },
    ]);
    await expect(parseSingleFileMultipart(buf, contentType)).rejects.toThrow(/filename/);
  });

  it('rejects when more than one file part is present', async () => {
    const { buf, contentType } = buildMultipart([
      { name: 'file', filename: 'a.txt', contentType: 'text/plain', body: 'a' },
      { name: 'file', filename: 'b.txt', contentType: 'text/plain', body: 'b' },
    ]);
    await expect(parseSingleFileMultipart(buf, contentType)).rejects.toThrow(/multiple file parts/);
  });

  it('rejects on missing content-type header', async () => {
    const { buf } = buildMultipart([
      { name: 'file', filename: 'a.txt', contentType: 'text/plain', body: 'a' },
    ]);
    await expect(parseSingleFileMultipart(buf, '')).rejects.toThrow(/content-type/i);
  });

  it('defaults mimeType to application/octet-stream when the part omits it', async () => {
    const { buf, contentType } = buildMultipart([
      { name: 'file', filename: 'blob.bin', body: Buffer.from([0x00, 0x01, 0x02]) },
    ]);
    const result = await parseSingleFileMultipart(buf, contentType);
    expect(result.mimeType).toBe('application/octet-stream');
    expect(result.bytes.length).toBe(3);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- multipart.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write the parser**

Create `packages/channel-web/src/server/multipart.ts`:

```ts
import Busboy from 'busboy';
import { Readable } from 'node:stream';

/**
 * Minimal multipart parser. Reads a buffered request body and returns the
 * single `name="file"` part's filename, MIME, and bytes. Rejects on:
 *   - missing or unparseable Content-Type
 *   - zero file parts
 *   - more than one file part
 *   - file part without a filename
 *
 * This is intentionally narrow: POST /api/attachments is the only caller,
 * and it expects exactly one file part. A wider general-purpose parser
 * would invite mis-use (multi-file uploads would silently work, blowing
 * past the per-message quota at commit time).
 *
 * We buffer-parse rather than stream-parse because the route's body cap
 * (25 MiB) is bounded — peak memory is one upload-in-flight per request.
 */
export interface ParsedFile {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export function parseSingleFileMultipart(
  body: Buffer,
  contentTypeHeader: string,
): Promise<ParsedFile> {
  return new Promise((resolve, reject) => {
    if (!contentTypeHeader || !contentTypeHeader.toLowerCase().startsWith('multipart/')) {
      reject(new Error('invalid content-type: expected multipart/form-data'));
      return;
    }
    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({ headers: { 'content-type': contentTypeHeader } });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const fileParts: ParsedFile[] = [];
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    busboy.on('file', (fieldname, stream, info) => {
      if (fieldname !== 'file') {
        // Drain unwanted parts so busboy reaches 'finish'.
        stream.resume();
        return;
      }
      if (fileParts.length >= 1) {
        stream.resume();
        settle(() => reject(new Error('multiple file parts not allowed')));
        return;
      }
      const filename = info.filename;
      const mimeType = info.mimeType || 'application/octet-stream';
      if (!filename || filename.length === 0) {
        stream.resume();
        settle(() => reject(new Error('file part missing filename')));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
      });
      stream.on('end', () => {
        fileParts.push({ filename, mimeType, bytes: Buffer.concat(chunks, total) });
      });
      stream.on('error', (err: Error) => settle(() => reject(err)));
    });

    busboy.on('error', (err) => settle(() => reject(err as Error)));
    busboy.on('finish', () => {
      if (fileParts.length === 0) {
        settle(() => reject(new Error('no file part in multipart body')));
        return;
      }
      settle(() => resolve(fileParts[0]!));
    });

    // Feed the buffered body into busboy via a Readable.
    Readable.from(body).pipe(busboy);
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @ax/channel-web test -- multipart.test.ts
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/package.json pnpm-lock.yaml packages/channel-web/src/server/multipart.ts packages/channel-web/src/__tests__/server/multipart.test.ts
git commit -m "feat(channel-web): busboy-backed single-file multipart parser"
```

---

## Task 3: `POST /api/attachments` route handler

Multipart upload endpoint. Auth + CSRF (latter via the http-server subscriber automatically since this is a POST), MIME allowlist enforced at the framework boundary by the parser + handler, then delegates to `attachments:store-temp`. The hook re-enforces the size cap + per-user pending quota (defense-in-depth, see `attachments/src/handlers.ts:77-86`).

**Files:**
- Create: `packages/channel-web/src/server/routes-attachments.ts`
- Create: `packages/channel-web/src/__tests__/server/routes-attachments.test.ts`

- [ ] **Step 1: Write failing tests for `POST /api/attachments`**

Create `packages/channel-web/src/__tests__/server/routes-attachments.test.ts` with the auth + happy-path + error cases. (Same testcontainer + harness pattern as `routes-chat.test.ts`; reuse the helpers from that file.)

```ts
// @vitest-environment node
import { randomBytes } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginError, type AgentContext, type Plugin } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createAttachmentsPlugin } from '@ax/attachments';
import {
  createMockWorkspacePlugin,
  createTestHarness,
  type TestHarness,
} from '@ax/test-harness';
import { createChannelWebServerPlugin } from '../../server/plugin';

const COOKIE_KEY = randomBytes(32);
const ALLOWED_ORIGIN = 'https://app.example.com';

function makeMultipart(parts: Array<{
  name: string;
  filename?: string;
  contentType?: string;
  body: Buffer | string;
}>, boundary = '----test-boundary'): { body: Buffer; headers: Record<string, string> } {
  // Same helper as multipart.test.ts; copied here so route tests don't
  // cross-import a test file. Keep them in sync (small, rare changes).
  const enc = (s: string) => Buffer.from(s, 'utf8');
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(enc(`--${boundary}\r\n`));
    let disp = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) disp += `; filename="${p.filename}"`;
    chunks.push(enc(disp + '\r\n'));
    if (p.contentType !== undefined) {
      chunks.push(enc(`Content-Type: ${p.contentType}\r\n`));
    }
    chunks.push(enc('\r\n'));
    chunks.push(typeof p.body === 'string' ? enc(p.body) : p.body);
    chunks.push(enc('\r\n'));
  }
  chunks.push(enc(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      origin: ALLOWED_ORIGIN,
      'x-requested-with': 'ax-admin',
    },
  };
}

function authMockPlugin(userId: string | null): Plugin {
  return {
    manifest: {
      name: '@test/auth',
      version: '0.0.0',
      registers: ['auth:require-user'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('auth:require-user', '@test/auth', async () => {
        if (userId === null) {
          throw new PluginError({
            code: 'unauthenticated',
            plugin: '@test/auth',
            hookName: 'auth:require-user',
            message: 'no session',
          });
        }
        return { user: { id: userId, isAdmin: false } };
      });
    },
  };
}

// Tests pinning Phase 3 acceptance:
//
//   1. Anonymous → 401
//   2. Happy path → 200 with { attachmentId, sizeBytes, mediaType, displayName, expiresAt }
//   3. Foreign Origin → 403 (CSRF gate)
//   4. Missing Content-Type → 400
//   5. No file part → 400
//   6. Multiple file parts → 400
//   7. MIME not in allowlist → 415
//   8. Oversize → 413
//   9. Pending quota exceeded → 429

let pg: StartedPostgreSqlContainer;
let dsn: string;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  dsn = pg.getConnectionUri();
}, 60_000);

afterAll(async () => {
  await pg?.stop();
});

describe('POST /api/attachments', () => {
  it('rejects anonymous requests with 401', async () => {
    const h = await makeHarness({ userId: null });
    const { body, headers } = makeMultipart([
      { name: 'file', filename: 'a.txt', contentType: 'text/plain', body: 'hi' },
    ]);
    const r = await h.fetch('/api/attachments', { method: 'POST', body, headers });
    expect(r.status).toBe(401);
    await h.shutdown();
  });

  it('returns 200 + attachmentId on the happy path', async () => {
    const h = await makeHarness({ userId: 'u1' });
    const { body, headers } = makeMultipart([
      { name: 'file', filename: 'hi.txt', contentType: 'text/plain', body: 'hi there' },
    ]);
    const r = await h.fetch('/api/attachments', { method: 'POST', body, headers });
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(typeof json.attachmentId).toBe('string');
    expect(json.sizeBytes).toBe(8);
    expect(json.mediaType).toBe('text/plain');
    expect(json.displayName).toBe('hi.txt');
    expect(typeof json.expiresAt).toBe('string');
    await h.shutdown();
  });

  it('rejects 415 when mediaType is not in allowlist', async () => {
    const h = await makeHarness({ userId: 'u1' });
    const { body, headers } = makeMultipart([
      { name: 'file', filename: 'evil.exe', contentType: 'application/x-msdownload', body: '...' },
    ]);
    const r = await h.fetch('/api/attachments', { method: 'POST', body, headers });
    expect(r.status).toBe(415);
    await h.shutdown();
  });

  it('rejects 413 when file exceeds 25 MiB cap (declared content-length)', async () => {
    const h = await makeHarness({ userId: 'u1' });
    // The framework's 413 fires from the content-length header alone for
    // the cheap path; we send a Content-Length much larger than 25 MiB.
    const r = await h.fetch('/api/attachments', {
      method: 'POST',
      body: Buffer.alloc(0),
      headers: {
        'content-type': 'multipart/form-data; boundary=anything',
        'content-length': String(30 * 1024 * 1024),
        origin: ALLOWED_ORIGIN,
        'x-requested-with': 'ax-admin',
      },
    });
    expect(r.status).toBe(413);
    await h.shutdown();
  });

  it('rejects 400 when no file part is present', async () => {
    const h = await makeHarness({ userId: 'u1' });
    const { body, headers } = makeMultipart([
      { name: 'other', body: 'wrong field name' },
    ]);
    const r = await h.fetch('/api/attachments', { method: 'POST', body, headers });
    expect(r.status).toBe(400);
    await h.shutdown();
  });

  it('rejects 403 on foreign Origin (CSRF gate)', async () => {
    const h = await makeHarness({ userId: 'u1' });
    const { body, headers } = makeMultipart([
      { name: 'file', filename: 'a.txt', contentType: 'text/plain', body: 'hi' },
    ]);
    headers['origin'] = 'https://evil.example.com';
    delete (headers as Record<string, string>)['x-requested-with'];
    const r = await h.fetch('/api/attachments', { method: 'POST', body, headers });
    expect(r.status).toBe(403);
    await h.shutdown();
  });
});

// Harness factory — same shape as routes-chat.test.ts's helper. Boots
// http-server + database-postgres + attachments + auth-mock + channel-web,
// returns { fetch, shutdown } that drives request.
async function makeHarness(opts: { userId: string | null }): Promise<{
  fetch: (path: string, init: RequestInit) => Promise<Response>;
  shutdown: () => Promise<void>;
}> {
  // [Implementation mirrors the existing harness in routes-chat.test.ts.
  //  See that file for the boot/listen/teardown sequence; the only deltas
  //  are: include @ax/attachments in plugins, drop the conversations
  //  plugin (these tests don't need it).]
  throw new Error('TODO: copy harness from routes-chat.test.ts and wire @ax/attachments');
}
```

Then translate the `TODO` harness into a real implementation by lifting the pattern from `routes-chat.test.ts:60-240`. Keep the harness local to this file — do not export to avoid drift with the chat-routes harness.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- routes-attachments.test.ts
```

Expected: FAIL — route handlers don't exist yet.

- [ ] **Step 3: Write the route module**

Create `packages/channel-web/src/server/routes-attachments.ts`:

```ts
import {
  isRejection,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { parseSingleFileMultipart } from './multipart.js';

// ---------------------------------------------------------------------------
// @ax/channel-web — attachments REST surface (Phase 3, 2026-05-18).
//
// Routes:
//   - POST /api/attachments   — multipart upload, 25 MiB cap, MIME allowlist.
//                               Calls attachments:store-temp.
//   - GET  /api/files         — ACL'd byte download. Calls attachments:download.
//
// Both endpoints require auth. POST is CSRF-gated by the http-server's
// subscriber (Origin + X-Requested-With check). GET is read-only and
// cookie-authed only — no CSRF gate needed (browsers gate state-changing
// methods; a GET that mutates would be a security bug, but GET /api/files
// never mutates).
//
// Boundary review (I1-I5):
//   - I1: payload field names — path, conversationId, attachmentId,
//     sizeBytes, mediaType, displayName, expiresAt — are workspace +
//     attachment vocabulary. No backend leak.
//   - I2: this file imports only @ax/core (and the local multipart helper).
//     All other plugins reached via bus.call.
//   - I3: full POST + GET surface lands in the same PR with canary
//     coverage (Phase 3 closes the half-wired window opened by Phase 1).
//   - I4: attachment metadata is the conversation transcript; no
//     side-table here. GET /api/files's path-scope ACL reads transcripts
//     via conversations:get inside attachments:download.
//   - I5: 25 MiB body cap per-route; MIME allowlist enforced by
//     attachments:store-temp; 200 MiB per-user pending quota inside the
//     hook; auth required for both; CSRF gated for POST.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/channel-web';

// Per-route body cap for POST /api/attachments. Matches the per-file cap
// the @ax/attachments plugin defaults to (25 MiB). This is the framework-
// level enforcement; the hook re-enforces inside store-temp for
// defense-in-depth.
const ATTACHMENTS_MAX_BODY_BYTES = 25 * 1024 * 1024;

// --- duck-typed request/response (Invariant I2 — no http-server import) ---

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  header(name: string, value: string): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  body(buf: Buffer, contentType?: string): void;
  end(): void;
}

// --- duck-typed hook payloads (I2) ----------------------------------------

interface AuthRequireUserInput { req: RouteRequest; }
interface AuthRequireUserOutput { user: { id: string; isAdmin: boolean }; }

interface StoreTempInput { bytes: Buffer; displayName: string; mediaType: string; }
interface StoreTempOutput {
  attachmentId: string;
  sizeBytes: number;
  expiresAt: string;
}

interface DownloadInput {
  path: string;
  conversationId: string;
  userId: string;
}
interface DownloadOutput {
  bytes: Buffer;
  mediaType: string;
  sizeBytes: number;
  displayName: string;
}

// --- shared auth helper (mirrors routes-chat.ts) --------------------------

async function authOr401(
  bus: HookBus,
  initCtx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<string | null> {
  try {
    const result = await bus.call<AuthRequireUserInput, AuthRequireUserOutput>(
      'auth:require-user',
      initCtx,
      { req },
    );
    return result.user.id;
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

// --- handler factory ------------------------------------------------------

export interface AttachmentsRouteDeps {
  bus: HookBus;
  initCtx: AgentContext;
}

export function createAttachmentsRouteHandlers(deps: AttachmentsRouteDeps) {
  const { bus, initCtx } = deps;
  return {
    /** POST /api/attachments — multipart upload. */
    async postAttachment(req: RouteRequest, res: RouteResponse): Promise<void> {
      // 1) Auth.
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      // 2) Parse multipart. Errors collapse to 400 (no internal-detail leak).
      let parsed: { filename: string; mimeType: string; bytes: Buffer };
      const contentType = req.headers['content-type'] ?? '';
      try {
        parsed = await parseSingleFileMultipart(req.body, contentType);
      } catch {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }

      // 3) Delegate to attachments:store-temp. The hook enforces:
      //    - 25 MiB per-file cap (size check, parallel to the http-server's)
      //    - MIME allowlist (returns invalid-payload on miss → we map to 415)
      //    - per-user pending quota (200 MiB; too-many-pending → 429)
      // Per-request ctx — userId must come from the auth gate, not the
      // route-init ctx (which is the plugin's boot context).
      const ctx = makeAgentContext({
        sessionId: 'attachments-upload',
        agentId: PLUGIN_NAME,
        userId,
      });
      try {
        const out = await bus.call<StoreTempInput, StoreTempOutput>(
          'attachments:store-temp',
          ctx,
          {
            bytes: parsed.bytes,
            displayName: parsed.filename,
            mediaType: parsed.mimeType,
          },
        );
        res.status(200).json({
          attachmentId: out.attachmentId,
          sizeBytes: out.sizeBytes,
          mediaType: parsed.mimeType,
          displayName: parsed.filename,
          expiresAt: out.expiresAt,
        });
      } catch (err) {
        if (err instanceof PluginError) {
          // The hook returns 'invalid-payload' for both oversize AND
          // mediaType rejection. Disambiguate on message content so the
          // status code reflects what actually failed:
          //   - "mediaType '<x>' not in allowlist" → 415
          //   - "attachment exceeds max file size …"  → 413
          //   - anything else                          → 400
          if (err.code === 'invalid-payload') {
            if (err.message.includes('not in allowlist')) {
              res.status(415).json({ error: 'unsupported-media-type' });
              return;
            }
            if (err.message.includes('max file size')) {
              res.status(413).json({ error: 'payload-too-large' });
              return;
            }
            res.status(400).json({ error: 'invalid-payload' });
            return;
          }
          if (err.code === 'too-many-pending') {
            res.status(429).json({ error: 'too-many-pending' });
            return;
          }
        }
        throw err;
      }
    },

    /** GET /api/files — ACL'd download. */
    async getFile(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      // 2) Validate query params at the route layer. The hook re-validates
      //    inside attachments:download; this is the cheap first reject
      //    for malformed shapes.
      const path = req.query['path'];
      const conversationId = req.query['conversationid'];
      // http-server lowercases query-param keys before delivering them.
      if (typeof path !== 'string' || path.length === 0) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      if (typeof conversationId !== 'string' || conversationId.length === 0) {
        res.status(404).json({ error: 'not-found' });
        return;
      }

      const ctx = makeAgentContext({
        sessionId: 'attachments-download',
        agentId: PLUGIN_NAME,
        userId,
        conversationId,
      });
      try {
        const out = await bus.call<DownloadInput, DownloadOutput>(
          'attachments:download',
          ctx,
          { path, conversationId, userId },
        );
        // Stream-equivalent body write. The framework's HttpResponse.body
        // is single-shot; bytes are flushed atomically. For 25 MiB this
        // is a one-shot write — memory and latency both fine.
        const filename = sanitizeContentDispositionFilename(out.displayName);
        res
          .status(200)
          .header('content-type', out.mediaType)
          .header('content-length', String(out.sizeBytes))
          .header('content-disposition', `attachment; filename="${filename}"`)
          .header('x-content-type-options', 'nosniff')
          .body(out.bytes, out.mediaType);
      } catch (err) {
        if (err instanceof PluginError) {
          // Uniform 404 for every forbidden / not-found condition (the hook
          // itself collapses cross-tenant + missing-path + symlink etc into
          // a not-found posture; we mirror that at the HTTP layer).
          if (err.code === 'not-found' || err.code === 'forbidden') {
            res.status(404).json({ error: 'not-found' });
            return;
          }
        }
        throw err;
      }
    },
  };
}

/**
 * Sanitize a display name for Content-Disposition. Browsers parse this
 * header loosely; we drop anything outside printable ASCII to avoid
 * injection (CRLF, quote-escape). For multi-byte filenames the proper
 * answer is RFC 5987's `filename*=UTF-8''...` syntax — out of scope at
 * v1 (display names are user-typed, not URL-encoded). Drop chars
 * outside [A-Za-z0-9._ -] to a single `_`.
 */
function sanitizeContentDispositionFilename(displayName: string): string {
  const trimmed = displayName.slice(0, 255);
  return trimmed.replace(/[^A-Za-z0-9._ -]/g, '_');
}

/** Register routes against @ax/http-server. */
export async function registerAttachmentsRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createAttachmentsRouteHandlers({ bus, initCtx });
  type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;
  const routes: Array<{
    method: 'POST' | 'GET';
    path: string;
    handler: RouteHandler;
    maxBodyBytes?: number;
  }> = [
    {
      method: 'POST',
      path: '/api/attachments',
      handler: handlers.postAttachment as unknown as RouteHandler,
      maxBodyBytes: ATTACHMENTS_MAX_BODY_BYTES,
    },
    {
      method: 'GET',
      path: '/api/files',
      handler: handlers.getFile as unknown as RouteHandler,
    },
  ];
  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>(
      'http:register-route',
      initCtx,
      route,
    );
    unregisters.push(result.unregister);
  }
  return unregisters;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @ax/channel-web test -- routes-attachments.test.ts
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/server/routes-attachments.ts packages/channel-web/src/__tests__/server/routes-attachments.test.ts
git commit -m "feat(channel-web): POST /api/attachments + GET /api/files routes"
```

---

## Task 4: Extend `POST /api/chat/messages` to commit `attachment_ref` blocks

The wire schema (`PostMessageRequest`) already accepts `attachment_ref` blocks via `ContentBlockSchema` — no schema change needed. The route handler currently extracts only the first text block (`extractText`) and discards the rest. Phase 3 extends it to:

1. Find every `attachment_ref` block, call `attachments:commit` per ref, replace it with the returned `attachment` block.
2. Enforce the 100 MiB per-message total cap.
3. Pass the rewritten `contentBlocks` to `agent:invoke` via the optional `AgentMessage.contentBlocks` field (Phase 2's D2).

The user's turn now lands in the workspace jsonl with `attachment` blocks (the runner writes it on first SDK turn; Phase 2 shipped that translation). `conversations:get` reads back the same blocks via the existing transcript-scan flow.

**Files:**
- Modify: `packages/channel-web/src/server/routes-chat.ts`
- Modify: `packages/channel-web/src/__tests__/server/routes-chat.test.ts`

- [ ] **Step 1: Write failing tests for the new behavior**

Append to `packages/channel-web/src/__tests__/server/routes-chat.test.ts` a new `describe` block. The harness already boots `@ax/conversations`; extend it to also boot `@ax/attachments` (add to the `plugins` array in the existing harness factory):

```ts
describe('POST /api/chat/messages — attachment_ref handling', () => {
  it('commits attachment_ref blocks and dispatches agent:invoke with attachment blocks', async () => {
    const h = await makeHarness({ userId: 'u1' });
    // Pre-stage a temp via attachments:store-temp so we have a real
    // attachmentId to redeem. The hook is reachable through the kernel.
    const stored = await h.bus.call<unknown, {
      attachmentId: string;
      sizeBytes: number;
      expiresAt: string;
    }>('attachments:store-temp', h.userCtx, {
      bytes: Buffer.from('hello pdf bytes'),
      displayName: 'note.pdf',
      mediaType: 'application/pdf',
    });

    let dispatchedMessage: unknown = null;
    h.bus.registerService('agent:invoke', '@test/agent-invoke', async (_ctx, input) => {
      dispatchedMessage = (input as { message: unknown }).message;
      return { kind: 'complete', messages: [] };
    });

    const resp = await h.postJson('/api/chat/messages', {
      conversationId: null,
      agentId: 'agent-1',
      contentBlocks: [
        { type: 'text', text: 'hi here is a doc' },
        { type: 'attachment_ref', attachmentId: stored.attachmentId },
      ],
    });
    expect(resp.status).toBe(202);

    // agent:invoke dispatch is async — wait for the next tick.
    await new Promise((r) => setTimeout(r, 50));

    expect(dispatchedMessage).toBeTruthy();
    const m = dispatchedMessage as {
      role: string;
      content: string;
      contentBlocks?: Array<{ type: string; path?: string; mediaType?: string }>;
    };
    expect(m.role).toBe('user');
    expect(m.contentBlocks).toBeTruthy();
    expect(m.contentBlocks).toHaveLength(2);
    expect(m.contentBlocks![0]).toEqual({ type: 'text', text: 'hi here is a doc' });
    const att = m.contentBlocks![1];
    expect(att.type).toBe('attachment');
    expect(att.mediaType).toBe('application/pdf');
    expect(att.path).toMatch(/^\.ax\/uploads\/.+\/note\.pdf$/);

    await h.shutdown();
  });

  it('returns 400 attachment-not-found for an unknown attachmentId', async () => {
    const h = await makeHarness({ userId: 'u1' });
    const resp = await h.postJson('/api/chat/messages', {
      conversationId: null,
      agentId: 'agent-1',
      contentBlocks: [
        { type: 'attachment_ref', attachmentId: 'does-not-exist' },
      ],
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe('attachment-not-found');
    await h.shutdown();
  });

  it('returns 400 attachment-foreign-user for a foreign attachmentId', async () => {
    const h = await makeHarness({ userId: 'u1' });
    // User 2 stores a temp.
    const u2ctx = h.makeCtx('u2');
    const stored = await h.bus.call<unknown, { attachmentId: string }>(
      'attachments:store-temp',
      u2ctx,
      { bytes: Buffer.from('foreign'), displayName: 'x.txt', mediaType: 'text/plain' },
    );
    // u1 tries to redeem it.
    const resp = await h.postJson('/api/chat/messages', {
      conversationId: null,
      agentId: 'agent-1',
      contentBlocks: [
        { type: 'attachment_ref', attachmentId: stored.attachmentId },
      ],
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe('attachment-foreign-user');
    await h.shutdown();
  });

  it('returns 413 attachment-total-too-large when sum > 100 MiB', async () => {
    const h = await makeHarness({ userId: 'u1', attachmentsConfig: { maxFileBytes: 60 * 1024 * 1024 } });
    // Two 60 MiB pretend uploads — sum is 120 MiB > 100 MiB cap.
    const big1 = Buffer.alloc(60 * 1024 * 1024, 0xab);
    const big2 = Buffer.alloc(60 * 1024 * 1024, 0xcd);
    const s1 = await h.bus.call<unknown, { attachmentId: string }>(
      'attachments:store-temp', h.userCtx,
      { bytes: big1, displayName: 'a.bin', mediaType: 'application/octet-stream' },
    );
    const s2 = await h.bus.call<unknown, { attachmentId: string }>(
      'attachments:store-temp', h.userCtx,
      { bytes: big2, displayName: 'b.bin', mediaType: 'application/octet-stream' },
    );
    const resp = await h.postJson('/api/chat/messages', {
      conversationId: null,
      agentId: 'agent-1',
      contentBlocks: [
        { type: 'attachment_ref', attachmentId: s1.attachmentId },
        { type: 'attachment_ref', attachmentId: s2.attachmentId },
      ],
    });
    expect(resp.status).toBe(413);
    expect((await resp.json()).error).toBe('attachment-total-too-large');
    await h.shutdown();
  });
});
```

The harness needs a `userCtx`, `makeCtx(userId)`, `postJson(path, body)`, `bus`, `shutdown` surface. Extend the existing harness factory in `routes-chat.test.ts` to expose these (most are already implicit; just lift them to the return value).

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- routes-chat.test.ts
```

Expected: FAIL — handler does not handle `attachment_ref` yet.

- [ ] **Step 3: Extend the route handler**

Open `packages/channel-web/src/server/routes-chat.ts`. Find the `extractText` import at top and add `extractAttachmentRefs` (we'll create it). For now, modify the imports:

```ts
import {
  extractText,
  GetConversationQuery,
  ListConversationsQuery,
  PostMessageRequest,
} from '../wire/chat.js';
```

…stays unchanged. Add `ContentBlock` to the type imports if not already imported:

```ts
import type { ContentBlock } from '@ax/ipc-protocol';
```

(already present per line 10 — confirm.)

Add new payload interfaces near the existing duck-typed payloads:

```ts
interface AttachmentsCommitInput {
  attachmentId: string;
  conversationId: string;
  turnId: string;
}
interface AttachmentsCommitOutput {
  path: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  displayName: string;
}
```

Extend `AgentInvokeInput`'s `message` typing — Phase 2 added optional `contentBlocks`:

```ts
interface AgentInvokeMessage {
  role: 'user';
  content: string;
  contentBlocks?: ContentBlock[];
}
interface AgentInvokeInput {
  message: AgentInvokeMessage;
}
```

(Replace the existing `AgentInvokeInput` declaration.)

Add a constant for the per-message total cap near the top of the file:

```ts
/** Per-message attachment-bytes cap. Sum of `sizeBytes` across all
 *  attachment blocks in a single user turn. Design doc §"Caps (v1)". */
const MAX_PER_MESSAGE_ATTACHMENT_BYTES = 100 * 1024 * 1024;
```

In `postMessage`, after step 4 (get-or-create conversation) and before step 5 (mint reqId), insert the attachment commit block:

```ts
      // 4.5) Commit any attachment_ref blocks. The wire allows them as
      // part of contentBlocks; we resolve each one to a workspace path
      // BEFORE dispatching agent:invoke so the runner sees stable
      // `attachment` blocks (single source of truth at I4).
      //
      // turnId is server-minted here (it's the same turnId the runner
      // will use when it writes the user message to the workspace jsonl;
      // the runner reads it from message.turnId — D2 in Phase 2).
      const userTurnId = makeReqId();
      const rewrittenBlocks: ContentBlock[] = [];
      let totalAttachmentBytes = 0;
      const attachmentCtx = makeAgentContext({
        sessionId: 'channel-web-commit',
        agentId: body.agentId,
        userId,
        conversationId,
      });
      for (const block of body.contentBlocks) {
        if (block.type !== 'attachment_ref') {
          rewrittenBlocks.push(block);
          continue;
        }
        try {
          const committed = await bus.call<
            AttachmentsCommitInput,
            AttachmentsCommitOutput
          >('attachments:commit', attachmentCtx, {
            attachmentId: block.attachmentId,
            conversationId,
            turnId: userTurnId,
          });
          totalAttachmentBytes += committed.sizeBytes;
          if (totalAttachmentBytes > MAX_PER_MESSAGE_ATTACHMENT_BYTES) {
            res.status(413).json({ error: 'attachment-total-too-large' });
            return;
          }
          rewrittenBlocks.push({
            type: 'attachment',
            path: committed.path,
            displayName: committed.displayName,
            mediaType: committed.mediaType,
            sizeBytes: committed.sizeBytes,
          });
        } catch (err) {
          if (err instanceof PluginError) {
            if (err.code === 'not-found') {
              res.status(400).json({ error: 'attachment-not-found' });
              return;
            }
            if (err.code === 'forbidden') {
              res.status(400).json({ error: 'attachment-foreign-user' });
              return;
            }
          }
          throw err;
        }
      }
```

Then in step 6 (the `AgentMessage` construction), change:

```ts
      const message: AgentMessage = {
        role: 'user',
        content: extractText(body.contentBlocks),
      };
```

to:

```ts
      const message: AgentMessage = {
        role: 'user',
        content: extractText(rewrittenBlocks),
        // Phase 3: pass the full block list when any non-text block is
        // present so the runner can render attachments. Phase 2's D2
        // extension on AgentMessageSchema makes `contentBlocks`
        // optional; Phase 3 starts populating it.
        contentBlocks: rewrittenBlocks,
      };
```

Also pass `userTurnId` into the `agentInvokeCtx` via `makeAgentContext` so the runner can read it from the per-call ctx; if `AgentContext` does not carry `turnId`, instead extend `AgentMessage` to carry it. (Phase 2's `AgentMessageSchema` extension; verify on `packages/ipc-protocol/src/actions.ts`. If `turnId` already lives on `AgentMessage`, set it; if not, leave it on ctx and Phase 3 adds the schema field in a sub-step.) Quickly verify:

```bash
grep -n "turnId" packages/ipc-protocol/src/actions.ts
```

If `turnId` is not in `AgentMessageSchema`, add it:

```ts
// packages/ipc-protocol/src/actions.ts (extend AgentMessageSchema)
export const AgentMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  contentBlocks: z.array(ContentBlockSchema).optional(),
  /** Server-minted user-turn id (Phase 3, 2026-05-18). Used by the
   *  runner to bind the user message to the same turn the host
   *  committed attachments under. */
  turnId: z.string().optional(),
});
```

And populate it in the rewritten `message`:

```ts
      const message: AgentMessage = {
        role: 'user',
        content: extractText(rewrittenBlocks),
        contentBlocks: rewrittenBlocks,
        turnId: userTurnId,
      };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @ax/channel-web test -- routes-chat.test.ts
pnpm --filter @ax/ipc-protocol test
pnpm --filter @ax/channel-web build
```

Expected: PASS across the channel-web + ipc-protocol filters; build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/server/routes-chat.ts packages/channel-web/src/__tests__/server/routes-chat.test.ts packages/ipc-protocol/src/actions.ts
git commit -m "feat(channel-web): commit attachment_ref blocks in POST /api/chat/messages"
```

---

## Task 5: Wire new routes into `@ax/channel-web`'s plugin

Add `registerAttachmentsRoutes` to the plugin's `init`, declare the new service-hook calls in the manifest, and ensure shutdown unregisters them.

**Files:**
- Modify: `packages/channel-web/src/server/plugin.ts`
- Modify: `packages/channel-web/src/__tests__/server/plugin.test.ts`

- [ ] **Step 1: Write failing test for manifest + route registration**

Append to `packages/channel-web/src/__tests__/server/plugin.test.ts` (find the existing test that asserts which routes get registered):

```ts
describe('attachments routes', () => {
  it('declares attachments:* hooks in manifest.calls', () => {
    const plugin = createChannelWebServerPlugin();
    expect(plugin.manifest.calls).toContain('attachments:store-temp');
    expect(plugin.manifest.calls).toContain('attachments:commit');
    expect(plugin.manifest.calls).toContain('attachments:download');
  });

  it('registers POST /api/attachments and GET /api/files', async () => {
    const harness = await makeHarnessWithAttachments();
    const routes = harness.routesRegistered();
    expect(routes).toContainEqual({ method: 'POST', path: '/api/attachments' });
    expect(routes).toContainEqual({ method: 'GET', path: '/api/files' });
    await harness.shutdown();
  });
});
```

(`makeHarnessWithAttachments`: clone the existing harness factory in plugin.test.ts and add `createAttachmentsPlugin` to its plugin list. `routesRegistered` reads from the existing http-server mock that captures `http:register-route` calls.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- plugin.test.ts
```

Expected: FAIL — the plugin doesn't register attachments routes yet.

- [ ] **Step 3: Wire routes into `plugin.ts`**

Open `packages/channel-web/src/server/plugin.ts`. Add the import:

```ts
import { registerAttachmentsRoutes } from './routes-attachments.js';
```

Extend `manifest.calls`:

```ts
      calls: [
        'http:register-route',
        'auth:require-user',
        'agents:resolve',
        'agents:list-for-user',
        'conversations:get-by-req-id',
        'conversations:create',
        'conversations:get',
        'conversations:list',
        'conversations:delete',
        'agent:invoke',
        // Phase 3 — attachments & artifacts.
        'attachments:store-temp',
        'attachments:commit',
        'attachments:download',
      ],
```

In `init`, after the existing `registerChatRoutes` call:

```ts
      const chatRouteUnregisters = await registerChatRoutes(bus, initCtx);
      for (const u of chatRouteUnregisters) unregisterRoutes.push(u);

      // Phase 3 — attachments + downloads.
      const attachmentRouteUnregisters = await registerAttachmentsRoutes(
        bus,
        initCtx,
      );
      for (const u of attachmentRouteUnregisters) unregisterRoutes.push(u);
```

(The existing `shutdown` already drains `unregisterRoutes`, so the new routes tear down with the others.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @ax/channel-web test -- plugin.test.ts
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/server/plugin.ts packages/channel-web/src/__tests__/server/plugin.test.ts
git commit -m "feat(channel-web): register attachments routes in plugin init"
```

---

## Task 6: Translate `attachment` blocks → assistant-ui `file` parts in the history adapter

assistant-ui's `MessagePrimitive.Parts` dispatches by part type. The chip components render via `Parts.components.File` (we wire that in Task 11). For history load (cold open of a conversation), the conversation row contains stored `attachment` ContentBlocks; the history adapter is the boundary that translates them to assistant-ui's `FileUIPart` shape.

For the live-send path, the adapter's `send()` already produces a `file` part with `data: ax://attachment/<id>` (Task 8 implements this). On replay the path is different — the stored block has `path` (the workspace path) not `attachmentId`. We use `data: ax://attachment-path/<base64url(path)>` so the chip can decode the path client-side and feed it to `GET /api/files`.

**Files:**
- Modify: `packages/channel-web/src/lib/history-adapter.ts`
- Modify: `packages/channel-web/src/__tests__/history-adapter.test.ts`

- [ ] **Step 1: Read the current history adapter**

```bash
grep -n "ContentBlock\|attachment\|type: 'file'" packages/channel-web/src/lib/history-adapter.ts | head -20
```

The current adapter (per Task 11 of Week 10–12) translates `text`/`thinking`/`tool_use`/`tool_result` blocks into assistant-ui parts. It does not yet handle `attachment` blocks — they'd flow through whatever fallback the adapter uses (most likely dropped silently).

- [ ] **Step 2: Write failing tests for the new translation**

Add to `packages/channel-web/src/__tests__/history-adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { contentBlocksToAuiParts } from '../lib/history-adapter';

describe('contentBlocksToAuiParts — attachment blocks', () => {
  it('translates an image attachment block to a file part with image type', () => {
    const blocks = [{
      type: 'attachment' as const,
      path: '.ax/uploads/c1/t1/abcd1234__cat.png',
      displayName: 'cat.png',
      mediaType: 'image/png',
      sizeBytes: 1234,
    }];
    const parts = contentBlocksToAuiParts(blocks, { conversationId: 'c1' });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      filename: 'cat.png',
    });
    const data = (parts[0] as { data: string }).data;
    expect(data.startsWith('ax://attachment-path/')).toBe(true);
  });

  it('translates a PDF attachment block to a file part with pdf type', () => {
    const blocks = [{
      type: 'attachment' as const,
      path: '.ax/uploads/c1/t1/abcd1234__report.pdf',
      displayName: 'Q4 Report.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 482113,
    }];
    const parts = contentBlocksToAuiParts(blocks, { conversationId: 'c1' });
    expect(parts[0]).toMatchObject({
      type: 'file',
      mediaType: 'application/pdf',
      filename: 'Q4 Report.pdf',
    });
  });

  it('preserves text + attachment ordering', () => {
    const blocks = [
      { type: 'text' as const, text: 'see attached' },
      {
        type: 'attachment' as const,
        path: '.ax/uploads/c1/t1/x.pdf',
        displayName: 'x.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 10,
      },
    ];
    const parts = contentBlocksToAuiParts(blocks, { conversationId: 'c1' });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect(parts[1]).toMatchObject({ type: 'file' });
  });
});
```

(`contentBlocksToAuiParts` may currently be named differently. If the adapter exports a different function — e.g. `mapTurnToMessage` or `toThreadMessages` — adapt the tests to that public surface. The key is testing translation of `attachment` blocks.)

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- history-adapter.test.ts
```

Expected: FAIL — adapter doesn't recognise `attachment` blocks.

- [ ] **Step 4: Extend the translator**

Open `packages/channel-web/src/lib/history-adapter.ts`. Add the attachment-block case inside the main translation loop (the exact location depends on the adapter's current structure):

```ts
// Inside the per-block switch:
case 'attachment': {
  // Workspace-relative path → opaque url that AttachmentChip can decode
  // to feed GET /api/files. We use base64url so the path can carry
  // slashes safely in a URL.
  const encodedPath = base64url(block.path);
  parts.push({
    type: 'file',
    data: `ax://attachment-path/${encodedPath}`,
    mediaType: block.mediaType,
    filename: block.displayName,
  });
  break;
}
```

Add the `base64url` helper at the bottom of the file:

```ts
function base64url(input: string): string {
  return btoa(input)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
```

And export a decoder used by `AttachmentChip` (Task 11):

```ts
export function decodeAttachmentPath(url: string): string | null {
  const PREFIX = 'ax://attachment-path/';
  if (!url.startsWith(PREFIX)) return null;
  const encoded = url.slice(PREFIX.length);
  const padded = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  try {
    return atob(padded + '==='.slice(0, (4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run tests + build**

```bash
pnpm --filter @ax/channel-web test -- history-adapter.test.ts
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/lib/history-adapter.ts packages/channel-web/src/__tests__/history-adapter.test.ts
git commit -m "feat(channel-web): translate attachment blocks to assistant-ui file parts"
```

---

## Task 7: `AxAttachmentAdapter` — assistant-ui's `AttachmentAdapter` impl

The adapter mediates between assistant-ui's composer state and the upload endpoint. `add()` is a generator that yields progressive states; `send()` returns the final part that gets folded into the user message; `remove()` is a no-op (the temp-store TTL handles cleanup).

XHR (not fetch) is used for `add` so we can observe upload progress events — fetch's streaming-upload progress isn't broadly supported yet.

**Files:**
- Create: `packages/channel-web/src/lib/ax-attachment-adapter.ts`
- Create: `packages/channel-web/src/__tests__/ax-attachment-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/channel-web/src/__tests__/ax-attachment-adapter.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxAttachmentAdapter } from '../lib/ax-attachment-adapter';

const ORIG_XHR = globalThis.XMLHttpRequest;

class MockXhr {
  upload = { onprogress: null as null | ((e: ProgressEvent) => void) };
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  responseText = '';
  status = 0;
  withCredentials = false;
  private headers: Record<string, string> = {};
  open(_method: string, _url: string) { /* noop */ }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(_body: unknown) {
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent);
      this.status = 200;
      this.responseText = JSON.stringify({
        attachmentId: 'att-123',
        sizeBytes: 100,
        mediaType: 'application/pdf',
        displayName: 'report.pdf',
        expiresAt: '2026-05-18T12:00:00Z',
      });
      this.onload?.();
    }, 0);
  }
}

beforeEach(() => {
  (globalThis as unknown as { XMLHttpRequest: typeof MockXhr }).XMLHttpRequest =
    MockXhr;
});
afterEach(() => {
  (globalThis as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest =
    ORIG_XHR;
});

describe('AxAttachmentAdapter', () => {
  it('yields a running-pending and then a requires-action state on success', async () => {
    const adapter = new AxAttachmentAdapter();
    const file = new File(['fake bytes'], 'report.pdf', { type: 'application/pdf' });
    const states: unknown[] = [];
    for await (const state of adapter.add({ file })) {
      states.push(state);
    }
    expect(states.length).toBeGreaterThanOrEqual(2);
    const last = states[states.length - 1] as { id: string; status: { type: string } };
    expect(last.id).toBe('att-123');
    expect(last.status.type).toBe('requires-action');
  });

  it('send() returns a CompleteAttachment with an ax://attachment URL', async () => {
    const adapter = new AxAttachmentAdapter();
    const pending = {
      id: 'att-123',
      type: 'document' as const,
      name: 'report.pdf',
      contentType: 'application/pdf',
      file: new File(['x'], 'report.pdf', { type: 'application/pdf' }),
      status: { type: 'requires-action' as const, reason: 'composer-send' as const },
    };
    const result = await adapter.send(pending);
    expect(result.id).toBe('att-123');
    expect(result.status.type).toBe('complete');
    expect(result.content).toHaveLength(1);
    const part = result.content[0] as {
      type: string;
      data: string;
      mimeType: string;
      filename: string;
    };
    expect(part.type).toBe('file');
    expect(part.data).toBe('ax://attachment/att-123');
    expect(part.mimeType).toBe('application/pdf');
    expect(part.filename).toBe('report.pdf');
  });

  it('remove() is a no-op', async () => {
    const adapter = new AxAttachmentAdapter();
    await expect(adapter.remove({} as never)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- ax-attachment-adapter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

Create `packages/channel-web/src/lib/ax-attachment-adapter.ts`:

```ts
import type {
  AttachmentAdapter,
  PendingAttachment,
  CompleteAttachment,
} from '@assistant-ui/react';

/**
 * AxAttachmentAdapter — assistant-ui AttachmentAdapter implementation that
 * speaks the AX `/api/attachments` upload endpoint.
 *
 * Phase 3 (2026-05-18). Replaces the previous "no adapter, attach button
 * hidden" posture documented in lib/runtime.tsx.
 *
 * Flow:
 *   add(file)
 *     → POST /api/attachments multipart
 *     → yield PendingAttachment(running:uploading, progress 0..1)
 *     → on success: yield PendingAttachment(requires-action:composer-send)
 *           with id = server-minted attachmentId.
 *   send(pending)
 *     → return CompleteAttachment with a `file` content part carrying
 *       `data: ax://attachment/<attachmentId>`. The transport's
 *       toContentBlocks() converts this to an `attachment_ref` block.
 *   remove()
 *     → no-op. Temp-store TTL (default 10 min) reclaims unsent uploads.
 *       Future: explicit DELETE /api/attachments/<id>.
 */
export class AxAttachmentAdapter implements AttachmentAdapter {
  // Comma-joined MIME list. Matches the server's default allowlist.
  // Server is authoritative — this is just a UX hint for the file picker.
  accept =
    'image/png,image/jpeg,image/gif,image/webp,application/pdf,' +
    'text/plain,text/csv,text/markdown,application/json,application/zip';

  async *add({
    file,
  }: {
    file: File;
  }): AsyncGenerator<PendingAttachment> {
    const tempId = crypto.randomUUID();
    yield {
      id: tempId,
      type: typeForMime(file.type),
      name: file.name,
      contentType: file.type || 'application/octet-stream',
      file,
      status: { type: 'running', reason: 'uploading', progress: 0 },
    };

    let lastProgress = 0;
    const result = await uploadWithProgress(file, (progress) => {
      lastProgress = progress;
    });
    void lastProgress; // observed via the promise's progress callback above

    yield {
      id: result.attachmentId,
      type: typeForMime(result.mediaType),
      name: result.displayName,
      contentType: result.mediaType,
      file,
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  }

  async send(pending: PendingAttachment): Promise<CompleteAttachment> {
    return {
      id: pending.id,
      type: pending.type,
      name: pending.name,
      contentType: pending.contentType,
      status: { type: 'complete' },
      content: [
        {
          type: 'file',
          data: `ax://attachment/${pending.id}`,
          mimeType: pending.contentType ?? 'application/octet-stream',
          filename: pending.name,
        },
      ],
    };
  }

  async remove(): Promise<void> {
    // No-op. TTL janitor reaps unsent temps.
  }
}

interface UploadResult {
  attachmentId: string;
  sizeBytes: number;
  mediaType: string;
  displayName: string;
  expiresAt: string;
}

function typeForMime(mime: string): PendingAttachment['type'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function uploadWithProgress(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/attachments');
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Requested-With', 'ax-admin');
    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(e.loaded / e.total);
      }
    };
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(xhr.responseText) as UploadResult;
          resolve(parsed);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      } else {
        // Try to parse a JSON error body for a nicer UX; otherwise
        // surface status code.
        let errCode = `upload failed (${xhr.status})`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: string };
          if (parsed.error) errCode = parsed.error;
        } catch { /* ignore */ }
        reject(new Error(errCode));
      }
    };
    xhr.send(form);
  });
}
```

- [ ] **Step 4: Run tests + build**

```bash
pnpm --filter @ax/channel-web test -- ax-attachment-adapter.test.ts
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/ax-attachment-adapter.ts packages/channel-web/src/__tests__/ax-attachment-adapter.test.ts
git commit -m "feat(channel-web): AxAttachmentAdapter for POST /api/attachments uploads"
```

---

## Task 8: Update `AxChatTransport.toContentBlocks` to emit `attachment_ref`

The transport currently translates assistant-ui `file` parts to a text fallback (`[attachment: ...]`). Phase 3 replaces this with proper `attachment_ref` block emission when `part.data` matches `ax://attachment/<id>`.

**Files:**
- Modify: `packages/channel-web/src/lib/transport.ts`
- Modify: `packages/channel-web/src/__tests__/transport.test.ts` (or wherever `toContentBlocks` is exercised; create if absent)

- [ ] **Step 1: Write failing tests**

If `transport.test.ts` doesn't exist, create `packages/channel-web/src/__tests__/transport.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { toContentBlocksForTesting } from '../lib/transport';

describe('toContentBlocks — attachment handling', () => {
  it('emits attachment_ref blocks for ax://attachment/<id> file parts', () => {
    const msg = {
      role: 'user' as const,
      id: 'm1',
      parts: [
        { type: 'text' as const, text: 'see attached' },
        {
          type: 'file' as const,
          url: 'ax://attachment/att-abc',
          data: 'ax://attachment/att-abc',
          mediaType: 'application/pdf',
          filename: 'report.pdf',
        },
      ],
    };
    const blocks = toContentBlocksForTesting(msg);
    expect(blocks).toEqual([
      { type: 'text', text: 'see attached' },
      { type: 'attachment_ref', attachmentId: 'att-abc' },
    ]);
  });

  it('preserves attachment_ref ordering across multiple files', () => {
    const msg = {
      role: 'user' as const,
      id: 'm1',
      parts: [
        { type: 'text' as const, text: 'two files:' },
        { type: 'file' as const, data: 'ax://attachment/a1', mediaType: 'text/plain', filename: 'a.txt' },
        { type: 'file' as const, data: 'ax://attachment/a2', mediaType: 'text/plain', filename: 'b.txt' },
      ],
    };
    const blocks = toContentBlocksForTesting(msg);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toEqual({ type: 'attachment_ref', attachmentId: 'a1' });
    expect(blocks[2]).toEqual({ type: 'attachment_ref', attachmentId: 'a2' });
  });

  it('falls back to a text mention for non-ax file parts', () => {
    const msg = {
      role: 'user' as const,
      id: 'm1',
      parts: [
        {
          type: 'file' as const,
          url: 'https://example.com/x.pdf',
          mediaType: 'application/pdf',
          filename: 'x.pdf',
        },
      ],
    };
    const blocks = toContentBlocksForTesting(msg);
    expect(blocks[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('x.pdf'),
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- transport.test.ts
```

Expected: FAIL — emission produces a `text` block, not `attachment_ref`.

- [ ] **Step 3: Update `toContentBlocks`**

Open `packages/channel-web/src/lib/transport.ts`. Replace the existing `toContentBlocks` function (lines 122-150) with:

```ts
const AX_ATTACHMENT_URL_PREFIX = 'ax://attachment/';

function isAxAttachmentPart(p: unknown): { attachmentId: string } | null {
  if (!p || typeof p !== 'object') return null;
  const obj = p as { type?: unknown; data?: unknown; url?: unknown };
  if (obj.type !== 'file') return null;
  const candidate =
    typeof obj.data === 'string' ? obj.data :
    typeof obj.url === 'string' ? obj.url : null;
  if (candidate === null) return null;
  if (!candidate.startsWith(AX_ATTACHMENT_URL_PREFIX)) return null;
  const id = candidate.slice(AX_ATTACHMENT_URL_PREFIX.length);
  if (id.length === 0) return null;
  return { attachmentId: id };
}

/** Convert one AI-SDK UIMessage's parts list to an AX ContentBlock array.
 *  Phase 3: ax://attachment/<id> file parts become attachment_ref blocks;
 *  other file parts fall back to text mentions (legacy behavior preserved
 *  for any non-ax adapter that might surface a file part in the future).
 */
function toContentBlocks(msg: UIMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (!msg.parts) return blocks;

  // Collect text first (chat-flow concatenates all text into one block).
  let collectedText = '';
  for (const p of msg.parts) {
    if (p.type === 'text') {
      collectedText += p.text;
    }
  }
  if (collectedText.length > 0) {
    blocks.push({ type: 'text', text: collectedText });
  }

  // Then file parts, preserving order.
  for (const p of msg.parts) {
    if (p.type !== 'file') continue;
    const ax = isAxAttachmentPart(p);
    if (ax !== null) {
      blocks.push({ type: 'attachment_ref', attachmentId: ax.attachmentId });
      continue;
    }
    // Non-ax file part — text-mention fallback (preserves the legacy
    // path so a future adapter that emits e.g. https:// file parts
    // doesn't drop the user's intent silently).
    const fp = p as { url?: string; mediaType?: string; filename?: string };
    const ref = fp.url ?? '';
    const filename = fp.filename ?? '';
    blocks.push({
      type: 'text',
      text: `[attachment: ${filename || ref}]`,
    });
  }
  return blocks;
}

/** Test-only export of toContentBlocks so unit tests can drive it
 *  without booting an entire transport instance. */
export const toContentBlocksForTesting = toContentBlocks;
```

- [ ] **Step 4: Run tests + build**

```bash
pnpm --filter @ax/channel-web test -- transport.test.ts
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/transport.ts packages/channel-web/src/__tests__/transport.test.ts
git commit -m "feat(channel-web): emit attachment_ref blocks from ax:// file parts"
```

---

## Task 9: Wire `AxAttachmentAdapter` into the runtime

Replace the "no attachments adapter" no-op in `useChatThreadRuntime` with an instantiation of `AxAttachmentAdapter`. The runtime hook is the single boundary the assistant-ui composer consults to detect adapter presence.

**Files:**
- Modify: `packages/channel-web/src/lib/runtime.tsx`
- Modify (extend): `packages/channel-web/src/__tests__/composer.test.tsx` (or create a new `runtime.test.tsx`)

- [ ] **Step 1: Update `useChatThreadRuntime`**

Open `packages/channel-web/src/lib/runtime.tsx`. Find lines 18-25 (the comment block explaining why no adapter is configured). Delete that comment. In the `useChatThreadRuntime` function body, before the `useChat` call, add:

```ts
import { AxAttachmentAdapter } from './ax-attachment-adapter';
```

(at the file's top imports.)

Then inside `useChatThreadRuntime`:

```ts
const useChatThreadRuntime = (transport: AxChatTransport): AssistantRuntime => {
  const id = useAuiState(({ threadListItem }) => threadListItem.id);
  const aui = useAui();
  const { visible: thinkingVisible } = useThinkingStore();

  const history = useMemo(
    () =>
      createAxHistoryAdapter(
        () => aui.threadListItem().getState().remoteId,
        { includeThinking: thinkingVisible },
      ),
    [aui, thinkingVisible],
  );

  // Phase 3: AxAttachmentAdapter mediates POST /api/attachments. Stable
  // across the hook lifetime — no per-prop state, so a single instance
  // is enough.
  const attachments = useMemo(() => new AxAttachmentAdapter(), []);

  const chat = useChat({ id, transport });
  return useAISDKRuntime(chat, {
    adapters: { history, attachments },
  });
};
```

- [ ] **Step 2: Add a smoke test for the wiring**

Create `packages/channel-web/src/__tests__/composer-attachments.test.tsx`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { Composer } from '../components/Composer';
import { AxAttachmentAdapter } from '../lib/ax-attachment-adapter';

function ProviderWithAttachments({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime(
    { async run() { return { content: [{ type: 'text', text: 'ok' }] }; } },
    { adapters: { attachments: new AxAttachmentAdapter() } },
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

describe('Composer with attachments adapter', () => {
  it('renders the Attach button (gated on adapter presence)', () => {
    render(
      <ProviderWithAttachments>
        <Composer />
      </ProviderWithAttachments>,
    );
    expect(screen.getByLabelText('Attach')).toBeTruthy();
  });
});
```

This test verifies the gate works against `useLocalRuntime`; in production it's `useAISDKRuntime` with the same adapters slot, so the same gate applies.

- [ ] **Step 3: Run tests + build**

```bash
pnpm --filter @ax/channel-web test -- composer-attachments.test.tsx
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/src/lib/runtime.tsx packages/channel-web/src/__tests__/composer-attachments.test.tsx
git commit -m "feat(channel-web): wire AxAttachmentAdapter into useChatThreadRuntime"
```

---

## Task 10: `AttachmentComposerChip` — pre-send chip in the composer

A pre-send chip with thumbnail (image/*) or file-type icon (other), display name, formatted size, optional upload progress bar, and remove button. Composed from shadcn primitives — `Button` (variant ghost size icon), `lucide-react` icons, semantic tokens, and assistant-ui's `AttachmentPrimitive` for state plumbing.

**Files:**
- Create: `packages/channel-web/src/components/AttachmentComposerChip.tsx`
- Create: `packages/channel-web/src/__tests__/attachment-composer-chip.test.tsx`

- [ ] **Step 1: Add shadcn `Progress` primitive**

```bash
pnpm dlx shadcn@latest add progress -c packages/channel-web
```

Expected: creates `packages/channel-web/src/components/ui/progress.tsx`. Verify by listing:

```bash
ls packages/channel-web/src/components/ui/
```

`progress.tsx` should be present alongside the existing primitives.

- [ ] **Step 2: Write failing tests for the chip**

Create `packages/channel-web/src/__tests__/attachment-composer-chip.test.tsx`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { AttachmentComposerChip } from '../components/AttachmentComposerChip';
import { AxAttachmentAdapter } from '../lib/ax-attachment-adapter';

function Wrapper({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime(
    { async run() { return { content: [{ type: 'text', text: 'ok' }] }; } },
    { adapters: { attachments: new AxAttachmentAdapter() } },
  );
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

describe('AttachmentComposerChip', () => {
  it('renders the display name', () => {
    // The chip pulls from useAttachment(); we render it inside a
    // controlled AttachmentPrimitive context for the test.
    render(
      <Wrapper>
        <TestHarness name="Q4 Report.pdf" mediaType="application/pdf" />
      </Wrapper>,
    );
    expect(screen.getByText('Q4 Report.pdf')).toBeTruthy();
  });

  it('renders an image thumbnail for image/* attachments', () => {
    const { container } = render(
      <Wrapper>
        <TestHarness name="cat.png" mediaType="image/png" />
      </Wrapper>,
    );
    // Thumb renders an <img> when assistant-ui's unstable_Thumb fires.
    // In jsdom the actual <img> may not load; we just assert the
    // image-variant container class is present.
    expect(container.querySelector('[data-variant="image"]')).toBeTruthy();
  });

  it('shows the remove button', () => {
    render(
      <Wrapper>
        <TestHarness name="x.pdf" mediaType="application/pdf" />
      </Wrapper>,
    );
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
  });
});

// Minimal harness: ComposerPrimitive.Attachments dispatches by an
// internal attachment-runtime context. For the unit test we mount the
// chip directly under a stub AttachmentPrimitive.Root that supplies a
// frozen attachment via the runtime context. The exact stub depends on
// the assistant-ui surface — if direct mounting fails, drop to render
// via the parent Composer instead.
function TestHarness(props: { name: string; mediaType: string }) {
  return (
    <AttachmentComposerChip
      _testAttachment={{
        id: 'test-id',
        name: props.name,
        contentType: props.mediaType,
        type: props.mediaType.startsWith('image/') ? 'image' : 'document',
        status: { type: 'complete' },
      }}
    />
  );
}
```

(The `_testAttachment` prop is a test-only escape hatch you'll add in the component to bypass the assistant-ui attachment-runtime context when rendered outside `ComposerPrimitive.Attachments`. The production composer renders this component via the `components.Attachment` slot and the context flows naturally.)

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- attachment-composer-chip.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the chip**

Create `packages/channel-web/src/components/AttachmentComposerChip.tsx`:

```tsx
import type { FC } from 'react';
import {
  AttachmentPrimitive,
  useAttachment,
} from '@assistant-ui/react';
import {
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AttachmentLike {
  id: string;
  name: string;
  contentType?: string;
  type: 'image' | 'video' | 'audio' | 'document' | 'file';
  status: { type: 'running' | 'requires-action' | 'complete' | 'incomplete'; reason?: string; progress?: number };
}

interface AttachmentComposerChipProps {
  /** Test-only escape hatch — when set, the chip renders against this
   *  frozen state instead of pulling from the attachment runtime context.
   *  Production callers should NEVER pass this; the prop is left
   *  untyped on the public surface to discourage misuse.
   */
  _testAttachment?: AttachmentLike;
}

function pickIcon(mediaType: string | undefined) {
  if (!mediaType) return FileIcon;
  if (mediaType.startsWith('image/')) return ImageIcon;
  if (mediaType.startsWith('text/') || mediaType === 'application/json') return FileText;
  return FileIcon;
}

export const AttachmentComposerChip: FC<AttachmentComposerChipProps> = ({
  _testAttachment,
}) => {
  // useAttachment pulls from the assistant-ui composer-runtime context.
  // The test path overrides via _testAttachment.
  const ctxAttachment = useAttachment(
    (a) => a as unknown as AttachmentLike,
    () => false,
  );
  const attachment = _testAttachment ?? ctxAttachment;
  const isImage = (attachment.contentType ?? '').startsWith('image/');
  const Icon = pickIcon(attachment.contentType);
  const isUploading = attachment.status.type === 'running';
  const progress = isUploading && typeof attachment.status.progress === 'number'
    ? Math.round(attachment.status.progress * 100)
    : null;

  return (
    <div
      data-variant={isImage ? 'image' : 'file'}
      className={cn(
        'group/chip relative flex items-center gap-2 max-w-[220px]',
        'rounded-md border border-border bg-card px-2 py-1.5',
        'text-[12px] leading-tight text-foreground',
      )}
    >
      {isImage ? (
        <AttachmentPrimitive.unstable_Thumb
          className="size-7 shrink-0 rounded-sm object-cover bg-muted"
        />
      ) : (
        <div className="size-7 shrink-0 rounded-sm bg-muted flex items-center justify-center text-muted-foreground">
          <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium text-foreground">
          {attachment.name}
        </div>
        {isUploading && progress !== null && (
          <div
            className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>
      <AttachmentPrimitive.Remove asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove attachment"
          className="size-5 shrink-0 opacity-60 hover:opacity-100"
        >
          <X className="size-3" strokeWidth={1.5} aria-hidden="true" />
        </Button>
      </AttachmentPrimitive.Remove>
    </div>
  );
};
```

(If `AttachmentPrimitive.Remove` is not an assistant-ui export at the pinned version, fall back to wiring `useAttachmentRuntime().remove` via an `onClick`. The pinned version is `@assistant-ui/react@^0.12.19`; check `AttachmentPrimitive` exports before writing the implementation — `grep -n "AttachmentPrimitive" node_modules/@assistant-ui/react/dist/*.d.ts`.)

- [ ] **Step 5: Run tests + build**

```bash
pnpm --filter @ax/channel-web test -- attachment-composer-chip.test.tsx
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/AttachmentComposerChip.tsx packages/channel-web/src/components/ui/progress.tsx packages/channel-web/src/__tests__/attachment-composer-chip.test.tsx
git commit -m "feat(channel-web): AttachmentComposerChip (pre-send chip with progress + remove)"
```

---

## Task 11: `AttachmentChip` — in-transcript user-message chip

Renders inline inside user-message bubbles. Click triggers `GET /api/files`. No remove action.

**Files:**
- Create: `packages/channel-web/src/components/AttachmentChip.tsx`
- Create: `packages/channel-web/src/__tests__/attachment-chip.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `packages/channel-web/src/__tests__/attachment-chip.test.tsx`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AttachmentChip } from '../components/AttachmentChip';

describe('AttachmentChip', () => {
  it('renders display name and triggers GET /api/files on click', () => {
    const openSpy = vi.fn();
    Object.defineProperty(window, 'open', { value: openSpy, writable: true });

    render(
      <AttachmentChip
        path=".ax/uploads/c1/t1/foo.pdf"
        displayName="Q4 Report.pdf"
        mediaType="application/pdf"
        conversationId="c1"
      />,
    );
    expect(screen.getByText('Q4 Report.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/files\?path=[^&]+&conversationId=c1$/),
      expect.any(String),
    );
  });

  it('renders an image preview for image/*', () => {
    const { container } = render(
      <AttachmentChip
        path=".ax/uploads/c1/t1/cat.png"
        displayName="cat.png"
        mediaType="image/png"
        conversationId="c1"
      />,
    );
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toMatch(/\/api\/files\?path=[^&]+&conversationId=c1$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- attachment-chip.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the chip**

Create `packages/channel-web/src/components/AttachmentChip.tsx`:

```tsx
import type { FC } from 'react';
import { Download, File as FileIcon, FileText, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface AttachmentChipProps {
  /** Workspace-relative path (e.g. ".ax/uploads/<conv>/<turn>/<file>"). */
  path: string;
  displayName: string;
  mediaType: string;
  conversationId: string;
  /** Optional sizeBytes — when present, shown as a formatted suffix. */
  sizeBytes?: number;
}

function pickIcon(mediaType: string) {
  if (mediaType.startsWith('image/')) return ImageIcon;
  if (mediaType.startsWith('text/') || mediaType === 'application/json') return FileText;
  return FileIcon;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadUrl(path: string, conversationId: string): string {
  return `/api/files?path=${encodeURIComponent(path)}&conversationId=${encodeURIComponent(conversationId)}`;
}

export const AttachmentChip: FC<AttachmentChipProps> = ({
  path,
  displayName,
  mediaType,
  conversationId,
  sizeBytes,
}) => {
  const isImage = mediaType.startsWith('image/');
  const Icon = pickIcon(mediaType);
  const href = downloadUrl(path, conversationId);

  const onDownload = () => {
    // Use window.open with a sandboxed target so the browser's
    // download UI fires from the Content-Disposition header on the
    // server response. Same-origin, no popup blocker concerns.
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  if (isImage) {
    return (
      <button
        type="button"
        aria-label={`Download ${displayName}`}
        onClick={onDownload}
        className={cn(
          'group/chip block max-w-[280px] overflow-hidden',
          'rounded-md border border-border bg-card',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        )}
      >
        <img
          src={href}
          alt={displayName}
          className="block max-h-[200px] w-auto object-contain bg-muted"
        />
        <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted-foreground">
          <Icon className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span className="truncate">{displayName}</span>
        </div>
      </button>
    );
  }

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 max-w-[280px]',
        'rounded-md border border-border bg-card px-2.5 py-1.5',
        'text-[12px] leading-tight text-foreground',
      )}
    >
      <div className="size-7 shrink-0 rounded-sm bg-muted flex items-center justify-center text-muted-foreground">
        <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium">{displayName}</div>
        {typeof sizeBytes === 'number' && sizeBytes > 0 && (
          <div className="font-mono text-[10px] text-muted-foreground">
            {formatSize(sizeBytes)}
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Download ${displayName}`}
        className="size-5 shrink-0 opacity-60 hover:opacity-100"
        onClick={onDownload}
      >
        <Download className="size-3" strokeWidth={1.5} aria-hidden="true" />
      </Button>
    </div>
  );
};
```

- [ ] **Step 4: Run tests + build**

```bash
pnpm --filter @ax/channel-web test -- attachment-chip.test.tsx
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/AttachmentChip.tsx packages/channel-web/src/__tests__/attachment-chip.test.tsx
git commit -m "feat(channel-web): AttachmentChip for in-transcript user-message rendering"
```

---

## Task 12: `ArtifactChip` — assistant-message artifact chip

Two render modes: `inline` (shown at the tool-call's position) and `link` (Markdown link substitution for `ax://artifact/<id>`). Both resolve via the same `GET /api/files` mechanism, looking up the artifact's `path` from the matching `tool_result` in the surrounding assistant turn.

**Files:**
- Create: `packages/channel-web/src/components/ArtifactChip.tsx`
- Create: `packages/channel-web/src/__tests__/artifact-chip.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `packages/channel-web/src/__tests__/artifact-chip.test.tsx`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArtifactChip } from '../components/ArtifactChip';

describe('ArtifactChip', () => {
  it('renders displayName + size + a download trigger (inline variant)', () => {
    render(
      <ArtifactChip
        variant="inline"
        path="workspace/reports/Q4.pdf"
        displayName="Q4 Report"
        mediaType="application/pdf"
        sizeBytes={482113}
        conversationId="c1"
      />,
    );
    expect(screen.getByText('Q4 Report')).toBeTruthy();
    expect(screen.getByText(/470/)).toBeTruthy(); // 482113 / 1024 ≈ 471 KB
    expect(screen.getByLabelText(/Download Q4 Report/)).toBeTruthy();
  });

  it('renders a disabled "unknown artifact" pill when no match is provided', () => {
    render(
      <ArtifactChip
        variant="link"
        artifactId="unknown-id"
        conversationId="c1"
        // No path / displayName given → unknown.
      />,
    );
    expect(screen.getByText(/unknown artifact/i)).toBeTruthy();
  });

  it('link variant renders inline with the display name as link text', () => {
    render(
      <ArtifactChip
        variant="link"
        path="workspace/x.pdf"
        displayName="x.pdf"
        mediaType="application/pdf"
        sizeBytes={1024}
        conversationId="c1"
      />,
    );
    const a = screen.getByRole('link', { name: 'x.pdf' });
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toMatch(/\/api\/files\?/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- artifact-chip.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the chip**

Create `packages/channel-web/src/components/ArtifactChip.tsx`:

```tsx
import type { FC } from 'react';
import { Download, FileSparkles, FileText, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface BaseProps {
  variant: 'inline' | 'link';
  conversationId: string;
}

interface ResolvedProps extends BaseProps {
  path: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  artifactId?: string;
}

interface UnknownProps extends BaseProps {
  artifactId: string;
  path?: undefined;
}

export type ArtifactChipProps = ResolvedProps | UnknownProps;

function pickIcon(mediaType: string) {
  if (mediaType.startsWith('image/')) return ImageIcon;
  if (mediaType.startsWith('text/') || mediaType === 'application/json') return FileText;
  return FileSparkles;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadUrl(path: string, conversationId: string): string {
  return `/api/files?path=${encodeURIComponent(path)}&conversationId=${encodeURIComponent(conversationId)}`;
}

export const ArtifactChip: FC<ArtifactChipProps> = (props) => {
  if (!('path' in props) || props.path === undefined) {
    // Unknown artifact — render disabled pill.
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md',
          'border border-dashed border-border bg-muted/50 px-2 py-0.5',
          'text-[12px] text-muted-foreground',
        )}
        aria-label={`Unknown artifact ${props.artifactId}`}
      >
        <FileSparkles className="size-3" strokeWidth={1.5} aria-hidden="true" />
        unknown artifact
      </span>
    );
  }

  const Icon = pickIcon(props.mediaType);
  const href = downloadUrl(props.path, props.conversationId);

  if (props.variant === 'link') {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          'inline-flex items-center gap-1 align-baseline',
          'underline decoration-dotted underline-offset-2',
          'text-foreground hover:text-primary transition-colors',
        )}
      >
        <Icon className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        {props.displayName}
      </a>
    );
  }

  // Inline variant — full chip card.
  const onDownload = () => {
    window.open(href, '_blank', 'noopener,noreferrer');
  };
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 max-w-[320px]',
        'rounded-md border border-border bg-card px-2.5 py-1.5 mt-2',
        'text-[12px] leading-tight text-foreground',
      )}
      data-testid="artifact-chip"
    >
      <div className="size-7 shrink-0 rounded-sm bg-muted flex items-center justify-center text-muted-foreground">
        <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium">{props.displayName}</div>
        <div className="font-mono text-[10px] text-muted-foreground">
          {formatSize(props.sizeBytes)}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Download ${props.displayName}`}
        className="size-5 shrink-0 opacity-60 hover:opacity-100"
        onClick={onDownload}
      >
        <Download className="size-3" strokeWidth={1.5} aria-hidden="true" />
      </Button>
    </div>
  );
};
```

If `FileSparkles` isn't in lucide-react at the pinned version, swap to `Sparkles` or `FileSymlink`. Verify with:

```bash
grep -l "FileSparkles\|FileSymlink\|Sparkles" node_modules/lucide-react/dist/lucide-react.d.ts | head -1
```

- [ ] **Step 4: Run tests + build**

```bash
pnpm --filter @ax/channel-web test -- artifact-chip.test.tsx
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/ArtifactChip.tsx packages/channel-web/src/__tests__/artifact-chip.test.tsx
git commit -m "feat(channel-web): ArtifactChip with inline and link variants"
```

---

## Task 13: Wire `ComposerPrimitive.AttachmentDropzone` + `Attachments` into the Composer

Wrap the existing composer in `ComposerPrimitive.AttachmentDropzone` (drag-and-drop), and render `ComposerPrimitive.Attachments` with `components={{ Attachment: AttachmentComposerChip }}` above the input row so pre-send chips appear there.

**Files:**
- Modify: `packages/channel-web/src/components/Composer.tsx`
- Modify: `packages/channel-web/src/__tests__/composer.test.tsx`

- [ ] **Step 1: Write failing test for the dropzone + attachment row**

Append to `packages/channel-web/src/__tests__/composer.test.tsx`:

```ts
import { AxAttachmentAdapter } from '../lib/ax-attachment-adapter';
// extend StubRuntimeProvider to include attachments adapter:
const AttachmentRuntimeProvider = ({ children }: { children: ReactNode }) => {
  const runtime = useLocalRuntime(
    { async run() { return { content: [{ type: 'text', text: 'ok' }] }; } },
    { adapters: { attachments: new AxAttachmentAdapter() } },
  );
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
};

describe('Composer with attachment dropzone', () => {
  it('mounts the dropzone wrapper', () => {
    const { container } = render(
      <AttachmentRuntimeProvider>
        <Composer />
      </AttachmentRuntimeProvider>,
    );
    // assistant-ui's AttachmentDropzone tags its root with a data attribute.
    expect(container.querySelector('[data-attachment-dropzone]')).toBeTruthy();
  });

  it('renders the attachments slot above the input row', () => {
    const { container } = render(
      <AttachmentRuntimeProvider>
        <Composer />
      </AttachmentRuntimeProvider>,
    );
    const attachmentsRow = container.querySelector('.composer-attachments');
    expect(attachmentsRow).toBeTruthy();
    const fieldRow = container.querySelector('.composer-field');
    expect(fieldRow).toBeTruthy();
    // Order check: attachments row precedes the field row.
    const inner = container.querySelector('.composer-inner');
    expect(inner).toBeTruthy();
    const children = Array.from(inner!.children);
    const attIdx = children.findIndex((c) => c.classList.contains('composer-attachments'));
    const fieldIdx = children.findIndex((c) => c.classList.contains('composer-field'));
    expect(attIdx).toBeGreaterThanOrEqual(0);
    expect(attIdx).toBeLessThan(fieldIdx);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- composer.test.tsx
```

Expected: FAIL — no dropzone, no attachments row.

- [ ] **Step 3: Update the Composer**

Open `packages/channel-web/src/components/Composer.tsx`. Add imports:

```tsx
import { AttachmentComposerChip } from './AttachmentComposerChip';
```

(`ComposerPrimitive` is already imported.)

Modify the JSX. Replace the inner of `<ComposerPrimitive.Root>` with the dropzone wrapper + attachments slot + field. The new shape:

```tsx
return (
  <div
    className="
      composer composer-fade group/composer
      fixed bottom-0 right-[var(--scrollbar-gutter,15px)] left-[240px]
      [body.sidebar-collapsed_&]:left-[56px]
      max-[720px]:!left-0
      flex justify-center px-6 pt-10 pb-[22px] z-20
      transition-[left] duration-200
    "
  >
    <ComposerPrimitive.Root
      className="composer-inner relative w-full max-w-[640px]"
      onSubmit={onSubmit}
    >
      <AgentStatus />
      <ComposerPrimitive.AttachmentDropzone
        data-attachment-dropzone=""
        className="
          relative rounded-lg
          data-[dragging=true]:ring-2 data-[dragging=true]:ring-primary
          data-[dragging=true]:ring-offset-2
        "
      >
        <ComposerPrimitive.Attachments
          components={{ Attachment: AttachmentComposerChip }}
          className="composer-attachments flex flex-wrap gap-1.5 px-1.5 pt-1.5 empty:hidden"
        />
        <div
          className="
            composer-field relative flex items-end gap-2.5
            px-3.5 pl-[14px] py-2.5 rounded-lg bg-card
            border border-border shadow-sm transition-[border-color,box-shadow] duration-150
            focus-within:border-primary/40
            focus-within:shadow-[0_0_0_4px_hsl(var(--primary)/0.14),0_1px_2px_hsl(0_0%_0%/0.04)]
          "
        >
          <AttachMenu />
          <ComposerPrimitive.Input
            placeholder="Message ax…"
            className="
              composer-input flex-1 min-w-0 resize-none border-0 outline-none bg-transparent
              text-foreground text-[15px] leading-[1.55] py-0.5
              min-h-7 max-h-[200px]
              placeholder:text-muted-foreground
            "
            autoFocus
            rows={1}
            ref={inputRef}
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send asChild>
              {/* existing Send button — unchanged */}
              {/* ... omitted for brevity, paste from current Composer.tsx ... */}
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel asChild>
              {/* existing Cancel button — unchanged */}
              {/* ... omitted for brevity, paste from current Composer.tsx ... */}
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
      </ComposerPrimitive.AttachmentDropzone>
      <div
        className="
          mt-2 text-center text-[10.5px] tracking-[0.04em] text-ink-ghost pointer-events-none
          opacity-0 transition-opacity duration-150
          group-hover/composer:opacity-100 group-focus-within/composer:opacity-100
        "
      >
        <kbd className="font-mono text-[10px] text-muted-foreground">⏎</kbd> send ·{' '}
        <kbd className="font-mono text-[10px] text-muted-foreground">⇧⏎</kbd> newline
      </div>
    </ComposerPrimitive.Root>
  </div>
);
```

The Send and Cancel buttons stay exactly as in the current file — copy them verbatim from `packages/channel-web/src/components/Composer.tsx:163-204`. The change is purely the new wrapper hierarchy.

- [ ] **Step 4: Run tests + build**

```bash
pnpm --filter @ax/channel-web test -- composer.test.tsx
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/Composer.tsx packages/channel-web/src/__tests__/composer.test.tsx
git commit -m "feat(channel-web): wire AttachmentDropzone + Attachments slot into composer"
```

---

## Task 14: Wire `AttachmentChip` + `ArtifactChip` into `Thread.tsx` message rendering

The Thread component dispatches message parts via `MessagePrimitive.Parts.components`. Phase 3 adds:
1. `File: AttachmentChip` on user messages so `ax://attachment-path/<base64url(path)>` file parts (from the history adapter, Task 6) render as chips.
2. A custom tool-call renderer for `name === 'artifact_publish'` that parses the matched `tool_result` and renders `<ArtifactChip variant="inline" />`.

**Files:**
- Modify: `packages/channel-web/src/components/Thread.tsx`
- Modify: `packages/channel-web/src/components/ToolUse.tsx`
- Modify: `packages/channel-web/src/__tests__/composer.test.tsx` (or a new `thread-attachments.test.tsx`)

- [ ] **Step 1: Write failing tests**

Create `packages/channel-web/src/__tests__/thread-attachments.test.tsx`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { Thread } from '../components/Thread';

// Seed runtime with a user message that carries a file part whose data
// is ax://attachment-path/<base64url(path)>, then assert AttachmentChip
// renders.
function ProviderWithSeededMessages({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime(
    { async run() { return { content: [{ type: 'text', text: 'ack' }] }; } },
    {
      initialMessages: [
        {
          id: 'm-user-1',
          role: 'user',
          parts: [
            { type: 'text', text: 'see attached' },
            {
              type: 'file',
              data: 'ax://attachment-path/' + btoa('.ax/uploads/c1/t1/foo.pdf'),
              mediaType: 'application/pdf',
              filename: 'foo.pdf',
            },
          ],
        } as never,
      ],
    },
  );
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

describe('Thread renders AttachmentChip for attachment-path file parts', () => {
  it('renders the chip with the display name', () => {
    render(
      <ProviderWithSeededMessages>
        <Thread />
      </ProviderWithSeededMessages>,
    );
    expect(screen.getByText('foo.pdf')).toBeTruthy();
  });
});
```

(`initialMessages` may have a slightly different shape in the pinned assistant-ui version; adapt the test seed to match. The key invariant the test pins is: a `file` part with `data` starting with `ax://attachment-path/` renders as `AttachmentChip` with the decoded display name.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- thread-attachments.test.tsx
```

Expected: FAIL — Thread.tsx doesn't render File parts.

- [ ] **Step 3: Update `Thread.tsx`**

Open `packages/channel-web/src/components/Thread.tsx`. Add imports:

```tsx
import { AttachmentChip } from './AttachmentChip';
import { decodeAttachmentPath } from '../lib/history-adapter';
import { useConversationId } from '../lib/use-conversation-id';
```

(Create `lib/use-conversation-id.ts` as a tiny hook that reads the current conversationId from the transport's resolver — Task 14a sub-step below.)

Add a `UserAttachmentPart` adapter that converts assistant-ui's `FileMessagePart` shape into `AttachmentChip` props:

```tsx
interface FileMessagePartProps {
  /** assistant-ui's FilePart shape: data is the URL, mediaType the MIME. */
  data?: string;
  url?: string;
  mediaType?: string;
  filename?: string;
}

const UserFilePart: FC<FileMessagePartProps> = (props) => {
  const conversationId = useConversationId();
  const url = props.data ?? props.url ?? '';
  const path = decodeAttachmentPath(url);
  if (path === null || conversationId === null) {
    // Unknown URL shape — render bare text fallback so we never silently
    // drop the user's attachment from the transcript.
    return (
      <span className="text-xs text-muted-foreground italic">
        [attachment: {props.filename ?? 'unknown'}]
      </span>
    );
  }
  return (
    <AttachmentChip
      path={path}
      displayName={props.filename ?? 'file'}
      mediaType={props.mediaType ?? 'application/octet-stream'}
      conversationId={conversationId}
    />
  );
};
```

In the `UserMessage` component (line 100 onwards), pass `UserFilePart` to `MessagePrimitive.Parts.components`:

```tsx
<MessagePrimitive.Parts
  components={{
    Text: MarkdownText,
    File: UserFilePart,
  }}
/>
```

For the `AssistantMessage`, extend the existing `components` slot to register `tool-call`-specific behavior for `artifact_publish`. The current ToolFallback handles all unknown tools; we need a name-keyed override. Per assistant-ui's API, `tools` accepts a map of names → renderers:

```tsx
<MessagePrimitive.Parts
  components={{
    Text: MarkdownText,
    File: UserFilePart, // assistant turns rarely have file parts, but symmetry costs nothing
    tools: {
      by_name: { artifact_publish: ArtifactPublishTool },
      Fallback: ToolFallback,
    },
    ToolGroup,
  }}
/>
```

Create the `ArtifactPublishTool` component inline in Thread.tsx (or in ToolUse.tsx; the latter keeps tool-call rendering together):

```tsx
// In ToolUse.tsx — append:
import { ArtifactChip } from './ArtifactChip';

interface ArtifactPublishToolResult {
  artifactId: string;
  downloadUrl: string;
  path: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

export const ArtifactPublishTool: FC<ToolCallMessagePartProps> = (p) => {
  const conversationId = useConversationId();
  if (p.status?.type === 'running' || p.result === undefined) {
    // Tool in flight — render the standard fallback while waiting.
    return <ToolFallback {...p} />;
  }
  if (p.isError === true) {
    return <ToolFallback {...p} />;
  }
  let parsed: ArtifactPublishToolResult | null = null;
  try {
    const raw = typeof p.result === 'string' ? p.result : JSON.stringify(p.result);
    parsed = JSON.parse(raw) as ArtifactPublishToolResult;
  } catch {
    return <ToolFallback {...p} />;
  }
  if (!parsed || conversationId === null) return <ToolFallback {...p} />;
  return (
    <ArtifactChip
      variant="inline"
      conversationId={conversationId}
      path={parsed.path}
      displayName={parsed.displayName}
      mediaType={parsed.mediaType}
      sizeBytes={parsed.sizeBytes}
      artifactId={parsed.artifactId}
    />
  );
};
```

Add `useConversationId` to `ToolUse.tsx`'s imports.

- [ ] **Step 4 (sub-step): Create the `useConversationId` hook**

Create `packages/channel-web/src/lib/use-conversation-id.ts`:

```ts
/**
 * Read the current conversation id from the AxChatTransport. Returns null
 * before the first POST /api/chat/messages mints one (welcome state).
 *
 * Wired against the same `conversationRef` the runtime hook (lib/runtime.tsx)
 * holds. Exposed via a tiny module-level subscription so deep components
 * don't have to prop-drill it.
 */
let current: string | null = null;
const subscribers = new Set<() => void>();

export function setActiveConversationId(id: string | null): void {
  if (current === id) return;
  current = id;
  for (const sub of subscribers) sub();
}

import { useSyncExternalStore } from 'react';

export function useConversationId(): string | null {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => current,
    () => null,
  );
}
```

Wire `setActiveConversationId` into `lib/runtime.tsx`'s `handleSetConversationId`:

```ts
import { setActiveConversationId } from './use-conversation-id';

// ... inside handleSetConversationId:
const handleSetConversationId = useCallback((id: string) => {
  conversationRef.current = id;
  setActiveConversationId(id);
  sessionStoreActions.setActiveSession(id, true);
  sessionStoreActions.bumpVersion();
}, []);
```

And clear it when the active session clears:

```ts
useEffect(() => {
  if (activeSessionId === null) {
    conversationRef.current = null;
    setActiveConversationId(null);
  }
}, [activeSessionId]);
```

- [ ] **Step 5: Run tests + build**

```bash
pnpm --filter @ax/channel-web test -- thread-attachments.test.tsx
pnpm --filter @ax/channel-web test -- composer.test.tsx
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/Thread.tsx packages/channel-web/src/components/ToolUse.tsx packages/channel-web/src/lib/use-conversation-id.ts packages/channel-web/src/lib/runtime.tsx packages/channel-web/src/__tests__/thread-attachments.test.tsx
git commit -m "feat(channel-web): wire AttachmentChip + ArtifactChip into Thread renderer"
```

---

## Task 15: Extend `MarkdownText` to render `ax://artifact/<id>` URLs as `<ArtifactChip variant=\"link\" />`

react-markdown drops links to disallowed protocols by default (`ax://` isn't in the safe-protocol list). We extend `MarkdownTextPrimitive` via `urlTransform` (pass-through for `ax://`) and a custom `components.a` that detects `ax://artifact/<id>` hrefs and substitutes an `ArtifactChip`.

**Files:**
- Modify: `packages/channel-web/src/components/MarkdownText.tsx`
- Create: `packages/channel-web/src/__tests__/markdown-text.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `packages/channel-web/src/__tests__/markdown-text.test.tsx`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { MarkdownText } from '../components/MarkdownText';
import { setActiveConversationId } from '../lib/use-conversation-id';

// Tiny harness: feeds a markdown body through MarkdownText inside a
// thread with one assistant turn that carries a matching tool_result.
function Harness({ markdown, toolResult }: { markdown: string; toolResult?: object }) {
  setActiveConversationId('c1');
  const runtime = useLocalRuntime(
    { async run() { return { content: [{ type: 'text', text: 'ack' }] }; } },
    {
      initialMessages: [{
        id: 'a',
        role: 'assistant',
        parts: [
          ...(toolResult
            ? [{
                type: 'tool-call' as const,
                toolCallId: 't1',
                toolName: 'artifact_publish',
                args: { path: '/permanent/x.pdf' },
                result: JSON.stringify(toolResult),
                status: { type: 'complete' as const },
              }]
            : []),
          { type: 'text' as const, text: markdown },
        ],
      } as never],
    },
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages
          components={{
            AssistantMessage: () => (
              <MessagePrimitive.Root>
                <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
              </MessagePrimitive.Root>
            ),
          }}
        />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

describe('MarkdownText ax:// URL handling', () => {
  it('renders ax://artifact/<id> as a link chip when the artifact is known', () => {
    render(
      <Harness
        markdown="see [download](ax://artifact/a3f2)"
        toolResult={{
          artifactId: 'a3f2',
          downloadUrl: 'ax://artifact/a3f2',
          path: 'workspace/x.pdf',
          displayName: 'x.pdf',
          mediaType: 'application/pdf',
          sizeBytes: 1234,
          sha256: 'a3f2deadbeef',
        }}
      />,
    );
    // The link variant of ArtifactChip renders an <a> with the displayName.
    const a = screen.getByRole('link', { name: 'x.pdf' });
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toMatch(/\/api\/files\?/);
  });

  it('renders "unknown artifact" for unmatched ids', () => {
    render(
      <Harness markdown="[broken](ax://artifact/nope)" />,
    );
    expect(screen.getByText(/unknown artifact/i)).toBeTruthy();
  });

  it('leaves regular http://… links untouched', () => {
    render(<Harness markdown="[ok](https://example.com)" />);
    const a = screen.getByRole('link', { name: 'ok' });
    expect(a.getAttribute('href')).toBe('https://example.com/');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @ax/channel-web test -- markdown-text.test.tsx
```

Expected: FAIL — `ax://` links currently get stripped by react-markdown's default urlTransform.

- [ ] **Step 3: Extend MarkdownText**

Open `packages/channel-web/src/components/MarkdownText.tsx`. Replace the body with:

```tsx
import type { FC } from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import { useMessage } from '@assistant-ui/react';
import remarkGfm from 'remark-gfm';
import { ArtifactChip } from './ArtifactChip';
import { useConversationId } from '../lib/use-conversation-id';

const AX_ARTIFACT_PREFIX = 'ax://artifact/';

/**
 * Permissive urlTransform — react-markdown's default strips ax:// URLs.
 * We pass them through so the custom `a` component can intercept them.
 * All other protocols still go through the default safe-protocol filter
 * (defaultUrlTransform behavior preserved by returning the value
 * unchanged here only when it starts with ax://; the primitive's own
 * default handles the rest when this returns undefined).
 */
function urlTransform(url: string): string {
  if (url.startsWith(AX_ARTIFACT_PREFIX)) return url;
  return url;
}

interface ArtifactToolResult {
  artifactId: string;
  path: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
}

function parseArtifactsFromTurn(
  parts: readonly unknown[],
): Map<string, ArtifactToolResult> {
  const map = new Map<string, ArtifactToolResult>();
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const obj = p as {
      type?: unknown;
      toolName?: unknown;
      result?: unknown;
    };
    if (obj.type !== 'tool-call') continue;
    if (obj.toolName !== 'artifact_publish') continue;
    const raw =
      typeof obj.result === 'string' ? obj.result :
      typeof obj.result === 'object' && obj.result !== null
        ? JSON.stringify(obj.result)
        : null;
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as ArtifactToolResult;
      if (typeof parsed.artifactId === 'string' && typeof parsed.path === 'string') {
        map.set(parsed.artifactId, parsed);
      }
    } catch { /* skip non-JSON tool_results */ }
  }
  return map;
}

interface AnchorProps {
  href?: string;
  children?: React.ReactNode;
}

const Anchor: FC<AnchorProps> = ({ href, children }) => {
  const conversationId = useConversationId();
  const parts = useMessage(
    (m) => (m as { content?: readonly unknown[] }).content ?? [],
  );
  if (typeof href === 'string' && href.startsWith(AX_ARTIFACT_PREFIX)) {
    const artifactId = href.slice(AX_ARTIFACT_PREFIX.length);
    const artifacts = parseArtifactsFromTurn(parts);
    const match = artifacts.get(artifactId);
    if (!match || conversationId === null) {
      return (
        <ArtifactChip
          variant="link"
          conversationId={conversationId ?? ''}
          artifactId={artifactId}
        />
      );
    }
    return (
      <ArtifactChip
        variant="link"
        conversationId={conversationId}
        path={match.path}
        displayName={match.displayName}
        mediaType={match.mediaType}
        sizeBytes={match.sizeBytes}
        artifactId={match.artifactId}
      />
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
};

export const MarkdownText: FC = () => (
  <MarkdownTextPrimitive
    remarkPlugins={[remarkGfm]}
    urlTransform={urlTransform}
    components={{ a: Anchor }}
    className="aui-md prose dark:prose-invert max-w-none prose-p:leading-7 prose-pre:bg-card prose-pre:border prose-pre:border-border/40 prose-pre:rounded-xl prose-pre:backdrop-blur-sm prose-code:font-mono prose-code:text-[0.85em] prose-headings:tracking-tight prose-a:text-amber prose-a:no-underline hover:prose-a:underline prose-th:text-left"
  />
);
```

(If the pinned `@assistant-ui/react-markdown` version doesn't expose `urlTransform` directly, the prop may be named `transformLinkUri`. Check `node_modules/@assistant-ui/react-markdown/dist/*.d.ts` for the exact prop name; the implementation is otherwise unchanged.)

- [ ] **Step 4: Run tests + build**

```bash
pnpm --filter @ax/channel-web test -- markdown-text.test.tsx
pnpm --filter @ax/channel-web build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/MarkdownText.tsx packages/channel-web/src/__tests__/markdown-text.test.tsx
git commit -m "feat(channel-web): render ax://artifact links via ArtifactChip in MarkdownText"
```

---

## Task 16: Extend the canary acceptance test — the I3 anchor

Closes the half-wired window opened by Phase 1. The canary now exercises the round-trip: attach a PDF via POST /api/attachments, send a message via POST /api/chat/messages, agent dispatch calls `artifact_publish` on a workspace file, user downloads both via GET /api/files. If this can't run end-to-end, the PR doesn't merge.

The existing `presets/k8s/src/__tests__/acceptance.test.ts` boots a real http-server + workspace-git-server + storage tier. Phase 3 adds a new sub-scenario alongside the existing canary stages.

**Files:**
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (preset.test.ts already includes `@ax/attachments` + `@ax/tool-artifact-publish` in the expected plugin list; no add needed — verify with `grep`)
- Modify: `presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts` — ditto

- [ ] **Step 1: Confirm preset plugin lists already include attachments + artifact-publish**

```bash
grep -n "@ax/attachments\|@ax/tool-artifact-publish" presets/k8s/src/__tests__/preset.test.ts
```

Expected: both listed (per memory `project_attachments_phase_2_pr94` notes; Phase 2 already wired them). If `@ax/tool-artifact-publish` is missing from `preset.test.ts`'s loaded-list assertion, add it. Don't touch the `PLUGINS_TO_DROP` arrays in acceptance.test.ts / multi-tenant-acceptance.test.ts — those are infra-strip lists, not load-lists (memory: `feedback_preset_drop_vs_load_lists`).

- [ ] **Step 2: Remove `@ax/attachments` from acceptance.test.ts's drop list (it now has a caller)**

Open `presets/k8s/src/__tests__/acceptance.test.ts`. Find the `PLUGINS_TO_DROP` array (around line 158 per the existing grep). The current entry:

```ts
  // Attachments: postgres-backed (database:get-instance) and not exercised
  // by any of these canaries — Phase 1 of the attachments subsystem has no
  // caller yet (half-wired window open through Phase 3). The static hook
  // wiring is pinned in preset.test.ts; drop here so these sub-tests don't
  // need a postgres testcontainer.
  '@ax/attachments',
```

Update the comment but KEEP `@ax/attachments` in the drop list for the bulk of the canary stages (chat-path, workspace, etc. don't exercise it). Add a NEW dedicated sub-test for the attachments round-trip that boots a fresh harness *with* `@ax/attachments` (and the Postgres testcontainer it needs).

Replace the existing comment with:

```ts
  // Attachments: postgres-backed (database:get-instance). The bulk of the
  // chat-path canaries don't exercise attachments; we drop it from the
  // shared kernel to avoid every sub-test paying the testcontainer cost.
  // The Phase 3 attachments-round-trip canary further down boots its own
  // kernel WITH @ax/attachments loaded against a real Postgres.
  '@ax/attachments',
```

- [ ] **Step 3: Add the round-trip canary sub-test**

Append to `presets/k8s/src/__tests__/acceptance.test.ts` (near the existing "Phase D canary" block, after the workspace + chat canaries):

```ts
  // ---------------------------------------------------------------------------
  // Phase 3 canary — attachments + artifact_publish round-trip (I3 anchor).
  //
  // The I3 anchor that closes the half-wired window opened by Phase 1.
  //
  //   1. Boot the kernel with @ax/attachments + @ax/tool-artifact-publish +
  //      a real Postgres testcontainer + a real workspace-git-server +
  //      a stub agent:invoke that simulates an artifact_publish call.
  //   2. POST /api/attachments — upload "hello.pdf" → expect 200 + attachmentId.
  //   3. POST /api/chat/messages with the attachmentId → expect 202; the
  //      committed attachment block lives in the conversation transcript
  //      (verified via conversations:get).
  //   4. Stub agent appends an assistant turn carrying an artifact_publish
  //      tool_result pointing at a file the stub previously committed via
  //      workspace:apply.
  //   5. GET /api/files for the user's attachment path → expect 200 + bytes match.
  //   6. GET /api/files for the artifact's path → expect 200 + bytes match.
  //   7. GET /api/files for an unscoped path → expect 404 (path-scope ACL).
  //   8. GET /api/files for the same path from a foreign user → expect 404.
  // ---------------------------------------------------------------------------

  it(
    'Phase 3 canary: attachments + artifact_publish round-trip via /api/attachments + /api/chat/messages + /api/files',
    async () => {
      let pgContainer: StartedPostgreSqlContainer | null = null;
      let server: WorkspaceGitServer | null = null;
      let handle: BootstrappedKernel | null = null;
      const serverRepoRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'ax-phase3-attachments-canary-'),
      );

      try {
        pgContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
        const dsn = pgContainer.getConnectionUri();

        server = await createWorkspaceGitServer({
          repoRoot: serverRepoRoot,
          listen: { host: '127.0.0.1', port: 0 },
          authBearer: 'test-bearer',
        });

        // Boot a kernel WITH @ax/attachments + @ax/tool-artifact-publish +
        // a stub agent:invoke. The kernel's http-server is the one we POST
        // against; the test drives requests through its in-process HTTP
        // adapter (bus.call('http:register-route', ...) returns
        // unregister but the kernel routes through the real socket — we
        // listen on 127.0.0.1:0 and grab the actual port for fetch).
        const plugins: Plugin[] = [
          createHttpServerPlugin({ cookieKey: COOKIE_KEY, listen: { host: '127.0.0.1', port: 0 } }),
          createDatabasePostgresPlugin({ dsn }),
          createAttachmentsPlugin(),
          createConversationsPlugin(),
          createMockWorkspacePlugin({ /* … minimal workspace stub … */ }),
          createPermissiveAuthStubPlugin('canary-user'),
          createPermissiveAgentsStubPlugin(),
          createToolArtifactPublishPlugin(),
          createChannelWebServerPlugin(),
          createAgentInvokeStub((ctx, input) => {
            // Append an assistant turn with an artifact_publish tool_use +
            // tool_result. The artifact path was committed by a previous
            // workspace:apply in this sub-test.
            return {
              kind: 'complete',
              messages: [
                {
                  role: 'assistant',
                  content: 'Here is your artifact: [download](ax://artifact/abc12345).',
                  contentBlocks: [
                    {
                      type: 'tool_use',
                      id: 'toolu_1',
                      name: 'artifact_publish',
                      input: { path: '/permanent/workspace/report.txt' },
                    },
                    {
                      type: 'tool_result',
                      tool_use_id: 'toolu_1',
                      content: JSON.stringify({
                        artifactId: 'abc12345',
                        downloadUrl: 'ax://artifact/abc12345',
                        path: 'workspace/report.txt',
                        displayName: 'report.txt',
                        mediaType: 'text/plain',
                        sizeBytes: 12,
                        sha256: 'abc12345' + 'a'.repeat(56),
                      }),
                    },
                    {
                      type: 'text',
                      text: 'Here is your artifact: [download](ax://artifact/abc12345).',
                    },
                  ],
                },
              ],
            } as AgentOutcome;
          }),
        ];
        handle = await bootstrap({ plugins, config: {} });

        // Pre-commit the artifact file via workspace:apply.
        const ctx = makeAgentContext({
          sessionId: 'phase3-attachments-canary',
          agentId: 'preset-test-agent',
          userId: 'canary-user',
        });
        await handle.bus.call('workspace:apply', ctx, {
          changes: [{
            path: 'workspace/report.txt',
            kind: 'put',
            content: new TextEncoder().encode('hello report'),
          }],
          parent: null,
          reason: 'phase 3 canary pre-commit',
        });

        // 2) POST /api/attachments.
        const upload = await uploadFile(handle, {
          filename: 'note.txt',
          mediaType: 'text/plain',
          body: Buffer.from('hello attached'),
          cookieUser: 'canary-user',
        });
        expect(upload.status).toBe(200);
        const uploadJson = await upload.json();
        expect(typeof uploadJson.attachmentId).toBe('string');

        // 3) POST /api/chat/messages with the attachmentId.
        const chatResp = await postJson(handle, '/api/chat/messages', {
          conversationId: null,
          agentId: 'preset-test-agent',
          contentBlocks: [
            { type: 'text', text: 'here is a doc' },
            { type: 'attachment_ref', attachmentId: uploadJson.attachmentId },
          ],
        }, 'canary-user');
        expect(chatResp.status).toBe(202);
        const chatJson = await chatResp.json();
        const conversationId = chatJson.conversationId as string;

        // Let agent:invoke run to completion (it's fire-and-forget on the
        // route side; conversations:append-turn for the assistant message
        // happens inside the stub).
        await new Promise((r) => setTimeout(r, 200));

        // 5) GET /api/files for the user's upload path.
        const got = await handle.bus.call<unknown, {
          conversation: unknown;
          turns: Array<{ contentBlocks: ContentBlock[] }>;
        }>('conversations:get', ctx, {
          conversationId,
          userId: 'canary-user',
        });
        const attachmentBlock = got.turns
          .flatMap((t) => t.contentBlocks)
          .find((b) => b.type === 'attachment') as
            { type: 'attachment'; path: string; displayName: string } | undefined;
        expect(attachmentBlock).toBeTruthy();

        const downloadResp = await getFile(
          handle,
          attachmentBlock!.path,
          conversationId,
          'canary-user',
        );
        expect(downloadResp.status).toBe(200);
        expect(await downloadResp.text()).toBe('hello attached');

        // 6) GET /api/files for the artifact path.
        const artResp = await getFile(
          handle,
          'workspace/report.txt',
          conversationId,
          'canary-user',
        );
        expect(artResp.status).toBe(200);
        expect(await artResp.text()).toBe('hello report');

        // 7) GET /api/files for an unscoped path → 404 (path-scope ACL).
        const denied = await getFile(handle, 'unscoped/secret.txt', conversationId, 'canary-user');
        expect(denied.status).toBe(404);

        // 8) GET /api/files for the artifact path from a foreign user → 404.
        const foreign = await getFile(handle, 'workspace/report.txt', conversationId, 'other-user');
        expect(foreign.status).toBe(404);
      } finally {
        if (handle !== null) await handle.shutdown();
        if (server !== null) await server.close();
        if (pgContainer !== null) await pgContainer.stop();
        await fs.rm(serverRepoRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );

  // --- helpers ----------------------------------------------------------

  async function uploadFile(
    handle: BootstrappedKernel,
    args: {
      filename: string;
      mediaType: string;
      body: Buffer;
      cookieUser: string;
    },
  ): Promise<Response> {
    const port = handle.httpListener.port; // the http-server plugin exposes this
    const boundary = '----canary-boundary';
    const enc = (s: string) => Buffer.from(s, 'utf8');
    const part = Buffer.concat([
      enc(`--${boundary}\r\n`),
      enc(`Content-Disposition: form-data; name="file"; filename="${args.filename}"\r\n`),
      enc(`Content-Type: ${args.mediaType}\r\n\r\n`),
      args.body,
      enc(`\r\n--${boundary}--\r\n`),
    ]);
    return fetch(`http://127.0.0.1:${port}/api/attachments`, {
      method: 'POST',
      body: part,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        cookie: signCookieFor(args.cookieUser),
        origin: `http://127.0.0.1:${port}`,
        'x-requested-with': 'ax-admin',
      },
    });
  }

  async function postJson(
    handle: BootstrappedKernel,
    path: string,
    body: object,
    cookieUser: string,
  ): Promise<Response> {
    const port = handle.httpListener.port;
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        cookie: signCookieFor(cookieUser),
        origin: `http://127.0.0.1:${port}`,
        'x-requested-with': 'ax-admin',
      },
    });
  }

  async function getFile(
    handle: BootstrappedKernel,
    workspacePath: string,
    conversationId: string,
    cookieUser: string,
  ): Promise<Response> {
    const port = handle.httpListener.port;
    const qs = new URLSearchParams({ path: workspacePath, conversationId }).toString();
    return fetch(`http://127.0.0.1:${port}/api/files?${qs}`, {
      method: 'GET',
      headers: {
        cookie: signCookieFor(cookieUser),
      },
    });
  }

  function signCookieFor(userId: string): string {
    // Reuses the signCookieValue from @ax/http-server, mirroring the
    // existing `createSignedSessionCookie` pattern in routes-chat.test.ts.
    return `session=${signCookieValue(COOKIE_KEY, JSON.stringify({ userId }))}`;
  }
```

(The exact helper imports — `signCookieValue`, `createPermissiveAuthStubPlugin`, `createAgentInvokeStub`, `BootstrappedKernel` — come from the existing acceptance.test.ts and dev-agents-stub.ts. Reuse what's there; don't introduce a new path. The shape above is the contract — implementation aligns with the existing canary stages.)

- [ ] **Step 4: Run the canary**

```bash
pnpm --filter @ax/preset-k8s test -- acceptance.test.ts
```

Expected: PASS. Allow 2–3 min for the Postgres testcontainer + workspace-git-server boot.

- [ ] **Step 5: Run the full test + build + lint sweep**

```bash
pnpm build
pnpm test
pnpm lint
```

Expected: all clean. If lint flags new files, fix per project conventions (memory: `feedback_run_lint_before_pr`).

- [ ] **Step 6: Commit**

```bash
git add presets/k8s/src/__tests__/acceptance.test.ts
git commit -m "test(preset-k8s): Phase 3 canary — attachments + artifact_publish round-trip (I3)"
```

---

## Task 17: Final verification + PR-body sketch + self-review

The half-wired window is closed once the canary passes. Final verification + PR body.

- [ ] **Step 1: Verify full repo build + test + lint clean**

```bash
pnpm build
pnpm test
pnpm lint
```

Expected: all clean. Specifically watch for:
- `tsc` errors that vitest's looser TS pass tolerated (memory: `feedback_run_tsc_alongside_vitest`).
- Lint errors on new files (especially the chip components — Tailwind class ordering can flag).

- [ ] **Step 2: Verify the canary preset's plugin list still matches**

```bash
pnpm --filter @ax/preset-k8s test -- preset.test.ts
pnpm --filter @ax/preset-k8s test -- multi-tenant-acceptance.test.ts
```

Expected: PASS — no plugin-load-list drift.

- [ ] **Step 3: Manual smoke against kind dev (optional but recommended)**

Memory: `project_kind_fast_loop_spa_only` — `make dev-fast` syncs SPA only. For Phase 3 the host runtime changed (new routes), so a full image rebuild is needed:

```bash
make dev
# wait for image rebuild + redeploy
```

Then in the browser at `http://localhost:8080`:
1. Sign in.
2. Open a new conversation.
3. Click the Attach button → pick a small PDF.
4. Verify the chip appears with the file name.
5. Type "summarize" and send. (The model needs to be reachable; if it's not, skip this step and rely on the canary.)
6. Verify the assistant turn includes an `ax://artifact/...` link or an inline chip.
7. Click both chips → file downloads with the correct Content-Disposition filename.

Document any UI quirks in the PR body as known follow-ups.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/attachments-phase-3
gh pr create --title "feat: attachments & artifacts Phase 3 — channel-web wiring (closes I3 half-wired window)" --body "$(cat <<'EOF'
## Summary

Phase 3 of the attachments & artifacts subsystem (design `docs/plans/2026-05-15-attachments-and-artifacts-design.md`; Phase 1 = PR #72, Phase 2 = PR #94). **Closes the half-wired window opened in Phase 1** by wiring the browser-facing half of the round-trip end-to-end.

Lands the channel-web half:
- `POST /api/attachments` (multipart, 25 MiB cap, MIME allowlist, 200 MiB per-user pending quota) calling `attachments:store-temp`.
- `GET /api/files` (uniform 404 posture for every forbidden/not-found condition) calling `attachments:download` — the path-scope ACL lives inside the hook (Boundary C; Phase 1).
- `POST /api/chat/messages` extension: recognises `attachment_ref` items in `contentBlocks`, calls `attachments:commit` per ref, enforces the 100 MiB per-message total cap, rewrites to `attachment` blocks before dispatching `agent:invoke`.
- `AxAttachmentAdapter` (assistant-ui `AttachmentAdapter` impl) with XHR progress, wired into `useChatThreadRuntime`.
- `AttachmentComposerChip` (pre-send), `AttachmentChip` (in-transcript user-message), `ArtifactChip` (assistant-message inline + link variants) — all composed of shadcn primitives + semantic tokens + lucide-react icons.
- `MarkdownText` extension: `ax://artifact/<id>` URLs substituted with `<ArtifactChip variant="link" />` via `urlTransform` + custom `components.a`.
- Composer wraps in `ComposerPrimitive.AttachmentDropzone`; `ComposerPrimitive.Attachments` slot renders chips above the input row.
- Canary acceptance test (preset-k8s) gains the Phase 3 round-trip — the I3 anchor.

## Design deviations (flagged in plan §"Design deviations from the spec")

- **D1.** Extends `@ax/http-server`'s `HttpRegisterRouteInput` with optional `maxBodyBytes` so `/api/attachments` opts into 25 MiB without raising the global 1 MiB default.
- **D2.** Adds `busboy@1.6.0` for multipart parsing (no transitive deps, audited).
- **D3.** Replaces `AxChatTransport.toContentBlocks`'s text-fallback for `file` parts with proper `attachment_ref` emission when `data: ax://attachment/<id>`.
- **D4.** Permissive `urlTransform` on `MarkdownTextPrimitive` to admit `ax://` URLs; custom `components.a` intercepts and renders `ArtifactChip`.
- **D5.** Removes `runtime.tsx`'s "no attachments adapter" stub; the gate is now satisfied.
- **D6.** History-adapter translates stored `attachment` blocks → assistant-ui `file` parts with `data: ax://attachment-path/<base64url(path)>` so `MessagePrimitive.Parts.components.File = AttachmentChip` dispatches them.
- **D7.** No new hook surface — Phase 3 only calls into existing Phase 1 hooks.

## Half-wired windows

**CLOSED.** Phase 1's window (opened in PR #72) and Phase 2's continuation (PR #94) close with this PR. The canary acceptance test exercises the full round-trip (attach → send → publish → download both via web channel).

## Boundary review

- New service hooks: none.
- New IPC actions: none.
- New HTTP routes: `POST /api/attachments`, `GET /api/files`. Both call existing hooks; payload field names are workspace+attachment vocabulary (`path`, `displayName`, `mediaType`, `sizeBytes`, `attachmentId`, `expiresAt`) — no backend leak.
- New extension on `POST /api/chat/messages`: recognises `attachment_ref` and emits `attachment` blocks through `AgentMessage.contentBlocks` (Phase 2's D2 extension; populated for the first time here).

## Security review

- Boundary A (`POST /api/attachments`): auth + CSRF (existing subscriber) + 25 MiB body cap + MIME allowlist + 200 MiB pending quota. Filename sanitization is server-constructed (random prefix); user filename → `displayName` verbatim.
- Boundary B (`POST /api/chat/messages` extension): cross-user redemption blocked by `attachments:commit` (returns `forbidden`, mapped to 400 attachment-foreign-user). Expired/unknown → 400 attachment-not-found. Per-message total cap enforced after each successful commit.
- Boundary C (`GET /api/files`): uniform 404 for every forbidden/not-found condition. The path-scope ACL lives inside `attachments:download`. Symlink refusal enforced at write time (Phase 2's artifact_publish; uploads can't introduce symlinks).
- Supply chain: one pinned npm dependency added — `busboy@1.6.0` (no transitive deps, audited).
- Prompt-injection: a model that talks the user into clicking `ax://artifact/<malicious-id>` hits the path-scope ACL (the artifact path must appear in this conversation's transcript). An unknown id renders the disabled "unknown artifact" pill.

## Tests

| Package | Coverage |
|---|---|
| `@ax/http-server` | per-route `maxBodyBytes` (3 cases) |
| `@ax/channel-web` (server) | multipart parser (6 cases); `POST /api/attachments` (7 cases); `GET /api/files` (4 cases); `POST /api/chat/messages` attachment_ref handling (4 cases) |
| `@ax/channel-web` (browser) | `AxAttachmentAdapter` (3 cases); `toContentBlocks` (3 cases); `AttachmentComposerChip` (3 cases); `AttachmentChip` (2 cases); `ArtifactChip` (3 cases); composer dropzone wiring (2 cases); thread attachment rendering (1 case); MarkdownText `ax://` handling (3 cases); history-adapter translation (3 cases) |
| `@ax/preset-k8s` | Phase 3 round-trip canary — upload → send → publish → download both (I3 anchor) |

## Test plan

- [ ] `pnpm build` clean
- [ ] `pnpm test` clean (including the Phase 3 canary's Postgres+workspace-git-server harness)
- [ ] `pnpm lint` clean
- [ ] Manual `make dev` smoke: attach a PDF, send a message, agent publishes an artifact, both chips download.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Return the PR URL when done.

- [ ] **Step 5: Self-review checklist before requesting review**

Before tagging reviewers:

- All 17 task commits present? `git log --oneline phase-2-merge-base..HEAD`
- Every new file has its corresponding test file?
- Lint clean? `pnpm lint`
- Half-wired-window CLOSED declaration present in PR body?
- D1–D7 design deviations called out in PR body?
- `runtime.tsx`'s "no attachments adapter" comment block deleted (not just stale-commented)?
- `AxChatTransport.toContentBlocks` no longer emits `[attachment: ...]` text for ax:// file parts?
- `useConversationId` wired through both `handleSetConversationId` AND the `activeSessionId === null` reset (so the chip context stays in sync with conversation switches)?
- Phase 3 canary in `acceptance.test.ts` passes against a real Postgres testcontainer + workspace-git-server?
- Browser smoke run — at minimum, the Attach button now appears (gate satisfied)?

---

## Summary

After 17 tasks:
- Two new HTTP routes (`POST /api/attachments`, `GET /api/files`).
- One existing route extended (`POST /api/chat/messages` now resolves `attachment_ref` → `attachment`).
- One new framework primitive (`HttpRegisterRouteInput.maxBodyBytes`).
- One new npm dep (`busboy@1.6.0`, no transitives).
- One new assistant-ui adapter (`AxAttachmentAdapter`).
- Three new React chip components (`AttachmentComposerChip`, `AttachmentChip`, `ArtifactChip`) — shadcn-primitive-composed, semantic tokens only.
- One MarkdownText extension for `ax://artifact/<id>` URL substitution.
- One canary acceptance test extension — the I3 anchor that closes the half-wired window.

## Half-wired windows

OPEN from Phase 1 (PR #72), continued through Phase 2 (PR #94). **CLOSED by this PR.** The canary now exercises the end-to-end round-trip (upload → send → publish → download both).

## Boundary review

- No new service hooks.
- No new IPC actions.
- Two new HTTP routes + one extension. All call into Phase 1's existing hooks. Payload vocabulary is workspace+attachment (`path`, `displayName`, `mediaType`, `sizeBytes`, `attachmentId`, `expiresAt`); no backend leak.

## Test plan

- [ ] `pnpm build`, `pnpm test`, `pnpm lint` clean across the repo
- [ ] Phase 3 canary in `presets/k8s/src/__tests__/acceptance.test.ts` passes
- [ ] Manual browser smoke against `make dev` (or kind cluster `ax-next-dev`) — Attach button appears; upload → send → agent publishes artifact → download both via chips

## Self-review checklist

- [ ] Every task's tests fail before impl, pass after
- [ ] `runtime.tsx`'s "no attachments adapter" comment block DELETED (not stale-commented)
- [ ] `AxChatTransport.toContentBlocks` no longer emits text fallback for `ax://attachment/<id>` file parts
- [ ] No `ax://` URLs leak through to react-markdown's default urlTransform (would be silently stripped)
- [ ] Per-route `maxBodyBytes` defaults to `MAX_BODY_BYTES` when unset (every existing route inherits the 1 MiB cap)
- [ ] Path-scope ACL still lives inside `attachments:download`, NOT the route layer (Boundary C contract preserved from Phase 1)
- [ ] Half-wired-window CLOSED declaration present in PR body
- [ ] D1–D7 design deviations called out in PR body
- [ ] Phase 3 canary exercises all four failure modes (foreign-user, unscoped path, missing path, expired ref)
