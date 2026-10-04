// ---------------------------------------------------------------------------
// Connector tools (TASK-826): the aisdk runner's MCP client for the agent's
// attached connectors — remote streamable-HTTP MCP servers only.
//
// The claude-sdk runner hands the projected servers to `query({ mcpServers })`
// and the SDK subprocess speaks MCP. This runner has no subprocess, so it
// connects its own `@modelcontextprotocol/sdk` Client per connector, at session
// start, and exposes each tool as an ordinary `ai@7` tool. Parity points:
//
//   - Model-facing name `mcp__<ns>__<tool>` — the same string the SDK puts on
//     the wire, so transcripts, live chunks and channel-web's connector labels
//     (TASK-744) are identical across runners.
//   - Policy name `mcp.<ns>.<tool>` — what `classifySdkToolName` lifts the
//     SDK name to, and what `tool.pre-call` / @ax/tool-policy key on. So the
//     record KEY and the policy NAME differ here, and only here.
//   - Every execute goes through `wrapWithPolicy` (I₁). Denied tools
//     (`agentConfig.disallowedTools`) are not offered at all — catalog
//     hygiene; enforcement stays at tool.pre-call (TASK-736 F4).
//   - Network: every request goes through `opts.fetch`, the runner's
//     credential-proxy dispatcher (`createProxyFetch`). Header values are
//     `ax-cred:` placeholders the proxy swaps on allowlisted hosts; this
//     process never holds a real secret.
//
// Failure isolation: a connector that fails to connect or list (dead,
// wedged, 401, malformed list) loses only its own tools, with one stderr
// line. It never fails the session boot. A tool name the provider would
// reject is SKIPPED with a log line, never mangled — a renamed tool would
// silently miss its policy key and its UI label. A connector that would push
// the session past its tool budget (`maxTools`, from MAX_TOOLS_PER_SESSION)
// is dropped whole, in sorted-namespace order, with one log line.
// ---------------------------------------------------------------------------

import { jsonSchema, tool, type JSONSchema7, type Tool } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { HoldLatch, ProjectedMcpServer, ToolPolicy } from '@ax/agent-runner-core';
import { renderMcpResult } from './mcp-result.js';
import { wrapWithPolicy } from './policy-wrap.js';

export const CONNECT_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 300_000;
/** Hard ceiling so a server can't hold a call open forever by streaming progress; Stop still aborts sooner. */
export const MAX_CALL_TOTAL_MS = 1_800_000;
export const MAX_TOOLS_PER_CONNECTOR = 256;
/**
 * The whole session's tool ceiling: the strictest provider limit this runner
 * drives (OpenAI-compatible endpoints reject more than 128 functions).
 * Anthropic has no such cap, but one fixed ceiling keeps an agent's behaviour
 * identical whichever provider its model is on. main.ts subtracts the
 * non-connector tools and passes the remainder as `maxTools`.
 */
export const MAX_TOOLS_PER_SESSION = 128;
const MAX_LIST_PAGES = 16;
const CLOSE_TIMEOUT_MS = 5_000;
/**
 * The strictest tool-name rule across the providers this runner drives:
 * Anthropic `^[a-zA-Z0-9_-]{1,64}$`; OpenAI-compatible endpoints use the same.
 */
export const MODEL_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/**
 * Cap on a thrown call error's text. The MCP SDK embeds the whole HTTP
 * response body in its errors (`Error POSTing to endpoint: <body>`), and that
 * text flows to postToolUse, the live chunk, the model and the transcript.
 */
export const MAX_ERROR_CHARS = 4096;
/** Cap on an untrusted string quoted in a log line (it is also JSON-escaped). */
const MAX_LOGGED_CHARS = 200;

