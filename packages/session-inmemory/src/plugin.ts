import { PluginError, type Plugin } from '@ax/core';
import { createInbox } from './inbox.js';
import { createSessionStore, UNKNOWN_SESSION } from './store.js';
import type {
  AgentConfig,
  InboxEntry,
  SessionClaimWorkInput,
  SessionClaimWorkOutput,
  SessionCreateInput,
  SessionCreateOutput,
  SessionGetConfigInput,
  SessionGetConfigOutput,
  SessionQueueWorkInput,
  SessionQueueWorkOutput,
  SessionResolveTokenInput,
  SessionResolveTokenOutput,
  SessionTerminateInput,
  SessionTerminateOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/session-inmemory';

// ---------------------------------------------------------------------------
// @ax/session-inmemory
//
// In-memory session store + per-session long-poll inbox. Registers five
// service hooks (see manifest below). Pure-kernel — the postgres impl in
// Week 7–9 must implement the exact same hook contract; no postgres / sqlite
// vocabulary leaks into these payloads.
//
// The IPC server (Task 3/4) is what actually speaks wire protocol — this
// plugin only talks to its peers through the bus.
// ---------------------------------------------------------------------------

function requireString(
  value: unknown,
  field: string,
  hookName: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'${field}' must be a non-empty string`,
    });
  }
}

// ---------------------------------------------------------------------------
// validateOwner — runs at session:create time on the optional `owner`
// field. We require the full triple (no half-set owners) because a
// session that's "kind of" owned is exactly the bug I10 is meant to
// prevent. allowedTools / mcpConfigIds are bounded but not deduped here —
// the agents plugin already validated those at the agent's create/update
// time; this is a defensive shape check, not a re-validation.
// ---------------------------------------------------------------------------
function validateOwner(
  raw: unknown,
  hookName: string,
): { userId: string; agentId: string; agentConfig: AgentConfig } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'owner' must be an object when present`,
    });
  }
  const userId = (raw as { userId?: unknown }).userId;
  const agentId = (raw as { agentId?: unknown }).agentId;
  const agentConfig = (raw as { agentConfig?: unknown }).agentConfig;
  requireString(userId, 'owner.userId', hookName);
  requireString(agentId, 'owner.agentId', hookName);
  if (typeof agentConfig !== 'object' || agentConfig === null) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'owner.agentConfig' must be an object`,
    });
  }
  const cfg = agentConfig as Record<string, unknown>;
  requireString(cfg.systemPrompt, 'owner.agentConfig.systemPrompt', hookName);
  requireString(cfg.model, 'owner.agentConfig.model', hookName);
  if (!Array.isArray(cfg.allowedTools) || !cfg.allowedTools.every((t) => typeof t === 'string')) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'owner.agentConfig.allowedTools' must be a string[]`,
    });
  }
  if (!Array.isArray(cfg.mcpConfigIds) || !cfg.mcpConfigIds.every((t) => typeof t === 'string')) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'owner.agentConfig.mcpConfigIds' must be a string[]`,
    });
  }
  return {
    userId,
    agentId,
    agentConfig: {
      systemPrompt: cfg.systemPrompt as string,
      allowedTools: cfg.allowedTools as string[],
      mcpConfigIds: cfg.mcpConfigIds as string[],
      model: cfg.model as string,
    },
  };
}

function requireNonNegativeInt(
  value: unknown,
  field: string,
  hookName: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'${field}' must be a non-negative integer`,
    });
  }
}

const VALID_ROLES = new Set(['user', 'assistant', 'system']);

