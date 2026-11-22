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
//   - `outputSchema` is dropped. `inputSchema` is kept as opaque JSON for
//     callers that relay it (an external apps platform needs each tool's
//     argument schema): only a plain object, at most 32 KiB serialized and
//     within 1 MiB per server listing, else null. What we keep is a fresh
//     parse of the exact JSON we measured (so a `__proto__` the SDK's parse
//     turned into a prototype is gone), and it is never compiled, read or
//     acted on here. We deliberately
//     call `client.request('tools/list')` instead of `client.listTools()`,
//     because the latter compiles every tool's `outputSchema` with a
//     JSON-Schema validator — compiling attacker-supplied schemas on the host
//     buys nothing for an inventory.
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
  /** A tool's `inputSchema` is kept only up to this many UTF-8 bytes of JSON. */
  maxInputSchemaBytes: 32_768,
  /** ...and only while one server's kept schemas total at most this many. */
  maxInputSchemaBytesPerServer: 1_048_576,
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
  /**
   * The server's own JSON Schema for the tool's arguments. UNTRUSTED and
   * opaque: never compiled. Null when absent, not a plain object, or over
   * the size caps.
   */
  inputSchema: Record<string, unknown> | null;
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

/**
 * A plain JSON object: not null, not an array, and with `Object.prototype` (or
 * no prototype). The SDK's catchall parse turns a top-level `__proto__` key in
 * a server's schema into the parsed object's prototype, so "is an object" is
 * not enough. Shared with the cache read (store.ts).
 */
export function isPlainJsonObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * A fresh copy of `schema` made from its own JSON, with its UTF-8 size: what
 * we keep is exactly the bytes we measured, always a plain object, and the
 * same as what the cache round-trip (stringify, then parse) gives back. A
 * value JSON can't encode reads as too big (null).
 */
function copySchema(schema: object): { copy: Record<string, unknown>; bytes: number } | null {
  try {
    const json = JSON.stringify(schema);
    if (typeof json !== 'string') return null;
    const copy: unknown = JSON.parse(json);
    if (!isPlainJsonObject(copy)) return null;
    return { copy, bytes: Buffer.byteLength(json, 'utf8') };
  } catch {
    return null;
  }
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
  /** UTF-8 bytes of the schemas kept so far in this listing. */
  let schemaTotal = 0;
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      dropped++;
      continue;
    }
    const t = entry as {
      name?: unknown;
      title?: unknown;
      description?: unknown;
      annotations?: unknown;
      inputSchema?: unknown;
    };
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
    let inputSchema: Record<string, unknown> | null = null;
    // The SDK's object is only the input: a top-level `__proto__` from the
    // wire is its prototype, not an own key. Only a plain object reaches the
    // copy, and what we keep is the copy, re-read from the JSON we measured.
    const sent: unknown = t.inputSchema;
    const measured =
      sent !== null && typeof sent === 'object' && !Array.isArray(sent) ? copySchema(sent) : null;
    if (
      measured !== null &&
      measured.bytes <= INVENTORY_LIMITS.maxInputSchemaBytes &&
      schemaTotal + measured.bytes <= INVENTORY_LIMITS.maxInputSchemaBytesPerServer
    ) {
      inputSchema = measured.copy;
      schemaTotal += measured.bytes;
    }
    out.push({
      name,
      title: title.length > 0 ? title : name,
      description: cleanText(t.description, INVENTORY_LIMITS.maxDescriptionLength),
      readOnly: mapReadOnly(t.annotations),
      outward: mapOutward(t.annotations),
      inputSchema,
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
  const oversize = new AbortController();
  let guarded: ReturnType<typeof createGuardedFetch>;
  try {
    guarded = createGuardedFetch({
      serverUrl: opts.url,
      timeoutMs: limits.requestTimeoutMs,
      maxResponseBytes: limits.maxResponseBytes,
      onOversize: error => oversize.abort(error),
      ...(opts.resolver !== undefined ? { resolver: opts.resolver } : {}),
      ...(opts.baseFetch !== undefined ? { baseFetch: opts.baseFetch } : {}),
    });
  } catch (err) {
    return classifyError(err);
  }
  const budget = AbortSignal.any([AbortSignal.timeout(limits.serverBudgetMs), oversize.signal]);
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
    return classifyError(oversize.signal.aborted ? oversize.signal.reason : err);
  } finally {
    await client.close().catch(() => {});
    await guarded.close();
  }
}
