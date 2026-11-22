/**
 * An agent's Slack section: the wire client and the words for its failures
 * (TASK-1094). The routes live in @ax/channel-slack
 * (`packages/channel-slack/src/agent-routes.ts`); the types below mirror its
 * answers by shape, not by import (the SPA depends on no host plugin).
 *
 *   GET  /settings/slack/:agentId             → AgentSlackStatus
 *   POST /settings/slack/:agentId/bot         { botName, refreshToken?, iconPng? } → { installUrl, iconSet }
 *   POST /settings/slack/:agentId/bot/install-url  → { installUrl }
 *   POST /settings/slack/:agentId/bot/cancel  { installId } → { appDeleted }
 *        (TASK-1173: the pending bot the page showed; 409 not-pending for any other)
 *   POST /settings/slack/:agentId/bot/replace-token  { refreshToken } → {}
 *        (TASK-1173: the live bot's approver replaces their configuration token; 403 not-approver for anyone else)
 *   POST /settings/slack/:agentId/bot/claim   { installId } → {}
 *        (TASK-1173: a team admin takes over a live bot whose requester is no longer one; 409 claim-not-needed otherwise)
 *   POST /settings/slack/:agentId/bot/disconnect  { installId } → { appDeleted }
 *        (TASK-1172: a live or pending bot, named by the install id the page showed; 409 no-bot for any other)
 *   POST /settings/slack/:agentId/bot/rename  { botName } → { botName } (TASK-1171: the live bot; 409 not-live otherwise)
 *   POST /settings/slack/:agentId/bot/icon    { iconPng } → {}
 *   POST /settings/slack/:agentId/bot-request         { botName } → {}
 *   POST /settings/slack/:agentId/bot-request/cancel  → {}
 *
 * Every request carries the session cookie (`httpFetch`, which also notices a
 * 401), and every POST the `x-requested-with: ax-admin` header the CSRF check
 * wants (the same write headers as `lib/slack-admin.ts`). Answers are read
 * field by field; a field of the wrong type is a `bad-response`, never a
 * half-drawn row.
 */
import { HttpError, httpFetch } from './http';
import { SLACK_ERROR_COPY } from './slack-admin';
import { BOT_NAME_COPY, BOT_NAME_FALLBACK, BOT_TOKEN_COPY, SLACK_TOKEN_COPY } from './slack-token-copy';

/**
 * A channel the agent's own bot has answered in (TASK-1180; the status lists
 * them as `botChannels`). `isPrivate`: Slack last described it as private,
 * where the agent answers and never remembers (TASK-1188).
 */
export interface BotChannelRow {
  channelId: string;
  name: string;
  isPrivate?: boolean;
}

/** A live bot as the invite line names it: its @handle, or its name when Slack never said one. */
export interface InviteTarget {
  botName: string;
  handle: string | null;
}

/**
 * The agent's own Slack bot, as this viewer may see it (mirrors
 * @ax/channel-slack's `AgentSlackBot` by shape). `pending` reaches only the
 * people who manage the agent. `approver` is a display name, never an email.
 *
 * `installId` is the bot's own opaque id, the key its Disconnect takes, so a
 * page only ever takes away the bot it showed (TASK-1172). Only the people
 * who manage the agent get it. It is null for anyone else, and from an older
 * server that doesn't send it; with no id there is no Disconnect.
 */
