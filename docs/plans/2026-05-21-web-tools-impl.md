# `@ax/web-tools` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `@ax/web-tools` plugin that gives every agent two host-executed tools — `web_search` and `web_extract` — backed by Anthropic's server-side `web_search` / `web_fetch`, keeping the sandbox egress lock fully intact.

**Architecture:** The plugin registers two `executesIn: 'host'` tool descriptors via `tool:register` and two `tool:execute:<name>` service-hook executors. Each executor makes its own host-side `@anthropic-ai/sdk` Messages call with the relevant server tool enabled (`max_uses: 1`), harvests the structured result block, and returns a plain JSON result. Anthropic performs all network egress; our host only ever calls `api.anthropic.com`. Loaded in the CLI preset and the k8s preset behind the same global-`ANTHROPIC_API_KEY` gate that `@ax/llm-anthropic` uses.

**Tech Stack:** TypeScript (ESM, NodeNext), `@anthropic-ai/sdk` ^0.91.1 (stable; `web_search_20250305` + `web_fetch_20250910` are GA and need no beta header), Vitest, pnpm workspace + tsc project references.

---

## Design reference

Spec: `docs/plans/2026-05-21-web-tools-design.md`.

## Contracts grounded in the codebase (read before coding)

- **Tool registration:** a tool plugin calls `bus.call('tool:register', ctx, descriptor)` at init (descriptor type `ToolDescriptor` from `@ax/core`; `ctx` built with `makeAgentContext`). The `@ax/tool-dispatcher` plugin (in `@ax/mcp-client`) owns the catalog and serves it via `tool:list`. See `packages/memory-strata/src/tools/memory-search.ts`.
- **Host execution contract (IMPORTANT):** the `tool:execute:<name>` service hook receives the **full `ToolCall`** object `{ id, name, input }` as its payload and reads `call.input` for the tool arguments. The IPC handler (`packages/ipc-core/src/handlers/tool-execute-host.ts`) wraps the hook's return value in `{ output }`, so the **executor returns the bare result object**. Ground truth: `packages/mcp-client/src/plugin.ts:245-254` and its e2e test `packages/mcp-client/src/__tests__/plugin.test.ts:303-316`, which call the hook with `{ id, name, input }`.
  - NOTE: `packages/memory-strata/src/tools/memory-search.ts` reads `input.query` (bare-input shape) instead of `call.input.query`. That is a **pre-existing bug** masked by a unit test that invokes the hook with the wrong shape. Do **not** copy that pattern; mirror mcp-client. (Tracked as a separate follow-up — out of scope for this plan.)
- **Anthropic server tools (SDK 0.91.1):** pass server tools in the stable `client.messages.create({ tools })`. Tool param shapes: `{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }` and `{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1, max_content_tokens? }`. Result content blocks: `WebSearchToolResultBlock` (`type: 'web_search_tool_result'`, `content: WebSearchToolResultError | WebSearchResultBlock[]`) and `WebFetchToolResultBlock` (`type: 'web_fetch_tool_result'`, `content: WebFetchToolResultErrorBlock | WebFetchBlock`). `WebSearchResultBlock = { type: 'web_search_result', url, title, page_age, encrypted_content }`. `WebFetchBlock.content` is a `DocumentBlock` with `source: PlainTextSource | Base64PDFSource` and `title`; `PlainTextSource = { type: 'text', media_type: 'text/plain', data }`.

## File structure

```
packages/web-tools/
  package.json
  tsconfig.json
  src/
    index.ts            # public exports
    plugin.ts           # createWebToolsPlugin(cfg)
    anthropic-client.ts # runWebSearch / runWebExtract (server-tool call + harvest)
    url-guard.ts        # isAllowedExtractUrl(url)
    tools/
      web-search.ts     # WEB_SEARCH_DESCRIPTOR + registerWebSearch
      web-extract.ts    # WEB_EXTRACT_DESCRIPTOR + registerWebExtract
    __tests__/
      url-guard.test.ts
      anthropic-client.test.ts
      tools-web-search.test.ts
      tools-web-extract.test.ts
      plugin.test.ts
      canary.test.ts    # real tool-dispatcher + web-tools, stubbed Anthropic
```

Modified for wiring:
- `packages/cli/src/main.ts` (CLI preset)
- `presets/k8s/src/index.ts` (k8s preset)
- `presets/k8s/src/__tests__/preset.test.ts` (membership assertions)
- root `tsconfig.json` (project reference). `pnpm-workspace.yaml` is glob-based (`packages/*`) so it needs no edit — verify.

---

## Task 1: Scaffold the `@ax/web-tools` package

**Files:**
- Create: `packages/web-tools/package.json`
- Create: `packages/web-tools/tsconfig.json`
- Create: `packages/web-tools/src/index.ts`
- Modify: `tsconfig.json` (repo root — add project reference)

- [ ] **Step 1: Write `package.json`** (mirror `packages/llm-anthropic/package.json`)

```json
{
  "name": "@ax/web-tools",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "SECURITY.md"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "@anthropic-ai/sdk": "^0.91.1"
  },
  "devDependencies": {
    "@ax/mcp-client": "workspace:*",
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

(`@ax/mcp-client` is a **dev**Dependency only — used by the canary test to load the real tool-dispatcher. Production code never imports it, preserving invariant #2.)

- [ ] **Step 2: Write `tsconfig.json`** (mirror `packages/llm-anthropic/tsconfig.json`)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**", "dist", "node_modules"],
  "references": [
    { "path": "../core" }
  ]
}
```

- [ ] **Step 3: Write `src/index.ts`** with a temporary export so the build has a valid entry

