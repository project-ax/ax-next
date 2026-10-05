// ---------------------------------------------------------------------------
// Tell the host when a connector's MCP server refused us (TASK-842).
//
// TASK-817 marks an OAuth connector needs-reconnect when the provider refuses
// its stored token, but only when a HOST-side check (the connectors rail, the
// details view) sees the refusal. A person who only chats never triggers one,
// so the connector stayed "Connected" while every chat turn silently lacked
// its tools. This is the runner's half: notice the refusal, say so.
//
// What the agent SDK shows us, measured against the pinned CLI (2.1.119)
// with a local MCP server answering 401 (connector-mcp-real-sdk.e2e.test.ts):
//
//   - 401 on `initialize`: `system/init` lists the server as `failed` (or
//     `needs-auth`, when the SDK's OAuth discovery finds an authorization
//     server), and none of its tools is offered.
//   - 401 on a `tools/call` after a good start: the tool result is an error
//     whose text says nothing about auth, and the server STAYS `connected`.
//     An error from a connector tool is the only mid-turn signal there is.
//
// Neither tells us it was a 401, and neither has to: the host does not trust
// this report. It re-checks the connector itself (the rail's cooldown-bounded
// check), and only a 401 the host sees reaches the sign-in machinery. So the
// report is deliberately coarse and carries nothing but the server's
// host-minted namespace and a closed status: no URL, no header, no error
// text, no token.
//
// Fire-and-forget: a report that fails to send is logged and dropped. It must
// never slow, fail or reorder a turn.
// ---------------------------------------------------------------------------

import { CONNECTOR_TOOL_NAMESPACE_RE } from '@ax/agent-runner-core';
import { splitConnectorToolName } from './tool-names.js';

export type ConnectorAuthStatus = 'needs-auth' | 'failed' | 'tool-error';

export interface ConnectorAuthFailureReport {
  servers: Array<{ toolNamespace: string; status: ConnectorAuthStatus }>;
}

export interface ConnectorAuthReporter {
  /** `system/init`'s `mcp_servers`. Reports each refused connector server once per process. */
  onInit(mcpServers: unknown): void;
  /** An assistant `tool_use` block: remember which connector server it went to. */
  onToolUse(toolUseId: string, sdkToolName: string): void;
  /** A `tool_result` block. `isError` already excludes held calls (not failures). */
  onToolResult(toolUseId: string, isError: boolean): void;
  /** Turn boundary: a server may be reported again for a tool error next turn. */
  endTurn(): void;
}

/** Same cap as the wire schema; a session never has this many connector servers. */
const MAX_SERVERS = 32;
const INIT_REFUSED = new Set(['needs-auth', 'failed']);

export function createConnectorAuthReporter(
  send: (report: ConnectorAuthFailureReport) => Promise<void>,
  log: (line: string) => void = (line) => process.stderr.write(`runner: connector-auth: ${line}\n`),
): ConnectorAuthReporter {
  const reportedAtInit = new Set<string>();
  const reportedThisTurn = new Set<string>();
  /** tool_use id → connector namespace, for this turn's connector calls only. */
  const pending = new Map<string, string>();

  const fire = (report: ConnectorAuthFailureReport): void => {
    let sent: Promise<void>;
    try {
      sent = send(report);
    } catch (err) {
      sent = Promise.reject(err);
    }
    sent.catch((err: unknown) => {
      log(`report not sent: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  return {
    onInit(mcpServers) {
      if (!Array.isArray(mcpServers)) return;
      const servers: ConnectorAuthFailureReport['servers'] = [];
      for (const s of mcpServers) {
        const name = (s as { name?: unknown } | null)?.name;
        const status = (s as { status?: unknown } | null)?.status;
        // Only host-minted connector servers; ours (ax-host / ax-sandbox) and
        // anything else are not connectors.
        if (typeof name !== 'string' || !CONNECTOR_TOOL_NAMESPACE_RE.test(name)) continue;
        if (typeof status !== 'string' || !INIT_REFUSED.has(status)) continue;
        if (reportedAtInit.has(name) || servers.length >= MAX_SERVERS) continue;
        reportedAtInit.add(name);
        servers.push({ toolNamespace: name, status: status as ConnectorAuthStatus });
      }
      if (servers.length > 0) fire({ servers });
    },
    onToolUse(toolUseId, sdkToolName) {
      const split = splitConnectorToolName(sdkToolName);
      if (split !== undefined) pending.set(toolUseId, split.toolNamespace);
    },
    onToolResult(toolUseId, isError) {
      const ns = pending.get(toolUseId);
      if (ns === undefined) return;
      pending.delete(toolUseId);
      if (!isError || reportedThisTurn.has(ns)) return;
      reportedThisTurn.add(ns);
      fire({ servers: [{ toolNamespace: ns, status: 'tool-error' }] });
    },
    endTurn() {
      reportedThisTurn.clear();
      pending.clear();
    },
  };
}
