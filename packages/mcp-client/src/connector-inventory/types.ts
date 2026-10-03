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
    connectorIds: z.array(z.string().min(1).max(256)).max(500),
  })
  .strict();
