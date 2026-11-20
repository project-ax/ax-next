import {
  PluginError,
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type Logger,
} from '@ax/core';
import { logCode } from './log-code.js';

/**
 * channel-slack's secrets, kept in the credentials vault (design §3), never
 * in channel-slack's own table. Each is one global row (`scope: 'global'`,
 * `ownerId: null`) of kind `api-key`, which the vault hands back as UTF-8
 * text. There are two kinds:
 *
 *   - three per install, under `slack:<installId>:<name>`: the bot token, the
 *     signing secret and the client secret;
 *   - one per PERSON (TASK-1175), under
 *     `slack:person:<userId>:config-refresh-token`: an AX user's
 *     configuration refresh token, shared by every Slack app they made
 *     through AX.
 *
 * Why per person: only the token of whoever created a Slack app can change or
 * delete it, and Slack lets each person hold one configuration token per
 * workspace (design §8 Q5, measured). So every app a person made (an install
 * names them in `connectedByUserId`, and so does a leftover app's row) goes
 * through their one token. The successor each rotate mints is written back
 * to that one slot, so all of their apps keep working.
 *
 * Reads ask for the GLOBAL row only (`credentials:get`'s `scope: 'global'`),
 * so nothing a person or an agent stored under the same ref can stand in. A
 * user-scoped `slack:<id>:signing-secret` would otherwise shadow the real one
 * and let whoever planted it sign events, and a planted configuration token
 * would be handed to Slack as someone's own. A read still names a person,
 * because the hook requires a userId: an install's secrets are read as the
 * person whose configuration token made it, and a person's token as that
 * person, who also writes and deletes it. The ctx's `agentId` is `''`: a
 * non-empty one that isn't an agent id makes the store throw.
 *
 * Why the person is IN the ref: on a global-only read the vault tries one
 * row, `{ scope: 'global', ownerId: null, ref }` (`findRow` in
 * @ax/credentials' plugin.ts), and the read's `userId` gates only `account:`
 * refs. A global row is keyed by its ref alone, so who is named never
 * changes which row is read. Only the ref can tell one person's token from
 * another's.
 *
 * The person-id rule (`PERSON_ID_RE`): a letter or digit, then up to 127
 * letters, digits, `_`, `.` or `-`. The vault's user ids may hold `@`, but
 * its refs may not, and a `:` or `/` would make an id look like more than
 * one segment of the ref. Every AX id today fits: better-auth's 32 letters
 * and digits, and the setup admin's `usr_` and hex. For any other id,
 * `configTokenRef` throws `invalid-person-id` (a fixed message, never the
 * id) before anything reaches the vault: that person can hold no token.
 *
 * `SECRET_NAMES` still lists `config-refresh-token`, because before TASK-1175
 * an install kept the token under its own ref. At boot an old row moves to
 * its person, and `removeAll` still deletes one. `put` no longer takes that
 * name, so nothing can store one there again.
 *
 * Nothing in the vault limits which plugin reads a ref, so "only channel-slack
 * reads these" is held by a repo-scan guard on `slack:` strings
 * (scripts/__tests__/channel-slack-boundaries.test.js), not at runtime. No
 * method here returns a value anywhere but to its caller, and no log line
 * carries one, or a person's id: failures log the install and a code.
 *
 * Since TASK-1159, a configuration refresh token stored here is never the
 * one an admin pasted: Connect rotates that one once and stores the refresh
 * token Slack mints with it. Replace (TASK-1128) does the same with a refresh
 * token pasted later, and stores the minted one only after Slack accepted the
 * app's manifest from the access token minted with it. (A token stored
 * before TASK-1159 is still the pasted one until a rotate's new token is
 * kept.) After each later rotate, admin-routes.ts writes the one Slack mints
 * alongside over the person's token, because Slack retires a rotated refresh
 * token within minutes to hours (slack-api.ts). If that write fails, the old
 * one stays, and works only until Slack retires it.
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

/** An AX user id that can name a vault ref, so its person can hold a configuration token. */
export const PERSON_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A person id that can't name a vault ref. Its message is fixed, never the id, so it is safe to log. */
class InvalidPersonIdError extends Error {
  readonly code = 'invalid-person-id';
  constructor() {
    super('channel-slack: refusing a person id that cannot name a vault ref');
    this.name = 'InvalidPersonIdError';
  }
}

/**
 * Where a person's configuration refresh token lives (TASK-1175). Throws
 * `invalid-person-id` for an id outside `PERSON_ID_RE`.
 */
export function configTokenRef(userId: string): string {
  // `typeof` first: a RegExp test reads null as the text "null".
  if (typeof userId !== 'string' || !PERSON_ID_RE.test(userId)) throw new InvalidPersonIdError();
  return `slack:person:${userId}:config-refresh-token`;
}

/**
 * Whose secrets: the install, and the person whose configuration token made
 * it, as whom the vault is read. For a person's own configuration token,
 * `connectedByUserId` picks the token, and `installId` only names the app in
 * a log line.
 */