export type AgentSlackBot =
  /** `configTokenStored`: whether the server holds the viewer's OWN configuration token, so the form can skip the paste. */
  | { state: 'none'; configTokenStored: boolean }
  /**
   * A team admin asked the AX admins for it, and none has approved yet (TASK-1169). Nothing exists in Slack.
   * `requestedAt`: when it was asked, as an ISO 8601 instant. Like `pending`, it reaches only managers.
   */
  | { state: 'requested'; botName: string; requestedAt: string }
  /** `canContinue`: the viewer is the approver and Slack is connected, so "Continue in Slack" can finish it. */
  | { state: 'pending'; botName: string; approver: string; canContinue: boolean; installId: string | null }
  /**
   * `handle`: the bot's @handle, or null when Slack never said. `needsClaim`: no team admin stands behind it now.
   * `approverGone`: the person who set it up is no longer an account here, so only a rebuild can change it.
   * `viewerIsApprover`: the viewer set it up, so they can replace its token. An older host omits both; that reads as false.
   */
  | {
      state: 'live';
      botName: string;
      handle: string | null;
      approver: string;
      needsClaim: boolean;
      approverGone: boolean;
      viewerIsApprover: boolean;
      installId: string | null;
    };

export type AgentSlackStatus =
  | {
      state: 'no-workspace';
      /**
       * Whether the viewer manages the agent. Slack may be gone while the
       * agent's own bot stays (TASK-1172), and its manager can still take it
       * away. An older host omits it; that reads as "a pending bot is theirs".
       */
      canManage: boolean;
      bot: AgentSlackBot;
      /** The agent's own bot's channels, oldest first, only while `bot` is live. An older host omits it; that reads as none. */
      botChannels?: BotChannelRow[];
    }
  | {
      state: 'personal-agent';
      botName: string;
      /**
       * Whether a direct message to the bot reaches this agent (its owner's
       * oldest personal agent). An older host omits it; that reads as true.
       */
      answersDms: boolean;
    }
  | {
      state: 'ready';
      botName: string;
      workspaceName: string;
      canManage: boolean;
      bot: AgentSlackBot;
      /** The agent's own bot's channels, oldest first, only while `bot` is live. An older host omits it; that reads as none. */
      botChannels?: BotChannelRow[];
    };

/** `unavailable`: this server doesn't run the Slack plugin (or can't show us the agent). */
export type AgentSlackRead = AgentSlackStatus | { state: 'unavailable' };

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

/** The server's own refusal codes (`not-live`, `bot-exists`, …). */
const CODE_RE = /^[a-z0-9-]{1,64}$/;
/** A bot's install id as the server makes them: 16 random bytes, base64url. */
const INSTALL_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * A request that failed with an answer we could read, or an answer we
 * couldn't use (`bad-response`). `code` and `reason` are the server's, kept
 * only when they are code-shaped; `message` is for the console, never a page.
 */
export class AgentSlackError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string | null;

  constructor(status: number, code: string, reason: string | null = null) {
    super(`agent slack request failed: ${status} ${code}`);
    this.name = 'AgentSlackError';
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codeOf(value: unknown): string | null {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

const badResponse = (status: number): AgentSlackError => new AgentSlackError(status, 'bad-response');

/** A date for a line of prose ("Nov 20, 2026"); a value that isn't a date shows as it came. */
export function slackShortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

const base = (agentId: string): string => `/settings/slack/${encodeURIComponent(agentId)}`;

/**
 * A bot's install id: one the server could have made, or null (the viewer
 * doesn't manage the agent). An older server omits it, which reads as null.
 * Anything else is no answer at all: it would be posted back as the bot to
 * disconnect.
 */
function isInstallId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && INSTALL_ID_RE.test(value));
}

function parseBot(value: unknown): AgentSlackBot | null {
  if (!isRecord(value)) return null;
  switch (value['state']) {
    case 'none': {
      const { configTokenStored } = value;
      return typeof configTokenStored === 'boolean' ? { state: 'none', configTokenStored } : null;
    }
    case 'requested': {
      const { botName, requestedAt } = value;
      return typeof botName === 'string' && typeof requestedAt === 'string'
        ? { state: 'requested', botName, requestedAt }
        : null;
    }
    case 'pending': {
      const { botName, approver, canContinue, installId = null } = value;
      return typeof botName === 'string' &&
        typeof approver === 'string' &&
        typeof canContinue === 'boolean' &&
        isInstallId(installId)
        ? { state: 'pending', botName, approver, canContinue, installId }
        : null;
    }
    case 'live': {
      const { botName, handle, approver, needsClaim, approverGone = false, viewerIsApprover = false, installId = null } = value;
      return typeof botName === 'string' &&
        (handle === null || typeof handle === 'string') &&
        typeof approver === 'string' &&
        typeof needsClaim === 'boolean' &&
        typeof approverGone === 'boolean' &&
        typeof viewerIsApprover === 'boolean' &&
        isInstallId(installId)
        ? { state: 'live', botName, handle, approver, needsClaim, approverGone, viewerIsApprover, installId }
        : null;
    }
    default:
      return null;
  }
}