export interface ConnectConnectorToolsOptions {
  /** From `loadProjectedMcpServers`, keyed by host-minted toolNamespace. */
  servers: Record<string, ProjectedMcpServer>;
  /** `createProxyFetch(providerEnv)`; undefined only when no proxy is configured (tests). */
  fetch: typeof fetch | undefined;
  policy: ToolPolicy;
  holdLatch: HoldLatch;
  onHold: (toolCallId: string) => void;
  onToolFailure: (toolCallId: string) => void;
  /** `agentConfig.disallowedTools` — canonical names (`mcp.<ns>.<tool>` among them). */
  disallowed: readonly string[];
  log?: (line: string) => void;
  connectTimeoutMs?: number;
  /** Per-call timeout (default `CALL_TIMEOUT_MS`). A test seam only — production never sets it. */
  callTimeoutMs?: number;
  /**
   * Connector-tool budget for this session (default: unlimited). Connectors
   * are admitted in sorted-namespace order; one whose tools would push the
   * total over this is dropped WHOLE (no tools, bundle not loaded, client
   * closed) — never half-offered.
   */
  maxTools?: number;
}

export interface ConnectorTools {
  tools: Record<string, Tool>;
  /** Bundle dirs whose server connected + listed (even if every tool was then skipped). */
  loadedBundles: Set<string>;
  close(): Promise<void>;
}

