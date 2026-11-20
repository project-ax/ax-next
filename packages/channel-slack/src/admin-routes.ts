import { makeAgentContext, type HookBus, type Logger } from '@ax/core';
import { checkAdmin, type AdminActor } from './admin-auth.js';
import { checkBotName, defaultBotName } from './bot-name.js';
import type { RouteRequest, RouteSpec } from './http-types.js';
import { parseIconPng, type ParsedIcon } from './icon.js';
import {
  ADMIN_BODY_MAX_BYTES,
  ADMIN_CONNECT_BODY_MAX_BYTES,
  INSTALL_ID_BYTES,
  SLACK_ID_RE,
} from './limits.js';
import { BOT_SCOPES, buildAppManifest, slackUrls, withoutTrailingSlashes } from './manifest.js';
import type { Mutex } from './mutex.js';
import { personName } from './person-name.js';
import { configTokenRef, type SecretOwner, type SecretStore } from './secrets.js';
import {
  ACCESS_TOKEN_PREFIX,
  OAUTH_CODE_RE,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_REFUSED,
  STATE_RE,
  TOKEN_ERRORS,
  UNCONFIRMED_CODES,
  HTTP_5XX,
  bodyObject,
  configToken,
  createAppError,
  createAppSteps,
  isHttps,
  isRecord,
  refreshTokenError,
  sha256Hex,
  type InstallLink,
} from './slack-apps.js';
import { SlackApiError, type CreatedApp, type RotatedConfigToken, type SlackApi } from './slack-api.js';
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
 *     Disconnect couldn't that are the connecting admin's own, or name no
 *     one (below), then creates the app and sets its icon (and, if Connect
 *     fails halfway, deletes the app again). Then it is dropped. It is never
 *     stored.
 *   - The configuration REFRESH token belongs to a person, not to an app
 *     (TASK-1175). Slack lets each person hold one per workspace, and only
 *     the token of whoever created an app can change or delete it (design
 *     §8 Q5). So the vault keeps one per AX user (secrets.ts), an install's
 *     person is the admin who connected it (`connectedByUserId`), and every
 *     use below reads and writes that person's one token, which serves every
 *     Slack app they made through AX. Every use runs under the admin lock:
 *     a rotate through any one of their apps spends it for all of them.
 *   - The pasted REFRESH token is tried once, right after Slack makes the
 *     app: Connect rotates it and stores the refresh token Slack mints in
 *     its place as the connecting admin's own, and never uses that rotate's
 *     access token (TASK-1159). If the rotate fails in any way, no secret is
 *     stored and the app goes again, or onto the leftover list when Slack
 *     won't delete it (below), so an install never starts with a token Slack
 *     won't take. An admin id that can't name a vault ref (secrets.ts) can
 *     hold no token: that Connect fails closed (500) before Slack is asked
 *     anything, so no app is made and the pasted pair is never spent. No
 *     route ever returns the stored one. Only Disconnect, Rename and the
 *     leftover pass read it, each to mint one access token for one job:
 *     Disconnect to delete the app, Rename to update its manifest, the pass
 *     to delete that person's leftover apps (below). Each rotate also mints
 *     a new refresh token, and Slack retires the old one within minutes to
 *     hours (MEASURED, TASK-1097 walk; slack-api.ts), so the new one
 *     replaces it in the person's slot BEFORE the access token is used. If
 *     that write fails, Rename stops (a retry soon after may still work with
 *     the old token), and Disconnect and the pass delete anyway.
 *   - Replace (TASK-1128) takes a newly pasted REFRESH token, once the
 *     install is active, and tries it once, as Connect does. The access
 *     token that rotate mints first sends Slack the app's whole manifest, as
 *     Rename does: Slack taking it shows the new token's owner can manage
 *     this app, and only its creator's token can. So the minted refresh
 *     token is stored as the install's person's, whoever pasted it, and only
 *     the row's date moves: Replace never moves an app to another person,
 *     and it fixes every other app of theirs at once. Last, the leftover apps
 *     go (below), that person's own with the same access token. Nothing
 *     reads or rotates the old token, so any failure before the store leaves
 *     the install as it was. The old one needs no revoking: generating the
 *     new one revoked it on Slack (one per person).
 *   - A person's token goes once no install and no leftover app names them
 *     (config-tokens.ts): after Disconnect, after Connect's own undo (on
 *     any failure once the pasted token was rotated, whether or not the
 *     token was stored), when a reset took the install while Rename or
 *     Replace was storing it, and when a leftover pass or "I deleted it"
 *     forgets an app of theirs. While anything still names them, it stays:
 *     it is how that app is changed or deleted. A check that fails keeps it,
 *     and is logged.
 *   - The client secret, signing secret and bot token go to the vault,
 *     under the install.
 *   - No response body and no log line carries any of them, or a person's
 *     id. Log lines name an install, a stage or reason, a code, and whether
 *     Slack deleted an app.
 *
 * The bot's picture is drawn by the admin's browser and arrives as
 * `iconPng`, a base64 PNG (icon.ts checks it). It is uploaded to Slack as it
 * is, and never stored, logged or decoded past its header. A missing or
 * unusable one leaves Slack's default picture and never fails a Connect.
 *
 * Disconnect (and Cancel, the same route) deletes the Slack app with an
 * access token minted from its person's stored refresh token. When Slack
 * won't (the token is dead or revoked, or Slack doesn't answer), the install
 * still goes, and in the same statement its app's id, name and person (whose
 * token made it, TASK-1175) move to the leftover list (store.ts) instead of
 * being forgotten; that person's token then stays while the app names them.
 * Connect's own undo does the same when Slack won't delete the app Connect
 * just made: with the pending row, in the same statement, once it exists,
 * and straight onto the list before it (trying the pasted refresh token
 * failed, or storing failed before the row). The
 * status names them in every state, and the next Connect or Replace deletes
 * them, each with its maker's token (deleteLeftoverApps): the access token
 * in hand when it is theirs, else one minted from their stored token. To
 * either, only Slack's `app_not_found` means already gone. An admin who
 * deleted one on Slack's page says so with forget-leftover-app, which takes
 * their word for it and asks Slack nothing: it stops the note naming that
 * app, and its maker's token goes once nothing names them.
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
 * A failure in the leftover pass that is about Slack itself, not one app or
 * one token: no answer in time, one we couldn't read, a 5xx from its edge, or
 * `ratelimited`. Every later call in the same pass, a rotate or a delete,
 * would wait out the same per-call deadline while the admin lock is held, so
 * the pass ends at the first one. Slack refusing a token (TOKEN_ERRORS) is not
 * one of these: only that token's apps are skipped (deleteLeftoverApps).
 */