/**
 * The bot's channels: absent (an older host, or no live bot) reads as absent;
 * present, it is an array of whole rows or the whole answer is bad (never a
 * half-drawn list). `null` is "malformed".
 */
function parseBotChannels(value: unknown): BotChannelRow[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const rows: BotChannelRow[] = [];
  for (const c of value) {
    if (!isRecord(c)) return null;
    const { channelId, name, isPrivate } = c;
    if (typeof channelId !== 'string' || typeof name !== 'string') return null;
    // Absent: an older host, which binds public channels only. Anything but a boolean is a bad answer.
    if (isPrivate !== undefined && typeof isPrivate !== 'boolean') return null;
    rows.push({ channelId, name, ...(isPrivate !== undefined ? { isPrivate } : {}) });
  }
  return rows;
}

function parseStatus(body: unknown): AgentSlackStatus | null {
  if (!isRecord(body)) return null;
  switch (body['state']) {
    case 'no-workspace': {
      const bot = parseBot(body['bot']);
      if (bot === null) return null;
      const canManage = 'canManage' in body ? body['canManage'] : bot.state === 'pending';
      const botChannels = parseBotChannels(body['botChannels']);
      if (typeof canManage !== 'boolean' || botChannels === null) return null;
      return { state: 'no-workspace', canManage, bot, ...(botChannels !== undefined ? { botChannels } : {}) };
    }
    case 'personal-agent': {
      const { botName, answersDms = true } = body;
      return typeof botName === 'string' && typeof answersDms === 'boolean'
        ? { state: 'personal-agent', botName, answersDms }
        : null;
    }
    case 'ready': {
      const { botName, workspaceName, canManage } = body;
      if (
        typeof botName !== 'string' ||
        typeof workspaceName !== 'string' ||
        typeof canManage !== 'boolean'
      ) {
        return null;
      }
      const bot = parseBot(body['bot']);
      if (bot === null) return null;
      const botChannels = parseBotChannels(body['botChannels']);
      if (botChannels === null) return null;
      return {
        state: 'ready',
        botName,
        workspaceName,
        canManage,
        bot,
        ...(botChannels !== undefined ? { botChannels } : {}),
      };
    }
    default:
      return null;
  }
}

async function failure(res: Response): Promise<AgentSlackError> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const fields = isRecord(json) ? json : {};
  return new AgentSlackError(res.status, codeOf(fields['error']) ?? 'unknown', codeOf(fields['reason']));
}

/**
 * How Slack stands for one agent. A 404 means this server has no Slack routes
 * (or the agent isn't one we can see), and so does a page that isn't JSON: a
 * host that serves the app answers an unknown GET with the app's own HTML.
 * Any other failure throws, for a retry.
 */
export async function fetchAgentSlack(agentId: string): Promise<AgentSlackRead> {
  const res = await httpFetch(base(agentId));
  if (res.status === 404) return { state: 'unavailable' };
  if (!res.ok) throw new HttpError(base(agentId), res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { state: 'unavailable' };
  }
  const status = parseStatus(body);
  if (status === null) throw badResponse(res.status);
  return status;
}

/** A POST with the write headers. A non-ok answer becomes an AgentSlackError. */
async function post(agentId: string, suffix: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await httpFetch(`${base(agentId)}${suffix}`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json };
}

