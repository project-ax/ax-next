import { describe, expect, it } from 'vitest';
import {
  BOT_EVENTS,
  BOT_SCOPES,
  buildAppManifest,
  buildInstallUrl,
  slackUrls,
} from '../manifest.js';

const INSTALL_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const ORIGIN = 'https://ax.example';
const REDIRECT = 'https://ax.example/admin/slack/oauth/callback';

describe('slackUrls', () => {
  it('builds the events URL and the OAuth redirect from the public origin', () => {
    expect(slackUrls(ORIGIN, INSTALL_ID)).toStrictEqual({
      eventsUrl: 'https://ax.example/slack/events/AAAAAAAAAAAAAAAAAAAAAA',
      redirectUrl: REDIRECT,
    });
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
          bot: ['app_mentions:read', 'chat:write', 'im:history', 'reactions:write', 'users:read', 'users:read.email'],
        },
      },
      settings: {
        event_subscriptions: {
          request_url: 'https://ax.example/slack/events/AAAAAAAAAAAAAAAAAAAAAA',
          bot_events: ['app_mention', 'message.im'],
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
      // 👀 on the owner's message while the agent works (walk on kind, 2026-11-13).
      'reactions:write',
      'users:read',
      'users:read.email',
    ]);
    expect([...BOT_EVENTS]).toStrictEqual(['app_mention', 'message.im']);
    expect(Object.isFrozen(BOT_SCOPES)).toBe(true);
    expect(Object.isFrozen(BOT_EVENTS)).toBe(true);
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
    expect(url.searchParams.get('scope')).toBe(
      'app_mentions:read,chat:write,im:history,reactions:write,users:read,users:read.email',
    );
    expect(url.searchParams.get('state')).toBe('abc123');
    expect(url.hash).toBe('');
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
