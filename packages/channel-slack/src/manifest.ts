/**
 * The Slack apps AX creates: the shared one for a workspace, and a team
 * agent's own channel-only bot (TASK-1167). For each: its manifest, the URLs
 * Slack calls back on, and the install link an admin follows to Allow it.
 *
 * The dedicated bot is channel-only (invariant 5): seven scopes, one event
 * (`app_mention`), no slash command, no DMs (the App Home messages tab is
 * off, no `im:history`) and no `channels:join` (it only answers in channels
 * it was invited to). It alone reads channels' flags: public ones
 * (`channels:read`) and, since TASK-1188 (design §4b.3), private ones it was
 * invited to (`groups:read`), where it answers and, since TASK-1203 (design
 * §4c), remembers like anywhere else. The shared app serves none
 * (TASK-1186). Its OAuth callback is its own, `BOT_OAUTH_CALLBACK_PATH`,
 * apart from Admin › Slack's.
 *
 * Everything below up to the dedicated bot section describes the shared app.
 *
 * The grant is as small as DMs need (invariant 5): six bot scopes, two
 * events, no slash command, and interactivity for approval buttons
 * (TASK-1095). The App Home messages tab is on and writable, because without
 * it people can't DM the app at all (MEASURED: `messages_tab_disabled`).
 * Token rotation is off so the bot token never expires. Existing installs
 * gain or shed a scope only by Disconnect + Connect: a rename sends Slack the
 * new manifest, but nothing builds the re-Allow Slack then asks for.
 *
 * What each scope is for:
 * - app_mentions:read  hear `@bot` in a channel, to tell an admitted sender
 *   privately that it answers DMs only (router.ts, TASK-1186): never a turn.
 * - chat:write         reply in DMs, that one private line in a channel, and
 *   DM people about a bot request (TASK-1170).
 * - im:history         read DMs sent to the bot.
 * - reactions:write    the eyes reaction while the agent works.
 * - users:read, users:read.email  resolve a sender to a workspace email, and
 *   find an AX admin or a bot's requester by email (TASK-1170).
 * Deliberately NOT requested: channels:history, chat:write.public,
 * groups:read, mpim:read; and channels:read, channels:join and commands,
 * because the shared app no longer serves channels (design §4b.1,
 * TASK-1186): a team agent answers in a channel only through its own bot.
 */

export const BOT_SCOPES = Object.freeze([
  'app_mentions:read',
  'chat:write',
  'im:history',
  'reactions:write',
  'users:read',
  'users:read.email',
] as const);

export const BOT_EVENTS = Object.freeze(['app_mention', 'message.im'] as const);

/**
 * The dedicated bot's grant: hear @mentions, reply, react, resolve a sender's
 * email, and read a channel's flags (`conversations.info`): `channels:read`
 * for a public channel, `groups:read` for a private one (TASK-1188; Slack's
 * docs say `conversations.info` takes it for private channels, which the
 * TASK-1189 walk measures). Without it Slack won't describe a private
 * channel to the bot at all, so the bot couldn't bind one, nor the turn-start
 * check (channel-check.ts) tell when one was archived or shared with another
 * company since. Its privacy itself is not read: a private channel is
 * answered in and remembered like any other (TASK-1203, design §4c).
 * Nothing that reads DMs or group DMs, joins channels, takes commands or
 * reads channel history. Adding a scope means Slack asks an installed bot
 * for Allow again.
 */
export const DEDICATED_BOT_SCOPES = Object.freeze([
  'app_mentions:read',
  'chat:write',
  'reactions:write',
  'users:read',
  'users:read.email',
  'channels:read',
  'groups:read',
] as const);

export const DEDICATED_BOT_EVENTS = Object.freeze(['app_mention'] as const);

/** Where Slack sends the person who started a bot request after Allow. */
export const BOT_OAUTH_CALLBACK_PATH = '/slack/bots/oauth/callback';

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const APP_DESCRIPTION = 'Talk to your AX agent.';
/**
 * A team bot's Slack profile description (TASK-1203, design §4c): the same
 * sentence the bot posts the first time it answers in a channel, in its own
 * voice. It names no team because Slack caps a description at 140 characters
 * and a team's name alone can run to 128. Every manifest send carries it (a
 * create, so Set up again; a rename; a token Replace), so a bot made before
 * this text gets it at its next one.
 */
