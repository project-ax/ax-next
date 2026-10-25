// ---------------------------------------------------------------------------
// Byte caps on every connector MCP answer (TASK-944).
//
// The runner reads each connector's answers through the MCP SDK's
// streamable-HTTP transport, which reads a body whole (`response.json()`, or
// an event stream parsed until it ends). A hostile, compromised or broken
// connector can send gigabytes, or a few KB of gzip that inflates to
// gigabytes, and the sandbox pod (1 GiB by default) has to hold all of it. So
// the fetch the transport uses wraps every answer with `capResponseBody`
// (`@ax/core/response-cap`): reading stops once the bytes that arrived, after
// any Content-Encoding is undone, pass the cap. A small, absent or lying
// Content-Length cannot get a big body past the count.
//
// Which cap applies, and who hears about it: an operation (one tool call, one
// connect) runs inside `withResponseScope`, and every request the SDK sends
// for it inherits that scope through AsyncLocalStorage. The SDK hands fetch no
// per-request signal, and a transport's fetch is fixed for its connection, so
// async context is the only link from an answer back to the operation it
// belongs to. A request made outside any scope gets
// MAX_CONNECTOR_RESPONSE_BYTES.
//
// Why the operation has to hear about it: when the cap cuts an event-stream
// answer (the MCP server SDK's default framing), the client SDK reports the
// stream error to its `onerror` and leaves the request pending until the
// request times out, 300 s for a tool call (MEASURED with SDK 1.32.1; a JSON
// answer fails in milliseconds). `onOversize` lets the operation abort itself
// at once instead.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks';
import { capResponseBody, type ResponseTooLargeError } from '@ax/core/response-cap';

/**
 * Cap on one `tools/call` answer. A real result can carry a multi-MB
 * screenshot plus text, though the model sees at most 100 KB of text and
 * images become placeholders (`renderMcpResult`). This bounds the bytes only.
 * What parsing them costs is bounded separately: `tools/call` results are
 * checked with the SDK's loose `ResultSchema` (TOOL_RESULT_SCHEMA in
 * connector-tools.ts), under which 8 MiB of junk peaks at about +40 MB
 * (MEASURED).
 */
export const MAX_TOOL_RESULT_BYTES = 8 * 1024 * 1024;

/**
 * Cap on every other answer: initialize, each `tools/list` page, and the
 * server's event stream. 2 MiB matches the host inventory's cap per
 * `tools/list` page (`@ax/mcp-client`), so the Tools tab never lists tools
 * this runner would refuse to load. The event stream is one long answer, so
 * for it this is a budget for the stream's whole life, not a cap on each
 * message: once it has carried 2 MiB it is cut (and logged; see
 * `connectScope` in connector-tools.ts).
 */
export const MAX_CONNECTOR_RESPONSE_BYTES = 2 * 1024 * 1024;

/** The byte cap, and the oversize report, for one operation's answers. */
export interface ResponseScope {
  /** Byte cap for every answer read while this scope is active. */
  readonly maxBytes: number;
  /**
   * Told when an answer passes `maxBytes`, once per answer, before the error
   * reaches the SDK's reader. A throw from it is swallowed.
   */
  onOversize(err: ResponseTooLargeError): void;
}

const activeScope = new AsyncLocalStorage<ResponseScope>();

/**
 * Run `fn` with `scope` as the active scope (AsyncLocalStorage). Every request
 * `fn` makes, at any depth, inherits it, including requests the SDK starts
 * later from inside it (such as the server's event stream after a connect).
 */
export function withResponseScope<T>(scope: ResponseScope, fn: () => Promise<T>): Promise<T> {
  return activeScope.run(scope, fn);
}

/**
 * Wrap `base` (undefined = the global fetch, looked up per request, as the
 * SDK does) so every answer is capped at the active scope's `maxBytes`, or
 * MAX_CONNECTOR_RESPONSE_BYTES with no scope, and an oversize answer is
 * reported to the scope that was active when fetch was called, whoever reads
 * the body.
 */
export function capConnectorFetch(base: typeof fetch | undefined): typeof fetch {
  return async (input, init) => {
    // Read before the first await: it names the operation this request is for.
    const scope = activeScope.getStore();
    const res = await (base ?? globalThis.fetch)(input, init);
    return capResponseBody(
      res,
      scope?.maxBytes ?? MAX_CONNECTOR_RESPONSE_BYTES,
      scope !== undefined ? { onOversize: (err) => scope.onOversize(err) } : {},
    );
  };
}
