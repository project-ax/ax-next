import { createHash } from 'node:crypto';
import { makeAgentContext, type HookBus, type Logger } from '@ax/core';
import { checkAdmin, type AdminActor } from './admin-auth.js';
import { checkBotName, defaultBotName } from './bot-name.js';
import type { RouteRequest, RouteSpec } from './http-types.js';
import { parseIconPng, type ParsedIcon } from './icon.js';
import {
  ADMIN_BODY_MAX_BYTES,
  ADMIN_CONNECT_BODY_MAX_BYTES,
  INSTALL_ID_BYTES,
  OAUTH_STATE_BYTES,
  OAUTH_STATE_TTL_MS,
  SLACK_ID_RE,
  SLACK_TOKEN_MAX,
} from './limits.js';
import { logCode } from './log-code.js';
import { buildAppManifest, buildInstallUrl, slackUrls, withoutTrailingSlashes } from './manifest.js';
import type { Mutex } from './mutex.js';
import { personName } from './person-name.js';
import type { SecretOwner, SecretStore } from './secrets.js';
import {
  SlackApiError,
  type CreatedApp,
  type OAuthInstall,
  type RotatedConfigToken,
  type SlackApi,
} from './slack-api.js';
import { InstallStoreError, type InstallRow, type InstallStore } from './store.js';

/**
 * channel-slack's admin surface: see how Slack stands, connect a workspace,
 * pick an unfinished install back up, rename the bot, replace the
 * configuration token, and disconnect. Plus the OAuth callback Slack sends
 * the admin's browser to after they click Allow.
 *
 *   GET  /admin/slack                 → SlackStatus (every state: with the Slack apps AX made and couldn't delete)
 *   POST /admin/slack/connect         { accessToken, refreshToken, botName?, iconPng? } → { installUrl, iconSet }
 *   POST /admin/slack/install-url     → { installUrl }, only while the install is pending
 *   POST /admin/slack/rename          { botName } → { botName }, only once the install is active
 *   POST /admin/slack/replace-token   { refreshToken } → {}, only once the install is active
 *   POST /admin/slack/disconnect      → { appDeleted }
 *   POST /admin/slack/forget-leftover-app  { appId } → {}, once the admin has deleted that app by hand
 *   GET  /admin/slack/oauth/callback  ?code&state or ?error&state → 302 to `<publicOrigin>/?slack=<outcome>`
 *
 * Every route is admin-only: 401 signed out, 403 not an admin, except that
 * the callback sends a refused browser home instead (below). Every one that
 * changes anything runs under one in-process lock, so two admins can't
 * create two apps, and neither a callback nor a rename can race a
 * disconnect. The POSTs keep http-server's CSRF check; nothing here
 * bypasses it.
 *
 * Secrets:
 *   - The pasted ACCESS token first deletes the Slack apps an earlier
 *     Disconnect couldn't (below), then creates the app and sets its icon
 *     (and, if Connect fails halfway, deletes the app again). Then it is
 *     dropped. It is never stored.
 *   - The pasted REFRESH token is tried once, right after Slack makes the
 *     app: Connect rotates it and stores the refresh token Slack mints in
 *     its place, and never uses that rotate's access token (TASK-1159). If
 *     the rotate fails in any way, no secret is stored and the app goes
 *     again, or onto the leftover list when Slack won't delete it (below), so
 *     an install never starts with a token Slack won't take. No route ever
 *     returns the stored one. Only Disconnect and Rename read it, each to
 *     mint one access token that is used once: Disconnect to delete the
 *     app, Rename to update its manifest. Each rotate also mints a new
 *     refresh token, and Slack retires the old one within minutes to hours
 *     (MEASURED, TASK-1097 walk; slack-api.ts), so the new one replaces it
 *     in the vault BEFORE the access token is used. If that write fails,
 *     Rename stops (a retry soon after may still work with the old token)
 *     and Disconnect deletes the app anyway.
 *   - Replace (TASK-1128) takes a newly pasted REFRESH token, once the
 *     install is active, and tries it once, as Connect does. The access
 *     token that rotate mints first sends Slack the app's whole manifest, as
 *     Rename does: Slack taking it shows the new token's owner can manage
 *     this app. Only then is the minted refresh token stored over the old
 *     one, as the admin replacing it, and the row moved to them; last, the
 *     same access token deletes the leftover apps (below). Nothing reads or
 *     rotates the old token, so any failure before the store leaves the
 *     install as it was; after a replace, the old token stays live on Slack
 *     until whoever generated it revokes it.
 *   - The client secret, signing secret and bot token go to the vault.
 *   - No response body and no log line carries any of them. Log lines name
 *     an install, a stage or reason, a code, and whether Slack deleted an app.
 *
 * The bot's picture is drawn by the admin's browser and arrives as
 * `iconPng`, a base64 PNG (icon.ts checks it). It is uploaded to Slack as it
 * is, and never stored, logged or decoded past its header. A missing or
 * unusable one leaves Slack's default picture and never fails a Connect.
 *
 * Disconnect (and Cancel, the same route) deletes the Slack app with an
 * access token minted from the stored refresh token. When Slack won't (the
 * token is dead or revoked, or Slack doesn't answer), the install still
 * goes, and in the same statement its app's id, name and person (whose
 * token made it, TASK-1175) move to the leftover list (store.ts) instead of
 * being forgotten. Connect's own undo
 * does the same when trying the pasted refresh token fails in any way and
 * Slack then won't delete the app Connect just made: no install row holds
 * that one yet, so it goes straight onto the list. The status names
 * them in every state, and the next Connect (with its newly pasted access
 * token) or Replace (with the access token its rotate minted) deletes them;
 * to either, only Slack's `app_not_found` means already gone. An admin who deleted one on Slack's page says so with
 * forget-leftover-app, which takes their word for it and asks Slack nothing
 * (no token here could ask): it only stops the note naming that app.
 *
 * The OAuth `state` is 32 random bytes, hex. Only its sha256 is stored, on
 * the install's row, with the admin it was minted for and a 10-minute expiry.
 * The callback refuses a state it doesn't know, and another admin's without
 * spending it, so whoever learns a state can't cancel the real admin's
 * install. Otherwise it spends the state in one UPDATE, so it works once.
 *
 * A browser lands on the callback from Slack, so it never gets a JSON error.
 * Whatever happens there (done, cancelled, a refusal, a fault, or the admin
 * gate saying no) it goes to one fixed place, the app's root with
 * `slack=connected|cancelled|failed`. A refusal is logged by reason, and a
 * finished install as `slack_connected`. Nothing in the request picks that
 * address, so the callback can't be used as an open redirect.
 */

