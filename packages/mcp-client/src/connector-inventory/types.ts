// ---------------------------------------------------------------------------
// Hook payloads for `connectors:describe-tools` (service) and
// `connectors:tools-discovered` (subscriber). Registered by @ax/mcp-client.
//
// Boundary review: storage- and transport-agnostic. No url / transport /
// header / server-spec vocabulary crosses the hook — a caller sees a status,
// tool names, untrusted text, three-valued hints and the canonical toolKey.
// An alternate impl (a runtime-reported inventory from the sandbox, reporting
// what the agent's MCP client actually saw) fills the same shape.
// ---------------------------------------------------------------------------

import { z } from 'zod';

export type InventoryStatus = 'ok' | 'unreachable' | 'needs-auth' | 'unknown';

export interface InventoryTool {
  /** The tool's name as the server advertises it. */
  name: string;
  /** Untrusted display title (falls back to `name`). Fence when rendering. */
  title: string;
  /** Untrusted description ('' when absent). Fence when rendering. */
  description: string;
  /** Server's `readOnlyHint`; null when unstated. A hint, never a guarantee. */
  readOnly: boolean | null;
  /** `destructiveHint || openWorldHint`; null when undecidable. A hint. */
  outward: boolean | null;
  /** Canonical permission key: `mcp.<toolNamespace>.<name>`. */
  toolKey: string;
}

export interface DescribeToolsInput {
  userId: string;
  /** Agent whose credential scope applies. Verified via `agents:resolve`. */
  agentId?: string;
  connectorId: string;
  /** Bypass the cache and check the server now (Retry / Reconnect). */
  force?: boolean;
}

export interface DescribeToolsOutput {
  status: InventoryStatus;
  tools: InventoryTool[];
  /** ISO-8601 time the server was last actually checked. */
  checkedAt: string;
}

export interface ToolsDiscoveredEvent {
  connectorId: string;
  tools: InventoryTool[];
}

export const DescribeToolsInputSchema = z
  .object({
    userId: z.string().min(1).max(256),
    agentId: z.string().min(1).max(256).optional(),
    connectorId: z.string().min(1).max(256),
    force: z.boolean().optional(),
  })
  .strict();

/**
 * `connectors:inventory-status-batch` (TASK-741). The last KNOWN status of each
 * connector for one (user, agent), read from the inventory cache only — it never
 * lists tools, resolves a credential, or reaches a server, so the connectors
 * rail can show health for a page of rows without N probes. Only an explicit
 * `connectors:describe-tools {force: true}` (Retry) refreshes it.
 *
 * Boundary review: ids, a status word and a time — no url / transport / table
 * vocabulary. Alternate impl: health reported by the sandbox's own MCP client
 * as sessions use each connector, written to the same shape.
 *
 * The caller is responsible for having decided the user may see these
 * connectors on this agent (the rail lists them via `connectors:list-effective`
 * after `agents:resolve`); the answer only ever covers rows cached under
 * `userId`, so it cannot speak for anyone else's credential.
 */
export interface InventoryStatusBatchInput {
  userId: string;
  agentId?: string;
  connectorIds: string[];
}

export interface InventoryStatusBatchOutput {
  /** One entry per connector that has EVER been checked; unchecked ones are absent. */
  statuses: Array<{ connectorId: string; status: InventoryStatus; checkedAt: string }>;
}

export const InventoryStatusBatchInputSchema = z
  .object({
    userId: z.string().min(1).max(256),
    agentId: z.string().min(1).max(256).optional(),
    // Same cap as `mcp-oauth:status-batch` and the connector slug rule: the rail
    // sends ONE id list to both, and an all-or-nothing batch must not refuse
    // on one side only.
    connectorIds: z.array(z.string().min(1).max(128)).max(500),
  })
  .strict();

/**
 * `connectors:inventory-tool-titles` (TASK-753). The MCP server's own display
 * title for each tool of `connectorIds`, as last cached by
 * `connectors:describe-tools` for `userId` — under ANY of that user's agents,
 * newest check first. A pure cache read: nothing here lists tools, resolves a
 * credential, or reaches a server, so the label path (an approval card being
 * written inside the pre-call ceiling, a transcript being shaped) never waits
 * on the network.
 *
 * Only real titles come back: a tool whose server sent none carries its own
 * name as `title` in the cache, and that is left out. `title` is UNTRUSTED
 * third-party text — clamped here to bound the payload, fenced by whoever
 * renders it.
 *
 * Boundary review: ids, the canonical toolKey and untrusted text — no url /
 * transport / table vocabulary. Alternate impl: titles reported by the
 * sandbox's own MCP client as sessions list each connector's tools.
 *
 * The answer only ever covers rows cached under `userId`; the caller decides
 * which connectors that user may name (`connectors:tool-labels` asks for
 * exactly the ones `connectors:list` resolves for them).
 */
