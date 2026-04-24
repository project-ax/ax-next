import { PluginError, type Plugin } from '@ax/core';
import { createInbox } from './inbox.js';
import { createSessionStore, UNKNOWN_SESSION } from './store.js';
import type {
  InboxEntry,
  SessionClaimWorkInput,
  SessionClaimWorkOutput,
  SessionCreateInput,
  SessionCreateOutput,
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
      typeof (payload as { role?: unknown }).role !== 'string' ||
      typeof (payload as { content?: unknown }).content !== 'string'
    ) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName,
        message: `'entry.payload' must be a ChatMessage`,
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
          requireString(sessionId, 'sessionId', hookName);
          requireString(workspaceRoot, 'workspaceRoot', hookName);
          const record = store.create(sessionId, workspaceRoot);
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