/**
 * The Slack apps AX made and couldn't delete (Disconnect's, or Connect's own
 * undo's), oldest first: a name and an app id each, nothing else. Every
 * state carries it. After a Connect whose delete failed, the admin goes
 * straight to Slack and comes back connected, so a state without it would
 * read as "deleted".
 */
type LeftoverAppsField = Array<{ botName: string; appId: string }>;

export type SlackStatus =
  | {
      state: 'not-connected';
      defaultBotName: string;
      canConnect: boolean;
      leftoverApps: LeftoverAppsField;
    }
  | {
      state: 'pending';
      botName: string;
      connectedBy: string;
      connectedAt: string;
      leftoverApps: LeftoverAppsField;
    }
  | {
      state: 'connected';
      botName: string;
      workspaceName: string;
      connectedBy: string;
      connectedAt: string;
      leftoverApps: LeftoverAppsField;
    };

export interface AdminRoutesDeps {
  bus: HookBus;
  store: InstallStore;
  secrets: SecretStore;
  api: SlackApi;
  lock: Mutex;
  /** Where Slack reaches AX, and where the admin is sent back to. Only https can connect. */
  publicOrigin: string;
  logger: Logger;
  /** Epoch milliseconds. */
  now: () => number;
  randomBytes: (n: number) => Buffer;
}

export const ADMIN_STATUS_PATH = '/admin/slack';
export const ADMIN_CONNECT_PATH = '/admin/slack/connect';
export const ADMIN_INSTALL_URL_PATH = '/admin/slack/install-url';
export const ADMIN_RENAME_PATH = '/admin/slack/rename';
export const ADMIN_REPLACE_TOKEN_PATH = '/admin/slack/replace-token';
export const ADMIN_DISCONNECT_PATH = '/admin/slack/disconnect';
export const ADMIN_FORGET_LEFTOVER_APP_PATH = '/admin/slack/forget-leftover-app';
/** Must match the `redirect_uri` slackUrls registers in the manifest. */
export const OAUTH_CALLBACK_PATH = '/admin/slack/oauth/callback';

type InstallOutcome = 'connected' | 'cancelled' | 'failed';

/** Why Slack didn't take a rename, as the admin is told it (a 502). */
type RenameRefusal = 'slack-config-token' | 'slack-app-gone' | 'slack-name' | 'slack-error';

/** A route's answer, written once at the end: JSON with a status, or a redirect. */
type Reply = { status: number; body: unknown } | { location: string };

const PLUGIN = '@ax/channel-slack';
const ACCESS_TOKEN_PREFIX = 'xoxe.xoxp-';
const REFRESH_TOKEN_PREFIX = 'xoxe-';
/** A pasted configuration token's characters (`xoxe.xoxp-1-…`, `xoxe-1-…`). */
const CONFIG_TOKEN_CHARS = /^[A-Za-z0-9._-]+$/;
const STATE_RE = new RegExp(`^[0-9a-f]{${OAUTH_STATE_BYTES * 2}}$`);
/**
 * Slack's OAuth code (digits, dots and hex today). Any printable ASCII is let
 * through, bounded: it only ever travels form-encoded, to Slack.
 */
