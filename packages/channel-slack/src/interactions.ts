import type { Logger } from '@ax/core';
import { ACTION_BOT_REQUEST_DECLINE, actionOf, type PromptAction } from './blocks.js';
import type { RouteHandler, RouteRequest, RouteResponse } from './http-types.js';
import { INSTALL_ID_RE, admittedHandler, verifySignedRequest } from './ingress.js';
import type { Lifetime } from './lifetime.js';
import { INTERACTIONS_MAX_BODY_BYTES, SLACK_ID_RE } from './limits.js';
import { logCode } from './log-code.js';
import { PROMPT_ID_RE } from './prompts.js';
import type { SecretStore } from './secrets.js';
import type { InstallRow, InstallStore } from './store.js';

/**
 * `POST /slack/interactions/:installId`: a click on one of our buttons.
 * Two kinds: an approval prompt's Allow or Deny (TASK-1095; blocks.ts draws
 * the prompt and prompts.ts keeps it open), and Decline in the shared bot's
 * DM to an AX admin about a bot request (TASK-1170; bot-request-dms.ts sends
 * it). Slack sends every interaction with this app's messages here. The
 * route is public, so it trusts nothing it hasn't checked, in this order:
 *
 *   0-4. The ingress checks every Slack route shares (ingress.ts): the body
 *      cap (413, INTERACTIONS_MAX_BODY_BYTES), the install id and its
 *      spelling in the raw path, the install and its signing secret (one 404
 *      for all three), then the v0 signature (401). Nothing about the body
 *      is read before the signature passes.
 *   5. The body is a form (`application/x-www-form-urlencoded`, UTF-8) whose
 *      one `payload` field holds a JSON object, else 400. Slack's
 *      `ssl_check`, which carries no payload, is an empty 200.
 *   6. Anything but a click on one of our buttons is an empty 200, ignored:
 *      another kind of interaction, another app, a pending install, another
 *      workspace, a click on anything but a message the whole conversation
 *      sees (a modal; an ephemeral message, or one we can't tell isn't), or
 *      anything but exactly one button that is either
 *        - Allow or Deny, its value shaped like a prompt id; or
 *        - Decline, on the SHARED install (only the shared bot DMs anyone
 *          about a bot request), its value shaped like a request id.
 *      Approve, in the same DM, is a link: Slack still tells us of its
 *      click, which asks nothing of the bot, so it is ignored too.
 *   7. Who clicked (`user.id`), the channel (`channel.id`, else
 *      `container.channel_id`), the clicked message (`container.message_ts`,
 *      else `message.ts`) and its thread (`message.thread_ts`, when there is
 *      one) are Slack ids, else 400. Where Slack names the channel or the
 *      message twice, both must name the same one. The same for both kinds;
 *      a Decline hands on no thread (its DM is a top-level message).
 *   8. The 200 goes out, and only then is the click handed to its gate
 *      (`onClick` for a prompt's, `onBotRequestClick` for a Decline),
 *      tracked by the lifetime and never awaited: Slack wants its answer
 *      within 3 s, and answering a click takes Slack and AX calls.
 *   After `stopAdmission` every request gets 503, before any lookup.
 *
 * What a click may do is not this route's to decide. It reads which button,
 * which prompt or request, which message and who clicked, from the payload
 * Slack signed, and hands exactly that on; each kind's gate decides whether
 * this person may do what the button asks: answers.ts from the open prompt
 * the id names, bot-request-click.ts from who the clicker is to AX now.
 * Nothing else in the payload is read: not the message's text or blocks,
 * not the button's label or url, not `response_url` (`slack.com/api` stays
 * the only egress), not the legacy verification `token` (the signature is
 * the proof).
 *
 * Logs name only the install and a reason, stage or code
 * (`slack_interaction_*`): never a header, the body, a Slack id, a prompt or
 * request id, or an error's message.
 */

/** The path the handler is served on. */
export const INTERACTIONS_ROUTE_PATH = '/slack/interactions/:installId';
const INTERACTIONS_PATH_PREFIX = '/slack/interactions/';

/** One click on a prompt's button, as Slack signed it: all the route hands on. */
export interface ButtonClick {
  /** Signed by Slack: who clicked. */
  slackUserId: string;
  channel: string;
  /** The clicked message (`container.message_ts`). */
  messageTs: string;
  /** The message's `thread_ts`, when Slack sent one. */
  threadTs: string | null;
  action: PromptAction;
  /** The button's value: the id of the prompt it was drawn for. */
  promptId: string;
}

