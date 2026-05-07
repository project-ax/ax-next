import { type Plugin, PluginError } from '@ax/core';
import { createPendingStore, type PendingEntryInput } from './state.js';

const PLUGIN_NAME = '@ax/credentials-oauth-pending';

// ---------------------------------------------------------------------------
// @ax/credentials-oauth-pending
//
// In-memory holder for the OAuth web-paste flow's intermediate state.
// Registers two services:
//
//   credentials:oauth:stash-pending  → returns { pendingId }
//   credentials:oauth:claim-pending  → returns { entry }   (single-use)
//
// SINGLE-REPLICA ONLY: in-memory state means a different replica won't
// see the pending entry. Multi-replica deployments need either (a)
// sticky sessions for 5min, or (b) a DB-backed sibling plugin that
// registers the same hook surface. The plugin is conditionally loaded
// by the k8s preset whenever credentialsAdmin is on; multi-replica
// operators who want OAuth can skip that load and supply their own.
// ---------------------------------------------------------------------------

export interface CredentialsOauthPendingConfig {
  /** Default 5 minutes — long enough for a sign-in round-trip, short
   *  enough that a stolen pendingId can't sit around. */
  ttlMs?: number;
  /** Default 1000 — caps memory if a misbehaving client floods /start. */
  capacity?: number;
}

export function createCredentialsOauthPendingPlugin(
  opts: CredentialsOauthPendingConfig = {},
): Plugin {
  const store = createPendingStore({
    ttlMs: opts.ttlMs ?? 5 * 60 * 1000,
    capacity: opts.capacity ?? 1000,
  });
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'credentials:oauth:stash-pending',
        'credentials:oauth:claim-pending',
      ],
      calls: [],
      subscribes: [],
    },

    async init({ bus }) {
      bus.registerService<PendingEntryInput, { pendingId: string }>(
        'credentials:oauth:stash-pending',
        PLUGIN_NAME,
        async (_ctx, input) => {
          // Defensive shape check. Route layer already zod-validates, but
          // this hook is the abstract surface; another caller could pass
          // anything that fits the type.
          if (
            typeof input.codeVerifier !== 'string' ||
            typeof input.state !== 'string' ||
            typeof input.userId !== 'string' ||
            typeof input.ref !== 'string' ||
            typeof input.kind !== 'string'
          ) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'codeVerifier/state/userId/ref/kind must be strings',
            });
          }
          return { pendingId: store.stash(input) };
        },
      );

      bus.registerService<
        { pendingId: string; expectedUserId: string },
        { entry: PendingEntryInput | undefined }
      >(
        'credentials:oauth:claim-pending',
        PLUGIN_NAME,
        async (_ctx, input) => {
          if (
            typeof input.pendingId !== 'string' ||
            typeof input.expectedUserId !== 'string'
          ) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'pendingId and expectedUserId required',
            });
          }
          const entry = store.claim(input.pendingId, input.expectedUserId);
          if (entry === undefined) return { entry: undefined };
          // Strip expiresAt before returning — caller doesn't need it.
          const { expiresAt: _e, ...rest } = entry;
          void _e;
          return { entry: rest };
        },
      );
    },
  };
}