interface ListedTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [truncated]` : s;
}

/**
 * An upstream-authored string, made safe for one stderr line: bounded, and
 * JSON-escaped so an embedded newline can't forge a second log line.
 */
function quoteUntrusted(s: string): string {
  return JSON.stringify(s.slice(0, MAX_LOGGED_CHARS));
}

/** Reject with the signal's reason the moment it aborts, whatever `p` does. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function connectAndList(
  server: ProjectedMcpServer,
  fetchImpl: typeof fetch | undefined,
  timeoutMs: number,
): Promise<{ client: Client; tools: ListedTool[]; truncated: boolean; morePages: boolean }> {
  const client = new Client({ name: 'ax-aisdk-runner', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
    ...(server.headers !== undefined ? { requestInit: { headers: server.headers } } : {}),
  });
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error(`no answer within ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    const work = (async () => {
      const reqOpts = { signal: ac.signal, timeout: timeoutMs };
      // The SDK types this transport's `sessionId` accessor as `string |
      // undefined`, which `exactOptionalPropertyTypes` rejects against the
      // `Transport` interface's `sessionId?: string`. Same object, so cast.
      await client.connect(transport as Transport, reqOpts);
      const tools: ListedTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = await client.listTools(cursor === undefined ? undefined : { cursor }, reqOpts);
        tools.push(...(res.tools as ListedTool[]));
        cursor = res.nextCursor;
        if (cursor === undefined || tools.length > MAX_TOOLS_PER_CONNECTOR) break;
      }
      // Page cap hit with the server still offering more (and not already
      // over the per-connector cap, which has its own log line).
      const morePages = cursor !== undefined && tools.length <= MAX_TOOLS_PER_CONNECTOR;
      return { tools, morePages };
    })();
    const { tools, morePages } = await raceAbort(work, ac.signal);
    const truncated = tools.length > MAX_TOOLS_PER_CONNECTOR;
    return { client, tools: tools.slice(0, MAX_TOOLS_PER_CONNECTOR), truncated, morePages };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function connectConnectorTools(
  opts: ConnectConnectorToolsOptions,
): Promise<ConnectorTools> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`runner: connector-mcp: ${line}\n`));
  const timeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const denied = new Set(opts.disallowed);
  const tools: Record<string, Tool> = {};
  const loadedBundles = new Set<string>();
  const clients: Client[] = [];

  const buildTool = (client: Client, t: ListedTool, policyName: string): Tool => {
    const toolName = t.name;
    return tool({
      description: t.description ?? '',
      inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
      execute: wrapWithPolicy(
        {
          policy: opts.policy,
          name: policyName,
          isBuiltin: false,
          holdLatch: opts.holdLatch,
          onHold: opts.onHold,
          onToolFailure: opts.onToolFailure,
        },
        async (input, ctx) => {
          let res: unknown;
          try {
            res = await client.callTool({ name: toolName, arguments: input }, undefined, {
              ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
              timeout: callTimeoutMs,
              resetTimeoutOnProgress: true,
              maxTotalTimeout: MAX_CALL_TOTAL_MS,
              // The SDK only sends a progressToken — and only resets the
              // timeout on progress — when a handler is registered. Without
              // this no-op, `resetTimeoutOnProgress` is inert.
              onprogress: () => {},
            });
          } catch (err) {
            // Stop: rethrow untouched so the abort is recognised as one.
            if (ctx.abortSignal?.aborted === true) throw err;
            // Otherwise the SDK's message may carry a whole upstream HTTP
            // body (measured: 1 MB). Bound it before it leaves this process.
            throw new Error(`connector tool '${toolName}' failed: ${clip(errText(err), MAX_ERROR_CHARS)}`);
          }
          const text = renderMcpResult(res as { content?: unknown; structuredContent?: unknown });
          // Parity with host-tools / the claude-sdk runner: a tool that
          // reported its own failure is a FAILED tool call (is_error on the
          // persisted result), not a success whose text complains. ai@7 turns
          // the throw into a tool-error and the turn continues.
          if ((res as { isError?: unknown }).isError === true) throw new Error(text);
          return text;
        },
      ),
    });
  };

  const results = await Promise.allSettled(
    Object.entries(opts.servers).map(async ([ns, server]) => ({
      ns,
      server,
      ...(await connectAndList(server, opts.fetch, timeoutMs)),
    })),
  );

  // Admission runs after every connection settled, in sorted namespace
  // order, so which connectors fit the budget never depends on who answered
  // first.
  const maxTools = opts.maxTools ?? Number.POSITIVE_INFINITY;
  const entries = Object.keys(opts.servers);
  const order = results
    .map((r, i) => ({ r, ns: entries[i]! }))
    .sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
  for (const { r, ns: settledNs } of order) {
    if (r.status === 'rejected') {
      log(`${settledNs}: could not load this connector's tools: ${quoteUntrusted(errText(r.reason))}`);
      continue;
    }
    const { ns, server, client, tools: listed, truncated, morePages } = r.value;
    if (truncated) {
      log(`${ns}: lists more than ${MAX_TOOLS_PER_CONNECTOR} tools; only the first ${MAX_TOOLS_PER_CONNECTOR} are offered`);
    }
    if (morePages) {
      log(`${ns}: tools/list still had more pages after ${MAX_LIST_PAGES} — the rest are not offered`);
    }
    const own: Record<string, Tool> = {};
    const seen = new Set<string>();
    for (const t of listed) {
      const modelName = `mcp__${ns}__${t.name}`;
      const policyName = `mcp.${ns}.${t.name}`;
      if (!MODEL_TOOL_NAME_RE.test(modelName)) {
        log(`${ns}: tool ${quoteUntrusted(t.name)} skipped — not a valid model tool name once prefixed (^[a-zA-Z0-9_-]{1,64}$)`);
        continue;
      }
      if (seen.has(t.name)) {
        log(`${ns}: tool ${quoteUntrusted(t.name)} skipped — duplicate name in this connector's list`);
        continue;
      }
      seen.add(t.name);
      if (denied.has(policyName)) {
        log(`${ns}: tool ${quoteUntrusted(t.name)} not offered — denied for this agent`);
        continue;
      }
      own[modelName] = buildTool(client, t, policyName);
    }
    const count = Object.keys(own).length;
    if (Object.keys(tools).length + count > maxTools) {
      log(`${ns}: not offered — its ${count} tools would exceed this session's tool budget (${maxTools})`);
      void client.close().catch(() => {});
      continue;
    }
    Object.assign(tools, own);
    clients.push(client);
    loadedBundles.add(server.bundle);
  }

  let closed = false;
  return {
    tools,
    loadedBundles,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      let timer: NodeJS.Timeout | undefined;
      const finished = await Promise.race([
        Promise.allSettled(clients.map((c) => c.close())).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (!finished) log(`closing connector clients timed out after ${CLOSE_TIMEOUT_MS}ms`);
    },
  };
}
