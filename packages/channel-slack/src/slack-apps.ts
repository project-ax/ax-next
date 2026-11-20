import { createHash } from 'node:crypto';
import type { Logger } from '@ax/core';
import { releaseConfigToken } from './config-tokens.js';
import type { ParsedIcon } from './icon.js';
import { OAUTH_STATE_BYTES, OAUTH_STATE_TTL_MS, SLACK_TOKEN_MAX } from './limits.js';
import { logCode } from './log-code.js';
import { buildInstallUrl } from './manifest.js';
import type { SecretOwner, SecretStore } from './secrets.js';
import { SlackApiError, type OAuthInstall, type SlackApi } from './slack-api.js';
import type { InstallRow, InstallStore } from './store.js';

/**
 * The Slack-app steps Admin › Slack and a team agent's own bot share
 * (TASK-1167): constants, the pasted-token checks, and the steps that make,
 * finish and take back a Slack app. They moved here from admin-routes.ts
 * without a change in behaviour, so that one copy of the credential rules
 * serves both:
 *   - a refresh token a rotate mints is saved as its person's token BEFORE
 *     the access token it came with is used (`saveRotatedToken`);
 *   - a person's token is released only once nothing names them (`release`);
 *   - an app Slack won't delete is remembered with its row, never forgotten
 *     (`undoConnect`, `deleteSlackApp`).
 *
 * Every step that uses a configuration token runs under the caller's app lock
 * (the one plugin.ts creates, shared by Admin › Slack and the team bots):
 * none of them takes it, and none may be called without it. Log lines are code-only: an install id, a stage, a code. Never
 * a token, a person's id or a Slack id other than the install's.
 */

export const ACCESS_TOKEN_PREFIX = 'xoxe.xoxp-';
export const REFRESH_TOKEN_PREFIX = 'xoxe-';
/** A pasted configuration token's characters (`xoxe.xoxp-1-…`, `xoxe-1-…`). */
const CONFIG_TOKEN_CHARS = /^[A-Za-z0-9._-]+$/;
export const STATE_RE = new RegExp(`^[0-9a-f]{${OAUTH_STATE_BYTES * 2}}$`);
/**
 * Slack's OAuth code (digits, dots and hex today). Any printable ASCII is let
 * through, bounded: it only ever travels form-encoded, to Slack.
 */
export const OAUTH_CODE_RE = new RegExp(`^[\\x21-\\x7e]{1,${SLACK_TOKEN_MAX}}$`);
/** What Slack's `apps.manifest.*` methods say when a configuration access token is no good. */
export const TOKEN_ERRORS: ReadonlySet<string> = new Set([
  'invalid_auth',
  'not_authed',
  'token_expired',
  'token_revoked',
  'account_inactive',
]);
/**
 * Slack refusing a configuration refresh token itself at rotate, which no
 * retry fixes: TOKEN_ERRORS, or `invalid_refresh_token` (revoked on Slack's
 * page, or retired by Slack after a rotate whose new token wasn't kept).
 */
export const REFRESH_TOKEN_REFUSED: ReadonlySet<string> = new Set([...TOKEN_ERRORS, 'invalid_refresh_token']);
/**
 * `apps.manifest.create` failures where Slack may have made the app anyway:
 * we never got its answer (`timeout`, `network`, a 5xx from its edge), or
 * couldn't read the one we got (`bad-response`, `too-large`). slack-api.ts
 * names these codes.
 */
