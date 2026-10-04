// ---------------------------------------------------------------------------
// One-shot `tools/list` against a connector's http MCP server, plus the pure
// mapping from MCP tool metadata to the inventory shape.
//
// Everything a server returns here is UNTRUSTED third-party self-description:
//   - `readOnlyHint` / `destructiveHint` / `openWorldHint` only choose
//     pre-filled defaults and grouping in the UI. They are never a security
//     claim; enforcement keys off verdicts, not hints.
//   - names, titles and descriptions are length-capped and stripped of
//     control and bidi-override characters here; renderers still fence them.
//   - `inputSchema` / `outputSchema` are dropped. We deliberately call
//     `client.request('tools/list')` instead of `client.listTools()`, because
//     the latter compiles every tool's `outputSchema` with a JSON-Schema
//     validator — compiling attacker-supplied schemas on the host buys
//     nothing for an inventory.
// ---------------------------------------------------------------------------

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { stripSurfaceRewritersFromDocument } from '@ax/core/surface-text';
import { createGuardedFetch, type AllAddressesResolver, type FetchLike } from './safe-fetch.js';

/** Hard caps on what one server may hand us. */
export const INVENTORY_LIMITS = {
  /** Per-HTTP-request deadline. */
  requestTimeoutMs: 10_000,
  /** Wall-clock budget for connect + every tools/list page of ONE server. */
  serverBudgetMs: 20_000,
  /** Per-response body cap (tool lists carry input schemas; GitHub's is ~200 KiB). */
  maxResponseBytes: 2 * 1024 * 1024,
  /** Pagination cap. */
  maxPages: 10,
  /** Tools kept per server; the rest are dropped (and logged by the caller). */
  maxTools: 500,
  maxNameLength: 128,
  maxTitleLength: 200,
  maxDescriptionLength: 2_000,
} as const;

/** One tool as the inventory reports it (before the toolKey is attached). */
export interface InventoryToolBase {
  name: string;
  title: string;
  description: string;
  /** MCP `readOnlyHint`; null when the server did not say. */
  readOnly: boolean | null;
  /** `destructiveHint || openWorldHint`; null when that can't be decided. */
  outward: boolean | null;
}


function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // Controls (except tab/newline/CR) and invisible / bidi-override characters
  // that can make rendered text lie about its order — the shared class.
  const cleaned = stripSurfaceRewritersFromDocument(raw).trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Printable ASCII, no whitespace — what a toolKey segment may contain. */
const TOOL_NAME_RE = /^[\x21-\x7e]+$/;

/** `readOnly` from MCP annotations. */
export function mapReadOnly(annotations: unknown): boolean | null {
  if (annotations === null || typeof annotations !== 'object') return null;
  const v = (annotations as { readOnlyHint?: unknown }).readOnlyHint;
  return typeof v === 'boolean' ? v : null;
}

/**
 * `outward` = `destructiveHint || openWorldHint`, three-valued: true if either
 * hint is true, false only if BOTH are explicitly false, otherwise null. (The
 * MCP spec defaults both hints to true when absent; we report "unknown"
 * rather than guess, and let the caller pick the cautious default.)
 */
export function mapOutward(annotations: unknown): boolean | null {
  if (annotations === null || typeof annotations !== 'object') return null;
  const a = annotations as { destructiveHint?: unknown; openWorldHint?: unknown };
  const d = typeof a.destructiveHint === 'boolean' ? a.destructiveHint : null;
  const o = typeof a.openWorldHint === 'boolean' ? a.openWorldHint : null;
  if (d === true || o === true) return true;
  if (d === false && o === false) return false;
  return null;
}

export interface NormalizeResult {
  tools: InventoryToolBase[];
  /** Tools dropped for a malformed/oversize name, a duplicate, or the count cap. */
  dropped: number;
}

/** Map raw `tools/list` entries to inventory tools. Pure. */
export function normalizeTools(raw: ReadonlyArray<unknown>): NormalizeResult {
  const out: InventoryToolBase[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      dropped++;
      continue;
    }
    const t = entry as { name?: unknown; title?: unknown; description?: unknown; annotations?: unknown };
    const name = typeof t.name === 'string' ? t.name : '';
    if (
      name.length === 0 ||
      name.length > INVENTORY_LIMITS.maxNameLength ||
      !TOOL_NAME_RE.test(name) ||
      seen.has(name) ||
      out.length >= INVENTORY_LIMITS.maxTools
    ) {
      dropped++;
      continue;
    }
    seen.add(name);
    const annTitle =
      t.annotations !== null && typeof t.annotations === 'object'
        ? (t.annotations as { title?: unknown }).title
        : undefined;
    const title = cleanText(t.title ?? annTitle, INVENTORY_LIMITS.maxTitleLength);
    out.push({
      name,
      title: title.length > 0 ? title : name,
      description: cleanText(t.description, INVENTORY_LIMITS.maxDescriptionLength),
      readOnly: mapReadOnly(t.annotations),
      outward: mapOutward(t.annotations),
    });
  }
  return { tools: out, dropped };
}