/** What a click is handed to, once Slack has its 200. */
export type ClickHandler = (install: InstallRow, click: ButtonClick) => Promise<void>;

/** A click on a bot request DM's Decline (TASK-1170), as Slack signed it: all the route hands on. */
export interface BotRequestClick {
  /** Signed by Slack: who clicked. */
  slackUserId: string;
  /** The DM the clicked message is in. */
  channel: string;
  /** The clicked message (`container.message_ts`). */
  messageTs: string;
  /** The button's value: the id of the request the DM was sent about (ours, minted by bot-requests.ts). */
  requestId: string;
}

/** What a Decline is handed to, once Slack has its 200. Only ever with the shared install. */
export type BotRequestClickHandler = (install: InstallRow, click: BotRequestClick) => Promise<void>;

export interface InteractionsHandlerDeps {
  store: Pick<InstallStore, 'get'>;
  secrets: Pick<SecretStore, 'get'>;
  lifetime: Lifetime;
  logger: Logger;
  /** Epoch milliseconds. */
  now: () => number;
  /** A prompt's Allow or Deny: the click gate (answers.ts). */
  onClick: ClickHandler;
  /** A bot request DM's Decline: its own gate (bot-request-click.ts). */
  onBotRequestClick: BotRequestClickHandler;
}

// ── The form ────────────────────────────────────────────────────────────────

type InteractionForm = { kind: 'ssl-check' } | { kind: 'payload'; payload: Record<string, unknown> };