function endsLeftoverPass(err: unknown): boolean {
  if (!(err instanceof SlackApiError)) return false;
  return UNCONFIRMED_CODES.has(err.code) || HTTP_5XX.test(err.code) || err.code === 'ratelimited';
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

const json = (status: number, body: unknown): Reply => ({ status, body });
const INTERNAL = json(500, { error: 'internal' });

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
  // Every Slack-app step Admin › Slack shares with the team agents' bots (slack-apps.ts).
  const steps = createAppSteps({
    store: d.store,
    secrets: d.secrets,
    api: d.api,
    logger: d.logger,
    now: d.now,
    randomBytes: d.randomBytes,
    logPrefix: 'slack_admin',
  });
  const { failed, release, saveRotatedToken, deleteSlackApp, undoConnect, setIcon } = steps;
  /** Admin › Slack's install link: the shared bot's callback and scopes. */
  const linkFor = (installId: string): InstallLink => ({
    redirectUrl: slackUrls(d.publicOrigin, installId).redirectUrl,
    scopes: BOT_SCOPES,
  });

  // ── Logs: code-only, and a log line never changes an answer ──────────────

  const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, string | boolean>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
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
   * One access token for this pass over the leftover apps of
   * `app.connectedByUserId`, minted from their stored configuration token
   * (TASK-1175): read, rotated once, and the refresh token the rotate minted
   * saved to their slot BEFORE the access token is used, because the rotate
   * retired the one it was sent. A save that fails is logged, and the deletes
   * still go ahead, as Disconnect's do. `accessToken` is null when there is
   * none to be had: none stored, one the vault couldn't read, an id that
   * can't name one (`invalid-person-id`), or one Slack refused at the rotate,
   * each logged once, code-only, under `app`'s install. `endsPass` when Slack
   * itself didn't answer the rotate (endsLeftoverPass).
   */
  async function mintForPass(app: SecretOwner): Promise<{ accessToken: string | null; endsPass: boolean }> {
    const none = { accessToken: null, endsPass: false };
    let refreshToken: string | null;
    try {
      refreshToken = await d.secrets.getConfigToken(app);
    } catch (err) {
      failed('leftover-config-token', err, app.installId);
      return none;
    }
    if (refreshToken === null) {
      log('warn', 'slack_admin_failed', { installId: app.installId, stage: 'leftover-config-token', code: 'missing' });
      return none;
    }
    let rotated: RotatedConfigToken;
    try {
      rotated = await d.api.rotateConfigToken(refreshToken);
    } catch (err) {
      failed('leftover-rotate', err, app.installId);
      return { accessToken: null, endsPass: endsLeftoverPass(err) };
    }
    // Whether it was stored doesn't change what happens next: it is logged.
    await saveRotatedToken(app, rotated.refreshToken);
    return { accessToken: rotated.accessToken, endsPass: false };
  }

  /**
   * Run by Connect (before a new app) and by Replace (after the replace):
   * delete the apps an earlier Disconnect, or Connect's own undo, couldn't.
   * Only the token of whoever made an app can delete it (design §8 Q5), and
   * a newer token of theirs can (MEASURED, TASK-1163 check 1). So each app
   * goes with its maker's token (TASK-1175):
   *   - `inHand` is the access token the caller holds, and whose it is:
   *     Connect's pasted one, the connecting admin's; Replace's minted one,
   *     the install's person's. Their apps, and an app left before TASK-1175
   *     (it names no one), are tried with it, as before. Their stored token
   *     is never read or rotated here: at Connect their new paste ended it,
   *     and at Replace it is the one just stored.
   *   - Anyone else's apps go with one access token minted for this pass from
   *     that person's stored token (mintForPass), once per person whatever
   *     the number of their apps. Without one, their apps are skipped.
   * Deleted, or already gone on Slack's side (`app_not_found`): forgotten,
   * then logged at info (`slack_leftover_app_deleted`, with
   * `reason: 'already-gone'` for the second). If the forget fails, only that
   * failure is logged, and a later pass finds the app gone. Anything else:
   * kept, logged code-only, and still listed. Slack refusing a token
   * (TOKEN_ERRORS) skips the rest of that token's apps; a failure about Slack
   * itself (endsLeftoverPass), at a rotate or a delete, ends the pass, so one
   * Connect or Replace waits on at most one dead deadline. However the pass
   * ends, each other person whose app it forgot is then released: their
   * token goes unless an install or another leftover still names them. Never
   * fails the caller over Slack or the vault; a store fault reading the list
   * throws, before Slack is asked anything.
   */
  async function deleteLeftoverApps(inHand: { userId: string; accessToken: string }): Promise<void> {
    const apps = await d.store.leftoverApps();
    /** Another person → the access token this pass minted from theirs, or null when there is none to use. */
    const minted = new Map<string, string | null>();
    let inHandRefused = false;
    /** Another person whose app this pass forgot → that app's install id, which the release logs under. */
    const toRelease = new Map<string, string>();
    try {
      for (const app of apps) {
        // An app that names no one was made before TASK-1175: the token in hand tries it, as it always has.
        const person = app.connectedByUserId ?? inHand.userId;
        const own = person === inHand.userId;
        if (!own && !minted.has(person)) {
          const got = await mintForPass({ installId: app.installId, connectedByUserId: person });
          if (got.endsPass) return;
          minted.set(person, got.accessToken);
        }
        const token = own ? (inHandRefused ? null : inHand.accessToken) : (minted.get(person) ?? null);
        if (token === null) continue;

        let alreadyGone = false;
        try {
          await d.api.deleteApp(token, app.appId);
        } catch (err) {
          if (!(err instanceof SlackApiError && err.code === 'app_not_found')) {
            failed('delete-leftover-app', err, app.installId);
            if (endsLeftoverPass(err)) return;
            // Slack refusing the token itself: it would refuse every other app it was to try.
            if (err instanceof SlackApiError && TOKEN_ERRORS.has(err.code)) {
              if (own) inHandRefused = true;
              else minted.set(person, null);
            }
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
        if (!own && !toRelease.has(person)) toRelease.set(person, app.installId);
      }
    } finally {
      for (const [person, installId] of toRelease) await release({ installId, connectedByUserId: person });
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
    let rowStored = false;
    try {
      // The one Slack just minted from the pasted one, as the connecting
      // admin's own token (TASK-1175), until a rotate (Rename, Disconnect)
      // saves its replacement. First, straight after the rotate: generating
      // the pasted one revoked the token in their slot, so the minted one is
      // their only live token, and a later failure must not leave it unstored
      // (the undo's release then keeps it while anything names them). An id
      // that can't name a ref was refused before Slack was asked (connect);
      // should one get here, it throws before the vault, and the undo takes
      // the app back.
      await d.secrets.putConfigToken(owner, mintedRefreshToken);
      await d.secrets.put(owner, 'client-secret', app.clientSecret);
      await d.secrets.put(owner, 'signing-secret', app.signingSecret);
      await d.store.insertPending({
        installId,
        appId: app.appId,
        clientId: app.clientId,
        botName,
        connectedByUserId: actor.id,
      });
      rowStored = true;
      const iconSet = await setIcon(accessToken, app.appId, installId, icon);
      const installUrl = await steps.mintInstallUrl(installId, app.clientId, actor.id, linkFor(installId));
      return json(200, { installUrl, iconSet });
    } catch (err) {
      failed('connect', err, installId);
      await undoConnect(accessToken, app.appId, owner, botName, rowStored);
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
    const exchanged = await steps.exchangeCode(install, code, slackUrls(d.publicOrigin, installId).redirectUrl);
    if (!exchanged.ok) {
      // `oauth-access` was logged by the step; the other refusals are ours to name.
      if (exchanged.reason !== 'oauth-access') refused(exchanged.reason, installId);
      return backToApp('failed');
    }
    if (!(await steps.storeGrant(install, exchanged.granted))) return backToApp('failed');
    log('info', 'slack_connected', { installId });
    return backToApp('connected');
  }

  /**
   * Send Slack the app's whole manifest under `botName`, with an access token
   * minted from its person's stored refresh token and used once. Slack
   * replaces the manifest on update, so a part of one would drop the rest
   * (the approval buttons, `/ax`, the scopes). Null when Slack took it, else
   * what the admin is told. A vault fault reading the token, or a person id
   * that can't name one, throws: the route's 500.
   *
   * The new refresh token is stored first. If that fails, nothing is sent
   * (`'token-not-kept'`): a retry soon after may still work with the old one.
   */
  async function updateSlackApp(
    install: InstallRow,
    botName: string,
  ): Promise<RenameRefusal | 'token-not-kept' | null> {
    const refreshToken = await d.secrets.getConfigToken(install);
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
   * Whose configuration token the install uses: the admin who connected it,
   * whose token made the app (TASK-1175). A Replace stores the pasted token
   * as theirs, whoever pastes it, so it never changes who this is; it only
   * moves the date shown beside it. As auth knows them now: the row keeps
   * only their id (invariant 4: names are auth's). The display name, else
   * the email (only admins see this), else "Administrator", which also
   * stands in for an account that's gone or an auth that can't answer.
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
      // An admin whose id can't name a vault ref can hold no token
      // (secrets.ts): refused before Slack is asked anything, so no app is
      // made and the pasted pair is never spent. Logged code-only, never the id.
      try {
        configTokenRef(actor.id);
      } catch (err) {
        failed('connect', err);
        return INTERNAL;
      }
      // The pasted access token is the connecting admin's own.
      await deleteLeftoverApps({ userId: actor.id, accessToken });
      return createInstall(actor, accessToken, refreshToken, name.name, icon);
    });
  }

  async function installUrl(_req: RouteRequest, actor: AdminActor): Promise<Reply> {
    return d.lock.run(async () => {
      const install = await d.store.current();
      if (install === null || install.status !== 'pending') return json(409, { error: 'not-pending' });
      try {
        return json(200, {
          installUrl: await steps.mintInstallUrl(install.installId, install.clientId, actor.id, linkFor(install.installId)),
        });
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
          // (plugin.ts); this takes back the person's token stored after
          // that, unless an install or a leftover app still names them.
          // Still left live, where no route can reach it: one stored after
          // the reset's sweep when Slack then refused the update (that 502
          // returns before here), and any whose delete fails (logged).
          await release(install);
          return json(409, { error: 'not-connected' });
        }
        throw err;
      }
      return json(200, { botName: name.name });
    });
  }

  /**
   * Replace the configuration token the install uses with one an admin
   * pastes (TASK-1128), keeping the install, its channels and its other
   * secrets. The pasted refresh token is tried once. The access token that
   * mints sends Slack the app's whole manifest, as Rename does: Slack taking
   * it shows the new token's owner can manage this app. Only the app's
   * creator can (design §8 Q5), so only then is the minted refresh token
   * stored, as the install's person's own token, whoever pasted it
   * (TASK-1175): it now serves every app of theirs. The row keeps its person
   * and only its date moves. The old token is never read or rotated, so any
   * failure before the store leaves the install exactly as it was.
   */
  async function replaceToken(req: RouteRequest): Promise<Reply> {
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
      // Written as the install's person's token, never the pasting admin's:
      // Slack just took it for their app, so it is their chain. Writing it to
      // whoever pasted it would put one person's token in another's slot,
      // breaking every app the paster made.
      if (!(await saveRotatedToken(install, minted.refreshToken))) return INTERNAL;
      try {
        await d.store.setConfigTokenAddedAt(installId, new Date(d.now()));
      } catch (err) {
        if (err instanceof InstallStoreError) {
          // Gone meanwhile: a reset removes installs without this lock. Take
          // back the token just stored, as Rename does, unless an install or
          // a leftover app still names the person (a failed delete is
          // logged).
          await release(install);
          return json(409, { error: 'not-connected' });
        }
        // A 500, logged with its install. The vault keeps the new token,
        // which Slack just took for this app; only the date shown beside
        // "Added by" is stale until a retry.
        failed('save-added-at', err, installId);
        return INTERNAL;
      }
      log('info', 'slack_config_token_replaced', { installId });
      // Best-effort, after the replace has happened: the new token may delete
      // apps an earlier one couldn't. The access token in hand is the
      // install's person's, whoever pasted it: Slack just took it for their
      // app. A fault reading the list changes nothing.
      try {
        await deleteLeftoverApps({ userId: install.connectedByUserId, accessToken: minted.accessToken });
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
      // Peek first: another admin is refused WITHOUT spending the state. Only
      // the shared app's: a team bot's state is for its own callback
      // (TASK-1167), and reads here as unknown, unspent.
      const peeked = await d.store.peekOAuthState(stateHash, 'shared');
      if (peeked === null) return refuse('invalid-state');
      if (peeked.userId !== actor.id) return refuse('state-user-mismatch', peeked.installId);
      const spent = await d.store.consumeOAuthState(stateHash, 'shared');
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
      // Last, the person's token (TASK-1175), unless an install or a leftover
      // app still names them: this one, when Slack didn't delete it, needs it.
      await release(install);
      log('info', 'slack_disconnected', { installId: install.installId, appDeleted });
      return json(200, { appDeleted });
    });
  }

  /**
   * "I deleted it": the admin deleted a leftover app on Slack's page, so stop
   * naming it. Asks Slack nothing and touches no install: it forgets every
   * leftover entry with that app id. One it no longer lists is not an error,
   * so a double click is harmless. The id is checked like any Slack id
   * before the store is read; a store fault is the route's 500. Last, each
   * forgotten app's maker (TASK-1175) is released: their token goes unless an
   * install or another leftover still names them. That runs for the entries
   * already forgotten even when a later forget faults.
   */
  async function forgetLeftoverApp(req: RouteRequest): Promise<Reply> {
    // http-server's maxBodyBytes refused anything larger already; this is the backstop.
    if (req.body.length > ADMIN_BODY_MAX_BYTES) return json(413, { error: 'body-too-large' });
    const body = bodyObject(req.body);
    if (body === null) return json(400, { error: 'invalid-body' });
    const appId = body['appId'];
    if (typeof appId !== 'string' || !SLACK_ID_RE.test(appId)) return json(400, { error: 'invalid-app-id' });

    // Under the lock, so it never interleaves with a pass over the list, or with any use of a token.
    return d.lock.run(async () => {
      /** Each maker whose app this forgot → that app's install id, which the release logs under. */
      const makers = new Map<string, string>();
      try {
        for (const app of await d.store.leftoverApps()) {
          if (app.appId !== appId) continue;
          await d.store.forgetLeftoverApp(app.installId);
          // An app left before TASK-1175 names no one, so it has no token to release.
          if (app.connectedByUserId !== null && !makers.has(app.connectedByUserId)) {
            makers.set(app.connectedByUserId, app.installId);
          }
        }
      } finally {
        for (const [person, installId] of makers) await release({ installId, connectedByUserId: person });
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