export interface SecretOwner {
  installId: string;
  connectedByUserId: string;
}

/**
 * An install's own three secrets: every name but the configuration token's,
 * which is a person's (`putConfigToken`) and is never stored under an
 * install again.
 */
type InstallSecretName = Exclude<SecretName, 'config-refresh-token'>;

export interface SecretStore {
  /** Stores one of an install's own three secrets (`InstallSecretName`). */
  put(install: SecretOwner, name: InstallSecretName, value: string): Promise<void>;
  /** The value, or null when none is stored. Any other vault failure rejects. */
  get(install: SecretOwner, name: SecretName): Promise<string | null>;
  /** Deletes one. Logs a failure code-only, never throws. */
  remove(install: { installId: string }, name: SecretName): Promise<void>;
  /**
   * Deletes all four names, the old per-install configuration token too.
   * Tries every one, logs failures code-only, never throws.
   */
  removeAll(install: { installId: string }): Promise<void>;
  /**
   * The configuration refresh token of `app.connectedByUserId`, read from
   * the global row only, as that person. Null when none is stored (or it is
   * empty). Any other vault failure rejects, and so does an id that can't
   * name a ref (`invalid-person-id`), before the vault is asked.
   */
  getConfigToken(app: SecretOwner): Promise<string | null>;
  /** Stores that person's token, as them. An empty value or a bad id is refused before the vault. */
  putConfigToken(app: SecretOwner, value: string): Promise<void>;
  /**
   * Deletes that person's token, as them. Never throws: a failure, a bad id
   * included, is logged at error with the app's installId and a code.
   */
  removeConfigToken(app: SecretOwner): Promise<void>;
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

  /** Stores one global row, as `userId`. */
  const write = async (userId: string, ref: string, value: string): Promise<void> => {
    // An empty key verifies anything signed with an empty key.
    if (value.length === 0) throw new Error('channel-slack: refusing to store an empty secret');
    await bus.call('credentials:set', ctxFor(userId), {
      scope: 'global',
      ownerId: null,
      ref,
      kind: 'api-key',
      payload: new TextEncoder().encode(value),
    });
  };

  /** One global row's value, read as `userId`, or null when none is stored. */
  const read = async (userId: string, ref: string): Promise<string | null> => {
    let value: unknown;
    try {
      value = await bus.call('credentials:get', ctxFor(userId), {
        ref,
        userId,
        // The value stored for everyone, never a row someone stored for themselves.
        scope: 'global',
      });
    } catch (err) {
      if (pluginErrorCode(err) === NOT_FOUND) return null;
      throw err;
    }
    // Fail closed: an empty or non-text value is as good as none.
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  /**
   * Deletes one global row as `ctx`'s user. `refOf` runs inside the try, so a
   * ref that can't be built is logged like any other failed delete. Never
   * throws: a failure is logged with the install, the secret's name and a code.
   */
  const erase = async (
    ctx: AgentContext,
    installId: string,
    name: SecretName,
    refOf: () => string,
  ): Promise<void> => {
    try {
      await bus.call('credentials:delete', ctx, { scope: 'global', ownerId: null, ref: refOf() });
    } catch (err) {
      try {
        const fields = { installId, stage: name, code: logCode(err) };
        // The configuration refresh token is the one secret that outlives the
        // Slack app: left behind, it can still create apps in the workspace,
        // even after Disconnect deleted this one, until someone revokes it on
        // Slack's page.
        if (name === 'config-refresh-token') ctx.logger.error('slack_secret_remove_failed', fields);
        else ctx.logger.warn('slack_secret_remove_failed', fields);
      } catch {
        // Nothing left to report it with; any remaining deletes still run.
      }
    }
  };

  const remove = (install: { installId: string }, name: SecretName): Promise<void> =>
    // Not an admin action of anyone's in particular: it also runs when a
    // Connect fails halfway, before any row exists.
    erase(ctxFor('system'), install.installId, name, () => secretRef(install.installId, name));

  return {
    async put(install, name, value) {
      await write(install.connectedByUserId, secretRef(install.installId, name), value);
    },

    async get(install, name) {
      return read(install.connectedByUserId, secretRef(install.installId, name));
    },

    remove,

    async removeAll(install) {
      for (const name of SECRET_NAMES) await remove(install, name);
    },

    // A person's token is read, written and deleted as that person. The ref is
    // built first, so an id that can't name one never reaches the vault.
    async getConfigToken(app) {
      return read(app.connectedByUserId, configTokenRef(app.connectedByUserId));
    },

    async putConfigToken(app, value) {
      await write(app.connectedByUserId, configTokenRef(app.connectedByUserId), value);
    },

    async removeConfigToken(app) {
      await erase(ctxFor(app.connectedByUserId), app.installId, 'config-refresh-token', () =>
        configTokenRef(app.connectedByUserId),
      );
    },
  };
}
