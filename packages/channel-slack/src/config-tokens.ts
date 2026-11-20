import type { Logger } from '@ax/core';
import { logCode } from './log-code.js';
import type { SecretOwner, SecretStore } from './secrets.js';
import type { InstallRow, InstallStore } from './store.js';

/**
 * A person's configuration refresh token (TASK-1175): how the tokens that
 * installs held before it move to their person, and when a person's goes.
 *
 * Since TASK-1175, each AX user has one configuration token, under
 * `slack:person:<userId>:config-refresh-token` (secrets.ts), shared by every
 * Slack app they made through AX. Before it, each install held its own, under
 * `slack:<installId>:config-refresh-token`.
 *
 * `moveConfigTokens` moves those to their person, once, at boot, before any
 * route that uses a token is registered (decisions shard
 * `.claude/memory/decisions/2026-11-20-TASK-1175.md`, row 9). It takes each
 * person's installs, newest token first (`store.list()` orders them by when
 * each install's token was added), and reads every install's old token. If
 * the person has no token of their own yet, the newest old one becomes
 * theirs. Then every old one is deleted.
 *   - The newest, because the vault keeps no write time, and with one token
 *     per person only the latest generation (the latest Connect or Replace)
 *     still works: generating a new one revoked the one before.
 *   - A token the person already has is never overwritten. After a boot whose
 *     delete failed, the old row is a retired original and the person's token
 *     is its successor (a rotate since), so the next boot only drops the row.
 *   - A fault anywhere in a person's group (any read, or the write) skips that
 *     whole person until the next boot: nothing stored, nothing deleted. A
 *     read that fails is no proof there is nothing to read, and the row it
 *     couldn't read may be the newest one.
 *   - It never throws, so it never fails the boot. Its lines carry an install
 *     id, a stage and a code, or counts: never a value or a person's id.
 * The tokens are the vault's rows, so the move goes through `credentials:*`
 * (secrets.ts), not SQL.
 *
 * `releaseConfigToken` deletes a person's token once nothing names them: no
 * install and no leftover app (`store.personHasApps`; the shard's row 8).
 * While anything does, it is kept: it is how that app is changed or deleted.
 * A check that fails keeps it too, because a live app stranded without its
 * token is worse than a token kept a little longer. It runs after whatever
 * stopped naming the person is gone, and in the admin routes, under the admin
 * lock. It never throws: the secret store logs a delete that fails.
 */

/**
 * Moves each install's old configuration token to its person (see above).
 * `moved` counts the people it stored a token for; `dropped`, the old copies
 * it didn't store, because the person already had a token or a newer copy
 * won. Every old copy is then deleted; a delete that fails is the secret
 * store's to log.
 */
export async function moveConfigTokens(d: {
  store: Pick<InstallStore, 'list'>;
  secrets: Pick<SecretStore, 'get' | 'remove' | 'getConfigToken' | 'putConfigToken'>;
  logger: Logger;
}): Promise<{ moved: number; dropped: number }> {
  const log = (level: 'info' | 'error', msg: string, fields: Record<string, string | number>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with; the move goes on.
    }
  };
  /** A step that failed: the install when there is one, the stage and a code, never a message. */
  const failed = (stage: string, err: unknown, installId?: string): void => {
    log('error', 'slack_config_token_move_failed', {
      ...(installId !== undefined ? { installId } : {}),
      stage,
      code: logCode(err),
    });
  };

  let installs: InstallRow[];
  try {
    installs = await d.store.list();
  } catch (err) {
    failed('list', err);
    return { moved: 0, dropped: 0 };
  }

  // One group per person, each in list order: the newest token first.
  const people = new Map<string, InstallRow[]>();
  for (const install of installs) {
    const group = people.get(install.connectedByUserId);
    if (group === undefined) people.set(install.connectedByUserId, [install]);
    else group.push(install);
  }

  let moved = 0;
  let dropped = 0;
  for (const group of people.values()) {
    // Each step inside already catches its own fault; this is the backstop
    // that keeps one person's surprise from failing the boot or skipping the rest.
    try {
      const done = await movePerson(d.secrets, group, failed);
      moved += done.moved;
      dropped += done.dropped;
    } catch (err) {
      failed('move', err, group[0]!.installId);
    }
  }
  if (moved + dropped > 0) log('info', 'slack_config_tokens_moved', { moved, dropped });
  return { moved, dropped };
}

/** One person's installs, newest token first. A fault is logged, and moves and deletes nothing. */
async function movePerson(
  secrets: Pick<SecretStore, 'get' | 'remove' | 'getConfigToken' | 'putConfigToken'>,
  installs: InstallRow[],
  failed: (stage: string, err: unknown, installId: string) => void,
): Promise<{ moved: number; dropped: number }> {
  const none = { moved: 0, dropped: 0 };

  const olds: Array<{ install: InstallRow; token: string }> = [];
  for (const install of installs) {
    let token: string | null;
    try {
      token = await secrets.get(install, 'config-refresh-token');
    } catch (err) {
      failed('read-install-token', err, install.installId);
      return none;
    }
    if (token !== null) olds.push({ install, token });
  }
  const newest = olds[0];
  if (newest === undefined) return none;

  let has: boolean;
  try {
    has = (await secrets.getConfigToken(newest.install)) !== null;
  } catch (err) {
    // A person id that can't name a ref lands here too (`invalid-person-id`).
    failed('read-person-token', err, newest.install.installId);
    return none;
  }
  if (!has) {
    try {
      await secrets.putConfigToken(newest.install, newest.token);
    } catch (err) {
      failed('store-person-token', err, newest.install.installId);
      return none;
    }
  }

  // Only once the person's token is stored, so an old copy is never the last
  // one. `remove` never throws and logs its own failure; the next boot drops
  // whatever stays.
  for (const { install } of olds) await secrets.remove(install, 'config-refresh-token');
  return has ? { moved: 0, dropped: olds.length } : { moved: 1, dropped: olds.length - 1 };
}

/**
 * Deletes `app.connectedByUserId`'s configuration token unless an install or a
 * leftover app still names them (see above); `app.installId` only names the
 * app in the secret store's log line. A check that fails keeps the token and
 * is handed to `onFault`. With `onlyIfStored` (a reset), the token is read
 * first and deleted only when it is there or can't be read: the vault deletes
 * by writing an empty row, and a reset leaves no rows behind.
 */
export async function releaseConfigToken(
  d: {
    store: Pick<InstallStore, 'personHasApps'>;
    secrets: Pick<SecretStore, 'getConfigToken' | 'removeConfigToken'>;
  },
  app: SecretOwner,
  o: { onFault: (err: unknown) => void; onlyIfStored?: boolean },
): Promise<void> {
  try {
    if (await d.store.personHasApps(app.connectedByUserId)) return;
  } catch (err) {
    try {
      o.onFault(err);
    } catch {
      // Nothing left to report it with; the token is kept either way.
    }
    return;
  }
  if (o.onlyIfStored === true) {
    let stored = true;
    try {
      stored = (await d.secrets.getConfigToken(app)) !== null;
    } catch {
      // A read that fails is no proof it is gone: delete it.
    }
    if (!stored) return;
  }
  await d.secrets.removeConfigToken(app);
}