export const UNCONFIRMED_CODES: ReadonlySet<string> = new Set(['timeout', 'network', 'bad-response', 'too-large']);
export const HTTP_5XX = /^http-5\d\d$/;

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function isHttps(origin: string): boolean {
  try {
    return new URL(origin).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The body as a JSON object, or null when it is anything else. */
export function bodyObject(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(utf8.decode(body));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** A pasted configuration token of the kind `prefix` names, or null. */
export function configToken(value: unknown, prefix: string): string | null {
  return typeof value === 'string' &&
    value.length > prefix.length &&
    value.length <= SLACK_TOKEN_MAX &&
    value.startsWith(prefix) &&
    CONFIG_TOKEN_CHARS.test(value)
    ? value
    : null;
}

/**
 * What an `apps.manifest.create` failure tells the admin. `slack-unconfirmed`
 * means an app may exist on Slack's side that we never heard about (no app id,
 * so nothing here can delete it): the admin is told to check Slack's app list
 * before retrying, or a retry leaves a second app behind.
 */
export function createAppError(err: unknown): 'slack-token' | 'slack-name' | 'slack-unconfirmed' | 'slack-error' {
  if (!(err instanceof SlackApiError)) return 'slack-error';
  if (TOKEN_ERRORS.has(err.code)) return 'slack-token';
  if (err.code === 'invalid_manifest') return 'slack-name';
  return UNCONFIRMED_CODES.has(err.code) || HTTP_5XX.test(err.code) ? 'slack-unconfirmed' : 'slack-error';
}

/**
 * What a failed try of the pasted refresh token at Connect tells the admin.
 * `slack-refresh-token`: Slack refused the token itself, so only a new pair
 * helps. Anything else is `slack-error`: Slack may or may not have spent the
 * token, and a retry soon after works while Slack still honours it.
 */
export function refreshTokenError(err: unknown): 'slack-refresh-token' | 'slack-error' {
  return err instanceof SlackApiError && REFRESH_TOKEN_REFUSED.has(err.code) ? 'slack-refresh-token' : 'slack-error';
}

/** Where Slack sends the person back after Allow, and the scopes the install link asks for. */
export interface InstallLink {
  redirectUrl: string;
  scopes: readonly string[];
}

export interface AppStepsDeps {
  store: Pick<InstallStore, 'setOAuthState' | 'remove' | 'rememberLeftoverApp' | 'activate' | 'personHasApps'>;
  secrets: SecretStore;
  api: SlackApi;
  logger: Logger;
  /** Epoch milliseconds. */
  now: () => number;
  randomBytes: (n: number) => Buffer;
  /** Every step-failure line is `${logPrefix}_failed`: admin passes 'slack_admin', so its lines are unchanged. */
  logPrefix: 'slack_admin' | 'slack_bot';
}

export interface AppSteps {
  /** A failed step. Slack refusing is a warning (the default); our own store or vault failing is an error. */
  failed(stage: string, err: unknown, installId?: string, level?: 'warn' | 'error'): void;
  /**
   * A fresh OAuth state for a pending install, bound to `userId`, and the
   * Slack link that carries it. Any earlier state for the install stops
   * matching. Throws InstallStoreError when the install isn't pending.
   */
  mintInstallUrl(installId: string, clientId: string, userId: string, link: InstallLink): Promise<string>;
  /**
   * The bot's picture, best-effort: true only when Slack took it. None sent
   * (`null`: the browser had none to draw): Slack isn't asked and nothing is
   * logged. One icon.ts refused: never sent, one warning naming why. Slack
   * refusing it, or not answering: one warning with its code. Never throws,
   * so it never fails a Connect.
   */
  setIcon(accessToken: string, appId: string, installId: string, icon: ParsedIcon | null): Promise<boolean>;
  /**
   * A person's configuration token goes once no install and no leftover app
   * names them (config-tokens.ts, TASK-1175). The caller holds the app lock.
   * A check that fails keeps the token, and is logged here, code-only. Never
   * throws: the secret store logs a delete that fails. Answers `'kept'` when
   * the token stayed (something still names the person, or the check failed)
   * and `'released'` when it went (or none was stored).
   */
  release(app: SecretOwner): Promise<'kept' | 'released'>;
  /**
   * Keep the refresh token a rotate just minted as `app.connectedByUserId`'s
   * token, in place of the one it was minted from (TASK-1175: that one slot
   * serves every app of theirs). Slack retires a rotated refresh token within
   * minutes to hours (slack-api.ts), so without this the person's
   * configuration token dies after its first use. True when stored. A
   * failure is logged here, code-only, and the stored token then works only
   * until Slack retires it.
   */
  saveRotatedToken(app: SecretOwner, refreshToken: string): Promise<boolean>;
  /**
   * Delete the Slack app with an access token minted from its person's
   * stored refresh token. The minted token is used once. True when the app
   * is gone: deleted now, or already deleted on Slack's side
   * (`app_not_found`, say from api.slack.com/apps), which is what the caller
   * wanted anyway.
   *
   * The new refresh token is stored first, for the retry the caller keeps the
   * token for when the row won't delete. If that store fails, the app is
   * still deleted with the token in hand.
   */
  deleteSlackApp(install: InstallRow): Promise<boolean>;
  /**
   * A request failed after Slack made the app: take all of it back, so
   * nothing is left half-made. Each step is best-effort and logged. Deleting
   * the app needs a configuration access token, and the caller still has it.
   * If Slack won't delete it, the app goes onto the leftover list naming the
   * owner, so the next Connect or Replace deletes it. The row's delete always
   * runs and moves the app with it, as Disconnect does: an insert can commit
   * and still answer with an error, so "insertPending threw" is no proof
   * there is no row. Only when the insert never returned (`rowStored` false)
   * is the app also remembered directly; an id the delete just moved keeps
   * its first entry (ON CONFLICT DO NOTHING). Once the row surely exists, a
   * delete that fails remembers nothing: the row still names the app, so it
   * is never in both tables. Last, the owner's token goes too, unless an
   * install or a leftover app (that one included) still names them.
   */
  undoConnect(
    accessToken: string,
    appId: string,
    owner: SecretOwner,
    botName: string,
    rowStored: boolean,
  ): Promise<void>;
  /**
   * The install's client secret, then `oauth.v2.access`, then the checks that
   * the answer is for OUR app and isn't org-wide. Logs `oauth-access` itself;
   * the caller logs the other refusals. A vault fault throws.
   */
  exchangeCode(
    install: InstallRow,
    code: string,
    redirectUrl: string,
  ): Promise<
    | { ok: true; granted: OAuthInstall }
    | { ok: false; reason: 'no-client-secret' | 'oauth-access' | 'app-mismatch' | 'enterprise-install' }
  >;
  /**
   * The bot token first (an active install must always have one), then
   * activate, with `installedAt` = now. On failure, logs the stage and
   * removes the bot token. True when stored and active.
   */
  storeGrant(install: InstallRow, granted: OAuthInstall): Promise<boolean>;
}

/**
 * Every bot name already spoken for: the shared install's name, then each
 * team bot's name and stored handle, then each open bot request's name
 * (TASK-1169: a request holds its name until it is approved or taken back,
 * so the approve can't lose it to a later bot). `except` leaves out one
 * install or one open request, by its id (both are 22 random base64url
 * characters, so the two never collide): a rename can keep or vary its own
 * name, and an approve its own request's.
 */
export async function namesInUse(
  store: Pick<InstallStore, 'current' | 'listBots' | 'listBotRequests'>,
  o: { except?: string } = {},
): Promise<string[]> {
  const out: string[] = [];
  const shared = await store.current();
  if (shared !== null && shared.installId !== o.except) out.push(shared.botName);
  for (const bot of await store.listBots()) {
    if (bot.installId === o.except) continue;
    out.push(bot.botName);
    if (bot.botHandle !== null) out.push(bot.botHandle);
  }
  for (const request of await store.listBotRequests()) {
    if (request.requestId !== o.except) out.push(request.botName);
  }
  return out;
}

export function createAppSteps(d: AppStepsDeps): AppSteps {
  const failedLine = `${d.logPrefix}_failed`;

  const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, string | boolean>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };

  function failed(
    stage: string,
    err: unknown,
    installId?: string,
    level: 'warn' | 'error' = err instanceof SlackApiError ? 'warn' : 'error',
  ): void {
    log(level, failedLine, {
      ...(installId !== undefined ? { installId } : {}),
      stage,
      code: logCode(err),
    });
  }

  async function mintInstallUrl(
    installId: string,
    clientId: string,
    userId: string,
    link: InstallLink,
  ): Promise<string> {
    const state = d.randomBytes(OAUTH_STATE_BYTES).toString('hex');
    await d.store.setOAuthState(installId, {
      stateHash: sha256Hex(state),
      userId,
      expiresAt: new Date(d.now() + OAUTH_STATE_TTL_MS),
    });
    return buildInstallUrl({ clientId, redirectUrl: link.redirectUrl, scopes: link.scopes, state });
  }

  async function setIcon(
    accessToken: string,
    appId: string,
    installId: string,
    icon: ParsedIcon | null,
  ): Promise<boolean> {
    if (icon === null) return false;
    if (!icon.ok) {
      log('warn', failedLine, { installId, stage: 'icon', code: icon.code });
      return false;
    }
    try {
      await d.api.setAppIcon(accessToken, appId, icon.png);
      return true;
    } catch (err) {
      failed('icon', err, installId);
      return false;
    }
  }

  function release(app: SecretOwner): Promise<'kept' | 'released'> {
    return releaseConfigToken({ store: d.store, secrets: d.secrets }, app, {
      onFault: (err) => failed('release-config-token', err, app.installId),
    });
  }

  async function saveRotatedToken(app: SecretOwner, refreshToken: string): Promise<boolean> {
    try {
      await d.secrets.putConfigToken(app, refreshToken);
      return true;
    } catch (err) {
      failed('save-config-token', err, app.installId);
      return false;
    }
  }

  async function deleteSlackApp(install: InstallRow): Promise<boolean> {
    let stage = 'config-token';
    try {
      const refreshToken = await d.secrets.getConfigToken(install);
      if (refreshToken === null) {
        log('warn', failedLine, { installId: install.installId, stage, code: 'missing' });
        return false;
      }
      stage = 'rotate';
      const minted = await d.api.rotateConfigToken(refreshToken);
      // Whether it was stored doesn't change what happens next: it is logged.
      await saveRotatedToken(install, minted.refreshToken);
      stage = 'delete-app';
      await d.api.deleteApp(minted.accessToken, install.appId);
      return true;
    } catch (err) {
      if (stage === 'delete-app' && err instanceof SlackApiError && err.code === 'app_not_found') return true;
      failed(stage, err, install.installId);
      return false;
    }
  }

  async function undoConnect(
    accessToken: string,
    appId: string,
    owner: SecretOwner,
    botName: string,
    rowStored: boolean,
  ): Promise<void> {
    let appLeft = false;
    try {
      await d.api.deleteApp(accessToken, appId);
    } catch (err) {
      // Already gone on Slack's side is what the undo wanted.
      if (!(err instanceof SlackApiError && err.code === 'app_not_found')) {
        appLeft = true;
        failed('undo-delete-app', err, owner.installId);
      }
    }
    try {
      await d.store.remove(owner.installId, { appLeft });
    } catch (err) {
      failed('undo-remove', err, owner.installId);
    }
    if (appLeft && !rowStored) {
      try {
        await d.store.rememberLeftoverApp({
          installId: owner.installId,
          appId,
          botName,
          connectedByUserId: owner.connectedByUserId,
        });
      } catch (err) {
        failed('remember-leftover-app', err, owner.installId);
      }
    }
    await d.secrets.removeAll(owner);
    await release(owner);
  }

  async function exchangeCode(
    install: InstallRow,
    code: string,
    redirectUrl: string,
  ): Promise<
    | { ok: true; granted: OAuthInstall }
    | { ok: false; reason: 'no-client-secret' | 'oauth-access' | 'app-mismatch' | 'enterprise-install' }
  > {
    const clientSecret = await d.secrets.get(install, 'client-secret');
    if (clientSecret === null) return { ok: false, reason: 'no-client-secret' };

    let granted: OAuthInstall;
    try {
      granted = await d.api.oauthAccess({
        clientId: install.clientId,
        clientSecret,
        code,
        // Exactly the one in the manifest and the install link, or Slack refuses.
        redirectUri: redirectUrl,
      });
    } catch (err) {
      failed('oauth-access', err, install.installId);
      return { ok: false, reason: 'oauth-access' };
    }
    // The code came back to OUR callback with OUR state, so it must be our
    // app. Anything else, or an org-wide install, and the token isn't one we
    // should hold.
    if (granted.appId !== install.appId) return { ok: false, reason: 'app-mismatch' };
    if (granted.enterpriseInstall) return { ok: false, reason: 'enterprise-install' };
    return { ok: true, granted };
  }

  async function storeGrant(install: InstallRow, granted: OAuthInstall): Promise<boolean> {
    // The token first: an active install must always have one.
    let stage = 'bot-token';
    try {
      await d.secrets.put(install, 'bot-token', granted.botToken);
      stage = 'activate';
      await d.store.activate(install.installId, {
        teamId: granted.teamId,
        teamName: granted.teamName,
        botUserId: granted.botUserId,
        installedAt: new Date(d.now()),
      });
      return true;
    } catch (err) {
      failed(stage, err, install.installId);
      await d.secrets.remove(install, 'bot-token');
      return false;
    }
  }

  return {
    failed,
    mintInstallUrl,
    setIcon,
    release,
    saveRotatedToken,
    deleteSlackApp,
    undoConnect,
    exchangeCode,
    storeGrant,
  };
}