function requireInboxEntry(
  value: unknown,
  hookName: string,
): asserts value is InboxEntry {
  if (typeof value !== 'object' || value === null) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'entry' must be an object`,
    });
  }
  const type = (value as { type?: unknown }).type;
  if (type === 'user-message') {
    const payload = (value as { payload?: unknown }).payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof (payload as { content?: unknown }).content !== 'string'
    ) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName,
        message: `'entry.payload' must be a ChatMessage`,
      });
    }
    // Enforce the ChatMessage role enum at runtime, not just at the type
    // level — this hook is a trust boundary (the IPC server will feed
    // untrusted wire payloads through here once Task 3 lands).
    const role = (payload as { role?: unknown }).role;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName,
        message: `'entry.payload.role' must be 'user' | 'assistant' | 'system'`,
      });
    }
    return;
  }
  if (type === 'cancel') return;
  throw new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    hookName,
    message: `'entry.type' must be 'user-message' or 'cancel'`,
  });
}

export function createSessionInmemoryPlugin(): Plugin {
  const store = createSessionStore();
  const inbox = createInbox();

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'session:create',
        'session:resolve-token',
        'session:get-config',
        'session:queue-work',
        'session:claim-work',
        'session:terminate',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      // ----- session:create -----
      bus.registerService<SessionCreateInput, SessionCreateOutput>(
        'session:create',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'session:create';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          const workspaceRoot = (input as { workspaceRoot?: unknown })?.workspaceRoot;
          const owner = (input as { owner?: unknown })?.owner;
          requireString(sessionId, 'sessionId', hookName);
          requireString(workspaceRoot, 'workspaceRoot', hookName);
          const validated = validateOwner(owner, hookName);
          const record = store.create(sessionId, workspaceRoot, validated);
          return { sessionId: record.sessionId, token: record.token };
        },
      );

      // ----- session:resolve-token -----
      bus.registerService<SessionResolveTokenInput, SessionResolveTokenOutput>(
        'session:resolve-token',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'session:resolve-token';
          const token = (input as { token?: unknown })?.token;
          requireString(token, 'token', hookName);
          return store.resolveToken(token);
        },
      );

      // ----- session:get-config -----
      //
      // The runner calls this at boot via IPC. The IPC server's authenticate()
      // resolved the runner's bearer token to a sessionId and stamped that
      // onto ctx.sessionId — we read it here. There is intentionally NO
      // sessionId in the input; closing that door means a runner can't
      // ask for someone else's config.
      bus.registerService<SessionGetConfigInput, SessionGetConfigOutput>(
        'session:get-config',
        PLUGIN_NAME,
        async (ctx, _input) => {
          const hookName = 'session:get-config';
          requireString(ctx.sessionId, 'ctx.sessionId', hookName);
          const record = store.get(ctx.sessionId);
          if (record === null || record.terminated) {
            throw new PluginError({
              code: UNKNOWN_SESSION,
              plugin: PLUGIN_NAME,
              hookName,
              message: `session '${ctx.sessionId}' does not exist or has been terminated`,
            });
          }
          if (
            record.userId === null ||
            record.agentId === null ||
            record.agentConfig === null
          ) {
            // Pre-9.5 session OR a session minted by a non-orchestrator
            // path. Either way, there's no agent config to hand back —
            // refuse explicitly. The runner treats this as a hard boot
            // error (it has no system prompt to use).
            throw new PluginError({
              code: 'owner-missing',
              plugin: PLUGIN_NAME,
              hookName,
              message: `session '${ctx.sessionId}' has no owner — minted before Week 9.5 or by a non-orchestrator caller`,
            });
          }
          return {
            userId: record.userId,
            agentId: record.agentId,
            agentConfig: record.agentConfig,
          };
        },
      );

      // ----- session:queue-work -----
      bus.registerService<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'session:queue-work';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          const entry = (input as { entry?: unknown })?.entry;
          requireString(sessionId, 'sessionId', hookName);
          requireInboxEntry(entry, hookName);
          const record = store.get(sessionId);
          if (record === null || record.terminated) {
            throw new PluginError({
              code: UNKNOWN_SESSION,
              plugin: PLUGIN_NAME,
              hookName,
              message: `session '${sessionId}' does not exist or has been terminated`,
            });
          }
          return inbox.queue(sessionId, entry);
        },
      );

      // ----- session:claim-work -----
      bus.registerService<SessionClaimWorkInput, SessionClaimWorkOutput>(
        'session:claim-work',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'session:claim-work';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          const cursor = (input as { cursor?: unknown })?.cursor;
          const timeoutMs = (input as { timeoutMs?: unknown })?.timeoutMs;
          requireString(sessionId, 'sessionId', hookName);
          requireNonNegativeInt(cursor, 'cursor', hookName);
          requireNonNegativeInt(timeoutMs, 'timeoutMs', hookName);
          const record = store.get(sessionId);
          if (record === null) {
            // Unknown session — distinct from "terminated session". A claim on
            // a terminated-but-known session is allowed; it resolves via the
            // inbox's terminate-wake path as `timeout`.
            throw new PluginError({
              code: UNKNOWN_SESSION,
              plugin: PLUGIN_NAME,
              hookName,
              message: `session '${sessionId}' does not exist`,
            });
          }
          return inbox.claim(sessionId, cursor, timeoutMs);
        },
      );

      // ----- session:terminate -----
      bus.registerService<SessionTerminateInput, SessionTerminateOutput>(
        'session:terminate',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'session:terminate';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          requireString(sessionId, 'sessionId', hookName);
          // Idempotent: no-op on unknown or already-terminated sessions.
          store.terminate(sessionId);
          // Wake any in-flight claims for this session; they'll see terminated
          // and resolve as `timeout` with echo cursor.
          inbox.terminate(sessionId);
          return {};
        },
      );
    },
  };
}