const FORM_TYPE = 'application/x-www-form-urlencoded';
const utf8 = new TextDecoder('utf-8', { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Step 5 above. Null when the body isn't a form we accept. */
function parseInteractionForm(contentType: string | undefined, body: Buffer): InteractionForm | null {
  if ((contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() !== FORM_TYPE) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(utf8.decode(body));
  } catch {
    return null;
  }
  const payloads = params.getAll('payload');
  if (payloads.length === 0) {
    // Slack checking our certificate.
    const check = params.getAll('ssl_check');
    return check.length === 1 && check[0] === '1' ? { kind: 'ssl-check' } : null;
  }
  const [raw] = payloads;
  if (payloads.length > 1 || raw === undefined) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  return isRecord(payload) ? { kind: 'payload', payload } : null;
}

// ── The click ───────────────────────────────────────────────────────────────

type IgnoreReason = 'type' | 'app' | 'status' | 'team' | 'container' | 'action';

type Reading =
  | { kind: 'click'; click: ButtonClick }
  | { kind: 'bot-request'; click: BotRequestClick }
  | { kind: 'ignored'; reason: IgnoreReason }
  | { kind: 'malformed' };

/** Which of our buttons was clicked, and what its value names. */
type OurButton = { kind: 'prompt'; action: PromptAction; promptId: string } | { kind: 'bot-request'; requestId: string };

/** Where a click happened and who made it: step 7, the same for every button. */
type ClickedAt = Pick<ButtonClick, 'slackUserId' | 'channel' | 'messageTs' | 'threadTs'>;

const isId = (value: unknown): value is string => typeof value === 'string' && SLACK_ID_RE.test(value);

/** Slack left it out: missing, or null. */
const isAbsent = (value: unknown): value is null | undefined => value === undefined || value === null;

/**
 * A nested object Slack may leave out: empty when it did, null when it is
 * anything but an object (fail closed: one we can't read is malformed, never
 * absent).
 */
function optionalRecord(value: unknown): Record<string, unknown> | null {
  if (isAbsent(value)) return {};
  return isRecord(value) ? value : null;
}

/**
 * One Slack id that Slack may give in either of two places: the one named,
 * or null when neither names one, a named one isn't an id, or the two name
 * different ones.
 */
function oneId(first: unknown, second: unknown): string | null {
  const named = [first, second].filter((value) => !isAbsent(value));
  const [id] = named;
  return isId(id) && named.every((value) => value === id) ? id : null;
}

/**
 * The end of step 6: which of our buttons `button` is, from its action id
 * (matched exactly) and its value's shape, or null for anything else. A
 * Decline counts only on the shared install, the one bot that DMs anyone
 * about a bot request.
 */
function ourButton(button: Record<string, unknown>, install: InstallRow): OurButton | null {
  const actionId = button['action_id'];
  const value = button['value'];
  if (typeof actionId !== 'string' || typeof value !== 'string') return null;
  const action = actionOf(actionId);
  if (action !== null) return PROMPT_ID_RE.test(value) ? { kind: 'prompt', action, promptId: value } : null;
  if (actionId === ACTION_BOT_REQUEST_DECLINE && install.kind === 'shared' && INSTALL_ID_RE.test(value)) {
    return { kind: 'bot-request', requestId: value };
  }
  return null;
}

/** Step 7 above: who clicked, in which channel, on which message (and thread), or null when any can't be read. */
function clickedAt(p: Record<string, unknown>, container: Record<string, unknown>): ClickedAt | null {
  const user = p['user'];
  const channel = optionalRecord(p['channel']);
  const message = optionalRecord(p['message']);
  if (!isRecord(user) || channel === null || message === null) return null;
  const slackUserId = user['id'];
  const channelId = oneId(channel['id'], container['channel_id']);
  const messageTs = oneId(container['message_ts'], message['ts']);
  const thread = message['thread_ts'];
  const threadTs = isAbsent(thread) ? null : isId(thread) ? thread : undefined;
  if (!isId(slackUserId) || channelId === null || messageTs === null || threadTs === undefined) return null;
  return { slackUserId, channel: channelId, messageTs, threadTs };
}

/** Steps 6 and 7 above, over a payload signed for `install`. */
function readClick(p: Record<string, unknown>, install: InstallRow): Reading {
  const ignored = (reason: IgnoreReason): Reading => ({ kind: 'ignored', reason });
  if (p['type'] !== 'block_actions') return ignored('type');
  if (p['api_app_id'] !== install.appId) return ignored('app');
  if (install.status !== 'active') return ignored('status');
  const team = p['team'];
  const teamId = isRecord(team) ? team['id'] : undefined;
  if (typeof teamId !== 'string' || teamId !== install.teamId) return ignored('team');
  const container = p['container'];
  if (!isRecord(container) || container['type'] !== 'message') return ignored('container');
  const ephemeral = container['is_ephemeral'];
  if (!isAbsent(ephemeral) && ephemeral !== false) return ignored('container');
  const actions = p['actions'];
  const button = Array.isArray(actions) && actions.length === 1 ? actions[0] : undefined;
  if (!isRecord(button) || button['type'] !== 'button') return ignored('action');
  const ours = ourButton(button, install);
  if (ours === null) return ignored('action');

  const at = clickedAt(p, container);
  if (at === null) return { kind: 'malformed' };
  if (ours.kind === 'prompt') return { kind: 'click', click: { ...at, action: ours.action, promptId: ours.promptId } };
  return {
    kind: 'bot-request',
    click: { slackUserId: at.slackUserId, channel: at.channel, messageTs: at.messageTs, requestId: ours.requestId },
  };
}

// ── The handler ─────────────────────────────────────────────────────────────

export function createInteractionsHandler(d: InteractionsHandlerDeps): RouteHandler {
  // A log line never changes the answer Slack gets.
  const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, string>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };

  async function handle(req: RouteRequest, res: RouteResponse): Promise<void> {
    const signed = await verifySignedRequest(d, req, res, {
      pathPrefix: INTERACTIONS_PATH_PREFIX,
      maxBodyBytes: INTERACTIONS_MAX_BODY_BYTES,
      logPrefix: 'slack_interaction',
    });
    if (signed === null) return;
    const { install } = signed;
    const installId = install.installId;

    const contentType = Object.hasOwn(req.headers, 'content-type') ? req.headers['content-type'] : undefined;
    const form = parseInteractionForm(contentType, req.body);
    if (form?.kind === 'ssl-check') {
      res.status(200).end();
      return;
    }
    const read: Reading = form === null ? { kind: 'malformed' } : readClick(form.payload, install);
    if (read.kind === 'malformed') {
      log('warn', 'slack_interaction_refused', { installId, reason: 'malformed' });
      res.status(400).end();
      return;
    }
    if (read.kind === 'ignored') {
      log('info', 'slack_interaction_ignored', { installId, reason: read.reason });
      res.status(200).end();
      return;
    }

    res.status(200).end();
    // Only once Slack has its answer: what a click does takes longer than Slack waits.
    const failed =
      (stage: 'click' | 'bot-request') =>
      (err: unknown): void =>
        log('error', 'slack_interaction_failed', { installId, stage, code: logCode(err) });
    if (read.kind === 'click') {
      const { click } = read;
      void d.lifetime.track(() => d.onClick(install, click)).catch(failed('click'));
    } else {
      const { click } = read;
      void d.lifetime.track(() => d.onBotRequestClick(install, click)).catch(failed('bot-request'));
    }
  }

  return admittedHandler(d.lifetime, handle);
}