/**
 * Ask for the agent's own Slack bot. `refreshToken` is sent only when the
 * person pasted one (the server uses the one it holds otherwise); `iconPng`
 * only when there is a picture. The answer is where to send the person to
 * click Allow.
 */
export async function requestSlackBot(
  agentId: string,
  i: { botName: string; refreshToken?: string; iconPng?: string },
): Promise<{ installUrl: string; iconSet: boolean }> {
  const answer = await post(agentId, '/bot', {
    botName: i.botName,
    ...(i.refreshToken !== undefined ? { refreshToken: i.refreshToken } : {}),
    ...(i.iconPng !== undefined ? { iconPng: i.iconPng } : {}),
  });
  const fields = isRecord(answer.body) ? answer.body : {};
  const { installUrl, iconSet } = fields;
  if (typeof installUrl !== 'string' || installUrl === '' || typeof iconSet !== 'boolean') {
    throw badResponse(answer.status);
  }
  return { installUrl, iconSet };
}

/**
 * Ask the AX admins to approve the agent's own bot, for a team admin who
 * can't install apps in Slack. Nothing secret goes: only the name.
 */
export async function askSlackBotApproval(agentId: string, i: { botName: string }): Promise<void> {
  await post(agentId, '/bot-request', { botName: i.botName });
}

/** Take back a request no AX admin has approved yet. */
export async function cancelSlackBotRequest(agentId: string): Promise<void> {
  await post(agentId, '/bot-request/cancel', {});
}

/**
 * Replace the live bot's configuration token with a new one the person pasted
 * (TASK-1173; only the person who set the bot up may). Resolves once Slack
 * accepted the token and the server holds it.
 */
export async function replaceAgentSlackBotToken(agentId: string, refreshToken: string): Promise<void> {
  await post(agentId, '/bot/replace-token', { refreshToken });
}

/**
 * Take over a live bot whose requester is no longer a team admin (TASK-1173),
 * named by the install id the page showed.
 */
export async function claimAgentSlackBot(agentId: string, installId: string): Promise<void> {
  await post(agentId, '/bot/claim', { installId });
}

/** A fresh install link for the pending bot (its approver only). */
export async function continueSlackBot(agentId: string): Promise<{ installUrl: string }> {
  const answer = await post(agentId, '/bot/install-url', {});
  const installUrl = isRecord(answer.body) ? answer.body['installUrl'] : undefined;
  if (typeof installUrl !== 'string' || installUrl === '') throw badResponse(answer.status);
  return { installUrl };
}

/** Take back the pending request. `appDeleted` is false when the Slack app is left for its owner to delete. */
export async function cancelSlackBot(agentId: string, installId: string): Promise<{ appDeleted: boolean }> {
  const answer = await post(agentId, '/bot/cancel', { installId });
  const appDeleted = isRecord(answer.body) ? answer.body['appDeleted'] : undefined;
  if (typeof appDeleted !== 'boolean') throw badResponse(answer.status);
  return { appDeleted };
}

/**
 * Take the agent's own bot away, pending or live: the one whose `installId`
 * the page showed, and no other (any other is a 409 `no-bot`, see
 * `agentSlackBotStale`). `appDeleted` is false when its Slack app may still
 * be on Slack.
 */
export async function disconnectSlackBot(agentId: string, installId: string): Promise<{ appDeleted: boolean }> {
  const answer = await post(agentId, '/bot/disconnect', { installId });
  const appDeleted = isRecord(answer.body) ? answer.body['appDeleted'] : undefined;
  if (typeof appDeleted !== 'boolean') throw badResponse(answer.status);
  return { appDeleted };
}

/**
 * Rename the agent's live bot (its Slack app and the bot user). The answer is
 * the name the server stored.
 */