export type ListOutcome =
  | { kind: 'ok'; tools: InventoryToolBase[]; dropped: number }
  /** `rejected` (TASK-817): the server answered 401 — the credential that was
   *  sent was refused, as opposed to accepted-but-not-allowed (403). */
  | { kind: 'needs-auth'; rejected?: true }
  | { kind: 'unreachable'; reason: string };

export interface ListServerToolsOptions {
  url: string;
  headers: Record<string, string>;
  /** Test seams. */
  resolver?: AllAddressesResolver;
  baseFetch?: (url: string, init: Record<string, unknown>) => Promise<Response>;
  limits?: Partial<typeof INVENTORY_LIMITS>;
}

/** Short, non-echoing classification of a failure — never the server's text. */
function classifyError(err: unknown): ListOutcome {
  const code = (err as { code?: unknown } | null)?.code;
  const name = err instanceof Error ? err.name : '';
  if (code === 401 || name === 'UnauthorizedError') return { kind: 'needs-auth', rejected: true };
  if (code === 403) return { kind: 'needs-auth' };
  if (name === 'BlockedRequestError') return { kind: 'unreachable', reason: 'blocked' };
  if (name === 'ResponseTooLargeError') return { kind: 'unreachable', reason: 'response-too-large' };
  if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'unreachable', reason: 'timeout' };
  if (typeof code === 'number') return { kind: 'unreachable', reason: `http-${code}` };
  // A pinned-lookup refusal surfaces from undici as a TypeError('fetch failed')
  // whose cause is our BlockedRequestError.
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error && cause.name === 'BlockedRequestError') {
    return { kind: 'unreachable', reason: 'blocked' };
  }
  return { kind: 'unreachable', reason: 'error' };
}

/**
 * Connect to one http MCP server through the guarded fetch, page through
 * `tools/list`, and close. Never throws: every failure is an outcome.
 */
export async function listServerTools(opts: ListServerToolsOptions): Promise<ListOutcome> {
  const limits = { ...INVENTORY_LIMITS, ...(opts.limits ?? {}) };
  let guarded: ReturnType<typeof createGuardedFetch>;
  try {
    guarded = createGuardedFetch({
      serverUrl: opts.url,
      timeoutMs: limits.requestTimeoutMs,
      maxResponseBytes: limits.maxResponseBytes,
      ...(opts.resolver !== undefined ? { resolver: opts.resolver } : {}),
      ...(opts.baseFetch !== undefined ? { baseFetch: opts.baseFetch } : {}),
    });
  } catch (err) {
    return classifyError(err);
  }
  const budget = AbortSignal.timeout(limits.serverBudgetMs);
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
    fetch: guarded.fetch as FetchLike,
    requestInit: { headers: opts.headers },
    // One shot: never reconnect a dropped SSE stream in the background.
    reconnectionOptions: {
      maxReconnectionDelay: 0,
      initialReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const client = new Client({ name: '@ax/mcp-client', version: '0.0.0' }, { capabilities: {} });
  // The SDK reports background-stream errors (e.g. a 405 on the optional GET
  // stream) via onerror; they don't affect the request/response we need.
  client.onerror = () => {};
  try {
    // exactOptionalPropertyTypes: the SDK's own transport class is wider than
    // its `Transport` interface on `sessionId`; identical at runtime.
    await client.connect(transport as unknown as Parameters<Client['connect']>[0], { signal: budget, timeout: limits.requestTimeoutMs });
    const raw: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < limits.maxPages; page++) {
      const res = await client.request(
        { method: 'tools/list', params: cursor !== undefined ? { cursor } : {} },
        ListToolsResultSchema,
        { signal: budget, timeout: limits.requestTimeoutMs },
      );
      raw.push(...res.tools);
      cursor = res.nextCursor;
      if (cursor === undefined || raw.length >= limits.maxTools) break;
    }
    const { tools, dropped } = normalizeTools(raw);
    return { kind: 'ok', tools, dropped };
  } catch (err) {
    return classifyError(err);
  } finally {
    await client.close().catch(() => {});
    await guarded.close();
  }
}
