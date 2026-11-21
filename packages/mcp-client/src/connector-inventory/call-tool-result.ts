// ---------------------------------------------------------------------------
// `connectors:call-tool-result`: the same access checks as
// `connectors:call-tool` (the shared core, connector-call.ts, and the reasons
// in call-tool.ts's header), and the reply's content blocks on success and on
// a tool error.
//
// Intended caller: @ax/apps-bridge, which serves an external apps platform.
// It checks tool policy (`allow` only) and its own grants before it calls,
// and relays the content only to that platform, never to a model or a screen
// inside AX. Nothing here enforces that: like `connectors:call-tool`, any
// host plugin holds the same bus (SECURITY.md names the residual). What IS
// enforced: a named service, not an IPC action and not a `tool:execute:*`,
// so the sandbox cannot reach it.
//
// The content is UNTRUSTED. The transport reads it through a local schema
// (`callServerToolWithContent`), within the 2 MiB per-reply cap, and hands it
// back unchanged. The log line is the core's, codes only, under
// `connector_call_tool_result`: never the content, the input, a header or the
// url.
// ---------------------------------------------------------------------------

import type { AgentContext } from '@ax/core';
import {
  callServerToolWithContent,
  type CallServerToolOptions,
  type ServerCallResultOutcome,
} from './call-server-tool.js';
import { createConnectorCallHandler, type ConnectorCallBus } from './connector-call.js';
import type { ConnectorCallToolResultOutput } from './types.js';

export interface CallToolResultDeps {
  bus: ConnectorCallBus;
  /** Test seam: the one-shot transport. Default `callServerToolWithContent`. */
  callServerWithContent?: (opts: CallServerToolOptions) => Promise<ServerCallResultOutcome>;
  /** Test seam: the clock, in whole ms (see `createConnectorCallHandler`). */
  now?: () => number;
}

export function createCallToolResult(
  deps: CallToolResultDeps,
): (callerCtx: AgentContext, rawInput: unknown) => Promise<ConnectorCallToolResultOutput> {
  const callServerWithContent = deps.callServerWithContent ?? callServerToolWithContent;
  return createConnectorCallHandler<ServerCallResultOutcome>({
    bus: deps.bus,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    logEvent: 'connector_call_tool_result',
    send: (s) =>
      callServerWithContent({ url: s.url, headers: s.headers, tool: s.tool, input: s.input, limits: s.limits }),
  });
}
