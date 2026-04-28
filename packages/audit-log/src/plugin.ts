import { randomUUID } from 'node:crypto';
import type { AgentContext, AgentOutcome, Plugin } from '@ax/core';

const PLUGIN_NAME = '@ax/audit-log';

/**
 * Mirror of @ax/credential-proxy's HttpEgressEvent payload. Duplicated
 * structurally per I2 (audit-log doesn't import from credential-proxy
 * — the contract is the bus, not the type).
 */
interface HttpEgressEvent {
  sessionId: string;
  userId: string;
  method: string;
  host: string;
  path: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  credentialInjected: boolean;
  classification: 'llm' | 'mcp' | 'other';
  blockedReason?: 'allowlist' | 'private-ip' | 'canary' | 'tls-error';
  timestamp: number;
}

export function auditLogPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['storage:set'],
      subscribes: ['chat:end', 'event.http-egress'],
    },
    init({ bus }) {
      bus.subscribe<{ outcome: AgentOutcome }>(
        'chat:end',
        PLUGIN_NAME,
        async (ctx: AgentContext, payload) => {
          const record = {
            reqId: ctx.reqId,
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
            userId: ctx.userId,
            outcome: payload.outcome,
            timestamp: new Date().toISOString(),
          };
          const value = new TextEncoder().encode(JSON.stringify(record));
          await bus.call('storage:set', ctx, { key: `chat:${ctx.reqId}`, value });
          return undefined;
        },
      );

      // Phase 2 — credential-proxy fires event.http-egress per request
      // (success, block, or upstream error). Persist one row per egress
      // keyed by sessionId + timestamp so the admin's audit view can
      // reconstruct what crossed the proxy boundary.
      //
      // Pass-through (returns undefined): subscribers don't veto egress
      // events; the proxy already decided whether to block at request
      // time and stamped `blockedReason` accordingly.
      bus.subscribe<HttpEgressEvent>(
        'event.http-egress',
        PLUGIN_NAME,
        async (ctx: AgentContext, payload) => {
          // sessionId may be empty when the request hit the listener
          // before any per-session config matched (allowlist miss with
          // no owner). Key by 'unscoped' in that case so the row still
          // lands; the caller can join on host/timestamp post-hoc.
          //
          // Append a UUID suffix so two egress events that fall in the
          // same millisecond (an LLM call + an MCP call concurrently, or
          // any high-throughput burst) don't overwrite each other.
          // payload.timestamp gives natural sort order; the UUID just
          // breaks ties.
          const scope = payload.sessionId.length > 0 ? payload.sessionId : 'unscoped';
          const key = `egress:${scope}:${payload.timestamp}:${randomUUID()}`;
          const value = new TextEncoder().encode(JSON.stringify(payload));
          await bus.call('storage:set', ctx, { key, value });
          return undefined;
        },
      );
    },
  };
}