export const DEDICATED_BOT_DESCRIPTION =
  'What I hear is shared with everyone on my team, and I may bring it up elsewhere.';

export interface SlackUrls {
  /** Where Slack delivers events for this install. */
  eventsUrl: string;
  /** Where Slack sends the admin back after Allow (the OAuth `redirect_uri`). */
  redirectUrl: string;
  /** Where Slack sends button clicks for this install. */
  interactionsUrl: string;
}

/** `origin` without trailing slashes, so a configured `https://ax.example/` adds none. */
export function withoutTrailingSlashes(origin: string): string {
  let end = origin.length;
  while (end > 0 && origin[end - 1] === '/') end -= 1;
  return origin.slice(0, end);
}

export function slackUrls(publicOrigin: string, installId: string): SlackUrls {
  const origin = withoutTrailingSlashes(publicOrigin);
  return {
    eventsUrl: `${origin}/slack/events/${encodeURIComponent(installId)}`,
    redirectUrl: `${origin}/admin/slack/oauth/callback`,
    interactionsUrl: `${origin}/slack/interactions/${encodeURIComponent(installId)}`,
  };
}

/**
 * The manifest `apps.manifest.create` and `apps.manifest.update` take. Slack
 * replaces the whole manifest on update, so a rename sends all of it, and a
 * scope or event added here reaches an existing install that way (Slack then
 * wants a re-Allow, which nothing builds yet: the card that adds one owns
 * existing installs). `botName` must already have passed `checkBotName`. A
 * new object each call: the lists are copies.
 */
export function buildAppManifest(botName: string, urls: SlackUrls): Record<string, unknown> {
  return {
    display_information: { name: botName, description: APP_DESCRIPTION },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: botName, always_online: true },
    },
    oauth_config: {
      redirect_urls: [urls.redirectUrl],
      scopes: { bot: [...BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: { request_url: urls.eventsUrl, bot_events: [...BOT_EVENTS] },
      interactivity: { is_enabled: true, request_url: urls.interactionsUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export interface BotUrls {
  /** Where Slack delivers events for this bot. */
  eventsUrl: string;
  /** Where Slack sends the requester back after Allow. */
  redirectUrl: string;
  /** Where Slack sends button clicks for this bot. */
  interactionsUrl: string;
}

export function botUrls(publicOrigin: string, installId: string): BotUrls {
  const origin = withoutTrailingSlashes(publicOrigin);
  return {
    eventsUrl: `${origin}/slack/events/${encodeURIComponent(installId)}`,
    redirectUrl: `${origin}${BOT_OAUTH_CALLBACK_PATH}`,
    interactionsUrl: `${origin}/slack/interactions/${encodeURIComponent(installId)}`,
  };
}

/**
 * The manifest for a team agent's own bot: channel-only, @mentions only, no
 * slash command. `botName` must already have passed `checkBotName`. A new
 * object each call: the lists are copies.
 */
export function buildBotManifest(botName: string, urls: BotUrls): Record<string, unknown> {
  return {
    display_information: { name: botName, description: DEDICATED_BOT_DESCRIPTION },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: false,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: botName, always_online: true },
    },
    oauth_config: {
      redirect_urls: [urls.redirectUrl],
      scopes: { bot: [...DEDICATED_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: { request_url: urls.eventsUrl, bot_events: [...DEDICATED_BOT_EVENTS] },
      interactivity: { is_enabled: true, request_url: urls.interactionsUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/**
 * Slack's OAuth v2 authorize URL for this app. Every value goes through
 * URLSearchParams, so none can add or replace another parameter. `scopes`
 * defaults to the shared bot's; it must match the app's manifest.
 */
export function buildInstallUrl(i: {
  clientId: string;
  redirectUrl: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    client_id: i.clientId,
    scope: (i.scopes ?? BOT_SCOPES).join(','),
    redirect_uri: i.redirectUrl,
    state: i.state,
  });
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}