export async function renameAgentSlackBot(agentId: string, botName: string): Promise<{ botName: string }> {
  const answer = await post(agentId, '/bot/rename', { botName });
  const stored = isRecord(answer.body) ? answer.body['botName'] : undefined;
  if (typeof stored !== 'string' || stored === '') throw badResponse(answer.status);
  return { botName: stored };
}

/** Change the agent's live bot's picture: `iconPng` is a base64 PNG (see `drawPickedSlackAvatar`). */
export async function setAgentSlackBotPicture(agentId: string, iconPng: string): Promise<void> {
  await post(agentId, '/bot/icon', { iconPng });
}

// ── What an error says ────────────────────────────────────────────────────

export const AGENT_SLACK_COPY = Object.freeze({
  generic: 'Something went wrong. Try again in a minute.',
  privateChannelNotRemembered: "Private channels aren't remembered.",
});

/** How the card names a live bot: its @handle, or its name when Slack never said one. */
export function botWho(t: InviteTarget): string {
  return t.handle !== null ? `@${t.handle}` : t.botName;
}

/** Every line of an agent's Slack card (TASK-1187). Plain words: no roles, no plumbing, no product name. */
export const AGENT_SLACK_CARD_COPY = Object.freeze({
  notInSlack: (agentName: string): string => `${agentName} isn't in Slack yet`,
  addItLead: 'Add it to Slack, and people can mention it in channels.',
  teamAdminCanAdd: 'A team admin can add it.',
  adminWillApprove: "We'll ask an admin to approve it.",
  selfPathLink: 'I can install Slack apps myself',
  adminPathLink: 'Ask an admin instead',
  slackHasFinalSay: 'Slack has the final say: only someone allowed to install apps in your Slack workspace can add it.',
  removedNotice: (who: string): string =>
    `${who} was removed from Slack. Add it again below. It's a new bot in Slack, so invite it to each channel again.`,
  waitingForAdmin: (botName: string): string => `Waiting for an admin to approve ${botName}`,
  askedOn: (date: string, botName: string): string =>
    `Asked on ${date}. Once an admin approves it, ${botName} is ready to invite to channels.`,
  finishInSlack: (botName: string): string => `Almost there: finish adding ${botName} in Slack`,
  waitingForPerson: (person: string, botName: string): string =>
    `Waiting for ${person} to finish adding ${botName} in Slack`,
  cancelling: 'Cancelling…',
  inSlack: (who: string): string => `${who} is in Slack`,
  /** Before the live handle's own `/invite @handle`, which the card sets in <code>. */
  inviteLead: 'In any Slack channel, type ',
  inviteNoHandle: 'In any Slack channel, type /invite and pick it.',
  channelsLead: (t: InviteTarget): string =>
    `${botWho(t)} has answered in these channels. It remembers what team members say in public channels, never in private ones.`,
  /** The Not in Slack card's consent line: what adding the bot means for the manager who does it. */
  outsidersUseYourAccess: 'When someone outside the team mentions it, it answers them with your access.',
  helpLine: (who: string): string =>
    `When ${who} needs an OK for something, it asks the person who mentioned it. For people outside the team, it asks the team admin who set ${who} up.`,
  setUpAgain: (who: string): string => `${who} needs to be set up again. The person who added it to Slack has left.`,
  changesCantReach: (who: string): string => `Changes to ${who} can't reach Slack right now.`,
  askToReconnect: (who: string, approver: string): string =>
    `Changes to ${who} can't reach Slack right now. Ask ${approver} to reconnect it.`,
  outsidersCantUse: (who: string): string =>
    `People outside the team can't use ${who} right now, because the team admin who set it up isn't a team admin anymore.`,
  teamAdminCanFix: ' A team admin can fix this.',
  onceSlackIsBack: ' You can do this here once Slack is connected again.',
  reconnectThenRetry: (who: string): string => `Changes to ${who} can't reach Slack right now. Reconnect it, then try again.`,
  setUpAgainFirst: (who: string): string => `${who} needs to be set up again before it can be changed.`,
});