const OAUTH_CODE_RE = new RegExp(`^[\\x21-\\x7e]{1,${SLACK_TOKEN_MAX}}$`);
/** What Slack's `apps.manifest.*` methods say when a configuration access token is no good. */
const TOKEN_ERRORS: ReadonlySet<string> = new Set([
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
const REFRESH_TOKEN_REFUSED: ReadonlySet<string> = new Set([...TOKEN_ERRORS, 'invalid_refresh_token']);
/**
 * Slack refusing a rename over the STORED configuration token itself, which
 * no retry fixes. Either it is dead (REFRESH_TOKEN_REFUSED), or it works but
 * its owner can't manage this app (`no_permission`,
 * `app_not_owned_by_manager_app`, both listed for `apps.manifest.update`).
 * The remedy is the same for all: Replace the token with one whose owner can
 * manage the app.
 */
const CONFIG_TOKEN_REFUSED: ReadonlySet<string> = new Set([
  ...REFRESH_TOKEN_REFUSED,
  'no_permission',
  'app_not_owned_by_manager_app',
]);
/**
 * Slack refusing Replace's check (TASK-1128): the newly pasted token works,
 * but its owner can't manage this app (`no_permission`,
 * `app_not_owned_by_manager_app`) or can't see it (`app_not_found`). With a
 * new, unproven token, Slack can't tell "can't manage" from "another
 * workspace" from "gone" here. "Gone" sends the admin to Disconnect, which
 * costs every channel, so none of the three is called gone.
 */
const NOT_APP_MANAGER: ReadonlySet<string> = new Set([
  'no_permission',
  'app_not_owned_by_manager_app',
  'app_not_found',
]);
/**
 * `apps.manifest.create` failures where Slack may have made the app anyway:
 * we never got its answer (`timeout`, `network`, a 5xx from its edge), or
 * couldn't read the one we got (`bad-response`, `too-large`). slack-api.ts
 * names these codes.
 */
const UNCONFIRMED_CODES: ReadonlySet<string> = new Set(['timeout', 'network', 'bad-response', 'too-large']);
const HTTP_5XX = /^http-5\d\d$/;
/**
 * A leftover-app delete failure that is about Slack or the pasted token, not
 * that one app: every later delete in the same Connect would fail the same
 * way, each after up to a full per-call deadline, while the admin lock is
 * held. So the pass stops at the first one.
 */
function stopsLeftoverPass(err: unknown): boolean {
  if (!(err instanceof SlackApiError)) return false;
  return (
    TOKEN_ERRORS.has(err.code) ||
    UNCONFIRMED_CODES.has(err.code) ||
    HTTP_5XX.test(err.code) ||
    err.code === 'ratelimited'
  );
}

/** "Connected by" when auth has no name for the admin, no account, or no answer. */
const FALLBACK_NAME = 'Administrator';

/**
 * Callback refusals logged at info: the admin's own cancel, a stale or
 * garbled link, or a browser the admin gate turned away (signed out, or not
 * an admin).
 */
const QUIET_REFUSALS: ReadonlySet<string> = new Set([
  'cancelled',
  'invalid-state',
  'invalid-request',
  'unauthenticated',
  'forbidden',
]);

const utf8 = new TextDecoder('utf-8', { fatal: true });
const json = (status: number, body: unknown): Reply => ({ status, body });
const INTERNAL = json(500, { error: 'internal' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isHttps(origin: string): boolean {
  try {
    return new URL(origin).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The body as a JSON object, or null when it is anything else. */
function bodyObject(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(utf8.decode(body));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** A pasted configuration token of the kind `prefix` names, or null. */
function configToken(value: unknown, prefix: string): string | null {
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
function createAppError(err: unknown): 'slack-token' | 'slack-name' | 'slack-unconfirmed' | 'slack-error' {
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
function refreshTokenError(err: unknown): 'slack-refresh-token' | 'slack-error' {
  return err instanceof SlackApiError && REFRESH_TOKEN_REFUSED.has(err.code) ? 'slack-refresh-token' : 'slack-error';
}

/**
 * What a rename's failed Slack step tells the admin. Only the update carries
 * the name, so only it can mean `slack-name`, and only it can find the app
 * gone (`slack-app-gone`). Everything else is `slack-error`: a rename sends
 * the same manifest every time, so trying again is always safe.
 */
function renameError(stage: string, err: unknown): RenameRefusal {
  if (!(err instanceof SlackApiError)) return 'slack-error';
  if (CONFIG_TOKEN_REFUSED.has(err.code)) return 'slack-config-token';
  if (stage === 'update-app' && err.code === 'invalid_manifest') return 'slack-name';
  // A retry can't bring back an app that was deleted on Slack's side.
  if (stage === 'update-app' && err.code === 'app_not_found') return 'slack-app-gone';
  return 'slack-error';
}

/**
 * What a replace's failed check tells the admin. `slack-refresh-token`: the
 * access token the pasted refresh token minted is no good, so only a new
 * token helps. `slack-not-app-manager`: Slack says the token's owner can't
 * manage this app (NOT_APP_MANAGER). Anything else is `slack-error`: a retry
 * soon after may work while Slack still honours the pasted token.
 */
function replaceCheckError(err: unknown): 'slack-refresh-token' | 'slack-not-app-manager' | 'slack-error' {
  if (!(err instanceof SlackApiError)) return 'slack-error';
  if (REFRESH_TOKEN_REFUSED.has(err.code)) return 'slack-refresh-token';
  if (NOT_APP_MANAGER.has(err.code)) return 'slack-not-app-manager';
  return 'slack-error';
}

export function createAdminRoutes(d: AdminRoutesDeps): RouteSpec[] {
  const ctx = makeAgentContext({
    sessionId: 'channel-slack',
    agentId: PLUGIN,
    userId: 'system',
    logger: d.logger,
  });
  const appOrigin = withoutTrailingSlashes(d.publicOrigin);
  const canConnect = isHttps(d.publicOrigin);

  // ── Logs: code-only, and a log line never changes an answer ──────────────

  const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, string | boolean>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };
  /** A failed step. Slack refusing is a warning; our own store or vault failing is an error. */
  const failed = (
    stage: string,
    err: unknown,
    installId?: string,
    level: 'warn' | 'error' = err instanceof SlackApiError ? 'warn' : 'error',
  ): void => {
    log(level, 'slack_admin_failed', {
      ...(installId !== undefined ? { installId } : {}),
      stage,
      code: logCode(err),
    });
  };
  /**
   * A callback that didn't finish an install, and why, with the install when
   * it is known. A cancel, or a link that is stale or garbled, is no fault of
   * ours or Slack's.
   */
  const refused = (reason: string, installId?: string): void => {
    log(QUIET_REFUSALS.has(reason) ? 'info' : 'warn', 'slack_install_refused', {
      ...(installId !== undefined ? { installId } : {}),
      reason,
    });
  };

  /**
   * Where the callback sends the browser: the app's root and a fixed word.
   * Built from config alone, never from the request.
   */
  const backToApp = (outcome: InstallOutcome): Reply => ({ location: `${appOrigin}/?slack=${outcome}` });

  // ── Shared steps ──────────────────────────────────────────────────────────

  /** The default bot name: the handle form of the branding name, else `ax`. */
  async function brandedBotName(): Promise<string> {
    if (!d.bus.hasService('branding:get')) return defaultBotName(null);
    try {
      const out = await d.bus.call<Record<string, never>, unknown>('branding:get', ctx, {});
      const name = isRecord(out) ? out['name'] : undefined;
      return defaultBotName(typeof name === 'string' ? name : null);
    } catch (err) {
      failed('branding', err, undefined, 'warn');
      return defaultBotName(null);
    }
  }

  /**
   * A fresh OAuth state for a pending install, bound to `adminId`, and the
   * Slack link that carries it. Any earlier state for the install stops
   * matching. Throws InstallStoreError when the install isn't pending.
   */
  async function mintInstallUrl(installId: string, clientId: string, adminId: string): Promise<string> {
    const state = d.randomBytes(OAUTH_STATE_BYTES).toString('hex');
    await d.store.setOAuthState(installId, {
      stateHash: sha256Hex(state),
      userId: adminId,
      expiresAt: new Date(d.now() + OAUTH_STATE_TTL_MS),
    });
    return buildInstallUrl({
      clientId,
      redirectUrl: slackUrls(d.publicOrigin, installId).redirectUrl,
      state,
    });
  }

  /**
   * The bot's picture, best-effort: true only when Slack took it. None sent
   * (`null`: the browser had none to draw): Slack isn't asked and nothing is
   * logged. One icon.ts refused: never sent, one warning naming why. Slack
   * refusing it, or not answering: one warning with its code. Never throws,
   * so it never fails a Connect.
   */
  async function setIcon(
    accessToken: string,
    appId: string,
    installId: string,
    icon: ParsedIcon | null,
  ): Promise<boolean> {
    if (icon === null) return false;
    if (!icon.ok) {
      log('warn', 'slack_admin_failed', { installId, stage: 'icon', code: icon.code });
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

  /**
   * Connect failed after Slack made the app: take all of it back, so nothing
   * is left half-made. Each step is best-effort and logged. Deleting the app
   * needs a configuration access token, and the pasted one is still in hand.
   */
  async function undoConnect(accessToken: string, appId: string, installId: string): Promise<void> {
    try {
      await d.api.deleteApp(accessToken, appId);
    } catch (err) {
      failed('undo-delete-app', err, installId);
    }
    try {
      await d.store.remove(installId);
    } catch (err) {
      failed('undo-remove', err, installId);
    }
    await d.secrets.removeAll({ installId });
  }

  /**
   * Connect stopped right after Slack made the app, before anything was
   * stored: take the app back with the pasted access token. If Slack won't,
   * the app goes onto the leftover list (no install row holds it), naming
   * `connectedByUserId`, the connecting admin whose token made it
   * (TASK-1175), so the tab names it and the next Connect deletes it. Never
   * throws.
   */
  async function undoCreate(
    accessToken: string,
    appId: string,
    installId: string,
    botName: string,
    connectedByUserId: string,
  ): Promise<void> {
    try {
      await d.api.deleteApp(accessToken, appId);
      return;
    } catch (err) {
      // Already gone on Slack's side is what the undo wanted.
      if (err instanceof SlackApiError && err.code === 'app_not_found') return;
      failed('undo-delete-app', err, installId);
    }
    try {
      await d.store.rememberLeftoverApp({ installId, appId, botName, connectedByUserId });
    } catch (err) {
      failed('remember-leftover-app', err, installId);
    }
  }

  /**
   * Run by Connect (before a new app, with the access token the admin just
   * pasted) and by Replace (after the replace, with the access token its
   * rotate minted): delete the apps an earlier Disconnect couldn't. The
   * token's owner is usually the person whose earlier token made them; that
   * a new token can delete them is UNMEASURED, decisions shard. Deleted, or
   * already gone on Slack's side (`app_not_found`): forgotten, and then
   * logged at info (`slack_leftover_app_deleted`, with
   * `reason: 'already-gone'` for the second). If the forget fails, only that
   * failure is logged, and the next Connect or Replace finds the app gone.
   * Anything else: kept, logged code-only, and still listed; a failure about
   * Slack or the token rather than that app (stopsLeftoverPass) also ends the
   * pass, so one Connect or Replace waits on at most one dead deadline. Never
   * stops either; a store fault reading the list throws, before Slack is
   * asked anything.
   */
  async function deleteLeftoverApps(accessToken: string): Promise<void> {
    for (const app of await d.store.leftoverApps()) {
      let alreadyGone = false;
      try {
        await d.api.deleteApp(accessToken, app.appId);
      } catch (err) {
        if (!(err instanceof SlackApiError && err.code === 'app_not_found')) {
          failed('delete-leftover-app', err, app.installId);
          if (stopsLeftoverPass(err)) return;
          continue;
        }
        alreadyGone = true;
      }
      try {
        await d.store.forgetLeftoverApp(app.installId);
      } catch (err) {
        failed('forget-leftover-app', err, app.installId);
        continue;
      }
      log('info', 'slack_leftover_app_deleted', {
        installId: app.installId,
        ...(alreadyGone ? { reason: 'already-gone' } : {}),
      });
    }
  }

  async function createInstall(
    actor: AdminActor,
    accessToken: string,
    refreshToken: string,
    botName: string,
    icon: ParsedIcon | null,
  ): Promise<Reply> {
    const installId = d.randomBytes(INSTALL_ID_BYTES).toString('base64url');
    let app: CreatedApp;
    try {
      app = await d.api.createApp(accessToken, buildAppManifest(botName, slackUrls(d.publicOrigin, installId)));
    } catch (err) {
      failed('create-app', err, installId);
      return json(502, { error: createAppError(err) });
    }

    // Try the pasted refresh token once, before anything is stored, so an
    // install never starts with one Slack won't take (TASK-1159). Only the
    // refresh token Slack mints in its place is kept: the access token minted
    // with it is never used.
    let mintedRefreshToken: string;
    try {
      ({ refreshToken: mintedRefreshToken } = await d.api.rotateConfigToken(refreshToken));
    } catch (err) {
      failed('try-refresh-token', err, installId);
      await undoCreate(accessToken, app.appId, installId, botName, actor.id);
      return json(502, { error: refreshTokenError(err) });
    }

    const owner: SecretOwner = { installId, connectedByUserId: actor.id };
    try {
      await d.secrets.put(owner, 'client-secret', app.clientSecret);
      await d.secrets.put(owner, 'signing-secret', app.signingSecret);
      // The one Slack just minted from the pasted one, until a rotate (Rename, Disconnect) saves its replacement.
      await d.secrets.put(owner, 'config-refresh-token', mintedRefreshToken);
      await d.store.insertPending({
        installId,
        appId: app.appId,
        clientId: app.clientId,
        botName,
        connectedByUserId: actor.id,
      });
      const iconSet = await setIcon(accessToken, app.appId, installId, icon);
      const installUrl = await mintInstallUrl(installId, app.clientId, actor.id);
      return json(200, { installUrl, iconSet });
    } catch (err) {
      failed('connect', err, installId);
      await undoConnect(accessToken, app.appId, installId);
      return INTERNAL;
    }
  }

  /**
   * After the state is spent: trade the code for the bot token, keep it, and
   * mark the install active. Every failure sends the admin back with
   * `failed`; the install stays pending, so Continue in Slack still works.
   * A finished install is logged at info (`slack_connected`), so refusals in
   * the log are followed by the callback that worked.
   */
  async function finishInstall(installId: string, code: string): Promise<Reply> {
    const install = await d.store.get(installId);
    if (install === null || install.status !== 'pending') {
      refused('not-pending', installId);
      return backToApp('failed');
    }
    const clientSecret = await d.secrets.get(install, 'client-secret');
    if (clientSecret === null) {
      refused('no-client-secret', installId);
      return backToApp('failed');
    }

    let granted: OAuthInstall;
    try {
      granted = await d.api.oauthAccess({
        clientId: install.clientId,
        clientSecret,
        code,
        // Exactly the one in the manifest and the install link, or Slack refuses.
        redirectUri: slackUrls(d.publicOrigin, installId).redirectUrl,
      });
    } catch (err) {
      failed('oauth-access', err, installId);
      return backToApp('failed');
    }
    // The code came back to OUR callback with OUR state, so it must be our
    // app. Anything else, or an org-wide install, and the token isn't one we
    // should hold.
    if (granted.appId !== install.appId) {
      refused('app-mismatch', installId);
      return backToApp('failed');
    }
    if (granted.enterpriseInstall) {
      refused('enterprise-install', installId);
      return backToApp('failed');
    }

    // The token first: an active install must always have one.
    let stage = 'bot-token';
    try {
      await d.secrets.put(install, 'bot-token', granted.botToken);
      stage = 'activate';
      await d.store.activate(installId, {
        teamId: granted.teamId,
        teamName: granted.teamName,
        botUserId: granted.botUserId,
        installedAt: new Date(d.now()),
      });
    } catch (err) {
      failed(stage, err, installId);
      await d.secrets.remove(install, 'bot-token');
      return backToApp('failed');
    }
    log('info', 'slack_connected', { installId });
    return backToApp('connected');
  }

  /**
   * Keep the refresh token a rotate just minted, in place of the one it was
   * minted from. Slack retires a rotated refresh token within minutes to
   * hours (slack-api.ts), so without this the install's configuration token
   * dies after its first use. True when stored. A failure is logged here,
   * code-only, and the stored token then works only until Slack retires it.
   */
  async function saveRotatedToken(install: InstallRow, refreshToken: string): Promise<boolean> {
    try {
      await d.secrets.put(install, 'config-refresh-token', refreshToken);
      return true;
    } catch (err) {
      failed('save-config-token', err, install.installId);
      return false;
    }
  }

  /**
   * Delete the Slack app with an access token minted from the stored refresh
   * token. The minted token is used once. True when the app is gone: deleted
   * now, or already deleted on Slack's side (`app_not_found`, say from
   * api.slack.com/apps), which is what Disconnect wanted anyway.
   *
   * The new refresh token is stored first, for the retry `disconnect()` keeps
   * the secrets for when the row won't delete. If that store fails, the app
   * is still deleted with the token in hand.
   */
  async function deleteSlackApp(install: InstallRow): Promise<boolean> {
    let stage = 'config-token';
    try {
      const refreshToken = await d.secrets.get(install, 'config-refresh-token');
      if (refreshToken === null) {
        log('warn', 'slack_admin_failed', { installId: install.installId, stage, code: 'missing' });
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

  /**
   * Send Slack the app's whole manifest under `botName`, with an access token
   * minted from the stored refresh token and used once. Slack replaces the
   * manifest on update, so a part of one would drop the rest (the approval
   * buttons, `/ax`, the scopes). Null when Slack took it, else what the
   * admin is told. A vault fault reading the token throws: the route's 500.
   *
   * The new refresh token is stored first. If that fails, nothing is sent
   * (`'token-not-kept'`): a retry soon after may still work with the old one.
   */
  async function updateSlackApp(
    install: InstallRow,
    botName: string,
  ): Promise<RenameRefusal | 'token-not-kept' | null> {
    const refreshToken = await d.secrets.get(install, 'config-refresh-token');
    if (refreshToken === null) {
      log('warn', 'slack_admin_failed', { installId: install.installId, stage: 'config-token', code: 'missing' });
      return 'slack-config-token';
    }
    const manifest = buildAppManifest(botName, slackUrls(d.publicOrigin, install.installId));
    let stage = 'rotate';
    try {
      const minted = await d.api.rotateConfigToken(refreshToken);
      if (!(await saveRotatedToken(install, minted.refreshToken))) return 'token-not-kept';
      stage = 'update-app';
      await d.api.updateApp(minted.accessToken, install.appId, manifest);
      return null;
    } catch (err) {
      failed(stage, err, install.installId);
      return renameError(stage, err);
    }
  }

  /**
   * Who added the configuration token the install holds (at Connect, or the
   * latest Replace), as auth knows them now: the row keeps only their id
   * (invariant 4: names are auth's). The display name, else the email (only
   * admins see this), else "Administrator", which also stands in for an
   * account that's gone or an auth that can't answer.
   */
  function connectedByName(install: InstallRow): Promise<string> {
    return personName(d.bus, ctx, install.connectedByUserId, {
      allowEmail: true,
      fallback: FALLBACK_NAME,
      onFault: (err) => failed('connected-by', err, install.installId, 'warn'),
    });
  }

  // ── The routes ────────────────────────────────────────────────────────────

  async function status(): Promise<Reply> {
    const install = await d.store.current();
    // The name and the app id only: the install id and the date stay here.
    const leftoverApps = (await d.store.leftoverApps()).map(({ botName, appId }) => ({ botName, appId }));
    if (install === null) {
      const out: SlackStatus = {
        state: 'not-connected',
        defaultBotName: await brandedBotName(),
        canConnect,
        leftoverApps,
      };
      return json(200, out);
    }
    // connectedAt is when the configuration token was added (Connect, or the
    // latest Replace), not when Allow was clicked.
    const shared = {
      botName: install.botName,
      connectedBy: await connectedByName(install),
      connectedAt: install.configTokenAddedAt.toISOString(),
      leftoverApps,
    };
    const out: SlackStatus =
      install.status === 'active'
        ? { state: 'connected', ...shared, workspaceName: install.teamName ?? '' }
        : { state: 'pending', ...shared };
    return json(200, out);
  }

  async function connect(req: RouteRequest, actor: AdminActor): Promise<Reply> {
    // http-server's maxBodyBytes refused anything larger already; this is the backstop.
    // Connect's cap, not the other routes': its body can carry the bot's picture.
    if (req.body.length > ADMIN_CONNECT_BODY_MAX_BYTES) return json(413, { error: 'body-too-large' });
    const body = bodyObject(req.body);
    if (body === null) return json(400, { error: 'invalid-body' });
    // Checked before anything else, so a token pasted into the wrong box never reaches Slack.
    const accessToken = configToken(body['accessToken'], ACCESS_TOKEN_PREFIX);
    if (accessToken === null) return json(400, { error: 'invalid-access-token' });
    const refreshToken = configToken(body['refreshToken'], REFRESH_TOKEN_PREFIX);
    if (refreshToken === null) return json(400, { error: 'invalid-refresh-token' });
    const rawName = body['botName'] ?? (await brandedBotName());
    if (typeof rawName !== 'string') return json(400, { error: 'invalid-bot-name', reason: 'bad-characters' });
    const name = checkBotName(rawName);
    if (!name.ok) return json(400, { error: 'invalid-bot-name', reason: name.reason });
    // Never a 400: an unusable picture is skipped (and logged) once the install exists.
    const icon = body['iconPng'] === undefined ? null : parseIconPng(body['iconPng']);

    return d.lock.run(async () => {
      if ((await d.store.current()) !== null) return json(409, { error: 'already-connected' });
      if (!canConnect) return json(409, { error: 'public-origin-not-https' });
      await deleteLeftoverApps(accessToken);
      return createInstall(actor, accessToken, refreshToken, name.name, icon);
    });
  }

  async function installUrl(_req: RouteRequest, actor: AdminActor): Promise<Reply> {
    return d.lock.run(async () => {
      const install = await d.store.current();
      if (install === null || install.status !== 'pending') return json(409, { error: 'not-pending' });
      try {
        return json(200, { installUrl: await mintInstallUrl(install.installId, install.clientId, actor.id) });
      } catch (err) {
        if (err instanceof InstallStoreError) return json(409, { error: 'not-pending' });
        throw err;
      }
    });
  }

  async function rename(req: RouteRequest): Promise<Reply> {
    // http-server's maxBodyBytes refused anything larger already; this is the backstop.
    if (req.body.length > ADMIN_BODY_MAX_BYTES) return json(413, { error: 'body-too-large' });
    const body = bodyObject(req.body);
    if (body === null) return json(400, { error: 'invalid-body' });
    // The admin's input: checked before the vault or Slack is touched.
    const rawName = body['botName'];
    if (typeof rawName !== 'string') return json(400, { error: 'invalid-bot-name', reason: 'bad-characters' });
    const name = checkBotName(rawName);
    if (!name.ok) return json(400, { error: 'invalid-bot-name', reason: name.reason });

    return d.lock.run(async () => {
      const install = await d.store.current();
      if (install === null || install.status !== 'active') return json(409, { error: 'not-connected' });
      // The manifest carries the URLs Slack calls back on: https only, as at Connect.
      if (!canConnect) return json(409, { error: 'public-origin-not-https' });
      const refusal = await updateSlackApp(install, name.name);
      if (refusal === 'token-not-kept') return INTERNAL;
      if (refusal !== null) return json(502, { error: refusal });
      // Last, so the row only ever shows a name Slack took. If this write
      // fails, Slack has the name already, and a retry sends the same manifest.
      try {
        await d.store.setBotName(install.installId, name.name);
      } catch (err) {
        if (err instanceof InstallStoreError) {
          // Gone meanwhile: a reset removes installs without this lock. Once
          // the rows are gone it deletes what is left of their secrets
          // (plugin.ts); this takes back a token stored after that. Still
          // left live, where no route can reach it: one stored after the
          // reset's sweep when Slack then refused the update (that 502
          // returns before here), and any whose delete fails (logged).
          await d.secrets.remove(install, 'config-refresh-token');
          return json(409, { error: 'not-connected' });
        }
        throw err;
      }
      return json(200, { botName: name.name });
    });
  }

  /**
   * Replace the configuration token the install holds with one an admin
   * pastes (TASK-1128), keeping the install, its channels and its other
   * secrets. The pasted refresh token is tried once. The access token that
   * mints sends Slack the app's whole manifest, as Rename does: Slack taking
   * it shows the new token's owner can manage this app. Only then is the
   * minted refresh token stored, as the admin replacing it, and the row
   * moved to them. The old token is never read or rotated, so any failure
   * before the store leaves the install exactly as it was.
   */
  async function replaceToken(req: RouteRequest, actor: AdminActor): Promise<Reply> {
    // http-server's maxBodyBytes refused anything larger already; this is the backstop.
    if (req.body.length > ADMIN_BODY_MAX_BYTES) return json(413, { error: 'body-too-large' });
    const body = bodyObject(req.body);
    if (body === null) return json(400, { error: 'invalid-body' });
    // Checked before anything else, so an access token pasted into the refresh box never reaches Slack.
    const refreshToken = configToken(body['refreshToken'], REFRESH_TOKEN_PREFIX);
    if (refreshToken === null) return json(400, { error: 'invalid-refresh-token' });

    return d.lock.run(async () => {
      const install = await d.store.current();
      // Active only: an unfinished install has no channels yet, so Cancel and Connect again cost nothing.
      if (install === null || install.status !== 'active') return json(409, { error: 'not-connected' });
      // The manifest carries the URLs Slack calls back on: https only, as at Connect.
      if (!canConnect) return json(409, { error: 'public-origin-not-https' });
      const { installId } = install;

      let minted: RotatedConfigToken;
      try {
        minted = await d.api.rotateConfigToken(refreshToken);
      } catch (err) {
        failed('try-refresh-token', err, installId);
        return json(502, { error: refreshTokenError(err) });
      }
      // The check comes BEFORE the store. Rename stores first because the
      // token it spent is the stored one. Here the spent token is the pasted
      // one, and the stored one stays untouched until Slack has taken this
      // app's manifest from the new token: one whose owner can't manage the
      // app must never overwrite one that may still work.
      try {
        await d.api.updateApp(
          minted.accessToken,
          install.appId,
          buildAppManifest(install.botName, slackUrls(d.publicOrigin, installId)),
        );
      } catch (err) {
        failed('check-app', err, installId);
        return json(502, { error: replaceCheckError(err) });
      }
      // Written as the admin replacing it: every read after this names them.
      if (!(await saveRotatedToken({ ...install, connectedByUserId: actor.id }, minted.refreshToken))) {
        return INTERNAL;
      }
      try {
        await d.store.setConfigTokenOwner(installId, { userId: actor.id, addedAt: new Date(d.now()) });
      } catch (err) {
        if (err instanceof InstallStoreError) {
          // Gone meanwhile: a reset removes installs without this lock. Take
          // back the token just stored, as Rename does (a failed delete is
          // logged).
          await d.secrets.remove(install, 'config-refresh-token');
          return json(409, { error: 'not-connected' });
        }
        // A 500, logged with its install. The vault keeps the new token,
        // which Slack just took for this app; only "Added by" is stale until
        // a retry.
        failed('save-owner', err, installId);
        return INTERNAL;
      }
      log('info', 'slack_config_token_replaced', { installId });
      // Best-effort, after the replace has happened: the new token may delete
      // apps an earlier one couldn't. A fault reading the list changes nothing.
      try {
        await deleteLeftoverApps(minted.accessToken);
      } catch (err) {
        failed('leftover-apps', err, installId);
      }
      return json(200, {});
    });
  }

  async function callback(req: RouteRequest, actor: AdminActor): Promise<Reply> {
    const refuse = (reason: string, installId?: string): Reply => {
      refused(reason, installId);
      return backToApp('failed');
    };
    const state = req.query['state'];
    if (state === undefined || !STATE_RE.test(state)) return refuse('invalid-state');
    // Slack sends `code` after Allow, `error` after Cancel; never neither.
    const slackError = req.query['error'];
    const code = req.query['code'];
    const answer =
      slackError !== undefined
        ? { error: slackError }
        : code !== undefined && OAUTH_CODE_RE.test(code)
          ? { code }
          : null;
    if (answer === null) return refuse('invalid-request');
    const stateHash = sha256Hex(state);

    return d.lock.run(async () => {
      // Peek first: another admin is refused WITHOUT spending the state.
      const peeked = await d.store.peekOAuthState(stateHash);
      if (peeked === null) return refuse('invalid-state');
      if (peeked.userId !== actor.id) return refuse('state-user-mismatch', peeked.installId);
      const spent = await d.store.consumeOAuthState(stateHash);
      if (spent === null) return refuse('invalid-state');

      const { installId } = spent;
      if (spent.expiresAt.getTime() <= d.now()) {
        refused('expired', installId);
        return backToApp('failed');
      }
      if ('error' in answer) {
        // Only the code picks the outcome; Slack's text goes nowhere.
        const cancelled = answer.error === 'access_denied';
        refused(cancelled ? 'cancelled' : 'slack-error', installId);
        return backToApp(cancelled ? 'cancelled' : 'failed');
      }
      try {
        return await finishInstall(installId, answer.code);
      } catch (err) {
        failed('callback', err, installId);
        return backToApp('failed');
      }
    });
  }

  async function disconnect(): Promise<Reply> {
    return d.lock.run(async () => {
      const install = await d.store.current();
      if (install === null) return json(409, { error: 'not-connected' });
      const appDeleted = await deleteSlackApp(install);
      // Local state goes whatever Slack said: a dead token or an app someone
      // already deleted must never strand a "connected" row. An app Slack
      // didn't delete is remembered in the same statement, so the next
      // Connect can delete it and the tab names it until then. If the row
      // won't go, nothing is remembered and the secrets stay too, so a retry
      // can still delete the app. Once it answers, the outcome is logged at
      // info with the answer's `appDeleted` (`slack_disconnected`), so a walk
      // can check it afterwards.
      await d.store.remove(install.installId, { appLeft: !appDeleted });
      await d.secrets.removeAll(install);
      log('info', 'slack_disconnected', { installId: install.installId, appDeleted });
      return json(200, { appDeleted });
    });
  }

  /**
   * "I deleted it": the admin deleted a leftover app on Slack's page, so stop
   * naming it. Asks Slack nothing and touches no install: it only forgets
   * every leftover entry with that app id. One it no longer lists is not an
   * error, so a double click is harmless. The id is checked like any Slack
   * id before the store is read; a store fault is the route's 500.
   */
  async function forgetLeftoverApp(req: RouteRequest): Promise<Reply> {
    // http-server's maxBodyBytes refused anything larger already; this is the backstop.
    if (req.body.length > ADMIN_BODY_MAX_BYTES) return json(413, { error: 'body-too-large' });
    const body = bodyObject(req.body);
    if (body === null) return json(400, { error: 'invalid-body' });
    const appId = body['appId'];
    if (typeof appId !== 'string' || !SLACK_ID_RE.test(appId)) return json(400, { error: 'invalid-app-id' });

    // Under the lock, so it never interleaves with Connect's own pass over the list.
    return d.lock.run(async () => {
      for (const app of await d.store.leftoverApps()) {
        if (app.appId === appId) await d.store.forgetLeftoverApp(app.installId);
      }
      return json(200, {});
    });
  }

  /**
   * One route: the admin gate, then `run`, then exactly one answer. A throw
   * `run` didn't handle is logged code-only. A JSON route answers the gate's
   * refusal with its status and a fault with 500. A browser route (the OAuth
   * callback, where the admin lands from Slack) answers both by sending the
   * browser home with `failed`. A POST's body is capped at `maxBodyBytes`,
   * ADMIN_BODY_MAX_BYTES unless the route says otherwise.
   */
  function route(
    method: RouteSpec['method'],
    path: string,
    stage: string,
    run: (req: RouteRequest, actor: AdminActor) => Promise<Reply>,
    o: { browser?: true; maxBodyBytes?: number } = {},
  ): RouteSpec {
    const browser = o.browser === true;
    return {
      method,
      path,
      ...(method === 'POST' ? { maxBodyBytes: o.maxBodyBytes ?? ADMIN_BODY_MAX_BYTES } : {}),
      handler: async (req, res) => {
        const gate = await checkAdmin(d.bus, ctx, req);
        let reply: Reply;
        if (!gate.ok) {
          // A browser can't read the gate's answer, so say why in the log
          // (a 500 was already logged code-only by the gate).
          if (browser && gate.status !== 500) refused(gate.error);
          reply = browser ? backToApp('failed') : json(gate.status, { error: gate.error });
        } else {
          try {
            reply = await run(req, gate.actor);
          } catch (err) {
            failed(stage, err);
            reply = browser ? backToApp('failed') : INTERNAL;
          }
        }
        if ('location' in reply) res.redirect(reply.location, 302);
        else res.status(reply.status).json(reply.body);
      },
    };
  }

  return [
    route('GET', ADMIN_STATUS_PATH, 'status', status),
    // Its body can carry the bot's picture (icon.ts).
    route('POST', ADMIN_CONNECT_PATH, 'connect', connect, { maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES }),
    route('POST', ADMIN_INSTALL_URL_PATH, 'install-url', installUrl),
    route('POST', ADMIN_RENAME_PATH, 'rename', rename),
    route('POST', ADMIN_REPLACE_TOKEN_PATH, 'replace-token', replaceToken),
    route('POST', ADMIN_DISCONNECT_PATH, 'disconnect', disconnect),
    route('POST', ADMIN_FORGET_LEFTOVER_APP_PATH, 'forget-leftover-app', forgetLeftoverApp),
    // A browser lands here from Slack: a refusal or a fault still sends it home, with `failed`.
    route('GET', OAUTH_CALLBACK_PATH, 'callback', callback, { browser: true }),
  ];
}
