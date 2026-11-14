/**
 * The Slack app AX creates for a workspace: its manifest, the URLs Slack
 * calls back on, and the install link an admin follows to Allow it.
 *
 * The grant is as small as DMs and connected channels need (invariant 5):
 * nine bot scopes, two events, one slash command, no interactivity. The App
 * Home messages tab is on and writable, because without it people can't DM
 * the app at all (MEASURED: `messages_tab_disabled`). Token rotation is off
 * so the bot token never expires. Existing installs reach a new scope only
 * by Disconnect + Connect.
 *
 * What each scope is for:
 * - app_mentions:read  hear `@bot` in a channel.
 * - chat:write         reply (DMs and channels the bot has joined).
 * - im:history         read DMs sent to the bot.
 * - reactions:write    the eyes reaction while the agent works.
 * - users:read, users:read.email  resolve a sender to a workspace email.
 * - channels:read      look up a public channel's name and membership.
 * - channels:join      join a public channel when an admin connects it.
 * - commands           the `/ax` slash command. Deliberately NOT requested:
 *   channels:history, chat:write.public, groups:read, mpim:read.
 */

export const BOT_SCOPES = Object.freeze([
  'app_mentions:read',
  'chat:write',
  'im:history',
  'reactions:write',
  'users:read',
  'users:read.email',
  'channels:read',
  'channels:join',
  'commands',
] as const);

/** The one slash command the app registers. */
export const SLASH_COMMAND = '/ax';

export const BOT_EVENTS = Object.freeze(['app_mention', 'message.im'] as const);

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const APP_DESCRIPTION = 'Talk to your AX agent.';

export interface SlackUrls {
  /** Where Slack delivers events for this install. */
  eventsUrl: string;
  /** Where Slack sends the admin back after Allow (the OAuth `redirect_uri`). */
  redirectUrl: string;
  /** Where Slack sends `/ax` invocations for this install. */
  commandsUrl: string;
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
    commandsUrl: `${origin}/slack/commands/${encodeURIComponent(installId)}`,
  };
}

/**
 * The manifest `apps.manifest.create` takes. `botName` must already have
 * passed `checkBotName`. A new object each call: the lists are copies.
 */
export function buildAppManifest(botName: string, urls: SlackUrls): Record<string, unknown> {
  return {
    display_information: { name: botName, description: APP_DESCRIPTION },
    features: {
      slash_commands: [
        {
          command: SLASH_COMMAND,
          url: urls.commandsUrl,
          description: 'Connect this channel to a team agent',
          usage_hint: 'connect <agent name> | disconnect',
          should_escape: false,
        },
      ],
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
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/**
 * Slack's OAuth v2 authorize URL for this app. Every value goes through
 * URLSearchParams, so none can add or replace another parameter.
 */
export function buildInstallUrl(i: { clientId: string; redirectUrl: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: i.clientId,
    scope: BOT_SCOPES.join(','),
    redirect_uri: i.redirectUrl,
    state: i.state,
  });
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}