```ts
export const PLUGIN_NAME = '@ax/web-tools';
```

(Replaced with real exports in Task 8.)

- [ ] **Step 4: Add the project reference to the repo-root `tsconfig.json`**

Open `tsconfig.json` at the repo root, find the `references` array, and add (keeping alphabetical order if the file is sorted):

```json
    { "path": "packages/web-tools" },
```

- [ ] **Step 5: Install + build**

Run: `pnpm install && pnpm --filter @ax/web-tools build`
Expected: install links the workspace package; build succeeds (emits `dist/index.js`).

- [ ] **Step 6: Commit**

```bash
git add packages/web-tools tsconfig.json pnpm-lock.yaml
git commit -m "feat(web-tools): scaffold @ax/web-tools package"
```

---

## Task 2: `url-guard.ts` — reject internal/non-http targets for web_extract

**Files:**
- Create: `packages/web-tools/src/url-guard.ts`
- Test: `packages/web-tools/src/__tests__/url-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { isAllowedExtractUrl } from '../url-guard.js';

describe('isAllowedExtractUrl', () => {
  it('accepts public https and http URLs', () => {
    expect(isAllowedExtractUrl('https://example.com/page')).toBe(true);
    expect(isAllowedExtractUrl('http://example.com')).toBe(true);
  });

  it('rejects non-http(s) schemes', () => {
    for (const u of ['file:///etc/passwd', 'ftp://x', 'data:text/plain,hi', 'javascript:alert(1)']) {
      expect(isAllowedExtractUrl(u)).toBe(false);
    }
  });

  it('rejects loopback / private / link-local / metadata hosts', () => {
    for (const u of [
      'http://localhost/x',
      'https://127.0.0.1/x',
      'http://10.0.0.5/x',
      'https://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x',
      'http://metadata.google.internal/x',
    ]) {
      expect(isAllowedExtractUrl(u)).toBe(false);
    }
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedExtractUrl('not a url')).toBe(false);
    expect(isAllowedExtractUrl('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module not found)

Run: `pnpm --filter @ax/web-tools test -- url-guard`
Expected: FAIL — `Cannot find module '../url-guard.js'`.

- [ ] **Step 3: Implement `url-guard.ts`**

```ts
// Defense-in-depth URL gate for web_extract. Anthropic fetches server-side
// (so this cannot, by itself, stop SSRF against our cluster — Anthropic's
// network can't reach it), but we still refuse obviously-internal targets
// before spending an API call, and to keep the tool's contract honest:
// "extract a public web page", not "probe an address".

const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal)$/i;

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 0) return true;
  return false;
}

export function isAllowedExtractUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  // Strip IPv6 brackets for the loopback check.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.length === 0) return false;
  if (host === '::1' || host === '0.0.0.0') return false;
  if (PRIVATE_HOST_RE.test(host)) return false;
  if (isPrivateIpv4(host)) return false;
  return true;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ax/web-tools test -- url-guard`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web-tools/src/url-guard.ts packages/web-tools/src/__tests__/url-guard.test.ts
git commit -m "feat(web-tools): add url-guard for web_extract SSRF defense-in-depth"
```

---

## Task 3: `anthropic-client.ts` — `runWebSearch`

**Files:**
- Create: `packages/web-tools/src/anthropic-client.ts`
- Test: `packages/web-tools/src/__tests__/anthropic-client.test.ts`

This task adds `runWebSearch`. Task 4 adds `runWebExtract` to the same file.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runWebSearch } from '../anthropic-client.js';

// Build a fake Anthropic client whose messages.create returns the queued
// responses in order (one per call, to exercise the pause_turn loop).
function fakeClient(responses: unknown[]): Anthropic {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  return { messages: { create } } as unknown as Anthropic;
}

const SEARCH_RESULT_RESPONSE = {
  stop_reason: 'end_turn',
  content: [
    { type: 'text', text: 'Here is what I found.' },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srv_1',
      content: [
        { type: 'web_search_result', url: 'https://a.com', title: 'A', page_age: 'May 1, 2026', encrypted_content: 'SECRET' },
        { type: 'web_search_result', url: 'https://b.com', title: 'B', page_age: null, encrypted_content: 'SECRET2' },
      ],
    },
  ],
};