export interface InventoryToolTitlesInput {
  userId: string;
  connectorIds: string[];
}

export interface InventoryToolTitlesOutput {
  titles: Array<{ connectorId: string; toolKey: string; title: string }>;
}

export const InventoryToolTitlesInputSchema = z
  .object({
    userId: z.string().min(1).max(256),
    connectorIds: z.array(z.string().min(1).max(128)).max(500),
  })
  .strict();

// ---------------------------------------------------------------------------
// `connectors:call-tool` (service, TASK-1046). The host makes ONE connector
// call that a person approved, when no live agent is there to make it. Its
// intended caller is @ax/decisions; nothing in the hook enforces that (see
// call-tool.ts). It re-derives access from `userId` and `agentId` (the
// decision's owner and agent) on every call, sends one guarded `tools/call`,
// and answers with a closed code.
//
// Boundary review:
//   - Alternate impl: a one-shot sandbox replay, i.e. a short-lived runner
//     session for (user, agent) that makes the call through the
//     credential-proxy and reports the outcome. Or a non-MCP connector backend
//     (a REST/OpenAPI connector) answering the same canonical toolKey.
//   - Payload field names that might leak: `toolKey`'s value carries the
//     `mcp.` prefix. It is the canonical permission key since TASK-734, shared
//     by tool-policy, decisions, `connectors:tool-labels` and
//     `connectors:describe-tools`, not a transport field. `input` is the
//     ToolCall vocabulary, not MCP's `arguments`. The reason codes carry no
//     URL, header, HTTP status, server name or session id. `tool-error` (the
//     service answered that the call did not work, after it went out) is
//     MCP's `isError` or a JSON-RPC error object in our words; a REST
//     connector has the same answer (a tool-level failure body).
//   - Subscriber risk: none. It is a service hook, and nothing fires.
//   - Wire surface: none. It is deliberately NOT an IPC action, and NOT a
//     `tool:execute:<name>`: `tool.execute-host` dispatches only those, and no
//     IPC handler forwards `connectors:*`. The sandbox cannot reach it.
// ---------------------------------------------------------------------------

/**
 * A definite answer. Every reason but `tool-error` means nothing completed.
 * `tool-error` (review F3) is the service answering that the call did not
 * work after it was sent: the tool's own `isError`, or ANY JSON-RPC error
 * object the server sends back for it (review r3 S1, after r2 R1 moved
 * -32602): a relay or an SDK can send any code after the tool ran. The tool
 * may have run and done part of the work, so a caller must never read it as
 * "nothing happened". Kept under `failed` because the service did
 * answer, and given its own code so it is never confused with `rejected`
 * (the request was turned away before anything ran: before the send, or an
 * HTTP 4xx from the transport).
 */
export type ConnectorCallFailedReason =
  | 'invalid-call'
  | 'not-connected'
  | 'needs-auth'
  | 'unavailable'
  | 'unreachable'
  | 'rejected'
  | 'tool-error';

/** The call went out and no reliable answer came back: it may have happened. */
export type ConnectorCallUnknownReason = 'timeout' | 'interrupted';

export interface ConnectorCallToolInput {
  /** The decision's owner. The caller's ctx must name the same user. */
  userId: string;
  /** The agent whose call it was. The caller's ctx must name the same agent. */
  agentId: string;
  /** Canonical connector toolKey: `mcp.<toolNamespace>.<tool>`. */
  toolKey: string;
  /** The call's recorded arguments, sent exactly as given. */
  input: Record<string, unknown>;
}

export type ConnectorCallToolOutput =
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; reason: ConnectorCallFailedReason }
  | { outcome: 'unknown'; reason: ConnectorCallUnknownReason };

/** `mcp.<toolNamespace>.<tool>`: the namespace we mint, then the server's tool name. */
export const CONNECTOR_TOOL_KEY_RE = /^mcp\.(c[0-9a-f]{10})\.([\x21-\x7e]{1,128})$/;

export const ConnectorCallToolInputSchema = z
  .object({
    userId: z.string().min(1).max(256),
    agentId: z.string().min(1).max(256),
    toolKey: z.string().regex(CONNECTOR_TOOL_KEY_RE),
    input: z.record(z.unknown()),
  })
  .strict();

const FAILED_REASONS = [
  'invalid-call',
  'not-connected',
  'needs-auth',
  'unavailable',
  'unreachable',
  'rejected',
  'tool-error',
] as const satisfies readonly ConnectorCallFailedReason[];

/** The bus holds the hook to these shapes: no field can carry a server's text. */
export const ConnectorCallToolOutputSchema: z.ZodType<ConnectorCallToolOutput> = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('succeeded') }).strict(),
  z.object({ outcome: z.literal('failed'), reason: z.enum(FAILED_REASONS) }).strict(),
  z.object({ outcome: z.literal('unknown'), reason: z.enum(['timeout', 'interrupted']) }).strict(),
]);
