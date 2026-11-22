import { describe, expect, it } from 'vitest';
import {
  BOT_EVENTS,
  BOT_OAUTH_CALLBACK_PATH,
  BOT_SCOPES,
  DEDICATED_BOT_DESCRIPTION,
  DEDICATED_BOT_EVENTS,
  DEDICATED_BOT_SCOPES,
  botUrls,
  buildAppManifest,
  buildBotManifest,
  buildInstallUrl,
  slackUrls,
} from '../manifest.js';

const INSTALL_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const ORIGIN = 'https://ax.example';
const REDIRECT = 'https://ax.example/admin/slack/oauth/callback';

describe('slackUrls', () => {
  it('builds the events URL, the OAuth redirect and the interactions URL from the public origin, and no commands URL', () => {
    expect(slackUrls(ORIGIN, INSTALL_ID)).toStrictEqual({
      eventsUrl: 'https://ax.example/slack/events/AAAAAAAAAAAAAAAAAAAAAA',
      redirectUrl: REDIRECT,
      interactionsUrl: 'https://ax.example/slack/interactions/AAAAAAAAAAAAAAAAAAAAAA',
    });
  });

  it('builds the interactions URL with no double slash and a percent-encoded install id', () => {
    expect(slackUrls('https://ax.example/', INSTALL_ID).interactionsUrl).toBe(
      'https://ax.example/slack/interactions/AAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(slackUrls(ORIGIN, 'a/b').interactionsUrl).toBe('https://ax.example/slack/interactions/a%2Fb');
  });

  it('percent-encodes the install id in the events URL', () => {
    expect(slackUrls(ORIGIN, 'a/b').eventsUrl).toBe('https://ax.example/slack/events/a%2Fb');
  });

  it('does not double a slash when the origin ends in one', () => {
    expect(slackUrls('https://ax.example//', INSTALL_ID)).toStrictEqual(
      slackUrls(ORIGIN, INSTALL_ID),
    );
  });

  it('keeps the port of an http fallback origin', () => {
    expect(slackUrls('http://0.0.0.0:8080', INSTALL_ID).eventsUrl).toBe(
      'http://0.0.0.0:8080/slack/events/AAAAAAAAAAAAAAAAAAAAAA',
    );
  });
});

describe('buildAppManifest', () => {
  it('is exactly the reviewed manifest', () => {
    expect(buildAppManifest('ax', slackUrls(ORIGIN, INSTALL_ID))).toStrictEqual({
      display_information: { name: 'ax', description: 'Talk to your AX agent.' },
      features: {
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: 'ax', always_online: true },
      },
      oauth_config: {
        redirect_urls: ['https://ax.example/admin/slack/oauth/callback'],
        scopes: {
          bot: [...BOT_SCOPES],
        },
      },
      settings: {
        event_subscriptions: {
          request_url: 'https://ax.example/slack/events/AAAAAAAAAAAAAAAAAAAAAA',
          bot_events: ['app_mention', 'message.im'],
        },
        interactivity: {
          is_enabled: true,
          request_url: 'https://ax.example/slack/interactions/AAAAAAAAAAAAAAAAAAAAAA',
        },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
  });

  it('puts the bot name in both the app name and the bot display name', () => {
    const manifest = buildAppManifest('Ada Bot', slackUrls(ORIGIN, INSTALL_ID)) as {
      display_information: { name: string };
      features: { bot_user: { display_name: string } };
    };
    expect(manifest.display_information.name).toBe('Ada Bot');
    expect(manifest.features.bot_user.display_name).toBe('Ada Bot');
  });

  it('asks for exactly six bot scopes and two events', () => {
    expect([...BOT_SCOPES]).toStrictEqual([
      'app_mentions:read',
      'chat:write',
      'im:history',
      'reactions:write',
      'users:read',
      'users:read.email',
    ]);
    expect([...BOT_EVENTS]).toStrictEqual(['app_mention', 'message.im']);
    expect(Object.isFrozen(BOT_SCOPES)).toBe(true);
    expect(Object.isFrozen(BOT_EVENTS)).toBe(true);
  });

  it('asks for no history, public-write, private-channel or group-DM scope, and none that serves channels (TASK-1186)', () => {
    for (const banned of [
      'channels:history',
      'chat:write.public',
      'groups:read',
      'mpim:read',
      // The shared app no longer connects channels (design §4b.1): it reads,
      // joins and takes a command for none.
      'channels:read',
      'channels:join',
      'commands',
    ]) {
      expect(BOT_SCOPES).not.toContain(banned);
    }
  });

  it('declares no slash command, and interactivity for approval buttons', () => {
    const manifest = buildAppManifest('ax', slackUrls(ORIGIN, INSTALL_ID)) as {
      features: Record<string, unknown>;
      settings: Record<string, unknown>;
    };
    expect(Object.keys(manifest.features)).not.toContain('slash_commands');
    expect(manifest.settings['interactivity']).toStrictEqual({
      is_enabled: true,
      request_url: `${ORIGIN}/slack/interactions/${INSTALL_ID}`,
    });
  });

  it('never shares its scope or event lists with the caller', () => {
    const manifest = buildAppManifest('ax', slackUrls(ORIGIN, INSTALL_ID)) as {
      oauth_config: { scopes: { bot: string[] } };
      settings: { event_subscriptions: { bot_events: string[] } };
    };
    manifest.oauth_config.scopes.bot.push('channels:history');
    manifest.settings.event_subscriptions.bot_events.push('message.channels');
    expect(BOT_SCOPES).toHaveLength(6);
    expect(BOT_EVENTS).toHaveLength(2);
  });
});

describe('buildInstallUrl', () => {
  it("is Slack's authorize URL with exactly client_id, scope, redirect_uri and state", () => {
    const url = new URL(
      buildInstallUrl({ clientId: '123.456', redirectUrl: REDIRECT, state: 'abc123' }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://slack.com/oauth/v2/authorize');
    expect([...url.searchParams.keys()].sort()).toStrictEqual([
      'client_id',
      'redirect_uri',
      'scope',
      'state',
    ]);
    expect(url.searchParams.get('client_id')).toBe('123.456');
    expect(url.searchParams.get('scope')!.split(',')).toStrictEqual([...BOT_SCOPES]);
    expect(url.searchParams.get('state')).toBe('abc123');
    expect(url.hash).toBe('');
  });

  it('asks for the scopes it is given, and the shared bot scopes when it is given none', () => {
    const scopeOf = (scopes?: readonly string[]): string[] =>
      new URL(
        buildInstallUrl({ clientId: '1.2', redirectUrl: REDIRECT, state: 's', ...(scopes ? { scopes } : {}) }),
      )
        .searchParams.get('scope')!
        .split(',');
    expect(scopeOf(['chat:write', 'app_mentions:read'])).toStrictEqual(['chat:write', 'app_mentions:read']);
    expect(scopeOf()).toStrictEqual([...BOT_SCOPES]);
  });

  it('round-trips redirect_uri through URL unchanged', () => {
    const url = new URL(
      buildInstallUrl({ clientId: '123.456', redirectUrl: REDIRECT, state: 's' }),
    );
    const redirectUri = url.searchParams.get('redirect_uri');
    expect(redirectUri).toBe(REDIRECT);
    expect(new URL(redirectUri!).href).toBe(REDIRECT);
  });

  it('keeps a hostile value inside its own parameter', () => {
    const url = new URL(
      buildInstallUrl({
        clientId: '1&scope=admin',
        redirectUrl: REDIRECT,
        state: 'x#frag&redirect_uri=https://evil.example',
      }),
    );
    expect(url.searchParams.getAll('scope')).toHaveLength(1);
    expect(url.searchParams.getAll('redirect_uri')).toStrictEqual([REDIRECT]);
    expect(url.searchParams.get('client_id')).toBe('1&scope=admin');
    expect(url.searchParams.get('state')).toBe('x#frag&redirect_uri=https://evil.example');
    expect(url.hash).toBe('');
  });
});

describe('the dedicated bot manifest', () => {
  it('the bot manifest is the smallest a channel-only bot needs', () => {
    expect(buildBotManifest('Ada Bot', botUrls(ORIGIN, INSTALL_ID))).toStrictEqual({
      display_information: {
        name: 'Ada Bot',
        description: 'What I hear is shared with everyone on my team, and I may bring it up elsewhere.',
      },
      features: {
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: false,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: 'Ada Bot', always_online: true },
      },
      oauth_config: {
        redirect_urls: ['https://ax.example/slack/bots/oauth/callback'],
        scopes: {
          bot: [
            'app_mentions:read',
            'chat:write',
            'reactions:write',
            'users:read',
            'users:read.email',
            'channels:read',
            'groups:read',
          ],
        },
      },
      settings: {
        event_subscriptions: {
          request_url: 'https://ax.example/slack/events/AAAAAAAAAAAAAAAAAAAAAA',
          bot_events: ['app_mention'],
        },
        interactivity: {
          is_enabled: true,
          request_url: 'https://ax.example/slack/interactions/AAAAAAAAAAAAAAAAAAAAAA',
        },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
    expect(
      (buildBotManifest('x', botUrls(ORIGIN, INSTALL_ID)).features as Record<string, unknown>)[
        'slash_commands'
      ],
    ).toBeUndefined();
    expect([...DEDICATED_BOT_EVENTS]).toStrictEqual(['app_mention']);
    expect(Object.isFrozen(DEDICATED_BOT_SCOPES)).toBe(true);
    expect(Object.isFrozen(DEDICATED_BOT_EVENTS)).toBe(true);
  });

  it("a team bot's profile says what it hears is shared with its team, within Slack's 140 characters (TASK-1203)", () => {
    const description = (
      buildBotManifest('Ada Bot', botUrls(ORIGIN, INSTALL_ID)).display_information as { description: string }
    ).description;
    expect(description).toBe(DEDICATED_BOT_DESCRIPTION);
    expect(description).toBe(
      'What I hear is shared with everyone on my team, and I may bring it up elsewhere.',
    );
    expect(description.length).toBeLessThanOrEqual(140);
  });

  it("a dedicated bot can't read DMs, group DMs or any history, join channels or take commands", () => {
    expect(DEDICATED_BOT_SCOPES).toHaveLength(7);
    for (const banned of [
      'im:history',
      'im:read',
      'mpim:read',
      'mpim:history',
      'groups:history',
      'channels:join',
      'commands',
      'channels:history',
      'chat:write.public',
      'chat:write.customize',
    ]) {
      expect(DEDICATED_BOT_SCOPES).not.toContain(banned);
    }
    // Private channels: only their flags, so it can answer there and never remember them (design §4b.3, TASK-1188).
    const privateScopes = DEDICATED_BOT_SCOPES.filter((s) => /^(groups|mpim|im):/.test(s));
    expect(privateScopes).toStrictEqual(['groups:read']);
  });

  it('never shares its scope or event lists with the caller', () => {
    const manifest = buildBotManifest('x', botUrls(ORIGIN, INSTALL_ID)) as {
      oauth_config: { scopes: { bot: string[] } };
      settings: { event_subscriptions: { bot_events: string[] } };
    };
    manifest.oauth_config.scopes.bot.push('channels:history');
    manifest.settings.event_subscriptions.bot_events.push('message.channels');
    expect(DEDICATED_BOT_SCOPES).toHaveLength(7);
    expect(DEDICATED_BOT_EVENTS).toHaveLength(1);
  });

  it('botUrls drops trailing slashes and encodes the id', () => {
    expect(BOT_OAUTH_CALLBACK_PATH).toBe('/slack/bots/oauth/callback');
    expect(botUrls('https://ax.example//', 'a/b')).toStrictEqual({
      eventsUrl: 'https://ax.example/slack/events/a%2Fb',
      redirectUrl: 'https://ax.example/slack/bots/oauth/callback',
      interactionsUrl: 'https://ax.example/slack/interactions/a%2Fb',
    });
  });

  it('an install link for a bot asks for the seven scopes; the shared link is unchanged', () => {
    const scopeOf = (scopes?: readonly string[]): string[] =>
      new URL(
        buildInstallUrl({
          clientId: '1.2',
          redirectUrl: botUrls(ORIGIN, INSTALL_ID).redirectUrl,
          state: 's',
          ...(scopes ? { scopes } : {}),
        }),
      )
        .searchParams.get('scope')!
        .split(',');
    expect(scopeOf(DEDICATED_BOT_SCOPES)).toStrictEqual([...DEDICATED_BOT_SCOPES]);
    expect(scopeOf(DEDICATED_BOT_SCOPES)).toHaveLength(7);
    expect(scopeOf()).toStrictEqual([...BOT_SCOPES]);
  });
});
