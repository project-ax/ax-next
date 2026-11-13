/**
 * The Slack app AX creates for a workspace: its manifest, the two URLs Slack
 * calls back on, and the install link an admin follows to Allow it.
 *
 * The grant is as small as DMs need (invariant 5): six bot scopes, two
 * events, no interactivity and no slash commands. The App Home messages tab
 * is on and writable, because without it people can't DM the app at all
 * (MEASURED: `messages_tab_disabled`). Token rotation is off so the bot token
 * never expires. Later cards (channels, approval buttons) extend these lists;
 * a dev install then reconnects.
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

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const APP_DESCRIPTION = 'Talk to your AX agent.';

export interface SlackUrls {
  /** Where Slack delivers events for this install. */
  eventsUrl: string;
  /** Where Slack sends the admin back after Allow (the OAuth `redirect_uri`). */
  redirectUrl: string;
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
