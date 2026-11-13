import {
  PluginError,
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type Logger,
} from '@ax/core';
import { logCode } from './log-code.js';

/**
 * An install's four secrets, kept in the credentials vault (design §3), never
 * in channel-slack's own table:
 *
 *   ref    `slack:<installId>:<name>`
 *   scope  `global`, `ownerId: null`
 *   kind   `api-key` (the vault hands the stored bytes back as UTF-8 text)
 *
 * Reads ask for the GLOBAL row only (`credentials:get`'s `scope: 'global'`),
 * so nothing a person or an agent stored under the same ref can stand in for
 * an install's secret: a user-scoped `slack:<id>:signing-secret` would
 * otherwise shadow the real one and let whoever planted it sign events. The
 * read still names the admin who connected the install (the hook requires a
 * userId), with a ctx whose `agentId` is `''`: a non-empty one that isn't an
 * agent id makes the store throw.
 *
 * Nothing in the vault limits which plugin reads a ref, so "only channel-slack
 * reads these" is held by a repo-scan guard on `slack:` strings (TASK-1093
 * Task 12), not at runtime. No method here returns a value anywhere but to its
 * caller, and no log line carries one: failures log the install and a code.
 *
 * The configuration refresh token stored here is exactly the one the admin
 * pasted. Rotating mints a new pair, but the client never hands the new
 * refresh token back (slack-api.ts), so nothing can store it.
 */

export const SECRET_NAMES = Object.freeze([
  'bot-token',
  'signing-secret',
  'client-secret',
  'config-refresh-token',
] as const);
export type SecretName = (typeof SECRET_NAMES)[number];

export function secretRef(installId: string, name: SecretName): string {
  return `slack:${installId}:${name}`;
}

/** Whose secrets: the install, and the admin whose id the vault is read as. */
export interface SecretOwner {
  installId: string;
  connectedByUserId: string;
}

export interface SecretStore {
  put(install: SecretOwner, name: SecretName, value: string): Promise<void>;
  /** The value, or null when none is stored. Any other vault failure rejects. */
  get(install: SecretOwner, name: SecretName): Promise<string | null>;
  /** Deletes one. Logs a failure code-only, never throws. */
  remove(install: { installId: string }, name: SecretName): Promise<void>;
  /** Deletes all four. Tries every one, logs failures code-only, never throws. */
  removeAll(install: { installId: string }): Promise<void>;
}

/** The vault's own "nothing stored under this ref" (`@ax/credentials`). */
const NOT_FOUND = 'credential-not-found';
const SESSION = 'channel-slack';

/**
 * A plugin error's code, read without trusting the error: the bus hands a
 * PluginError back as thrown, getters and all, and `instanceof` can run a
 * Proxy's trap. Unreadable means no code, which is never "not found".
 */
function pluginErrorCode(error: unknown): string | undefined {
  try {
    if (!(error instanceof PluginError)) return undefined;
    const code: unknown = error.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

export function createSecretStore(bus: HookBus, opts: { logger?: Logger } = {}): SecretStore {
  const ctxFor = (userId: string): AgentContext =>
    makeAgentContext({
      sessionId: SESSION,
      agentId: '',
      userId,
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });

  const remove = async (install: { installId: string }, name: SecretName): Promise<void> => {
    // Not an admin action of anyone's in particular: it also runs when a
    // Connect fails halfway, before any row exists.
    const ctx = ctxFor('system');
    try {
      await bus.call('credentials:delete', ctx, {
        scope: 'global',
        ownerId: null,
        ref: secretRef(install.installId, name),
      });
    } catch (err) {
      try {
        ctx.logger.warn('slack_secret_remove_failed', {
          installId: install.installId,
          stage: name,
          code: logCode(err),
        });
      } catch {
        // Nothing left to report it with; any remaining deletes still run.
      }
    }
  };

  return {
    async put(install, name, value) {
      // An empty key verifies anything signed with an empty key.
      if (value.length === 0) throw new Error('channel-slack: refusing to store an empty secret');
      await bus.call('credentials:set', ctxFor(install.connectedByUserId), {
        scope: 'global',
        ownerId: null,
        ref: secretRef(install.installId, name),
        kind: 'api-key',
        payload: new TextEncoder().encode(value),
      });
    },

    async get(install, name) {
      let value: unknown;
      try {
        value = await bus.call('credentials:get', ctxFor(install.connectedByUserId), {
          ref: secretRef(install.installId, name),
          userId: install.connectedByUserId,
          // The install's own value, never a row someone stored for themselves.
          scope: 'global',
        });
      } catch (err) {
        if (pluginErrorCode(err) === NOT_FOUND) return null;
        throw err;
      }
      // Fail closed: an empty or non-text value is as good as none.
      return typeof value === 'string' && value.length > 0 ? value : null;
    },

    remove,

    async removeAll(install) {
      for (const name of SECRET_NAMES) await remove(install, name);
    },
  };
}