/** A Rename or Change picture refused because the bot's Slack token no longer works. */
export function agentSlackBotTokenDead(err: unknown): boolean {
  return err instanceof AgentSlackError && err.code === 'slack-config-token';
}

export const AGENT_SLACK_BOT_COPY = Object.freeze({
  'slack-config-token':
    "The configuration token we kept for you stopped working. Generate a new one on Slack's app settings and paste it below.",
  'config-token-needed': 'Paste a configuration token to continue.',
  'slack-token': "Slack didn't accept the configuration token. Generate a new one and paste it below.",
  'no-workspace': "Slack isn't connected yet. An admin connects it first.",
  'not-approver': 'Only the person who set this up can continue it in Slack.',
});

/**
 * The sentence a refused bot request, continue or cancel becomes, and where it
 * goes. `revealToken`: the refusal means "paste a configuration token", so the
 * form shows its token field (and the message sits under it). Never a raw code.
 */
export function agentSlackBotErrorCopy(err: unknown): {
  field: 'botName' | 'refreshToken' | null;
  message: string;
  revealToken: boolean;
} {
  if (err instanceof AgentSlackError) {
    switch (err.code) {
      case 'invalid-bot-name': {
        const known =
          err.reason !== null && Object.hasOwn(BOT_NAME_COPY, err.reason) ? BOT_NAME_COPY[err.reason] : undefined;
        return { field: 'botName', message: known ?? BOT_NAME_FALLBACK, revealToken: false };
      }
      case 'bot-name-taken':
        return { field: 'botName', message: SLACK_TOKEN_COPY['bot-name-taken'], revealToken: false };
      case 'slack-name':
        return { field: 'botName', message: SLACK_TOKEN_COPY['slack-name'], revealToken: false };
      case 'invalid-refresh-token':
        return { field: 'refreshToken', message: SLACK_TOKEN_COPY['invalid-refresh-token'], revealToken: false };
      case 'slack-refresh-token':
        return { field: 'refreshToken', message: SLACK_TOKEN_COPY['slack-refresh-token'], revealToken: false };
      case 'slack-config-token':
      case 'config-token-needed':
      case 'slack-token':
        return { field: 'refreshToken', message: AGENT_SLACK_BOT_COPY[err.code], revealToken: true };
      case 'no-workspace':
      case 'not-approver':
        return { field: null, message: AGENT_SLACK_BOT_COPY[err.code], revealToken: false };
      case 'public-origin-not-https':
        return { field: null, message: SLACK_ERROR_COPY['public-origin-not-https'], revealToken: false };
      case 'slack-unconfirmed':
        return { field: null, message: SLACK_TOKEN_COPY['slack-unconfirmed'], revealToken: false };
      case 'slack-error':
        return { field: null, message: SLACK_ERROR_COPY.generic, revealToken: false };
    }
  }
  // Our own failure (`internal`), or a dropped connection: nothing to blame Slack for.
  return { field: null, message: AGENT_SLACK_COPY.generic, revealToken: false };
}

export const AGENT_SLACK_BOT_CHANGE_COPY = Object.freeze({
  appGone: "Slack no longer has this bot's app. It may have been deleted on api.slack.com/apps.",
  badPicture: "We couldn't use that picture. Try another image.",
  pictureChanged: 'Slack has the new picture.',
});

/**
 * One sentence for a refused rename or picture change, and whether it belongs under the name field.
 * A dead token says what to do and who can: the viewer set the bot up (`reconnectThenRetry`), the person who did
 * has left (`setUpAgainFirst`), or anyone else (`askToReconnect`, naming that person), in that priority.
 */
