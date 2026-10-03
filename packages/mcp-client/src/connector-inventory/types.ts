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