describe('runWebSearch', () => {
  it('harvests results, drops encrypted_content, maps page_age to age, collects summary', async () => {
    const client = fakeClient([SEARCH_RESULT_RESPONSE]);
    const out = await runWebSearch(client, { model: 'claude-sonnet-4-6', maxTokens: 1024 }, 'cats');
    expect(out).toEqual({
      query: 'cats',
      results: [
        { title: 'A', url: 'https://a.com', age: 'May 1, 2026' },
        { title: 'B', url: 'https://b.com' },
      ],
      summary: 'Here is what I found.',
    });
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('continues through pause_turn up to the cap', async () => {
    const paused = { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'working' }] };
    const client = fakeClient([paused, SEARCH_RESULT_RESPONSE]);
    const out = await runWebSearch(client, { model: 'm', maxTokens: 100 }, 'cats');
    expect(out.results).toHaveLength(2);
    expect((client.messages.create as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it('throws a clean error when the search returns an error block', async () => {
    const errResp = {
      stop_reason: 'end_turn',
      content: [{ type: 'web_search_tool_result', tool_use_id: 's', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }],
    };
    const client = fakeClient([errResp]);
    await expect(runWebSearch(client, { model: 'm', maxTokens: 100 }, 'x')).rejects.toThrow(/max_uses_exceeded/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module/function not found)

Run: `pnpm --filter @ax/web-tools test -- anthropic-client`
Expected: FAIL — `runWebSearch` is not exported.

- [ ] **Step 3: Implement `runWebSearch` (+ shared internals) in `anthropic-client.ts`**

```ts
import type Anthropic from '@anthropic-ai/sdk';

export interface CallOpts {
  model: string;
  maxTokens: number;
}

export interface WebSearchHit {
  title: string;
  url: string;
  age?: string;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchHit[];
  summary?: string;
}

const MAX_PAUSE_ITERATIONS = 4;

// Drive a server-tool conversation to completion, accumulating every
// content block across pause_turn continuations. Generic over both web
// tools — the caller supplies the tool definition and the user prompt.
async function collectBlocks(
  client: Anthropic,
  opts: CallOpts,
  tool: Record<string, unknown>,
  userText: string,
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [{ role: 'user', content: userText }];
  const blocks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < MAX_PAUSE_ITERATIONS; i += 1) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      tools: [tool],
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const content: Array<Record<string, unknown>> = Array.isArray(res?.content) ? res.content : [];
    blocks.push(...content);
    if (res?.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content });
  }
  return blocks;
}

export async function runWebSearch(
  client: Anthropic,
  opts: CallOpts,
  query: string,
): Promise<WebSearchOutput> {
  const blocks = await collectBlocks(
    client,
    opts,
    { type: 'web_search_20250305', name: 'web_search', max_uses: 1 },
    `Search the web for: ${query}\nUse the web_search tool once, then stop.`,
  );

  const resultBlock = blocks.find((b) => b?.type === 'web_search_tool_result') as
    | { content?: unknown }
    | undefined;
  const rbContent = resultBlock?.content;
  if (resultBlock !== undefined && !Array.isArray(rbContent)) {
    const code = (rbContent as { error_code?: string } | undefined)?.error_code ?? 'unknown';
    throw new Error(`web_search failed: ${code}`);
  }

  const hits: WebSearchHit[] = Array.isArray(rbContent)
    ? (rbContent as Array<Record<string, unknown>>)
        .filter((r) => r?.type === 'web_search_result')
        .map((r) => ({
          title: String(r.title ?? ''),
          url: String(r.url ?? ''),
          ...(typeof r.page_age === 'string' && r.page_age.length > 0 ? { age: r.page_age as string } : {}),
        }))
    : [];

  const summary = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();

  return {
    query,
    results: hits,
    ...(summary.length > 0 ? { summary } : {}),
  };
}
```

(The narrow `any` casts isolate us from minor SDK request/response type churn while the harvest logic stays explicit. The result *output* types are strict.)

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ax/web-tools test -- anthropic-client`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web-tools/src/anthropic-client.ts packages/web-tools/src/__tests__/anthropic-client.test.ts
git commit -m "feat(web-tools): runWebSearch — server-side web_search harvest"
```

---

## Task 4: `anthropic-client.ts` — `runWebExtract`

**Files:**
- Modify: `packages/web-tools/src/anthropic-client.ts`
- Modify: `packages/web-tools/src/__tests__/anthropic-client.test.ts`

- [ ] **Step 1: Add the failing tests** (append to the test file)

```ts
import { runWebExtract } from '../anthropic-client.js';

const FETCH_RESPONSE = {
  stop_reason: 'end_turn',
  content: [
    {
      type: 'web_fetch_tool_result',
      tool_use_id: 'srv_2',
      content: {
        type: 'web_fetch_result',
        url: 'https://example.com/article',
        content: {
          type: 'document',
          title: 'Article Title',
          source: { type: 'text', media_type: 'text/plain', data: 'Full article text.' },
        },
      },
    },
  ],
};

describe('runWebExtract', () => {
  it('returns extracted text + title for a text/plain document', async () => {
    const client = fakeClient([FETCH_RESPONSE]);
    const out = await runWebExtract(client, { model: 'm', maxTokens: 1024 }, 'https://example.com/article', 50000);
    expect(out).toEqual({
      url: 'https://example.com/article',
      title: 'Article Title',
      text: 'Full article text.',
    });
  });

  it('throws unsupported for a binary/PDF (base64) document', async () => {
    const pdf = {
      stop_reason: 'end_turn',
      content: [{
        type: 'web_fetch_tool_result',
        tool_use_id: 's',
        content: { type: 'web_fetch_result', url: 'https://x/p.pdf', content: { type: 'document', title: null, source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } } },
      }],
    };
    const client = fakeClient([pdf]);
    await expect(runWebExtract(client, { model: 'm', maxTokens: 100 }, 'https://x/p.pdf', 1000)).rejects.toThrow(/unsupported/i);
  });

  it('throws a clean error on a fetch error block', async () => {
    const errResp = {
      stop_reason: 'end_turn',
      content: [{ type: 'web_fetch_tool_result', tool_use_id: 's', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } }],
    };
    const client = fakeClient([errResp]);
    await expect(runWebExtract(client, { model: 'm', maxTokens: 100 }, 'https://x', 1000)).rejects.toThrow(/url_not_accessible/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`runWebExtract` not exported)

Run: `pnpm --filter @ax/web-tools test -- anthropic-client`
Expected: FAIL.

- [ ] **Step 3: Add `runWebExtract` to `anthropic-client.ts`**

```ts
export interface WebExtractOutput {
  url: string;
  title?: string;
  text: string;
}

export async function runWebExtract(
  client: Anthropic,
  opts: CallOpts,
  url: string,
  maxContentTokens: number,
): Promise<WebExtractOutput> {
  const blocks = await collectBlocks(
    client,
    opts,
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1, max_content_tokens: maxContentTokens },
    `Fetch this URL and return its content verbatim: ${url}\nUse the web_fetch tool once, then stop.`,
  );

  const resultBlock = blocks.find((b) => b?.type === 'web_fetch_tool_result') as
    | { content?: Record<string, unknown> }
    | undefined;
  const content = resultBlock?.content;
  if (content === undefined) {
    throw new Error('web_fetch failed: no result returned');
  }
  if (content.type === 'web_fetch_tool_result_error') {
    throw new Error(`web_fetch failed: ${(content as { error_code?: string }).error_code ?? 'unknown'}`);
  }

  const doc = content.content as { source?: Record<string, unknown>; title?: unknown } | undefined;
  const source = doc?.source;
  if (source?.type !== 'text' || typeof source.data !== 'string') {
    throw new Error('web_fetch: unsupported content type (only text pages are supported; PDFs/binary are not)');
  }

  return {
    url: typeof content.url === 'string' ? (content.url as string) : url,
    ...(typeof doc?.title === 'string' && (doc.title as string).length > 0 ? { title: doc.title as string } : {}),
    text: source.data as string,
  };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ax/web-tools test -- anthropic-client`
Expected: PASS (6 tests total in file).

- [ ] **Step 5: Commit**

```bash
git add packages/web-tools/src/anthropic-client.ts packages/web-tools/src/__tests__/anthropic-client.test.ts
git commit -m "feat(web-tools): runWebExtract — server-side web_fetch harvest"
```

---

## Task 5: `tools/web-search.ts` — descriptor + executor

**Files:**
- Create: `packages/web-tools/src/tools/web-search.ts`
- Test: `packages/web-tools/src/__tests__/tools-web-search.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import type { ToolDescriptor } from '@ax/core';
import { WEB_SEARCH_DESCRIPTOR, registerWebSearch } from '../tools/web-search.js';

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

describe('tools/web-search', () => {
  it('descriptor is a host tool named web_search requiring query', () => {
    expect(WEB_SEARCH_DESCRIPTOR.name).toBe('web_search');
    expect(WEB_SEARCH_DESCRIPTOR.executesIn).toBe('host');
    expect(WEB_SEARCH_DESCRIPTOR.inputSchema).toMatchObject({ required: ['query'] });
  });

  it('registers the descriptor via tool:register', async () => {
    const bus = new HookBus();
    let registered: ToolDescriptor | undefined;
    bus.registerService<ToolDescriptor, { ok: true }>('tool:register', 'disp', async (_c, d) => {
      registered = d;
      return { ok: true };
    });
    await registerWebSearch(bus, { run: vi.fn() });
    expect(registered?.name).toBe('web_search');
  });

  it('executor reads call.input.query and returns the bare search result', async () => {
    const bus = new HookBus();
    bus.registerService('tool:register', 'disp', async () => ({ ok: true }));
    const run = vi.fn().mockResolvedValue({ query: 'cats', results: [{ title: 'A', url: 'https://a' }] });
    await registerWebSearch(bus, { run });

    // Host contract: the hook receives the FULL ToolCall { id, name, input }.
    const out = await bus.call('tool:execute:web_search', ctx(), {
      id: 'c1', name: 'web_search', input: { query: 'cats' },
    });
    expect(run).toHaveBeenCalledWith('cats');
    expect(out).toEqual({ query: 'cats', results: [{ title: 'A', url: 'https://a' }] });
  });

  it('rejects an empty query before calling the backend', async () => {
    const bus = new HookBus();
    bus.registerService('tool:register', 'disp', async () => ({ ok: true }));
    const run = vi.fn();
    await registerWebSearch(bus, { run });
    await expect(
      bus.call('tool:execute:web_search', ctx(), { id: 'c', name: 'web_search', input: {} }),
    ).rejects.toThrow(/query/i);
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @ax/web-tools test -- tools-web-search`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tools/web-search.ts`**

```ts
import { makeAgentContext, PluginError } from '@ax/core';
import type { HookBus, ToolDescriptor } from '@ax/core';
import type { WebSearchOutput } from '../anthropic-client.js';

const PLUGIN_NAME = '@ax/web-tools';

export const WEB_SEARCH_DESCRIPTOR: ToolDescriptor = {
  name: 'web_search',
  description:
    'Search the live web and get back a list of result hits (title + URL) plus a short summary. ' +
    'Use when you need current information beyond your training data.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
    },
    required: ['query'],
  },
};

/** Backend seam — supplied by the plugin so tests can stub the Anthropic call. */
export interface WebSearchBackend {
  run(query: string): Promise<WebSearchOutput>;
}

export async function registerWebSearch(bus: HookBus, backend: WebSearchBackend): Promise<void> {
  const ctx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', ctx, WEB_SEARCH_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, WebSearchOutput>(
    'tool:execute:web_search',
    PLUGIN_NAME,
    async (_ctx, call) => {
      const input = (call?.input ?? {}) as { query?: unknown };
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (query.length === 0) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:web_search',
          message: 'web_search requires a non-empty "query"',
        });
      }
      return backend.run(query);
    },
    { timeoutMs: 120_000 },
  );
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ax/web-tools test -- tools-web-search`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web-tools/src/tools/web-search.ts packages/web-tools/src/__tests__/tools-web-search.test.ts
git commit -m "feat(web-tools): web_search descriptor + host executor"
```

---

## Task 6: `tools/web-extract.ts` — descriptor + executor (with url-guard)

**Files:**
- Create: `packages/web-tools/src/tools/web-extract.ts`
- Test: `packages/web-tools/src/__tests__/tools-web-extract.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { WEB_EXTRACT_DESCRIPTOR, registerWebExtract } from '../tools/web-extract.js';

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

async function wired(run = vi.fn()) {
  const bus = new HookBus();
  bus.registerService('tool:register', 'disp', async () => ({ ok: true }));
  await registerWebExtract(bus, { run });
  return { bus, run };
}

describe('tools/web-extract', () => {
  it('descriptor is a host tool named web_extract requiring url', () => {
    expect(WEB_EXTRACT_DESCRIPTOR.name).toBe('web_extract');
    expect(WEB_EXTRACT_DESCRIPTOR.executesIn).toBe('host');
    expect(WEB_EXTRACT_DESCRIPTOR.inputSchema).toMatchObject({ required: ['url'] });
  });

  it('reads call.input.url and returns the bare extract result', async () => {
    const run = vi.fn().mockResolvedValue({ url: 'https://x', title: 'T', text: 'body' });
    const { bus } = await wired(run);
    const out = await bus.call('tool:execute:web_extract', ctx(), {
      id: 'c', name: 'web_extract', input: { url: 'https://example.com' },
    });
    expect(run).toHaveBeenCalledWith('https://example.com');
    expect(out).toEqual({ url: 'https://x', title: 'T', text: 'body' });
  });

  it('rejects a disallowed (internal) URL before calling the backend', async () => {
    const { bus, run } = await wired();
    await expect(
      bus.call('tool:execute:web_extract', ctx(), { id: 'c', name: 'web_extract', input: { url: 'http://169.254.169.254/' } }),
    ).rejects.toThrow(/url/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a missing url', async () => {
    const { bus, run } = await wired();
    await expect(
      bus.call('tool:execute:web_extract', ctx(), { id: 'c', name: 'web_extract', input: {} }),
    ).rejects.toThrow(/url/i);
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @ax/web-tools test -- tools-web-extract`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tools/web-extract.ts`**

```ts
import { makeAgentContext, PluginError } from '@ax/core';
import type { HookBus, ToolDescriptor } from '@ax/core';
import type { WebExtractOutput } from '../anthropic-client.js';
import { isAllowedExtractUrl } from '../url-guard.js';

const PLUGIN_NAME = '@ax/web-tools';

export const WEB_EXTRACT_DESCRIPTOR: ToolDescriptor = {
  name: 'web_extract',
  description:
    'Fetch a specific web page (by URL) and return its readable text content. ' +
    'Use after web_search, or when the user gives you a URL to read. Text pages only (not PDFs/binary).',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The http(s) URL to fetch.' },
    },
    required: ['url'],
  },
};

export interface WebExtractBackend {
  run(url: string): Promise<WebExtractOutput>;
}

export async function registerWebExtract(bus: HookBus, backend: WebExtractBackend): Promise<void> {
  const ctx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', ctx, WEB_EXTRACT_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, WebExtractOutput>(
    'tool:execute:web_extract',
    PLUGIN_NAME,
    async (_ctx, call) => {
      const input = (call?.input ?? {}) as { url?: unknown };
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (url.length === 0) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:web_extract',
          message: 'web_extract requires a non-empty "url"',
        });
      }
      if (!isAllowedExtractUrl(url)) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:web_extract',
          message: `web_extract: url not allowed (must be a public http(s) URL): ${url}`,
        });
      }
      return backend.run(url);
    },
    { timeoutMs: 120_000 },
  );
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ax/web-tools test -- tools-web-extract`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web-tools/src/tools/web-extract.ts packages/web-tools/src/__tests__/tools-web-extract.test.ts
git commit -m "feat(web-tools): web_extract descriptor + host executor with url-guard"
```

---

## Task 7: `plugin.ts` — `createWebToolsPlugin`

**Files:**
- Create: `packages/web-tools/src/plugin.ts`
- Test: `packages/web-tools/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HookBus } from '@ax/core';
import { createWebToolsPlugin } from '../plugin.js';

function busWithDispatcher() {
  const bus = new HookBus();
  const registered: string[] = [];
  bus.registerService('tool:register', 'disp', async (_c, d: unknown) => {
    registered.push((d as { name: string }).name);
    return { ok: true };
  });
  return { bus, registered };
}

const fakeFactory = () => ({ messages: { create: vi.fn() } }) as never;

describe('createWebToolsPlugin', () => {
  it('manifest declares the two execute hooks + tool:register', () => {
    const p = createWebToolsPlugin({ apiKey: 'sk-ant-x', clientFactory: fakeFactory });
    expect(p.manifest.name).toBe('@ax/web-tools');
    expect(p.manifest.registers).toEqual(
      expect.arrayContaining(['tool:execute:web_search', 'tool:execute:web_extract']),
    );
    expect(p.manifest.calls).toContain('tool:register');
  });

  it('registers both descriptors on init', async () => {
    const { bus, registered } = busWithDispatcher();
    await createWebToolsPlugin({ apiKey: 'sk-ant-x', clientFactory: fakeFactory }).init({ bus, config: {} as never });
    expect(registered.sort()).toEqual(['web_extract', 'web_search']);
  });

  it('enabled:false registers nothing and never needs a key', async () => {
    const { bus, registered } = busWithDispatcher();
    await createWebToolsPlugin({ enabled: false }).init({ bus, config: {} as never });
    expect(registered).toEqual([]);
    expect(bus.hasService('tool:execute:web_search')).toBe(false);
  });

  it('throws at init when enabled and no key resolves', async () => {
    const { bus } = busWithDispatcher();
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(
        createWebToolsPlugin({ clientFactory: fakeFactory }).init({ bus, config: {} as never }),
      ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @ax/web-tools test -- plugin`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `plugin.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';
import { PluginError, type Plugin } from '@ax/core';
import { runWebSearch, runWebExtract, type CallOpts } from './anthropic-client.js';
import { registerWebSearch } from './tools/web-search.js';
import { registerWebExtract } from './tools/web-extract.js';

const PLUGIN_NAME = '@ax/web-tools';
const PLUGIN_VERSION = '0.0.0';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_CONTENT_TOKENS = 50_000;

export interface WebToolsConfig {
  /** Global Anthropic key. Falls back to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Inner-call model. Default 'claude-sonnet-4-6'. */
  model?: string;
  /** Operator kill-switch. When false the plugin registers nothing. Default true. */
  enabled?: boolean;
  /** Per-request timeout (ms) for the inner Messages call. */
  timeoutMs?: number;
  /** Cap on extracted content tokens (web_fetch max_content_tokens). */
  maxContentTokens?: number;
  /** Test seam — stub Anthropic client. */
  clientFactory?: (apiKey: string) => Anthropic;
}

export function createWebToolsPlugin(cfg: WebToolsConfig = {}): Plugin {
  const enabled = cfg.enabled ?? true;
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: enabled ? ['tool:execute:web_search', 'tool:execute:web_extract'] : [],
      calls: enabled ? ['tool:register'] : [],
      subscribes: [],
    },
    async init({ bus }) {
      if (!enabled) return;

      const apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) {
        throw new PluginError({
          code: 'init-failed',
          plugin: PLUGIN_NAME,
          hookName: 'init',
          message:
            'ANTHROPIC_API_KEY not set and cfg.apiKey not provided — refusing to init (set cfg.enabled=false to disable web tools)',
        });
      }

      const client =
        cfg.clientFactory !== undefined
          ? cfg.clientFactory(apiKey)
          : new Anthropic({ apiKey, ...(cfg.timeoutMs !== undefined ? { timeout: cfg.timeoutMs } : {}) });

      const opts: CallOpts = { model: cfg.model ?? DEFAULT_MODEL, maxTokens: DEFAULT_MAX_TOKENS };
      const maxContentTokens = cfg.maxContentTokens ?? DEFAULT_MAX_CONTENT_TOKENS;

      await registerWebSearch(bus, { run: (query) => runWebSearch(client, opts, query) });
      await registerWebExtract(bus, { run: (url) => runWebExtract(client, opts, url, maxContentTokens) });
    },
  };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ax/web-tools test -- plugin`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web-tools/src/plugin.ts packages/web-tools/src/__tests__/plugin.test.ts
git commit -m "feat(web-tools): createWebToolsPlugin — wiring, kill-switch, key gate"
```

---

## Task 8: `index.ts` — public exports

**Files:**
- Modify: `packages/web-tools/src/index.ts`

- [ ] **Step 1: Replace the placeholder with real exports**

```ts
export { createWebToolsPlugin, type WebToolsConfig } from './plugin.js';
export { WEB_SEARCH_DESCRIPTOR } from './tools/web-search.js';
export { WEB_EXTRACT_DESCRIPTOR } from './tools/web-extract.js';
```

- [ ] **Step 2: Build the package**

Run: `pnpm --filter @ax/web-tools build`
Expected: PASS (clean tsc build).

- [ ] **Step 3: Commit**

```bash
git add packages/web-tools/src/index.ts
git commit -m "feat(web-tools): public exports"
```

---

## Task 9: Canary integration test (real tool-dispatcher + web-tools)

**Files:**
- Create: `packages/web-tools/src/__tests__/canary.test.ts`

This is the "reachable from a canary" coverage required by invariant #3: it boots the **real** `@ax/tool-dispatcher` alongside `@ax/web-tools` and proves the full register → `tool:list` → `tool:execute:<name>` path with a stubbed Anthropic client.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { createToolDispatcherPlugin } from '@ax/mcp-client';
import { createWebToolsPlugin } from '../plugin.js';

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

// Stub Anthropic: web_search returns one hit; web_fetch returns text.
function stubClientFactory() {
  const create = vi.fn(async (req: { tools?: Array<{ type?: string }> }) => {
    const toolType = req.tools?.[0]?.type ?? '';
    if (toolType.startsWith('web_search')) {
      return {
        stop_reason: 'end_turn',
        content: [{
          type: 'web_search_tool_result', tool_use_id: 's',
          content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A', page_age: null, encrypted_content: 'X' }],
        }],
      };
    }
    return {
      stop_reason: 'end_turn',
      content: [{
        type: 'web_fetch_tool_result', tool_use_id: 's',
        content: { type: 'web_fetch_result', url: 'https://a.com', content: { type: 'document', title: 'A', source: { type: 'text', media_type: 'text/plain', data: 'hello' } } },
      }],
    };
  });
  return () => ({ messages: { create } }) as never;
}

describe('web-tools canary (real tool-dispatcher)', () => {
  it('both tools appear in tool:list and dispatch end-to-end', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: undefined });
    await createWebToolsPlugin({ apiKey: 'sk-ant-x', clientFactory: stubClientFactory() }).init({ bus, config: {} as never });

    const list = await bus.call<Record<string, never>, { tools: Array<{ name: string; executesIn: string }> }>(
      'tool:list', ctx(), {},
    );
    const byName = new Map(list.tools.map((t) => [t.name, t]));
    expect(byName.get('web_search')?.executesIn).toBe('host');
    expect(byName.get('web_extract')?.executesIn).toBe('host');

    const search = await bus.call('tool:execute:web_search', ctx(), { id: 'c1', name: 'web_search', input: { query: 'cats' } });
    expect(search).toMatchObject({ results: [{ title: 'A', url: 'https://a.com' }] });
    expect(JSON.stringify(search)).not.toContain('"X"');

    const extract = await bus.call('tool:execute:web_extract', ctx(), { id: 'c2', name: 'web_extract', input: { url: 'https://a.com' } });
    expect(extract).toMatchObject({ url: 'https://a.com', title: 'A', text: 'hello' });
  });
});
```

- [ ] **Step 2: Run it — expect PASS**

Run: `pnpm --filter @ax/web-tools test -- canary`
Expected: PASS. If it fails on the `tool:list` generic types, confirm the dispatcher seals the catalog on first `tool:list`; registration in `init()` completes before the test queries, so this is fine.

- [ ] **Step 3: Run the full package test + build**

Run: `pnpm --filter @ax/web-tools test && pnpm --filter @ax/web-tools build`
Expected: all green. (Per project convention, run the `tsc` build alongside vitest — vitest tolerates undeclared deps, tsc does not.)

- [ ] **Step 4: Commit**

```bash
git add packages/web-tools/src/__tests__/canary.test.ts
git commit -m "test(web-tools): canary — real tool-dispatcher register+list+dispatch"
```

---

## Task 10: Wire into the CLI preset

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/package.json` (add `@ax/web-tools` dependency)

- [ ] **Step 1: Add the dependency**

In `packages/cli/package.json`, add to `dependencies` (keep sorted):

```json
    "@ax/web-tools": "workspace:*",
```

- [ ] **Step 2: Import the plugin factory** in `packages/cli/src/main.ts` (near the other plugin imports, ~line 28-29)

```ts
import { createWebToolsPlugin } from '@ax/web-tools';
```

- [ ] **Step 3: Push the plugin inside the existing `ANTHROPIC_API_KEY` gate**

In `packages/cli/src/main.ts`, find the block guarded by `if (process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY.length > 0)` (the one that pushes `createLlmAnthropicPlugin()` + `createMemoryStrataPlugin()`). Add, after `plugins.push(createLlmAnthropicPlugin());`:

```ts
    // @ax/web-tools — host-executed web_search + web_extract backed by
    // Anthropic's server-side web tools. Gated on the same global key as
    // the other host-side LLM capabilities (it constructs its own
    // Anthropic client from ANTHROPIC_API_KEY). Available to all agents.
    plugins.push(createWebToolsPlugin());
```

- [ ] **Step 4: Build + test the CLI package**

Run: `pnpm install && pnpm --filter @ax/cli build && pnpm --filter @ax/cli test`
Expected: green. (`pnpm install` relinks the new workspace dep.)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/package.json pnpm-lock.yaml
git commit -m "feat(web-tools): load @ax/web-tools in the CLI preset (ANTHROPIC_API_KEY gate)"
```

---

## Task 11: Wire into the k8s preset + membership assertions

**Files:**
- Modify: `presets/k8s/src/index.ts`
- Modify: `presets/k8s/package.json` (add `@ax/web-tools` dependency)
- Modify: `presets/k8s/src/__tests__/preset.test.ts`

- [ ] **Step 1: Add the dependency** to `presets/k8s/package.json` `dependencies` (keep sorted):

```json
    "@ax/web-tools": "workspace:*",
```

- [ ] **Step 2: Import the factory** in `presets/k8s/src/index.ts` (near the other plugin imports, e.g. after the `@ax/llm-anthropic` import ~line 32)

```ts
import { createWebToolsPlugin } from '@ax/web-tools';
```

- [ ] **Step 3: Push the plugin inside the `config.titles !== undefined` block**

In `presets/k8s/src/index.ts`, find `if (config.titles !== undefined) {` (the block that pushes `createLlmAnthropicPlugin()` + `createMemoryStrataPlugin()`). Add, after `plugins.push(createLlmAnthropicPlugin());`:

```ts
    // @ax/web-tools — host-executed web_search + web_extract backed by
    // Anthropic's server-side web tools. Piggybacks on the same env gate
    // (config.titles is set iff ANTHROPIC_API_KEY is present) because it
    // constructs its own Anthropic client from that key. Available to all
    // agents; the plugin's own `enabled` flag is the operator kill-switch.
    plugins.push(createWebToolsPlugin());
```

- [ ] **Step 4: Add membership assertions** to `presets/k8s/src/__tests__/preset.test.ts`

In the `describe('createK8sPlugins — conditional title plugins', ...)` block, extend the existing two tests.

In the "omits ... when cfg.titles is undefined" test, add:

```ts
    expect(names).not.toContain('@ax/web-tools');
```

In the "includes both plugins when cfg.titles is set" test, add:

```ts
    expect(names).toContain('@ax/web-tools');
```

- [ ] **Step 5: Build + test the k8s preset**

Run: `pnpm install && pnpm --filter @ax/preset-k8s build && pnpm --filter @ax/preset-k8s test -- preset`
Expected: green, including the new membership assertions.

- [ ] **Step 6: Commit**

```bash
git add presets/k8s/src/index.ts presets/k8s/package.json presets/k8s/src/__tests__/preset.test.ts pnpm-lock.yaml
git commit -m "feat(web-tools): load @ax/web-tools in the k8s preset + assert membership"
```

---

## Task 12: SECURITY.md, MANUAL-ACCEPTANCE, spec sync, and full-repo gate

**Files:**
- Create: `packages/web-tools/SECURITY.md`
- Modify: `deploy/MANUAL-ACCEPTANCE.md`
- Modify: `docs/plans/2026-05-21-web-tools-design.md` (sync the two refinements)

- [ ] **Step 1: Write `packages/web-tools/SECURITY.md`** (project voice — nervous-crab-but-competent)

```markdown
# @ax/web-tools — security notes

We give agents web search + page extraction without poking a single hole in the sandbox.

## How the egress stays locked

The sandbox can't reach the internet — that's by design, and we kept it that way.
These tools run on the **host** (`executesIn: 'host'`), and even the host doesn't
fetch arbitrary pages: it asks **Anthropic** to do the search/fetch server-side and
hands back the results. So the only outbound connection is to `api.anthropic.com`,
which we already trust. No new egress surface, no SSRF surface we own.

## The thing we stay paranoid about

Web content is **untrusted** — it's a classic prompt-injection vector. We never
interpret fetched text on the host; it flows back to the agent as tool output,
which the agent already treats as untrusted. The fetch runs in an isolated,
minimal-context call (just "fetch this URL") so a malicious page can't see the
agent's transcript or any secrets.

`web_extract` also runs a defense-in-depth URL guard (`url-guard.ts`) that refuses
non-`http(s)` schemes and internal/private/metadata addresses before we spend an
API call — belt and suspenders, since Anthropic can't reach our cluster anyway.

## Operational note

Web search must be enabled once by an org admin in the Claude Console. Web search
bills ~$10 per 1,000 searches; `web_extract` has no per-fetch fee. The whole plugin
can be turned off with `createWebToolsPlugin({ enabled: false })`.
```

- [ ] **Step 2: Add a MANUAL-ACCEPTANCE entry** — append a section to `deploy/MANUAL-ACCEPTANCE.md` (match the file's existing heading style):

```markdown
## Web tools (@ax/web-tools)

Prereq: org admin has enabled Web Search in the Claude Console; the host has `ANTHROPIC_API_KEY`.

1. In the chat UI, ask the agent: "Search the web for the latest stable Node.js release and tell me the version."
   - Expect: the agent calls `web_search`, returns a current version with source URLs.
2. Ask: "Fetch https://nodejs.org/en/about and summarize it."
   - Expect: the agent calls `web_extract` and summarizes real page content.
3. Ask the agent to fetch `http://169.254.169.254/latest/meta-data/`.
   - Expect: `web_extract` refuses (url-guard) — no metadata is returned.
```

- [ ] **Step 3: Sync the design spec** — in `docs/plans/2026-05-21-web-tools-design.md`, update the `web_extract` output line to `{ url, title?, text }` (remove `truncated`) and change the PDF note to "PDFs/binary return a clean unsupported error." Add a one-line note under "Host-side call specifics" that host executors receive the full `ToolCall` and read `call.input` (mirroring `@ax/mcp-client`, not `memory-search`).

- [ ] **Step 4: Run the `security-checklist` skill** over the diff and paste its structured note into the PR description. (Touches: untrusted content, network egress, caller-provided URL.)

- [ ] **Step 5: Full-repo gate** (per project pre-PR convention: build + test + lint)

Run: `pnpm build && pnpm test && pnpm lint`
Expected: all green. If a repo-wide test teardown trips over the new package, investigate before proceeding.

- [ ] **Step 6: Commit**

```bash
git add packages/web-tools/SECURITY.md deploy/MANUAL-ACCEPTANCE.md docs/plans/2026-05-21-web-tools-design.md
git commit -m "docs(web-tools): SECURITY.md, manual-acceptance walk, spec sync"
```

---

## Self-review

**Spec coverage:**
- Host-executed `web_search` + `web_extract` backed by Anthropic server tools → Tasks 3-7.
- Sandbox egress lock untouched (no built-in re-enable, no proxy holes) → by construction; SECURITY.md (Task 12).
- Global host key, no new credential → Task 7 (`apiKey ?? env`).
- Available to all agents by default + kill-switch → Tasks 7, 10, 11.
- url-guard / SSRF defense-in-depth → Tasks 2, 6.
- Strip `encrypted_content`; backend-neutral output fields → Tasks 3, 9.
- Loaded in both presets same PR + canary → Tasks 9, 10, 11 (half-wired window CLOSED on merge).
- GA tool versions, `max_uses: 1`, `pause_turn` loop, error mapping → Tasks 3, 4.
- Tests for harvest, errors, url-guard, enabled:false, missing-key throw → Tasks 2-7, 9.
- Security note → Task 12.

**Placeholder scan:** none — every code step has full code; every command has expected output.

**Type consistency:** `CallOpts`, `WebSearchOutput`/`WebSearchHit`, `WebExtractOutput` defined in `anthropic-client.ts` (Tasks 3-4) and consumed by name in Tasks 5-7. `WebSearchBackend.run(query)` / `WebExtractBackend.run(url)` defined in Tasks 5/6 and supplied in Task 7. Executor payload typed `{ input?: unknown }` consistently; executors read `call.input` everywhere (Tasks 5, 6, 9). Descriptor const names `WEB_SEARCH_DESCRIPTOR` / `WEB_EXTRACT_DESCRIPTOR` consistent across Tasks 5, 6, 8.

## Out of scope (do not implement)

Per-user/per-agent key billing; `allowed_domains`/`blocked_domains` knobs; dynamic-filtering tool versions; JS rendering; usage/cost metering events. Also out of scope: fixing the `memory-search` `call.input` bug (separate follow-up).