export function agentSlackBotChangeErrorCopy(
  err: unknown,
  bot: Pick<Extract<AgentSlackBot, { state: 'live' }>, 'botName' | 'handle' | 'approver' | 'approverGone' | 'viewerIsApprover'>,
): { field: 'botName' | null; message: string } {
  if (err instanceof AgentSlackError) {
    switch (err.code) {
      case 'invalid-bot-name': {
        const known =
          err.reason !== null && Object.hasOwn(BOT_NAME_COPY, err.reason) ? BOT_NAME_COPY[err.reason] : undefined;
        return { field: 'botName', message: known ?? BOT_NAME_FALLBACK };
      }
      case 'bot-name-taken':
      case 'slack-name':
        return { field: 'botName', message: SLACK_TOKEN_COPY[err.code] };
      case 'invalid-icon':
        return { field: null, message: AGENT_SLACK_BOT_CHANGE_COPY.badPicture };
      case 'slack-config-token':
        return {
          field: null,
          message: bot.viewerIsApprover
            ? AGENT_SLACK_CARD_COPY.reconnectThenRetry(botWho(bot))
            : bot.approverGone
              ? AGENT_SLACK_CARD_COPY.setUpAgainFirst(botWho(bot))
              : AGENT_SLACK_CARD_COPY.askToReconnect(botWho(bot), bot.approver),
        };
      case 'slack-app-gone':
        return { field: null, message: AGENT_SLACK_BOT_CHANGE_COPY.appGone };
      case 'public-origin-not-https':
        return { field: null, message: SLACK_ERROR_COPY['public-origin-not-https'] };
      case 'slack-error':
        return { field: null, message: SLACK_ERROR_COPY.generic };
    }
  }
  return { field: null, message: AGENT_SLACK_COPY.generic };
}

/**
 * A bot request, continue, cancel, disconnect, rename or picture change that says what we drew is out of date:
 * the bot is already there, already asked for, no longer pending or requested, or no longer
 * there (409), or the agent can't be managed (403 `forbidden`) or seen (404) any more. Read
 * the status again.
 * (`not-approver` is a 403 too, but it is an answer about the person, shown as it is.)
 */
export function agentSlackBotStale(err: unknown): boolean {
  if (!(err instanceof AgentSlackError)) return false;
  if (err.status === 404 || (err.status === 403 && err.code === 'forbidden')) return true;
  return (
    err.status === 409 &&
    (err.code === 'bot-exists' ||
      err.code === 'not-pending' ||
      err.code === 'bot-requested' ||
      err.code === 'not-requested' ||
      err.code === 'personal-agent' ||
      err.code === 'no-bot' ||
      err.code === 'not-live' ||
      err.code === 'claim-not-needed')
  );
}

/**
 * The sentence a refused Replace becomes, and where it goes: under the token
 * field for a token we or Slack turned away, nowhere in particular otherwise.
 * Never a raw code.
 */
export function agentSlackBotReplaceErrorCopy(err: unknown): { field: 'refreshToken' | null; message: string } {
  if (err instanceof AgentSlackError) {
    switch (err.code) {
      case 'invalid-refresh-token':
      case 'slack-refresh-token':
        return { field: 'refreshToken', message: SLACK_TOKEN_COPY[err.code] };
      case 'slack-not-app-manager':
        return { field: 'refreshToken', message: BOT_TOKEN_COPY['slack-not-app-manager'] };
      case 'public-origin-not-https':
        return { field: null, message: SLACK_ERROR_COPY['public-origin-not-https'] };
      case 'slack-error':
        return { field: null, message: SLACK_ERROR_COPY.generic };
    }
  }
  return { field: null, message: AGENT_SLACK_COPY.generic };
}

/**
 * A Replace that says what we drew is out of date: anything `agentSlackBotStale`
 * says, or 403 `not-approver` (the bot was rebuilt in another tab, so
 * the viewer isn't its approver now). Read the status again.
 */
export function agentSlackBotReplaceStale(err: unknown): boolean {
  return agentSlackBotStale(err) || (err instanceof AgentSlackError && err.status === 403 && err.code === 'not-approver');
}
